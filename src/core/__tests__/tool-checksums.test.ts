import { describe, expect, it } from "vitest";
import { toolDownloadUrls } from "../../../scripts/lib/tool-download-urls.js";
import { chromiumDownloadUrl } from "../chromium.js";
import { cloudflaredDownloadSource } from "../cloudflared-binary.js";
import { KonteError } from "../errors.js";
import { ffmpegDownloadSources } from "../ffmpeg-binary.js";
import { TOOL_CHECKSUMS, toolChecksum, toolPin } from "../tool-checksums.js";
import { tscDownloadUrl } from "../tsc.js";

// `toolDownloadUrls()` hand-lists the platform/arch each tool builds for, so an omission there
// would silently narrow what the coverage test below checks. Sweep the whole product instead — every
// `NodeJS.Platform` and `NodeJS.Architecture` there is, so a resolver that grows support for one
// cannot grow past the sweep — and ask each resolver itself: whatever it hands back a URL for is a
// download konte can be asked to make, and every one of those must be pinned.
const PLATFORMS: NodeJS.Platform[] = [
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
];
const ARCHS: NodeJS.Architecture[] = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc64",
  "riscv64",
  "s390x",
  "x64",
];

const RESOLVERS: Record<string, (platform: NodeJS.Platform, arch: string) => string[]> = {
  ffmpeg: (platform, arch) => {
    const src = ffmpegDownloadSources(platform, arch);
    return src.kind === "archive" ? [src.url] : [src.ffmpegUrl, src.ffprobeUrl];
  },
  cloudflared: (platform, arch) => [cloudflaredDownloadSource(platform, arch).url],
  tsc: (platform, arch) => [tscDownloadUrl(platform, arch)],
  chromium: (platform, arch) => [chromiumDownloadUrl(platform, arch)],
};

function reachableUrls(): { tool: string; platform: string; url: string }[] {
  const found: { tool: string; platform: string; url: string }[] = [];
  for (const [tool, resolve] of Object.entries(RESOLVERS)) {
    for (const platform of PLATFORMS) {
      for (const arch of ARCHS) {
        let urls: string[];
        try {
          urls = resolve(platform, arch);
        } catch (err) {
          // Only a deliberate refusal means "no build for this platform"; anything else is a bug
          // in the resolver that must not pass as one.
          expect(err, `${tool} ${platform}-${arch}`).toBeInstanceOf(KonteError);
          continue;
        }
        for (const url of urls) found.push({ tool, platform: `${platform}-${arch}`, url });
      }
    }
  }
  return found;
}

describe("tool checksum manifest", () => {
  it("pins every URL any resolver will hand back, across every platform/arch", () => {
    const missing = reachableUrls().filter(({ url }) => !TOOL_CHECKSUMS[url]);
    expect(missing, "run `bun run update:tool-checksums`").toEqual([]);
  });

  it("keeps the regeneration script's target list in step with those resolvers", () => {
    const swept = new Set(reachableUrls().map(({ url }) => url));
    expect([...swept].filter((url) => !toolDownloadUrls().includes(url))).toEqual([]);
  });

  it("carries no entry no platform asks for", () => {
    const reachable = new Set(reachableUrls().map(({ url }) => url));
    expect(Object.keys(TOOL_CHECKSUMS).filter((url) => !reachable.has(url))).toEqual([]);
  });

  it("holds a lowercase sha256 hex digest under every key", () => {
    for (const [url, sha256] of Object.entries(TOOL_CHECKSUMS)) {
      expect(sha256, url).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses a URL it has no pin for", () => {
    expect(() => toolChecksum("https://example.com/evil.tar.xz")).toThrow(KonteError);
    try {
      toolChecksum("https://example.com/evil.tar.xz");
    } catch (err) {
      expect((err as KonteError).code).toBe("CHECKSUM_UNKNOWN");
    }
  });

  it("builds a cache-directory pin from every artifact an install is made of", () => {
    const [a, b] = Object.keys(TOOL_CHECKSUMS);
    expect(toolPin([a!, b!])).toBe(`${TOOL_CHECKSUMS[a!]} ${TOOL_CHECKSUMS[b!]}`);
    expect(toolPin([a!])).not.toBe(toolPin([b!]));
  });
});
