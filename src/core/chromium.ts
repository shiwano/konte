import * as path from "node:path";
import {
  Browser,
  BrowserPlatform,
  computeExecutablePath,
  getDownloadUrl,
  install,
} from "@puppeteer/browsers";
import { endProgress, progressReporter } from "./download-progress.js";
import { KonteError, errorMessage } from "./errors.js";
import { toolChecksum, toolPin } from "./tool-checksums.js";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "./tool-cache.js";

// Not a free choice: HyperFrames drives the shell over CDP through its own puppeteer, so this must
// be the revision that puppeteer pins (PUPPETEER_REVISIONS). Copied rather than read at runtime —
// the compiled binary freezes puppeteer at build time, so a runtime read of an `@internal` path
// would buy nothing and fail on the user's machine if it ever moved. chromium.test.ts asserts the
// copy instead, so a producer bump that carries a new puppeteer fails there.
const CHROMIUM_BUILD_ID = "151.0.7922.71";

let chromiumPath: string | null = null;
let provisioning: Promise<string> | null = null;

export { CHROMIUM_BUILD_ID };

const PUPPETEER_PLATFORMS: Record<string, BrowserPlatform> = {
  "linux-x64": BrowserPlatform.LINUX,
  "linux-arm64": BrowserPlatform.LINUX_ARM,
  "darwin-x64": BrowserPlatform.MAC,
  "darwin-arm64": BrowserPlatform.MAC_ARM,
  "win32-x64": BrowserPlatform.WIN64,
};

/** Where each platform/arch fetches its pinned chrome-headless-shell archive. Pure (for testing). */
export function chromiumDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  const target = PUPPETEER_PLATFORMS[`${platform}-${arch}`];
  if (!target) {
    throw new KonteError(
      "CHROMIUM_SETUP_FAILED",
      `No managed chrome-headless-shell build for ${platform}-${arch}. ` +
        `Install Chrome/Chromium and set KONTE_CHROMIUM_PATH.`,
    );
  }
  return getDownloadUrl(Browser.CHROMEHEADLESSSHELL, target, CHROMIUM_BUILD_ID).toString();
}

/**
 * Absolute path to a usable chrome-headless-shell, provisioning the managed build on first use if
 * needed. `KONTE_CHROMIUM_PATH` overrides it with a local binary, skipping the download.
 *
 * Also exported through `PRODUCER_HEADLESS_SHELL_PATH`, since HyperFrames resolves the browser
 * itself and reads that env var before falling back to puppeteer's own `~/.cache/puppeteer` —
 * a cache only `bun install` fills, so a released konte binary would find nothing there.
 */
export async function ensureChromium(): Promise<string> {
  if (chromiumPath) return chromiumPath;

  const override = process.env.KONTE_CHROMIUM_PATH;
  if (override) {
    chromiumPath = override;
    process.env.PRODUCER_HEADLESS_SHELL_PATH = override;
    return override;
  }

  if (!provisioning) provisioning = provision();
  chromiumPath = await provisioning;
  process.env.PRODUCER_HEADLESS_SHELL_PATH = chromiumPath;
  return chromiumPath;
}

async function provision(): Promise<string> {
  const cacheDir = toolCacheDir(`chromium-${CHROMIUM_BUILD_ID}`);
  const options = {
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: CHROMIUM_BUILD_ID,
    cacheDir,
  } as const;

  try {
    const url = chromiumDownloadUrl(process.platform, process.arch);
    const pin = toolPin([url]);
    const cached = computeExecutablePath(options);
    const files = [path.relative(cacheDir, cached)];
    if (toolCacheReady(cacheDir, pin, files)) return cached;

    return await withToolCacheLock(cacheDir, async () => {
      if (toolCacheReady(cacheDir, pin, files)) return cached; // another process got there first

      console.error(`konte: provisioning chromium ${CHROMIUM_BUILD_ID} → ${cacheDir}`);
      // @puppeteer/browsers owns this download, so the archive is verified through its own
      // `expectedHash` rather than konte's downloadFile. A mismatch deletes the archive and throws.
      // It skips that check entirely for an archive already on disk, so clear the directory first:
      // a download killed mid-write would otherwise be extracted unverified.
      resetToolCacheDir(cacheDir);
      const installed = await install({
        ...options,
        expectedHash: toolChecksum(url),
        downloadProgressCallback: progressReporter("chromium"),
      });
      endProgress();
      await markToolCacheReady(cacheDir, pin);
      return installed.executablePath;
    });
  } catch (err) {
    if (err instanceof KonteError) throw err;
    const message = errorMessage(err);
    throw new KonteError(
      "CHROMIUM_SETUP_FAILED",
      `Chromium setup failed: ${message}. ` +
        `Install Chrome/Chromium and set KONTE_CHROMIUM_PATH to use it instead.`,
    );
  }
}
