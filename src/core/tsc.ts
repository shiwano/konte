import * as fs from "node:fs";
import * as path from "node:path";
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { KonteError, errorMessage } from "./errors.js";
import { VIDEO_MARKER, VIDEO_NAME_PATTERN, VIDEOS_DIR } from "./roots.js";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";
import { execFileAsync } from "./exec-file.js";

const TSC_VERSION = "7.0.2";

export { TSC_VERSION };

let tscPath: string | null = null;
let provisioning: Promise<void> | null = null;

/** Where each platform/arch fetches its version-pinned tsc. Pure (for testing). */
export function tscDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  // `arm` (32-bit) ships for linux only; @typescript publishes no darwin-arm or win32-arm package.
  const archs: Partial<Record<NodeJS.Platform, string[]>> = {
    linux: ["x64", "arm64", "arm"],
    darwin: ["x64", "arm64"],
    win32: ["x64", "arm64"],
  };
  if (!archs[platform]?.includes(arch)) {
    throw new KonteError("TSC_SETUP_FAILED", `Unsupported platform: ${platform}-${arch}`);
  }
  const pkg = `typescript-${platform}-${arch}`;
  return `https://registry.npmjs.org/@typescript/${pkg}/-/${pkg}-${TSC_VERSION}.tgz`;
}

interface TypeDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

interface TypeCheckResult {
  success: boolean;
  errorCount: number;
  output: string;
  diagnostics: TypeDiagnostic[];
  /** Diagnostics belonging to a video other than the one in scope — reported, never fatal. */
  otherVideos: TypeDiagnostic[];
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const DIAGNOSTIC_PATTERN = /^(.+?)(?::(\d+):(\d+) -|\((\d+),(\d+)\):) error (TS\d+): (.+)$/;

function parseDiagnostics(output: string): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = [];
  for (const raw of output.replace(ANSI_PATTERN, "").split("\n")) {
    const m = raw.match(DIAGNOSTIC_PATTERN);
    if (!m) continue;
    diagnostics.push({
      file: m[1]!,
      line: Number.parseInt((m[2] ?? m[4])!, 10),
      column: Number.parseInt((m[3] ?? m[5])!, 10),
      code: m[6]!,
      message: m[7]!,
    });
  }
  return diagnostics;
}

/**
 * Type-checks the whole workspace — every video, plus `adapters/` — from the workspace tsconfig.
 *
 * Only diagnostics that belong to the video in scope (or to shared workspace code) are fatal. A
 * broken `videos/ending/video.tsx` must not stop a command run against `videos/opening`, so its
 * diagnostics come back under `otherVideos` for the caller to mention and move on. Pass
 * `videoRoot: null` for a workspace-scoped command: then no single video's errors are fatal.
 */
export async function typeCheckWorkspace(
  workspaceRoot: string,
  videoRoot: string | null,
): Promise<TypeCheckResult> {
  const tscBin = await ensureTsc();

  const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    const { loadManagedTemplateContents } = await import("./generated/template-assets.js");
    const content = (await loadManagedTemplateContents())["tsconfig.json"];
    if (content) fs.writeFileSync(tsconfigPath, content, "utf-8");
  }

  // Incremental against a workspace-local build-info file: this check runs on every CLI
  // invocation, and a cold whole-workspace pass grows with the project while a warm one only
  // re-checks what changed. Verified against the managed native build: an unchanged broken
  // project keeps exiting non-zero and re-printing its diagnostics, so the gate stays sound.
  const buildInfoPath = path.join(workspaceRoot, ".konte", "tsc.tsbuildinfo");
  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });

  try {
    await execFileAsync(
      tscBin,
      ["--noEmit", "--pretty", "--incremental", "--tsBuildInfoFile", buildInfoPath],
      { cwd: workspaceRoot },
    );
    return { success: true, errorCount: 0, output: "", diagnostics: [], otherVideos: [] };
  } catch (err) {
    const stdout = err instanceof Error && "stdout" in err ? String(err.stdout) : "";
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
    const output = (stdout + stderr).trim();
    if (!output) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
      const signal = err instanceof Error && "signal" in err ? err.signal : null;
      throw new KonteError(
        "TSC_SETUP_FAILED",
        `tsc execution failed (code: ${code}${signal ? `, signal: ${signal}` : ""}): ${errorMessage(err)}`,
      );
    }

    const all = parseDiagnostics(output);
    const otherVideos = all.filter((d) => isOtherVideo(d.file, workspaceRoot, videoRoot));
    const diagnostics = all.filter((d) => !otherVideos.includes(d));

    // tsc's own "Found N errors" counts every video; report only what is fatal here. It can still
    // fail with no parseable diagnostic (a config error), so an empty parse means one real error.
    const errorCount = all.length === 0 ? 1 : diagnostics.length;
    return { success: errorCount === 0, errorCount, output, diagnostics, otherVideos };
  }
}

// A diagnostic is demoted only when it belongs to another *video* — a directory under `videos/`
// that is really one (a legal name, carrying a state file). A half-made `videos/scratch/` that no
// command can select is nobody's sibling, so its errors stay fatal rather than being waved
// through as "some other video's problem".
function isOtherVideo(file: string, workspaceRoot: string, videoRoot: string | null): boolean {
  const rel = path.relative(
    path.join(workspaceRoot, VIDEOS_DIR),
    path.resolve(workspaceRoot, file),
  );
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;

  const name = rel.split(path.sep)[0]!;
  if (!VIDEO_NAME_PATTERN.test(name)) return false;

  const owner = path.join(workspaceRoot, VIDEOS_DIR, name);
  if (!fs.existsSync(path.join(owner, VIDEO_MARKER))) return false;

  return videoRoot === null || path.resolve(owner) !== path.resolve(videoRoot);
}

/**
 * Absolute path to a usable tsc, provisioning the managed native build on first use if needed.
 *
 * `KONTE_TSC_PATH` overrides it with a local binary, skipping the download. The type-check passes
 * `--noEmit --pretty` (which the JS `tsc` also accepts), while `konte lsp` passes `--lsp -stdio`
 * (the native TypeScript 7 build only).
 */
export async function ensureTsc(): Promise<string> {
  if (tscPath) return tscPath;

  const override = process.env.KONTE_TSC_PATH;
  if (override) {
    tscPath = override;
    return override;
  }

  const url = tscDownloadUrl(process.platform, process.arch);
  const cacheDir = toolCacheDir(`tsc-${TSC_VERSION}`);
  const tscBin = path.join(cacheDir, process.platform === "win32" ? "tsc.exe" : "tsc");
  const pin = toolPin([url]);

  if (!toolCacheReady(cacheDir, pin, [path.basename(tscBin)])) {
    if (!provisioning) provisioning = provisionTsc(url, cacheDir, tscBin, pin);
    await provisioning;
  }

  tscPath = tscBin;
  return tscBin;
}

async function provisionTsc(
  url: string,
  cacheDir: string,
  tscBin: string,
  pin: string,
): Promise<void> {
  try {
    await withToolCacheLock(cacheDir, async () => {
      if (toolCacheReady(cacheDir, pin, [path.basename(tscBin)])) return; // another process got there first
      await downloadAndUnpack(url, cacheDir, tscBin, pin);
    });
  } catch (err) {
    if (err instanceof KonteError) throw err;
    const message = errorMessage(err);
    throw new KonteError("TSC_SETUP_FAILED", `tsc setup failed: ${message}`);
  }
}

async function downloadAndUnpack(
  url: string,
  cacheDir: string,
  tscBin: string,
  pin: string,
): Promise<void> {
  resetToolCacheDir(cacheDir);

  console.error(`konte: provisioning tsc ${TSC_VERSION} → ${cacheDir}`);
  const tarPath = path.join(cacheDir, "tsc.tgz");
  await downloadFile(url, tarPath, progressReporter("tsc"));
  endProgress();

  await execFileAsync("tar", ["xzf", tarPath, "-C", cacheDir]);

  const extractedDir = path.join(cacheDir, "package", "lib");
  for (const entry of fs.readdirSync(extractedDir)) {
    fs.renameSync(path.join(extractedDir, entry), path.join(cacheDir, entry));
  }

  fs.chmodSync(tscBin, 0o755);

  fs.rmSync(tarPath);
  fs.rmSync(path.join(cacheDir, "package"), { recursive: true });

  await markToolCacheReady(cacheDir, pin);
}
