import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@hyperframes/producer", () => ({
  createFileServer: vi.fn(),
  createCaptureSession: vi.fn(),
  initializeSession: vi.fn(),
  captureFrame: vi.fn(),
  closeCaptureSession: vi.fn(),
  createVideoFrameInjector: vi.fn(),
  quantizeTimeToFrame: (time: number, fps: number) => Math.floor(time * fps + 1e-9) / fps,
}));

vi.mock("../hyperframes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hyperframes.js")>()),
  ensureHyperFrames: vi.fn().mockResolvedValue(undefined),
  silenceHyperFramesLogs: () => () => {},
}));

const composition = vi.hoisted(() => ({
  html: '<html><body><img data-start="0" data-duration="1.75" /></body></html>',
}));

vi.mock("../composition-builder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../composition-builder.js")>()),
  buildShotCompositionHtml: () => ({
    html: composition.html,
    size: { width: 1248, height: 704 },
    fps: 24,
  }),
  compositionDrawsSomething: () => true,
}));

vi.mock("../composition-resource.js", () => ({
  compositionInputFingerprints: () => ({}),
  pictureRefsOf: () => [],
  unresolvedPictureRefs: () => [],
}));

const extractedFrames = vi.hoisted(() => ({ present: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) =>
      (extractedFrames.present && String(p).includes("/.frames/")) || actual.existsSync(p),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue("/tmp/konte-cap-mock"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    symlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import * as hfProducer from "@hyperframes/producer";
import type { StateManager } from "../state/index.js";
import { captureCompositionFrames } from "../thumbnail.js";
import type { StageDefinition } from "../types/index.js";

const createFileServerMock = hfProducer.createFileServer as unknown as Mock;
const createCaptureSessionMock = hfProducer.createCaptureSession as unknown as Mock;
const captureFrameMock = hfProducer.captureFrame as unknown as Mock;

const video = {
  stage: "animatic",
  format: { fps: 24, size: { width: 1248, height: 704 } },
  shots: [{ id: "01", duration: 3.5, action: "", assets: {}, shotFn: () => null }],
} as unknown as StageDefinition;

const manager = { getState: () => ({ assets: {} }) } as unknown as StateManager;
const defaultHtml = composition.html;

beforeEach(() => {
  vi.clearAllMocks();
  composition.html = defaultHtml;
  extractedFrames.present = false;
  createFileServerMock.mockResolvedValue({ url: "http://127.0.0.1:1234", close: vi.fn() });
  createCaptureSessionMock.mockResolvedValue({ id: "mock-session", warnings: [] });
  captureFrameMock.mockResolvedValue({ path: "/tmp/konte-cap-mock/frame_000000.jpg" });
});

describe("captureCompositionFrames", () => {
  // The page-side runtime quantizes every seek onto its own fps grid and falls back to 30 when the
  // server names none — which rounds a 24fps panel's start back over the cut before it, so the
  // frame captured FOR a keyframe is the one it cuts away from.
  it("serves the composition at its own fps, so a seek lands on the frame it asked for", async () => {
    await captureCompositionFrames({
      video,
      manager,
      shotId: "01",
      videoRoot: "/video",
      outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
      captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
    });

    expect(createFileServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ fps: { num: 24, den: 1 } }),
    );
    expect(createCaptureSessionMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234",
      expect.any(String),
      expect.objectContaining({ fps: { num: 24, den: 1 } }),
      undefined,
    );
  });

  // The producer names frames by session index, so two runs capturing into the shared cache dir
  // renamed each other's `frame_NNNNNN` away (ENOENT).
  it("captures into its own dir inside the cache dir and moves each frame into place", async () => {
    const fsp = await import("node:fs/promises");
    const mkdtempMock = fsp.mkdtemp as unknown as Mock;
    mkdtempMock.mockImplementation(async (prefix: string) => `${prefix}run`);
    captureFrameMock.mockImplementation(async (_session: unknown, index: number) => ({
      path: `${(createCaptureSessionMock.mock.calls[0] as [string, string])[1]}/frame_${index}.jpg`,
    }));

    const outputDir = "/video/.konte/cache/thumbnails/animatic/shot.01";
    const [frame] = await captureCompositionFrames({
      video,
      manager,
      shotId: "01",
      videoRoot: "/video",
      outputDir,
      captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
    });

    const cacheDir = `/video/${frame!.file.slice(0, frame!.file.lastIndexOf("/"))}`;
    const captureDir = (createCaptureSessionMock.mock.calls[0] as [string, string])[1];
    expect(captureDir).toBe(`${cacheDir}/.capture-run`);
    expect(fsp.rename).toHaveBeenCalledWith(
      `${captureDir}/frame_0.jpg`,
      `${cacheDir}/at-00001750ms.jpg`,
    );
    expect(fsp.rm).toHaveBeenCalledWith(captureDir, { recursive: true, force: true });
  });

  it("refuses a session whose media failed to load, caching no frame", async () => {
    const fsp = await import("node:fs/promises");
    createCaptureSessionMock.mockResolvedValue({
      id: "mock-session",
      warnings: [
        {
          code: "media_load_failed",
          message: "video media failed to load before capture",
          details: { sources: ["http://localhost:1234/video/shot.01.motion/v-1/clip%201.mp4"] },
        },
        {
          code: "media_readiness_timeout",
          message: "image media did not become capture-ready within 45000ms",
          details: { sources: ["http://localhost:1234/animatic/shot.01.first/v-2/panel.png"] },
        },
      ],
    });

    await expect(
      captureCompositionFrames({
        video,
        manager,
        shotId: "01",
        videoRoot: "/video",
        outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
        captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
      }),
    ).rejects.toMatchObject({
      code: "FRAME_CAPTURE_FAILED",
      message: expect.stringMatching(
        /media failed to load: video:shot\.01\.motion \(v-1\).*media still loading at the timeout: animatic:shot\.01\.first \(v-2\)/,
      ),
    });
    expect(captureFrameMock).not.toHaveBeenCalled();
    expect(fsp.rename).not.toHaveBeenCalled();
  });

  it("passes a layer left as an unresolved placeholder, which draws nothing on purpose", async () => {
    createCaptureSessionMock.mockResolvedValue({
      id: "mock-session",
      warnings: [
        {
          code: "media_load_failed",
          message: "image media failed to load before capture",
          details: { sources: ["http://localhost:1234/__konte:animatic:shot.01.first__"] },
        },
      ],
    });

    await expect(
      captureCompositionFrames({
        video,
        manager,
        shotId: "01",
        videoRoot: "/video",
        outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
        captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
      }),
    ).resolves.toHaveLength(1);
  });

  // A take nothing on the page uses may have lost its file, which a hard link or copy refuses.
  it("links in only the takes the page references", async () => {
    const fsp = await import("node:fs/promises");
    (fsp.mkdtemp as unknown as Mock).mockResolvedValue("/tmp/konte-cap-mock");
    composition.html =
      '<html><body><img src="/animatic/shot.01.first/v-used/panel%201.png" data-start="0" data-duration="1.75" /></body></html>';
    const withTakes = {
      getState: () => ({
        assets: {
          "animatic:shot.01.first": {
            variants: {
              "v-used": { file: "assets/animatic/shot.01.first/v-used/panel 1.png" },
              "v-old": { file: "assets/animatic/shot.01.first/v-old/gone.png" },
            },
          },
        },
      }),
    } as unknown as StateManager;

    await captureCompositionFrames({
      video,
      manager: withTakes,
      shotId: "01",
      videoRoot: "/video",
      outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
      captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
    });

    expect(fsp.symlink).toHaveBeenCalledTimes(1);
    expect(fsp.symlink).toHaveBeenCalledWith(
      "/video/assets/animatic/shot.01.first/v-used/panel 1.png",
      "/tmp/konte-cap-mock/animatic/shot.01.first/v-used/panel 1.png",
    );
  });

  it("names a take by its address, variant and file", async () => {
    composition.html =
      '<html><body><img src="/animatic/shot.01.first/v-used/panel%201.png" data-start="0" data-duration="1.75" /></body></html>';
    const withTake = {
      getState: () => ({
        assets: {
          "animatic:shot.01.first": {
            variants: { "v-used": { file: "assets/animatic/shot.01.first/v-used/panel 1.png" } },
          },
        },
      }),
    } as unknown as StateManager;
    createCaptureSessionMock.mockResolvedValue({
      id: "mock-session",
      warnings: [
        {
          code: "media_load_failed",
          message: "image media failed to load before capture",
          details: {
            sources: ["http://localhost:1234/animatic/shot.01.first/v-used/panel%201.png"],
          },
        },
      ],
    });

    await expect(
      captureCompositionFrames({
        video,
        manager: withTake,
        shotId: "01",
        videoRoot: "/video",
        outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
        captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "animatic:shot.01.first (v-used: assets/animatic/shot.01.first/v-used/panel 1.png)",
      ),
    });
  });

  it("reports a take it cannot stage as a typed capture failure", async () => {
    const fsp = await import("node:fs/promises");
    (fsp.mkdtemp as unknown as Mock).mockResolvedValue("/tmp/konte-cap-mock");
    (fsp.symlink as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" }),
    );
    composition.html =
      '<html><body><img src="/animatic/shot.01.first/v-used/panel.png" data-start="0" data-duration="1.75" /></body></html>';
    const withTake = {
      getState: () => ({
        assets: {
          "animatic:shot.01.first": {
            variants: { "v-used": { file: "assets/animatic/shot.01.first/v-used/panel.png" } },
          },
        },
      }),
    } as unknown as StateManager;

    await expect(
      captureCompositionFrames({
        video,
        manager: withTake,
        shotId: "01",
        videoRoot: "/video",
        outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
        captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
      }),
    ).rejects.toMatchObject({
      code: "FRAME_CAPTURE_FAILED",
      message: expect.stringContaining("animatic:shot.01.first (v-used): cannot stage"),
    });
  });

  // The render leaves a clip its frames are injected for out of the media check; a clip it could
  // not extract is still on screen as its own <video>, so that one is checked.
  it("leaves only a clip the injector could not supply to the page's media check", async () => {
    composition.html =
      '<html><body><video src="/video/shot.01.motion/v-1/missing.mp4" data-start="0" data-duration="3.5"></video></body></html>';

    await captureCompositionFrames({
      video,
      manager,
      shotId: "01",
      videoRoot: "/video",
      outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
      captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
    });

    expect(createCaptureSessionMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ skipReadinessVideoIds: [] }),
      undefined,
    );

    extractedFrames.present = true;
    await captureCompositionFrames({
      video,
      manager,
      shotId: "01",
      videoRoot: "/video",
      outputDir: "/video/.konte/cache/thumbnails/animatic/shot.01",
      captureOptions: { timestamps: [1.75], format: "jpeg", quality: 80, force: true },
    });

    expect(createCaptureSessionMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ skipReadinessVideoIds: [expect.any(String)] }),
      undefined,
    );
  });
});
