import { describe, expect, it } from "vitest";
import { CLOUDFLARED_VERSION, cloudflaredDownloadSource } from "../cloudflared-binary.js";

describe("cloudflaredDownloadSource", () => {
  it("takes the bare binary on linux and windows, and the tarball macOS publishes", () => {
    expect(cloudflaredDownloadSource("linux", "x64")).toEqual({
      kind: "binary",
      url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    });
    expect(cloudflaredDownloadSource("linux", "arm64").url).toMatch(/cloudflared-linux-arm64$/);
    expect(cloudflaredDownloadSource("win32", "x64").url).toMatch(
      /cloudflared-windows-amd64\.exe$/,
    );
    expect(cloudflaredDownloadSource("darwin", "arm64")).toMatchObject({ kind: "tgz" });
  });

  it("names the override rather than failing bare, where there is no build to fetch", () => {
    expect(() => cloudflaredDownloadSource("linux", "s390x")).toThrow(/KONTE_CLOUDFLARED_PATH/);
    expect(() => cloudflaredDownloadSource("freebsd", "x64")).toThrow(/freebsd-x64/);
  });

  it("pins a version, so an upgrade lands in a fresh cache directory", () => {
    expect(CLOUDFLARED_VERSION).toMatch(/^\d{4}\.\d+\.\d+$/);
  });
});
