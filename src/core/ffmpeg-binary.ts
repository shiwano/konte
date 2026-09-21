import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadKonteConfig } from "./config.js";
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { type KonteErrorCode, KonteError, errorMessage } from "./errors.js";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";
import { workspaceRootOrNull } from "./workspace-context.js";
import { execFileAsync } from "./exec-file.js";

// Pinned ffmpeg release for the BtbN builds (Linux/Windows, incl. arm64). The dated `autobuild-*`
// tag rather than `latest`: `latest`'s assets are replaced on every nightly build, so no checksum
// could be pinned against them. It must be a month-end tag: BtbN prunes every other dated tag
// after about two weeks and keeps only the last build of each month. `BTBN_BUILD` names the build inside that tag and `BTBN_VERSION`
// the ffmpeg branch it was cut from (the archive's `-gpl-<branch>` suffix). The managed build
// lands in a version-named tool-cache dir (`ffmpeg-<version>`), so an upgrade never reuses a stale
// binary. macOS arm64 uses a different source pinned at its own version (see below), so the cache
// version is per platform.
const BTBN_TAG = "autobuild-2026-08-31-13-27";
const BTBN_BUILD = "n8.1.2-50-g1a748fe2cd";
const BTBN_VERSION = "8.1";
// macOS arm64 has no clean native build from BtbN/evermeet, so it comes from eugeneware/ffmpeg-static
// (a static arm64 ffmpeg + ffprobe). Its release cadence is slower, so this version trails the BtbN
// one — an accepted per-platform split (Intel macs are unsupported as Rosetta 2 winds down).
const EUGENEWARE_VERSION = "6.1.1"; // release tag is `b${version}`
// Floor enforced only on an explicitly-provided binary (env/config). konte's filters (alimiter,
// afade, adelay, amix, concat) and frame-accurate seeking are all present since the 4.x line, so
// 4 is the practical minimum — high enough to reject genuinely ancient builds, low enough to
// accept the ffmpeg most distros ship. The managed build is pinned above, so it skips this check.
const MIN_MAJOR_VERSION = 4;

// A render that emits exactly one frame needs no thread pools, but ffmpeg sizes its decode, filter
// and encode pools off the core count anyway — 80 threads for one JPEG on a 32-core box. Renders run
// several at a time (see mapConcurrent) and a suite drives many at once, so those pools multiply
// into RLIMIT_NPROC until ffmpeg dies on `pthread_create() failed`. Capping them leaves the output
// byte-identical and is measurably faster: the pools cost more to set up than the frame costs to
// make. Two halves because `-threads` binds to whichever input or output it precedes.
export const SINGLE_FRAME_INPUT_ARGS = [
  "-threads",
  "1",
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
] as const;
export const SINGLE_FRAME_OUTPUT_ARGS = ["-threads", "1"] as const;

let ffmpegPath: string | null = null;
let ffprobePath: string | null = null;
let provisioning: Promise<void> | null = null;
let configOverrides: { ffmpegPath?: string; ffprobePath?: string } | undefined;

/** Absolute path to a usable ffmpeg, provisioning the managed build on first use if needed. */
export async function ffmpegBin(): Promise<string> {
  if (ffmpegPath) return ffmpegPath;
  const override = await resolveOverride("ffmpeg");
  if (override) {
    await assertBinVersion(override, "ffmpeg", "FFMPEG_SETUP_FAILED");
    ffmpegPath = override;
    return override;
  }
  await ensureManaged();
  return ffmpegPath as string;
}

/** Absolute path to a usable ffprobe, provisioning the managed build on first use if needed. */
export async function ffprobeBin(): Promise<string> {
  if (ffprobePath) return ffprobePath;
  const override = await resolveOverride("ffprobe");
  if (override) {
    await assertBinVersion(override, "ffprobe", "FFPROBE_SETUP_FAILED");
    ffprobePath = override;
    return override;
  }
  await ensureManaged();
  return ffprobePath as string;
}

/**
 * Lead `PATH` with the directories of the resolved ffmpeg/ffprobe, for a child process that shells
 * out to the bare names. konte's own calls never need this — they spawn the absolute path — but a
 * dependency that hardcodes `spawn("ffmpeg")` and offers no path option (HyperFrames does, across
 * frame extraction, encoding and probing) can only be routed through PATH.
 *
 * Skips an override that a PATH lookup cannot reach anyway: a bare name (`ffmpeg`) is already a
 * PATH lookup, and a renamed one (`/opt/bin/ffmpeg-7`) is not a name anyone looks up — leading with
 * its directory would silently hand the dependency a stranger that happens to sit beside it.
 */
export async function leadPathWithFfmpeg(): Promise<void> {
  const resolved = [
    ["ffmpeg", await ffmpegBin()],
    ["ffprobe", await ffprobeBin()],
  ] as const;

  const dirs = resolved
    .filter(([tool, bin]) => path.isAbsolute(bin) && path.basename(bin) === binName(tool))
    .map(([, bin]) => path.dirname(bin));

  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const missing = [...new Set(dirs)].filter((dir) => !current.includes(dir));
  if (missing.length > 0) {
    process.env.PATH = [...missing, ...current].join(path.delimiter);
  }
}

type FfmpegToolStatus = {
  source: "override" | "cached" | "pending" | "unpinned" | "unsupported";
  path: string;
  version: string;
};

/** Resolve where each binary would come from, WITHOUT downloading. Used by `konte doctor`. */
export async function ffmpegToolStatus(): Promise<{
  ffmpeg: FfmpegToolStatus;
  ffprobe: FfmpegToolStatus;
}> {
  const status = async (tool: "ffmpeg" | "ffprobe"): Promise<FfmpegToolStatus> => {
    const override = await resolveOverride(tool);
    if (override) return { source: "override", path: override, version: "" };

    let src: FfmpegSource;
    try {
      src = ffmpegSource();
    } catch {
      return { source: "unsupported", path: "", version: "" };
    }
    const dir = managedDir();
    const managed = path.join(dir, binName(tool));

    // Kept apart from the platform check above: a URL bumped without regenerating the manifest is
    // an actionable manifest error, not a platform konte has no build for.
    let pin: string;
    try {
      pin = toolPin(sourceUrls(src));
    } catch {
      return { source: "unpinned", path: managed, version: src.version };
    }
    const ready = toolCacheReady(dir, pin, managedBinNames());
    return { source: ready ? "cached" : "pending", path: managed, version: src.version };
  };
  return { ffmpeg: await status("ffmpeg"), ffprobe: await status("ffprobe") };
}

export { BTBN_BUILD, BTBN_TAG, BTBN_VERSION };

async function resolveOverride(tool: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const env = process.env[tool === "ffmpeg" ? "KONTE_FFMPEG_PATH" : "KONTE_FFPROBE_PATH"];
  if (env) return env;
  const cfg = await loadConfigOverrides();
  return (tool === "ffmpeg" ? cfg.ffmpegPath : cfg.ffprobePath) ?? null;
}

// Memoized for the process. Outside a workspace there is no config to read, so only the env
// overrides apply. A malformed config throws inside loadKonteConfig and propagates — an override
// the user wrote must not be silently dropped in favor of the managed build.
async function loadConfigOverrides(): Promise<{ ffmpegPath?: string; ffprobePath?: string }> {
  if (configOverrides !== undefined) return configOverrides;
  const workspace = workspaceRootOrNull();
  configOverrides = workspace ? ((await loadKonteConfig(workspace)).local ?? {}) : {};
  return configOverrides;
}

function managedDir(): string {
  return toolCacheDir(`ffmpeg-${ffmpegSource().version}`);
}

function binName(tool: "ffmpeg" | "ffprobe"): string {
  return process.platform === "win32" ? `${tool}.exe` : tool;
}

function managedBinNames(): string[] {
  return [binName("ffmpeg"), binName("ffprobe")];
}

async function ensureManaged(): Promise<void> {
  if (ffmpegPath && ffprobePath) return;
  const dir = managedDir();
  const fm = path.join(dir, binName("ffmpeg"));
  const fp = path.join(dir, binName("ffprobe"));
  const pin = toolPin(sourceUrls(ffmpegSource()));
  if (!toolCacheReady(dir, pin, managedBinNames())) {
    if (!provisioning) provisioning = provision(dir, fm, fp, pin);
    await provisioning;
  }
  // ??= so an already-resolved override path is never clobbered by the managed one.
  ffmpegPath ??= fm;
  ffprobePath ??= fp;
}

type FfmpegSource =
  // BtbN: one tar/zip archive holding both binaries under a nested `bin/` dir.
  | { kind: "archive"; version: string; url: string; ffmpeg: string; ffprobe: string }
  // eugeneware: a separate gzip-of-a-single-binary per tool.
  | { kind: "gzipped"; version: string; ffmpegUrl: string; ffprobeUrl: string };

/** Where each platform/arch fetches its version-pinned ffmpeg + ffprobe. Pure (for testing). */
export function ffmpegDownloadSources(platform: NodeJS.Platform, arch: string): FfmpegSource {
  // The build string identifies the archive, and names the cache dir. A tag-only bump leaves that
  // name unchanged, so it is the readiness marker's pin — not the directory name — that decides
  // whether an existing install still matches what konte pins (see toolCacheReady).
  const v = BTBN_BUILD.replace(/^n/, "");
  const btbn = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
  if (platform === "linux") {
    const plat = arch === "arm64" ? "linuxarm64" : arch === "x64" ? "linux64" : null;
    if (!plat) throw unsupported(platform, arch);
    return {
      kind: "archive",
      version: v,
      url: `${btbn}/ffmpeg-${BTBN_BUILD}-${plat}-gpl-${BTBN_VERSION}.tar.xz`,
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
    };
  }
  if (platform === "win32") {
    const plat = arch === "arm64" ? "winarm64" : arch === "x64" ? "win64" : null;
    if (!plat) throw unsupported(platform, arch);
    return {
      kind: "archive",
      version: v,
      url: `${btbn}/ffmpeg-${BTBN_BUILD}-${plat}-gpl-${BTBN_VERSION}.zip`,
      ffmpeg: "ffmpeg.exe",
      ffprobe: "ffprobe.exe",
    };
  }
  // macOS arm64 only — Intel macs are unsupported (no native build; Rosetta 2 is being retired).
  if (platform === "darwin" && arch === "arm64") {
    const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/b${EUGENEWARE_VERSION}`;
    return {
      kind: "gzipped",
      version: EUGENEWARE_VERSION,
      ffmpegUrl: `${base}/ffmpeg-darwin-arm64.gz`,
      ffprobeUrl: `${base}/ffprobe-darwin-arm64.gz`,
    };
  }
  throw unsupported(platform, arch);
}

function ffmpegSource(): FfmpegSource {
  return ffmpegDownloadSources(process.platform, process.arch);
}

function sourceUrls(src: FfmpegSource): string[] {
  return src.kind === "archive" ? [src.url] : [src.ffmpegUrl, src.ffprobeUrl];
}

function unsupported(platform: string, arch: string): KonteError {
  return new KonteError(
    "FFMPEG_SETUP_FAILED",
    `No managed ffmpeg build for ${platform}-${arch}. ` +
      `Install ffmpeg/ffprobe and set KONTE_FFMPEG_PATH / KONTE_FFPROBE_PATH (or local.ffmpegPath / local.ffprobePath in konte.config.json).`,
  );
}

async function provision(dir: string, fmDest: string, fpDest: string, pin: string): Promise<void> {
  try {
    await withToolCacheLock(dir, async () => {
      if (toolCacheReady(dir, pin, managedBinNames())) return; // another process got there first
      await downloadAndUnpack(dir, fmDest, fpDest, pin);
    });
  } catch (err) {
    if (err instanceof KonteError) throw err;
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_SETUP_FAILED", `ffmpeg setup failed: ${message}`);
  }
}

async function downloadAndUnpack(
  dir: string,
  fmDest: string,
  fpDest: string,
  pin: string,
): Promise<void> {
  resetToolCacheDir(dir);
  const src = ffmpegSource();
  console.error(`konte: provisioning ffmpeg ${src.version} → ${dir}`);
  const tmp = fs.mkdtempSync(path.join(dir, ".dl-"));
  try {
    if (src.kind === "archive") {
      const archive = path.join(tmp, path.basename(new URL(src.url).pathname));
      await downloadFile(src.url, archive, progressReporter("ffmpeg + ffprobe"));
      endProgress();
      await extractArchive(archive, tmp);
      relocate(findBinary(tmp, src.ffmpeg), fmDest);
      relocate(findBinary(tmp, src.ffprobe), fpDest);
    } else {
      await extractGzipped(src.ffmpegUrl, fmDest, "ffmpeg", tmp);
      await extractGzipped(src.ffprobeUrl, fpDest, "ffprobe", tmp);
    }
    fs.chmodSync(fmDest, 0o755);
    fs.chmodSync(fpDest, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await markToolCacheReady(dir, pin);
}

// bsdtar (libarchive) handles every archive konte downloads: .tar.xz on Linux and .zip on
// Windows. Win10+ ships bsdtar as `tar`; Linux uses GNU tar (xz-capable).
async function extractArchive(archive: string, destDir: string): Promise<void> {
  await execFileAsync("tar", ["xf", archive, "-C", destDir]);
}

// eugeneware ships each binary as a bare gzip stream (not a tar), so inflate straight to dest.
async function extractGzipped(
  url: string,
  dest: string,
  label: string,
  tmp: string,
): Promise<void> {
  const gz = path.join(tmp, `${label}.gz`);
  await downloadFile(url, gz, progressReporter(label));
  endProgress();
  fs.writeFileSync(dest, gunzipSync(fs.readFileSync(gz)));
}

function findBinary(dir: string, name: string): string {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  throw new KonteError("FFMPEG_SETUP_FAILED", `"${name}" not found in the downloaded archive`);
}

function relocate(src: string, dest: string): void {
  fs.rmSync(dest, { force: true });
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

async function assertBinVersion(
  bin: string,
  label: "ffmpeg" | "ffprobe",
  code: KonteErrorCode,
): Promise<void> {
  let out: string;
  try {
    out = (await execFileAsync(bin, ["-version"])).stdout;
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError(code, `failed to run ${label} at "${bin}": ${message}`);
  }
  // Numbered releases report e.g. "ffmpeg version 7.1" / "ffmpeg version n7.1-…"; git master
  // reports "ffmpeg version N-119242-…" with no numeric major — leave those unchecked (recent).
  const m = out.match(/version\s+n?(\d+)\.(\d+)/i);
  if (m && Number.parseInt(m[1]!, 10) < MIN_MAJOR_VERSION) {
    throw new KonteError(
      code,
      `${label} at "${bin}" is version ${m[1]}.${m[2]}; konte needs >= ${MIN_MAJOR_VERSION}. ` +
        `Update it, or unset the override to use the konte-managed build.`,
    );
  }
}
