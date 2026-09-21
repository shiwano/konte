import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KonteError } from "../errors.js";
import { BTBN_BUILD, BTBN_TAG, BTBN_VERSION, ffmpegDownloadSources } from "../ffmpeg-binary.js";

vi.mock("../exec-file.js", () => ({ execFileAsync: vi.fn() }));
vi.mock("../download.js", () => ({ downloadFile: vi.fn() }));
vi.mock("../config.js", () => ({ loadKonteConfig: vi.fn().mockResolvedValue({}) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

describe("ffmpegDownloadSources", () => {
  it("maps linux x64 to the BtbN linux64 tarball with both binaries", () => {
    const s = ffmpegDownloadSources("linux", "x64");
    if (s.kind !== "archive") throw new Error("expected archive source");
    expect(s.url).toContain("BtbN/FFmpeg-Builds");
    expect(s.url).toContain(`ffmpeg-${BTBN_BUILD}-linux64-gpl-${BTBN_VERSION}.tar.xz`);
    expect(s).toMatchObject({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
  });

  it("maps linux arm64 to the linuxarm64 tarball", () => {
    const s = ffmpegDownloadSources("linux", "arm64");
    if (s.kind !== "archive") throw new Error("expected archive source");
    expect(s.url).toContain(`ffmpeg-${BTBN_BUILD}-linuxarm64-gpl-${BTBN_VERSION}.tar.xz`);
  });

  it("maps win32 x64 to a zip and .exe binary names", () => {
    const s = ffmpegDownloadSources("win32", "x64");
    if (s.kind !== "archive") throw new Error("expected archive source");
    expect(s.url).toContain(`ffmpeg-${BTBN_BUILD}-win64-gpl-${BTBN_VERSION}.zip`);
    expect(s).toMatchObject({ ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" });
  });

  it("maps darwin arm64 to the eugeneware gzipped binaries", () => {
    const s = ffmpegDownloadSources("darwin", "arm64");
    if (s.kind !== "gzipped") throw new Error("expected gzipped source");
    expect(s.ffmpegUrl).toContain("eugeneware/ffmpeg-static");
    expect(s.ffmpegUrl).toContain("ffmpeg-darwin-arm64.gz");
    expect(s.ffprobeUrl).toContain("ffprobe-darwin-arm64.gz");
    expect(s.version).not.toBe(BTBN_BUILD); // macOS arm64 trails on a separate pin
  });

  it("pins a dated autobuild tag, never the rolling `latest` whose assets are replaced", () => {
    const m = BTBN_TAG.match(/^autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}$/);
    expect(m).not.toBeNull();
    const [year, month, day] = m!.slice(1).map(Number) as [number, number, number];
    // Month-end only: BtbN prunes every other dated tag after about two weeks.
    expect(day).toBe(new Date(Date.UTC(year, month, 0)).getUTCDate());
    const s = ffmpegDownloadSources("linux", "x64");
    if (s.kind !== "archive") throw new Error("expected archive source");
    expect(s.url).toContain(`/download/${BTBN_TAG}/`);
    // The cache dir is named for the build, so a tag-only bump leaves that name alone — what ages
    // the directory out is the readiness marker's pin (see tool-cache.test.ts).
    expect(s.version).toBe(BTBN_BUILD.replace(/^n/, ""));
  });

  it("throws on an Intel mac (unsupported) and on an unknown platform", () => {
    expect(() => ffmpegDownloadSources("darwin", "x64")).toThrow(KonteError);
    expect(() => ffmpegDownloadSources("freebsd" as NodeJS.Platform, "x64")).toThrow(KonteError);
  });
});

describe("ffmpegBin / ffprobeBin resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.KONTE_FFMPEG_PATH;
    delete process.env.KONTE_FFPROBE_PATH;
  });
  afterEach(() => {
    delete process.env.KONTE_FFMPEG_PATH;
    delete process.env.KONTE_FFPROBE_PATH;
  });

  async function load(version = `ffmpeg version ${BTBN_VERSION} Copyright`) {
    const { execFileAsync } = await import("../exec-file.js");
    const { downloadFile } = await import("../download.js");
    const { loadKonteConfig } = await import("../config.js");
    const fs = await import("node:fs");
    const { setWorkspaceRoot } = await import("../workspace-context.js");
    const mod = await import("../ffmpeg-binary.js");
    // The config override is only consulted inside a workspace (that is where konte.config.json
    // lives), so the resolver has nothing to read until a root is set.
    setWorkspaceRoot("/ws");
    (loadKonteConfig as unknown as Mock).mockResolvedValue({});
    (execFileAsync as unknown as Mock).mockResolvedValue({ stdout: version, stderr: "" });
    return {
      mod,
      downloadFile: downloadFile as unknown as Mock,
      loadKonteConfig: loadKonteConfig as unknown as Mock,
      existsSync: fs.existsSync as unknown as Mock,
    };
  }

  it("prefers the KONTE_FFMPEG_PATH override and never downloads", async () => {
    process.env.KONTE_FFMPEG_PATH = "/custom/ffmpeg";
    const { mod, downloadFile } = await load();
    await expect(mod.ffmpegBin()).resolves.toBe("/custom/ffmpeg");
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("rejects an override binary below the minimum version", async () => {
    process.env.KONTE_FFMPEG_PATH = "/old/ffmpeg";
    const { mod } = await load("ffmpeg version 3.4.8-0ubuntu0.2 Copyright");
    // resetModules gives the dynamically-imported module its own KonteError realm, so assert on
    // the stable error code rather than `instanceof` the statically-imported class.
    await expect(mod.ffmpegBin()).rejects.toMatchObject({ code: "FFMPEG_SETUP_FAILED" });
    await expect(mod.ffmpegBin()).rejects.toThrow(/>= 4/);
  });

  it("falls back to a config override when no env var is set", async () => {
    const { mod, loadKonteConfig, downloadFile } = await load();
    loadKonteConfig.mockResolvedValue({ local: { ffprobePath: "/cfg/ffprobe" } });
    await expect(mod.ffprobeBin()).resolves.toBe("/cfg/ffprobe");
    expect(downloadFile).not.toHaveBeenCalled();
  });

  describe("leadPathWithFfmpeg", () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it("leads PATH with the resolved binaries' directory", async () => {
      process.env.KONTE_FFMPEG_PATH = "/custom/bin/ffmpeg";
      process.env.KONTE_FFPROBE_PATH = "/custom/bin/ffprobe";
      process.env.PATH = "/usr/bin";
      const { mod } = await load();
      await mod.leadPathWithFfmpeg();
      expect(process.env.PATH).toBe(`/custom/bin${path.delimiter}/usr/bin`);
    });

    it("adds each distinct directory once, and never re-adds one already on PATH", async () => {
      process.env.KONTE_FFMPEG_PATH = "/a/ffmpeg";
      process.env.KONTE_FFPROBE_PATH = "/b/ffprobe";
      process.env.PATH = `/b${path.delimiter}/usr/bin`;
      const { mod } = await load();
      await mod.leadPathWithFfmpeg();
      expect(process.env.PATH).toBe(`/a${path.delimiter}/b${path.delimiter}/usr/bin`);
    });

    it("leaves PATH alone for a bare-name override — that is already a PATH lookup", async () => {
      process.env.KONTE_FFMPEG_PATH = "ffmpeg";
      process.env.KONTE_FFPROBE_PATH = "ffprobe";
      process.env.PATH = "/usr/bin";
      const { mod } = await load();
      await mod.leadPathWithFfmpeg();
      expect(process.env.PATH).toBe("/usr/bin");
    });

    it("leaves PATH alone for a renamed override — no lookup would reach it anyway", async () => {
      process.env.KONTE_FFMPEG_PATH = "/opt/bin/ffmpeg-7";
      process.env.KONTE_FFPROBE_PATH = "/opt/bin/ffprobe-7";
      process.env.PATH = "/usr/bin";
      const { mod } = await load();
      await mod.leadPathWithFfmpeg();
      expect(process.env.PATH).toBe("/usr/bin");
    });
  });

  it("reports override / cached / pending status without downloading", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const cache = realFs.mkdtempSync(path.join(os.tmpdir(), "konte-ffmpeg-status-"));
    const previousCache = process.env.KONTE_CACHE_DIR;
    process.env.KONTE_CACHE_DIR = cache;
    process.env.KONTE_FFMPEG_PATH = "/custom/ffmpeg";
    try {
      const { mod, downloadFile, existsSync } = await load();
      // The readiness check asks the real filesystem about the real cache dir built below.
      existsSync.mockImplementation(realFs.existsSync);
      const { toolPin } = await import("../tool-checksums.js");
      const { markToolCacheReady } = await import("../tool-cache.js");
      const version = BTBN_BUILD.replace(/^n/, "");
      const dir = path.join(cache, `ffmpeg-${version}`);

      // A directory full of plausible binaries is NOT a cache hit — only a finished install,
      // stamped with the pin it was verified against, is.
      realFs.mkdirSync(dir, { recursive: true });
      realFs.writeFileSync(path.join(dir, "ffmpeg"), "");
      realFs.writeFileSync(path.join(dir, "ffprobe"), "");
      const unmarked = await mod.ffmpegToolStatus();
      expect(unmarked.ffprobe.source).toBe("pending");

      const src = mod.ffmpegDownloadSources("linux", "x64");
      if (src.kind !== "archive") throw new Error("expected archive source");
      await markToolCacheReady(dir, toolPin([src.url]));

      const status = await mod.ffmpegToolStatus();
      expect(status.ffmpeg).toEqual({ source: "override", path: "/custom/ffmpeg", version: "" });
      expect(status.ffprobe.source).toBe("cached");
      expect(status.ffprobe.path).toContain(`ffmpeg-${version}`);
      expect(status.ffprobe.version).toBe(version);

      // A binary deleted under a still-current mark is not a cache konte may report as ready.
      realFs.rmSync(path.join(dir, "ffprobe"));
      expect((await mod.ffmpegToolStatus()).ffprobe.source).toBe("pending");
      realFs.writeFileSync(path.join(dir, "ffprobe"), "");

      // A mark left by some other pin ages out with it.
      await markToolCacheReady(dir, "some other pin");
      expect((await mod.ffmpegToolStatus()).ffprobe.source).toBe("pending");
      expect(downloadFile).not.toHaveBeenCalled();
    } finally {
      if (previousCache === undefined) delete process.env.KONTE_CACHE_DIR;
      else process.env.KONTE_CACHE_DIR = previousCache;
      realFs.rmSync(cache, { recursive: true, force: true });
    }
  });
});
