import * as fs from "node:fs";
import * as path from "node:path";
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { KonteError, errorMessage } from "./errors.js";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";
import { execFileAsync } from "./exec-file.js";

// Pinned cloudflared release; the version names its tool-cache dir.
const CLOUDFLARED_VERSION = "2026.8.3";

let cloudflaredPath: string | null = null;
let provisioning: Promise<void> | null = null;

/** Absolute path to a usable cloudflared, provisioning the managed build on first use if needed. */
export async function cloudflaredBin(): Promise<string> {
  if (cloudflaredPath) return cloudflaredPath;
  const override = process.env.KONTE_CLOUDFLARED_PATH;
  if (override) {
    cloudflaredPath = override;
    return override;
  }
  const dir = toolCacheDir(`cloudflared-${CLOUDFLARED_VERSION}`);
  const dest = path.join(dir, binName());
  const pin = toolPin([cloudflaredDownloadSource(process.platform, process.arch).url]);
  if (!toolCacheReady(dir, pin, [binName()])) {
    if (!provisioning) provisioning = provision(dir, dest, pin);
    await provisioning;
  }
  cloudflaredPath ??= dest;
  return cloudflaredPath;
}

export { CLOUDFLARED_VERSION };

// The bare binaries are published per platform; macOS ships a gzipped tar holding one.
type CloudflaredSource = { kind: "binary" | "tgz"; url: string };

/** Where each platform/arch fetches its version-pinned cloudflared. Pure (for testing). */
export function cloudflaredDownloadSource(
  platform: NodeJS.Platform,
  arch: string,
): CloudflaredSource {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
  if (platform === "linux") {
    const plat = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
    if (!plat) throw unsupported(platform, arch);
    return { kind: "binary", url: `${base}/cloudflared-linux-${plat}` };
  }
  if (platform === "darwin") {
    const plat = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
    if (!plat) throw unsupported(platform, arch);
    return { kind: "tgz", url: `${base}/cloudflared-darwin-${plat}.tgz` };
  }
  if (platform === "win32" && arch === "x64") {
    return { kind: "binary", url: `${base}/cloudflared-windows-amd64.exe` };
  }
  throw unsupported(platform, arch);
}

function binName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function unsupported(platform: string, arch: string): KonteError {
  return new KonteError(
    "CLOUDFLARED_SETUP_FAILED",
    `No managed cloudflared build for ${platform}-${arch}. ` +
      `Install cloudflared and set KONTE_CLOUDFLARED_PATH.`,
  );
}

async function provision(dir: string, dest: string, pin: string): Promise<void> {
  try {
    await withToolCacheLock(dir, async () => {
      if (toolCacheReady(dir, pin, [binName()])) return; // another process got there first
      await downloadAndUnpack(dir, dest, pin);
    });
  } catch (err) {
    if (err instanceof KonteError) throw err;
    throw new KonteError(
      "CLOUDFLARED_SETUP_FAILED",
      `cloudflared setup failed: ${errorMessage(err)}`,
    );
  }
}

async function downloadAndUnpack(dir: string, dest: string, pin: string): Promise<void> {
  resetToolCacheDir(dir);
  const src = cloudflaredDownloadSource(process.platform, process.arch);
  console.error(`konte: provisioning cloudflared ${CLOUDFLARED_VERSION} → ${dir}`);
  const tmp = fs.mkdtempSync(path.join(dir, ".dl-"));
  try {
    if (src.kind === "binary") {
      await downloadFile(src.url, dest, progressReporter("cloudflared"));
      endProgress();
    } else {
      const archive = path.join(tmp, "cloudflared.tgz");
      await downloadFile(src.url, archive, progressReporter("cloudflared"));
      endProgress();
      await execFileAsync("tar", ["xzf", archive, "-C", tmp]);
      relocate(findBinary(tmp, "cloudflared"), dest);
    }
    fs.chmodSync(dest, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await markToolCacheReady(dir, pin);
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
  throw new KonteError("CLOUDFLARED_SETUP_FAILED", `"${name}" not found in the downloaded archive`);
}

function relocate(src: string, dest: string): void {
  fs.rmSync(dest, { force: true });
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}
