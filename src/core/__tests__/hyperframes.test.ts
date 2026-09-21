import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KonteError } from "../errors.js";

vi.mock("@hyperframes/producer", () => ({
  createRenderJob: vi.fn().mockReturnValue({ id: "mock-job", warnings: [] }),
  executeRenderJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../chromium.js", () => ({
  ensureChromium: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../hyperframes-env.js", () => ({
  ensureHyperFramesEnv: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue("/tmp/konte-hf-mock"),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    symlink: vi.fn().mockResolvedValue(undefined),
    link: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import * as fsPromises from "node:fs/promises";
import * as hfProducer from "@hyperframes/producer";
import { compositeWithHyperFrames, ensureHyperFrames } from "../hyperframes.js";

const createRenderJobMock = hfProducer.createRenderJob as unknown as Mock;
const executeRenderJobMock = hfProducer.executeRenderJob as unknown as Mock;

beforeEach(() => {
  vi.resetAllMocks();

  createRenderJobMock.mockReturnValue({ id: "mock-job", warnings: [] });
  executeRenderJobMock.mockResolvedValue(undefined);

  (fsPromises.mkdir as Mock).mockResolvedValue(undefined);
  (fsPromises.mkdtemp as Mock).mockResolvedValue("/tmp/konte-hf-mock");
  (fsPromises.readFile as Mock).mockResolvedValue("");
  (fsPromises.writeFile as Mock).mockResolvedValue(undefined);
  (fsPromises.symlink as Mock).mockResolvedValue(undefined);
  (fsPromises.link as Mock).mockResolvedValue(undefined);
  (fsPromises.copyFile as Mock).mockResolvedValue(undefined);
  (fsPromises.rm as Mock).mockResolvedValue(undefined);
});

describe("ensureHyperFrames", () => {
  it("succeeds when @hyperframes/producer is available", async () => {
    await expect(ensureHyperFrames()).resolves.toBeUndefined();
  });
});

describe("compositeWithHyperFrames", () => {
  const sampleHtml = "<!doctype html><html><body>test</body></html>";

  it("writes compositionHtml to workspace and symlinks assets", async () => {
    await compositeWithHyperFrames({
      videoRoot: "/video",
      compositionHtml: sampleHtml,
      assetFiles: { "video.mp4": "/assets/video.mp4", "audio.wav": "/assets/audio.wav" },
      outputFile: "/output/shot.mp4",
      fps: 30,
      size: { width: 1920, height: 1080 },
      duration: 5,
      quality: "draft",
    });

    expect(fsPromises.mkdtemp).toHaveBeenCalledWith("/video/.konte/cache/capture/render-");
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      "/tmp/konte-hf-mock/index.html",
      sampleHtml,
      "utf-8",
    );
    expect(fsPromises.symlink).toHaveBeenCalledWith(
      "/assets/video.mp4",
      "/tmp/konte-hf-mock/video.mp4",
    );
    expect(fsPromises.symlink).toHaveBeenCalledWith(
      "/assets/audio.wav",
      "/tmp/konte-hf-mock/audio.wav",
    );
  });

  it.each(["EPERM", "EACCES"])(
    "renders with hard-linked assets when symlink fails with %s",
    async (code) => {
      (fsPromises.symlink as Mock).mockRejectedValueOnce(Object.assign(new Error(code), { code }));

      await compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: { "motion.mp4": "/assets/motion.mp4" },
        outputFile: "/output/shot.mp4",
        fps: 30,
        size: { width: 1920, height: 1080 },
        duration: 5,
        quality: "draft",
      });

      expect(fsPromises.link).toHaveBeenCalledWith(
        "/assets/motion.mp4",
        "/tmp/konte-hf-mock/motion.mp4",
      );
      expect(fsPromises.copyFile).not.toHaveBeenCalled();
      expect(executeRenderJobMock).toHaveBeenCalled();
    },
  );

  it.each(["EXDEV", "EPERM"])(
    "renders with copied assets when the hard link also fails with %s",
    async (code) => {
      (fsPromises.symlink as Mock).mockRejectedValueOnce(
        Object.assign(new Error("EPERM"), { code: "EPERM" }),
      );
      (fsPromises.link as Mock).mockRejectedValueOnce(Object.assign(new Error(code), { code }));

      await compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: { "motion.mp4": "/assets/shot.02.motion#delivery/take with spaces.mp4" },
        outputFile: "/output/shot.mp4",
        fps: 30,
        size: { width: 1920, height: 1080 },
        duration: 5,
        quality: "draft",
      });

      expect(fsPromises.copyFile).toHaveBeenCalledWith(
        "/assets/shot.02.motion#delivery/take with spaces.mp4",
        "/tmp/konte-hf-mock/motion.mp4",
      );
      expect(executeRenderJobMock).toHaveBeenCalled();
      expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-hf-mock", {
        recursive: true,
        force: true,
      });
    },
  );

  it.each(["symlink", "copyFile"] as const)(
    "reports %s failures and cleans up without rendering",
    async (operation) => {
      if (operation === "copyFile") {
        (fsPromises.symlink as Mock).mockRejectedValueOnce(
          Object.assign(new Error("permission denied"), { code: "EPERM" }),
        );
        (fsPromises.link as Mock).mockRejectedValueOnce(
          Object.assign(new Error("cross-device link"), { code: "EXDEV" }),
        );
      }
      (fsPromises[operation] as Mock).mockRejectedValueOnce(
        Object.assign(new Error("asset unavailable"), { code: "ENOENT" }),
      );

      await expect(
        compositeWithHyperFrames({
          videoRoot: "/video",
          compositionHtml: sampleHtml,
          assetFiles: { "motion.mp4": "/assets/motion.mp4" },
          outputFile: "/output/shot.mp4",
          fps: 30,
          size: { width: 1920, height: 1080 },
          duration: 5,
          quality: "draft",
        }),
      ).rejects.toMatchObject({
        code: "HYPERFRAMES_ERROR",
        message: "HyperFrames render failed: asset unavailable",
      });

      if (operation === "symlink") {
        expect(fsPromises.link).not.toHaveBeenCalled();
        expect(fsPromises.copyFile).not.toHaveBeenCalled();
      }
      expect(executeRenderJobMock).not.toHaveBeenCalled();
      expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-hf-mock", {
        recursive: true,
        force: true,
      });
    },
  );

  it("calls createRenderJob and executeRenderJob with correct params", async () => {
    await compositeWithHyperFrames({
      videoRoot: "/video",
      compositionHtml: sampleHtml,
      assetFiles: { "video.mp4": "/assets/video.mp4", "audio.wav": "/assets/audio.wav" },
      outputFile: "/output/shot.mp4",
      fps: 30,
      size: { width: 1920, height: 1080 },
      duration: 5,
      quality: "standard",
    });

    expect(createRenderJobMock).toHaveBeenCalledWith({
      fps: 30,
      quality: "standard",
      entryFile: "index.html",
    });
    expect(executeRenderJobMock).toHaveBeenCalledWith(
      { id: "mock-job", warnings: [] },
      "/tmp/konte-hf-mock",
      "/output/shot.mp4",
    );
  });

  it("passes fps through unchanged", async () => {
    for (const fps of [24, 25, 30, 60]) {
      createRenderJobMock.mockClear();
      await compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: { "video.mp4": "/assets/video.mp4", "audio.wav": "/assets/audio.wav" },
        outputFile: "/output/shot.mp4",
        fps,
        size: { width: 1920, height: 1080 },
        duration: 5,
        quality: "draft",
      });
      expect(createRenderJobMock).toHaveBeenCalledWith(expect.objectContaining({ fps }));
    }
  });

  it("routes render diagnostics to each shot's log without console output", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const starts: Array<() => void> = [];
    const started = [0, 1].map(() => new Promise<void>((resolve) => starts.push(resolve)));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    createRenderJobMock.mockImplementation((config) => ({ config, warnings: [] }));
    executeRenderJobMock.mockImplementation(async (job) => {
      starts.shift()!();
      await gate;
      job.config.logger.info("[Render:trace]", { phase: "capture", frames: 30 });
      job.config.logger.warn("retry", { url: "https://user:secret@host/frame?token=hidden" });
      job.config.logger.error("capture failed");
      job.config.logger.debug("diagnostics", { detail: "x".repeat(600) });
      console.error("[Compiler] Inlined CDN script: https://host/script?token=hidden");
      console.log("[BrowserManager] Browser launched");
    });
    const logs = [vi.fn(), vi.fn()];
    try {
      const render = (i: number) =>
        compositeWithHyperFrames({
          videoRoot: "/video",
          compositionHtml: sampleHtml,
          assetFiles: {},
          outputFile: `/output/shot-${i}.mp4`,
          fps: 30,
          size: { width: 1920, height: 1080 },
          duration: 1,
          quality: "draft",
          onLog: logs[i],
        });
      // Vitest's manual mocks share an import callstack; overlap renders after each import settles.
      const first = render(0);
      await started[0];
      const second = render(1);
      await started[1];
      release();
      await Promise.all([first, second]);
      for (const [i, log] of logs.entries()) {
        expect(log).toHaveBeenCalledTimes(6);
        expect(log).toHaveBeenCalledWith(
          `[shot-${i}.mp4] info: [Render:trace] {"phase":"capture","frames":30}`,
        );
        expect(log).toHaveBeenCalledWith(
          `[shot-${i}.mp4] warn: retry {"url":"https://host/frame"}`,
        );
        expect(log).toHaveBeenCalledWith(`[shot-${i}.mp4] error: capture failed`);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("x".repeat(600)));
        expect(log).toHaveBeenCalledWith(
          `[shot-${i}.mp4] error: [Compiler] Inlined CDN script: https://host/script`,
        );
        expect(log).toHaveBeenCalledWith(`[shot-${i}.mp4] log: [BrowserManager] Browser launched`);
      }
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      release();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("preserves unrelated console output and restores console after a render fails", async () => {
    const original = console.log;
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const onLog = vi.fn();
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executeRenderJobMock.mockImplementation(async () => {
      started();
      await gate;
      console.log("render detail");
      throw new Error("render failed");
    });
    try {
      const render = compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: {},
        outputFile: "/output/shot.mp4",
        fps: 30,
        size: { width: 320, height: 180 },
        duration: 1,
        quality: "draft",
        onLog,
      });
      await ready;
      console.log("other job completed");
      expect(output).toHaveBeenCalledWith("other job completed");
      expect(onLog).not.toHaveBeenCalled();
      console.log("[HyperFrames] runtime ready");
      expect(onLog).toHaveBeenCalledWith(
        "[shot.mp4] shared browser log: [HyperFrames] runtime ready",
      );
      release();
      await expect(render).rejects.toThrow("render failed");
      expect(onLog).toHaveBeenCalledWith("[shot.mp4] log: render detail");
      expect(console.log).toBe(output);
    } finally {
      release();
      output.mockRestore();
      expect(console.log).toBe(original);
    }
  });

  it("cleans up workspace after completion", async () => {
    await compositeWithHyperFrames({
      videoRoot: "/video",
      compositionHtml: sampleHtml,
      assetFiles: { "video.mp4": "/assets/video.mp4", "audio.wav": "/assets/audio.wav" },
      outputFile: "/output/shot.mp4",
      fps: 30,
      size: { width: 1920, height: 1080 },
      duration: 5,
      quality: "draft",
    });

    expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-hf-mock", {
      recursive: true,
      force: true,
    });
  });

  it("cleans up workspace even on error", async () => {
    executeRenderJobMock.mockRejectedValueOnce(new Error("render failed"));

    await expect(
      compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: { "video.mp4": "/assets/video.mp4", "audio.wav": "/assets/audio.wav" },
        outputFile: "/output/shot.mp4",
        fps: 30,
        size: { width: 1920, height: 1080 },
        duration: 5,
        quality: "draft",
      }),
    ).rejects.toThrow(KonteError);

    expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-hf-mock", {
      recursive: true,
      force: true,
    });
  });

  it("returns the warnings a best-effort render completed with", async () => {
    createRenderJobMock.mockReturnValue({
      id: "mock-job",
      warnings: [
        {
          code: "media_readiness_timeout",
          message: "video 'motion' never reached readyState 4",
          stage: "capture-readiness",
        },
      ],
    });

    const warnings = await compositeWithHyperFrames({
      videoRoot: "/video",
      compositionHtml: sampleHtml,
      assetFiles: {},
      outputFile: "/output/shot.mp4",
      fps: 30,
      size: { width: 1920, height: 1080 },
      duration: 5,
      quality: "draft",
    });

    expect(warnings).toEqual([
      "render (shot.mp4): media_readiness_timeout — video 'motion' never reached readyState 4",
    ]);
  });

  it("returns no warnings for a clean render", async () => {
    await expect(
      compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: {},
        outputFile: "/output/shot.mp4",
        fps: 30,
        size: { width: 1920, height: 1080 },
        duration: 5,
        quality: "draft",
      }),
    ).resolves.toEqual([]);
  });

  it("throws HYPERFRAMES_ERROR on render failure", async () => {
    executeRenderJobMock.mockRejectedValueOnce(new Error("Chrome crashed"));

    await expect(
      compositeWithHyperFrames({
        videoRoot: "/video",
        compositionHtml: sampleHtml,
        assetFiles: { "video.mp4": "/assets/video.mp4", "audio.wav": "/assets/audio.wav" },
        outputFile: "/output/shot.mp4",
        fps: 30,
        size: { width: 1920, height: 1080 },
        duration: 5,
        quality: "draft",
      }),
    ).rejects.toThrow("HyperFrames render failed");
  });
});
