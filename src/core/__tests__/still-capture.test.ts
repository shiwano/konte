import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@hyperframes/producer", () => ({
  createFileServer: vi.fn(),
  createCaptureSession: vi.fn(),
  initializeSession: vi.fn(),
  captureFrame: vi.fn(),
  closeCaptureSession: vi.fn(),
}));

vi.mock("../chromium.js", () => ({
  ensureChromium: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../hyperframes-env.js", () => ({
  ensureHyperFramesEnv: vi.fn(),
}));

vi.mock("../ffmpeg-binary.js", () => ({
  leadPathWithFfmpeg: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue("/tmp/konte-still-mock"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    symlink: vi.fn().mockResolvedValue(undefined),
    link: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import * as fsPromises from "node:fs/promises";
import * as hfProducer from "@hyperframes/producer";
import { captureHtmlToImage } from "../still-capture.js";

const createFileServerMock = hfProducer.createFileServer as unknown as Mock;
const createCaptureSessionMock = hfProducer.createCaptureSession as unknown as Mock;
const captureFrameMock = hfProducer.captureFrame as unknown as Mock;
const closeCaptureSessionMock = hfProducer.closeCaptureSession as unknown as Mock;

const closeServer = vi.fn();

const html = "<!doctype html><html><body>card</body></html>";

async function capture(overrides: Partial<Parameters<typeof captureHtmlToImage>[0]> = {}) {
  return captureHtmlToImage({
    html,
    assetFiles: {},
    outputFile: "/out/v-1/output.png",
    videoRoot: "/video",
    size: { width: 1920, height: 1080 },
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  closeServer.mockReset();

  createFileServerMock.mockResolvedValue({ url: "http://127.0.0.1:1234", close: closeServer });
  createCaptureSessionMock.mockResolvedValue({ id: "mock-session", warnings: [] });
  captureFrameMock.mockResolvedValue({ path: "/out/v-1/frame_000000.png" });
  closeCaptureSessionMock.mockResolvedValue(undefined);

  (fsPromises.mkdir as Mock).mockResolvedValue(undefined);
  (fsPromises.mkdtemp as Mock).mockResolvedValue("/tmp/konte-still-mock");
  (fsPromises.writeFile as Mock).mockResolvedValue(undefined);
  (fsPromises.symlink as Mock).mockResolvedValue(undefined);
  (fsPromises.link as Mock).mockResolvedValue(undefined);
  (fsPromises.copyFile as Mock).mockResolvedValue(undefined);
  (fsPromises.rename as Mock).mockResolvedValue(undefined);
  (fsPromises.rm as Mock).mockResolvedValue(undefined);
});

describe("captureHtmlToImage", () => {
  it("serves the document and its assets out of one throwaway workspace", async () => {
    await capture({ assetFiles: { "asset-0.png": "/assets/plate.png" } });

    // Under the video, so a hard link from its takes stays on one volume.
    expect(fsPromises.mkdtemp).toHaveBeenCalledWith("/video/.konte/cache/capture/still-");
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      "/tmp/konte-still-mock/index.html",
      html,
      "utf-8",
    );
    expect(fsPromises.symlink).toHaveBeenCalledWith(
      "/assets/plate.png",
      "/tmp/konte-still-mock/asset-0.png",
    );
    // The server's fps is what the page-side runtime quantizes a seek by; a still is captured at
    // t=0, which lands on frame 0 of any grid, but naming it keeps the server and the session on
    // one clock.
    expect(createFileServerMock).toHaveBeenCalledWith({
      projectDir: "/tmp/konte-still-mock",
      fps: { num: 1, den: 1 },
    });
  });

  // Windows refuses a symlink without Developer Mode.
  it("hard-links an asset in where the OS refuses a symlink", async () => {
    (fsPromises.symlink as Mock).mockRejectedValue(
      Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    );

    await capture({ assetFiles: { "asset-0.png": "/assets/plate.png" } });

    expect(fsPromises.link).toHaveBeenCalledWith(
      "/assets/plate.png",
      "/tmp/konte-still-mock/asset-0.png",
    );
  });

  it("refuses a capture whose media failed to load", async () => {
    createCaptureSessionMock.mockResolvedValue({
      id: "mock-session",
      warnings: [
        {
          code: "media_load_failed",
          message: "image media failed to load before capture",
          details: { sources: ["http://127.0.0.1:1234/asset-0.png"] },
        },
      ],
    });

    await expect(
      capture({ assetFiles: { "asset-0.png": "/assets/plate.png" } }),
    ).rejects.toMatchObject({
      code: "FRAME_CAPTURE_FAILED",
      message: expect.stringContaining("media failed to load: /assets/plate.png"),
    });
    expect(captureFrameMock).not.toHaveBeenCalled();
  });

  it("captures a single frame at t=0, as a png at the declared size", async () => {
    await capture();

    expect(createCaptureSessionMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234",
      "/out/v-1",
      expect.objectContaining({
        width: 1920,
        height: 1080,
        // A still has no clock: 1fps quantizes t=0 onto its own grid, which is t=0.
        fps: { num: 1, den: 1 },
        // png is also the engine's alpha path — what makes `background: "transparent"` mean anything.
        format: "png",
      }),
    );
    expect(captureFrameMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mock-session" }),
      0,
      0,
    );
  });

  it("moves the producer's own frame name onto the output file", async () => {
    await capture();

    expect(fsPromises.rename).toHaveBeenCalledWith(
      "/out/v-1/frame_000000.png",
      "/out/v-1/output.png",
    );
  });

  // The server is listening before the session exists, so a Chromium that fails to start must not
  // leave the handle behind — it would keep the CLI alive after the command returned.
  it("closes the server when the session never opens", async () => {
    createCaptureSessionMock.mockRejectedValue(new Error("chromium failed to start"));

    await expect(capture()).rejects.toMatchObject({ code: "HYPERFRAMES_ERROR" });

    expect(closeServer).toHaveBeenCalled();
    expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-still-mock", {
      recursive: true,
      force: true,
    });
  });

  it("closes the server even when closing the session throws", async () => {
    closeCaptureSessionMock.mockRejectedValue(new Error("cdp already gone"));

    await expect(capture()).rejects.toThrow();

    expect(closeServer).toHaveBeenCalled();
  });

  it("closes the session, the server and the workspace when the capture fails", async () => {
    captureFrameMock.mockRejectedValue(new Error("chromium died"));

    await expect(capture()).rejects.toMatchObject({ code: "HYPERFRAMES_ERROR" });

    expect(closeCaptureSessionMock).toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalled();
    expect(fsPromises.rm).toHaveBeenCalledWith("/tmp/konte-still-mock", {
      recursive: true,
      force: true,
    });
  });
});
