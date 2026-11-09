import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  calls: [] as Array<{ html: string; size: { width: number; height: number }; format?: string }>,
}));
vi.mock("../still-capture.js", () => ({
  captureHtmlToImage: async (opts: {
    html: string;
    outputFile: string;
    size: { width: number; height: number };
    format?: string;
  }) => {
    captured.calls.push({ html: opts.html, size: opts.size, format: opts.format });
    const fsp = await import("node:fs/promises");
    const pth = await import("node:path");
    await fsp.mkdir(pth.dirname(opts.outputFile), { recursive: true });
    await fsp.writeFile(opts.outputFile, "jpg");
  },
}));

const cut = vi.hoisted(() => ({ calls: [] as Array<{ from: string; at: number; to: string }> }));
vi.mock("../frame-extract.js", () => ({
  extractFrameWithin: async (from: string, at: number, to: string) => {
    cut.calls.push({ from, at, to });
    const fsp = await import("node:fs/promises");
    const pth = await import("node:path");
    await fsp.mkdir(pth.dirname(to), { recursive: true });
    await fsp.writeFile(to, "frame");
  },
}));

const encoded = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../ffmpeg-exec.js", () => ({
  runFfmpeg: async (args: string[]) => {
    encoded.calls.push(args);
    const fsp = await import("node:fs/promises");
    const pth = await import("node:path");
    await fsp.mkdir(pth.dirname(args.at(-1)!), { recursive: true });
    await fsp.writeFile(args.at(-1)!, "jpg");
    return { stdout: "", stderr: "" };
  },
}));

import {
  Composition,
  Image,
  Video,
  adapters,
  asset,
  defineDirection,
  defineVideo,
} from "../dsl/index.js";
import { THUMBNAIL_FRAME_ADDRESS, THUMBNAIL_STILL_ADDRESS } from "../address.js";
import { exportThumbnail, type RederiveLocal, THUMBNAIL_EXPORT_FILE } from "../export-thumbnail.js";
import { StateManager } from "../state/index.js";
import { directionDefaults } from "./helpers/direction.js";

const direction = () =>
  defineDirection({
    ...directionDefaults,
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [{ id: "01", role: "ordinary", action: "a", setup: "front", duration: 2, lineup: [] }],
    },
  });

const DELIVERED = { size: { width: 1280, height: 720 }, crop: { width: 1280, height: 720 } };

const withCover = () =>
  defineVideo(direction(), {
    timeline: ({ shot }) => ({
      shots: shot("01", () => {
        const motion = asset("motion", adapters.videoTrim, {
          source: { src: "__konte:video:timeline.raw__" } as never,
          start: 0,
          duration: 1,
        });
        return (
          <Composition>
            <Video src={motion} />
          </Composition>
        );
      }),
    }),
    thumbnail: {
      compose: ({ shot }) => {
        const still = asset("cover", adapters.videoFrame, {
          source: shot("01").video("motion"),
          at: 0.5,
        });
        return (
          <Composition>
            <Image src={still} fill />
          </Composition>
        );
      },
    },
  });

describe("exportThumbnail", () => {
  let dir: string;
  let manager: StateManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-export-thumbnail-"));
    manager = await StateManager.init(dir);
    captured.calls = [];
    cut.calls = [];
    encoded.calls = [];
    for (const [address, file] of [
      ["video:shot.01.motion", "motion.mp4"],
      ["video:thumbnail.cover", "cover.png"],
    ] as const) {
      const vid = manager.reserveVariantId(address);
      manager.getAssetState(address).variants![vid]!.file = file;
    }
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("captures a JPEG on the delivered frame, from the takes the render resolves", async () => {
    const outputDir = path.join(dir, "out");
    const file = await exportThumbnail({
      video: withCover(),
      manager,
      outputDir,
      deliverable: path.join(dir, "video.mp4"),
      layout: { size: { width: 1366, height: 768 }, crop: { width: 1280, height: 720 } },
      delivered: new Map(),
    });
    expect(file).toBe(path.join(outputDir, THUMBNAIL_EXPORT_FILE));
    expect(captured.calls).toEqual([
      expect.objectContaining({ size: { width: 1280, height: 720 }, format: "jpeg" }),
    ]);
    expect(captured.calls[0]!.html).toContain("asset-0.png");
  });

  it("makes a frame of an upscaled layer again from the upscale", async () => {
    const rederive = vi.fn(async () => path.join(dir, "rederived.png"));
    await exportThumbnail({
      video: withCover(),
      manager,
      outputDir: path.join(dir, "out"),
      deliverable: path.join(dir, "video.mp4"),
      layout: DELIVERED,
      delivered: new Map([["video:shot.01.motion", "/upscaled/motion.mp4"]]),
      rederive,
    });
    expect(rederive).toHaveBeenCalledWith(
      "video:thumbnail.cover",
      expect.objectContaining({ operation: "frame" }),
      { "video:shot.01.motion": "/upscaled/motion.mp4" },
      expect.any(String),
    );
  });

  it("keeps a crop of that frame at its working-size take, its window in those pixels", async () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          const motion = asset("motion", adapters.videoTrim, {
            source: { src: "__konte:video:timeline.raw__" } as never,
            start: 0,
            duration: 1,
          });
          return (
            <Composition>
              <Video src={motion} />
            </Composition>
          );
        }),
      }),
      thumbnail: {
        compose: ({ shot }) => {
          const frame = asset("frame", adapters.videoFrame, { source: shot("01").video("motion") });
          const crop = asset("crop", adapters.imageCrop, {
            image: frame,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          });
          return (
            <Composition>
              <Image src={crop} fill />
            </Composition>
          );
        },
      },
    });
    const vid = manager.reserveVariantId("video:thumbnail.crop");
    manager.getAssetState("video:thumbnail.crop").variants![vid]!.file = "crop.png";
    const rederive = vi.fn<RederiveLocal>(async (address) => `/remade/${address}.png`);
    await exportThumbnail({
      video,
      manager,
      outputDir: path.join(dir, "out"),
      deliverable: path.join(dir, "video.mp4"),
      layout: DELIVERED,
      delivered: new Map([["video:shot.01.motion", "/upscaled/motion.mp4"]]),
      rederive,
    });
    expect(rederive).not.toHaveBeenCalled();
    expect(captured.calls[0]!.html).toContain("asset-0.png");
  });

  it("keeps a frame a patch corrected and the human accepted", async () => {
    const cover = Object.keys(manager.getAssetState("video:thumbnail.cover").variants!)[0]!;
    const patched = manager.reserveVariantId("video:thumbnail.cover");
    const variants = manager.getAssetState("video:thumbnail.cover").variants!;
    variants[patched]!.file = "patched.png";
    variants[patched]!.derivedFrom = cover;
    manager.setAccepted("video:thumbnail.cover", patched);
    const rederive = vi.fn<RederiveLocal>(async () => "/remade.png");
    await exportThumbnail({
      video: withCover(),
      manager,
      outputDir: path.join(dir, "out"),
      deliverable: path.join(dir, "video.mp4"),
      layout: DELIVERED,
      delivered: new Map([["video:shot.01.motion", "/upscaled/motion.mp4"]]),
      rederive,
    });
    expect(rederive).not.toHaveBeenCalled();
  });

  it("builds the still on the canvas it is laid out on", async () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({ shots: shot("01", () => <Composition />) }),
      thumbnail: {
        compose: ({ format }) => (
          <Composition>
            <div data-canvas={`${format.size.width}x${format.size.height}`} />
          </Composition>
        ),
      },
    });
    await exportThumbnail({
      video,
      manager,
      outputDir: path.join(dir, "out"),
      deliverable: path.join(dir, "video.mp4"),
      layout: { size: { width: 2048, height: 1152 }, crop: { width: 2048, height: 1152 } },
      delivered: new Map(),
    });
    expect(captured.calls[0]!.html).toContain(`data-canvas="2048x1152"`);
  });

  it("cuts the frame at `at` from the deliverable, the cover itself", async () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({ shots: shot("01", () => <Composition />) }),
      thumbnail: { at: 1.5 },
    });
    const outputDir = path.join(dir, "out");
    const file = await exportThumbnail({
      video,
      manager,
      outputDir,
      deliverable: path.join(dir, "video.mp4"),
      layout: DELIVERED,
      delivered: new Map(),
    });
    expect(file).toBe(path.join(outputDir, THUMBNAIL_EXPORT_FILE));
    expect(cut.calls).toEqual([{ from: path.join(dir, "video.mp4"), at: 1.5, to: file }]);
    expect(captured.calls).toEqual([]);
  });

  it("draws the frame cut from the deliverable where the compose draws `frame`", async () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({ shots: shot("01", () => <Composition />) }),
      thumbnail: {
        at: 0.5,
        compose: ({ frame }) => (
          <Composition>
            <Image src={frame} fill />
            <h1>Title</h1>
          </Composition>
        ),
      },
    });
    await exportThumbnail({
      video,
      manager,
      outputDir: path.join(dir, "out"),
      deliverable: path.join(dir, "video.mp4"),
      layout: DELIVERED,
      delivered: new Map(),
    });
    expect(cut.calls).toEqual([
      expect.objectContaining({ from: path.join(dir, "video.mp4"), at: 0.5 }),
    ]);
    expect(captured.calls[0]!.html).toContain("asset-0.png");
    expect(captured.calls[0]!.html).toContain("Title");
  });

  const takeAt = (address: string, file: string, derivedFrom?: string): string => {
    const vid = manager.reserveVariantId(address);
    const variant = manager.getAssetState(address).variants![vid]!;
    variant.file = file;
    if (derivedFrom) variant.derivedFrom = derivedFrom;
    manager.setAccepted(address, vid);
    return vid;
  };

  it("ships the accepted cover take when the video has no delivery size", async () => {
    takeAt(THUMBNAIL_STILL_ADDRESS, "still.png");
    const outputDir = path.join(dir, "out");
    const file = await exportThumbnail({
      video: withCover(),
      manager,
      outputDir,
      deliverable: path.join(dir, "video.mp4"),
      layout: { size: { width: 1024, height: 576 } },
      delivered: new Map(),
    });
    expect(file).toBe(path.join(outputDir, THUMBNAIL_EXPORT_FILE));
    expect(encoded.calls).toEqual([
      expect.arrayContaining([path.join(dir, "still.png"), "scale=1024:576,setsar=1", file]),
    ]);
    expect(captured.calls).toEqual([]);
    expect(cut.calls).toEqual([]);
  });

  it("refuses a video with no delivery size whose cover has no take", async () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({ shots: shot("01", () => <Composition />) }),
      thumbnail: { at: 1 },
    });
    await expect(
      exportThumbnail({
        video,
        manager,
        outputDir: path.join(dir, "out"),
        deliverable: path.join(dir, "video.mp4"),
        layout: { size: { width: 1024, height: 576 } },
        delivered: new Map(),
      }),
    ).rejects.toThrow(`the thumbnail's cover ${THUMBNAIL_FRAME_ADDRESS} has no ready take`);
  });

  it("fills a patched cover take to the delivered frame instead of making it again", async () => {
    const source = takeAt(THUMBNAIL_STILL_ADDRESS, "still.png");
    takeAt(THUMBNAIL_STILL_ADDRESS, "patched.png", source);
    await exportThumbnail({
      video: withCover(),
      manager,
      outputDir: path.join(dir, "out"),
      deliverable: path.join(dir, "video.mp4"),
      layout: { size: { width: 1366, height: 768 }, crop: { width: 1280, height: 720 } },
      delivered: new Map(),
    });
    expect(encoded.calls).toEqual([
      expect.arrayContaining([
        path.join(dir, "patched.png"),
        "scale=1366:768,setsar=1,crop=1280:720:(in_w-1280)/2:(in_h-720)/2",
      ]),
    ]);
    expect(captured.calls).toEqual([]);
  });

  it("is nothing for a video with no thumbnail", async () => {
    const video = withCover();
    delete video.thumbnail;
    expect(
      await exportThumbnail({
        video,
        manager,
        outputDir: dir,
        deliverable: path.join(dir, "video.mp4"),
        layout: DELIVERED,
        delivered: new Map(),
      }),
    ).toBeNull();
  });
});
