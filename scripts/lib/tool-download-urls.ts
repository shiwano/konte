import { chromiumDownloadUrl } from "../../src/core/chromium.js";
import { cloudflaredDownloadSource } from "../../src/core/cloudflared-binary.js";
import { ffmpegDownloadSources } from "../../src/core/ffmpeg-binary.js";
import { tscDownloadUrl } from "../../src/core/tsc.js";

type Target = { platform: NodeJS.Platform; arch: string };

// Every platform/arch each tool ships a managed build for. A combination a tool has no build for is
// absent here rather than skipped: the resolver already fails with its own "install it yourself"
// message, and a manifest entry with no artifact behind it would go stale unnoticed.
const FFMPEG_TARGETS: Target[] = [
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
  { platform: "darwin", arch: "arm64" },
];
const CLOUDFLARED_TARGETS: Target[] = [
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];
const TSC_TARGETS: Target[] = [
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "arm" },
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
];
// linux-arm64 resolves to the same linux64 archive — puppeteer has no arm64 Chrome for Testing
// build and falls back to it, so it dedupes into one entry.
const CHROMIUM_TARGETS: Target[] = [
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];

/** Every managed-tool artifact URL konte can ask for, across all supported platforms. */
export function toolDownloadUrls(): string[] {
  const urls: string[] = [];
  for (const { platform, arch } of FFMPEG_TARGETS) {
    const src = ffmpegDownloadSources(platform, arch);
    if (src.kind === "archive") urls.push(src.url);
    else urls.push(src.ffmpegUrl, src.ffprobeUrl);
  }
  for (const { platform, arch } of CLOUDFLARED_TARGETS) {
    urls.push(cloudflaredDownloadSource(platform, arch).url);
  }
  for (const { platform, arch } of TSC_TARGETS) urls.push(tscDownloadUrl(platform, arch));
  for (const { platform, arch } of CHROMIUM_TARGETS) urls.push(chromiumDownloadUrl(platform, arch));
  return [...new Set(urls)];
}
