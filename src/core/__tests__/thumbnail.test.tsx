import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock("../still-capture.js", () => ({
  captureHtmlToImage: async (opts: { html: string; outputFile: string }) => {
    captured.html.push(opts.html);
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(opts.outputFile, `png:${opts.html.length}`);
  },
}));

import { cascadeAcceptConsumedDeps } from "../accept-cascade.js";
import { definitionHashForAddress } from "../composition-resource.js";
import { makeAddressPlaceholder } from "../dsl/shot-context.js";
import { commentSubjectAddresses } from "../feedback/subject.js";
import { buildDependencyGraph, listUnusedAddresses } from "../graph.js";
import { JobManager } from "../job-manager.js";
import { asJsxStillInputs, renderJsxStill } from "../jsx-render.js";
import { unacceptedOutsideRefs, unacceptedThumbnailRefs } from "../render-plan.js";
import { StateManager } from "../state/index.js";
import { withThumbnailFrameHashes } from "../thumbnail-frame.js";
import {
  THUMBNAIL_FRAME_ADDRESS,
  THUMBNAIL_STILL_ADDRESS,
  thumbnailCoverAddress,
  getAssetEntry,
  isMaterializedLeafAddress,
  listAddresses,
  parseAddress,
} from "../address.js";
import {
  Audio,
  Composition,
  Image,
  Video,
  adapters,
  asset,
  defineDirection,
  defineVideo,
  type ThumbnailSpec,
} from "../dsl/index.js";
import { directionDefaults } from "./helpers/direction.js";

const direction = () =>
  defineDirection({
    ...directionDefaults,
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        { id: "01", role: "ordinary", action: "a", setup: "front", duration: 2, lineup: [] },
        { id: "02", role: "hero", action: "b", setup: "front", duration: 2, lineup: [] },
      ],
    },
  });

const motionShot = () => {
  const motion = asset("motion", adapters.jsxImage, {});
  return (
    <Composition>
      <Image src={motion} />
    </Composition>
  );
};

describe("thumbnail", () => {
  it("parses its addresses as the video's thumbnail", () => {
    expect(parseAddress("video:thumbnail.cover")).toEqual({
      stage: "video",
      kind: "thumbnail",
      assetName: "cover",
      delivery: false,
    });
    expect(parseAddress(THUMBNAIL_STILL_ADDRESS).assetName).toBe("#still");
    expect(parseAddress(THUMBNAIL_FRAME_ADDRESS).assetName).toBe("#frame");
    expect(isMaterializedLeafAddress(THUMBNAIL_STILL_ADDRESS)).toBe(false);
    expect(() => parseAddress("animatic:thumbnail.cover")).toThrow();
    expect(() => parseAddress("video:thumbnail.cover#delivery")).toThrow();
    expect(() => parseAddress("video:thumbnail#composition")).toThrow();
  });

  it("declares its own assets and reaches a placed shot's", () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", motionShot).nextShot("02", () => <Composition />),
      }),
      thumbnail: {
        compose: ({ shot }) => {
          const still = asset("cover", adapters.videoFrame, {
            source: shot("01").image("motion") as never,
            at: 1,
          });
          return (
            <Composition>
              <Image src={still} />
            </Composition>
          );
        },
      },
    });
    expect(Object.keys(video.thumbnail!.assets)).toEqual(["cover"]);
    expect(video.thumbnail!.compose!.compositionRefs).toEqual(["video:thumbnail.cover"]);
    expect(listAddresses(video, "video")).toContain("video:thumbnail.cover");
    expect(getAssetEntry(video, "video:thumbnail.cover")).toMatchObject({ operation: "frame" });
  });

  it("finds a ref a function component pulls in from a closure", () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", motionShot).nextShot("02", () => <Composition />),
      }),
      thumbnail: {
        compose: ({ shot }) => {
          const Cover = () => <Image src={shot("01").image("motion")} fill />;
          return (
            <Composition>
              <Cover />
            </Composition>
          );
        },
      },
    });
    expect(video.thumbnail!.compose!.compositionRefs).toEqual(["video:shot.01.motion"]);
  });

  it("is absent unless declared", () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => <Composition />).nextShot("02", () => <Composition />),
      }),
    });
    expect(video.thumbnail).toBeUndefined();
  });

  it("refuses a still that plays media", () => {
    for (const media of [
      <Video key="video" src={"clip.mp4" as never} />,
      <Audio key="audio" src={"line.wav" as never} />,
    ]) {
      expect(() =>
        defineVideo(direction(), {
          timeline: ({ shot }) => ({
            shots: shot("01", () => <Composition />).nextShot("02", () => <Composition />),
          }),
          thumbnail: { compose: () => <Composition>{media}</Composition> },
        }),
      ).toThrow(/the thumbnail plays a <Video> or an <Audio>/);
    }
  });
});

describe("the thumbnail's still", () => {
  let dir: string;
  let manager: StateManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-thumbnail-test-"));
    manager = await StateManager.init(dir);
    captured.html = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const withCover = (title: string) =>
    defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", motionShot).nextShot("02", () => <Composition />),
      }),
      thumbnail: {
        compose: ({ shot }) => {
          const still = asset("cover", adapters.videoFrame, {
            source: shot("01").image("motion") as never,
            at: 1,
          });
          return (
            <Composition>
              <Image src={still} />
              <h1>{title}</h1>
            </Composition>
          );
        },
      },
    });

  function addReadyVariant(address: string, file: string): string {
    const vid = manager.reserveVariantId(address);
    const variant = manager.getAssetState(address).variants![vid]!;
    variant.file = file;
    variant.outputHash = `hash-${vid}`;
    return vid;
  }

  it("is a root of the graph, its assets used by it", () => {
    const video = withCover("Hi");
    const graph = buildDependencyGraph(video);
    expect(graph.dependencies.get(THUMBNAIL_STILL_ADDRESS)).toEqual(["video:thumbnail.cover"]);
    expect(graph.dependencies.get("video:thumbnail.cover")).toEqual(["video:shot.01.motion"]);
    expect(listUnusedAddresses(video, null, graph)).not.toContain("video:thumbnail.cover");
  });

  it("is a deterministic render over the working canvas, its definition moving with the build", () => {
    const video = withCover("Hi");
    expect(listAddresses(video, "video")).toContain(THUMBNAIL_STILL_ADDRESS);
    const still = getAssetEntry(video, THUMBNAIL_STILL_ADDRESS);
    expect(still).toMatchObject({
      kind: "local",
      operation: "render",
      mediaType: "image",
      deterministic: true,
      inputs: {
        width: video.format.size.width,
        height: video.format.size.height,
        refs: [makeAddressPlaceholder("video:thumbnail.cover")],
      },
    });
    expect(definitionHashForAddress(withCover("Bye"), THUMBNAIL_STILL_ADDRESS)).not.toBe(
      definitionHashForAddress(video, THUMBNAIL_STILL_ADDRESS),
    );
  });

  it("is captured by the local render op, every ref it draws substituted", async () => {
    const still = withCover("Hi").thumbnail!.compose!.still;
    const outputFile = path.join(dir, "still.png");
    await renderJsxStill({
      inputs: asJsxStillInputs(still.inputs),
      outputFile,
      videoRoot: dir,
      resolveRef: async () => path.join(dir, "cover.png"),
    });
    expect(captured.html).toHaveLength(1);
    expect(captured.html[0]).toContain("Hi");
    expect(captured.html[0]).not.toContain("__konte:");
  });

  it("signs off its own assets and never the shot takes they draw", async () => {
    const video = withCover("Hi");
    addReadyVariant("video:shot.01.motion", "motion.png");
    const cover = addReadyVariant("video:thumbnail.cover", "cover.png");
    const still = addReadyVariant(THUMBNAIL_STILL_ADDRESS, "still.png");
    const jobManager = new JobManager(dir);
    await jobManager.createJob({
      address: "video:thumbnail.cover",
      variantId: cover,
      resolvedDeps: { "video:shot.01.motion": "motion.png" },
      backendKind: "local",
    });
    await jobManager.createJob({
      address: THUMBNAIL_STILL_ADDRESS,
      variantId: still,
      resolvedDeps: { "video:thumbnail.cover": "cover.png" },
      backendKind: "local",
    });
    manager.setAccepted(THUMBNAIL_STILL_ADDRESS, still);
    const accepted = await cascadeAcceptConsumedDeps(
      manager,
      jobManager,
      THUMBNAIL_STILL_ADDRESS,
      still,
      { video, castAddresses: new Set() },
    );
    expect(accepted).toEqual(["video:thumbnail.cover"]);
    expect(manager.getAcceptedVariant("video:shot.01.motion")).toBeNull();
  });

  it("holds an export to its still and every take it draws, a shot's outside its own included", () => {
    const video = defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => <Composition />).nextShot("02", motionShot),
      }),
      thumbnail: {
        compose: ({ shot }) => (
          <Composition>
            <Image src={shot("02").image("motion")} fill />
          </Composition>
        ),
      },
    });
    const motion = addReadyVariant("video:shot.02.motion", "motion.png");
    expect(unacceptedThumbnailRefs(video, manager)).toEqual([
      THUMBNAIL_STILL_ADDRESS,
      "video:shot.02.motion",
    ]);
    expect(unacceptedOutsideRefs(video, manager)).toContain("video:shot.02.motion");
    manager.setAccepted("video:shot.02.motion", motion);
    expect(unacceptedThumbnailRefs(video, manager)).toEqual([THUMBNAIL_STILL_ADDRESS]);
    manager.setAccepted(
      THUMBNAIL_STILL_ADDRESS,
      addReadyVariant(THUMBNAIL_STILL_ADDRESS, "still.png"),
    );
    expect(unacceptedThumbnailRefs(video, manager)).toEqual([]);
  });

  it("is what a comment on the thumbnail stands on", () => {
    const subject = commentSubjectAddresses(withCover("Hi"), "video:thumbnail");
    expect(subject).toEqual({
      assets: [THUMBNAIL_STILL_ADDRESS, "video:thumbnail.cover"],
      leaves: [],
    });
  });
});

describe("the thumbnail's frame", () => {
  const withFrame = (at: number, picture = "a") =>
    defineVideo(direction(), {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          const motion = asset("motion", adapters.jsxImage, {});
          return (
            <Composition>
              <Image src={motion} />
              <p>{picture}</p>
            </Composition>
          );
        }).nextShot("02", () => <Composition />),
      }),
      thumbnail: { at },
    });

  it("is cut from the shot under `at`, its inputs the takes that shot draws", () => {
    const video = withFrame(1.25);
    expect(video.thumbnail!.frame).toMatchObject({ at: 1.25, shotId: "01", shotTime: 1.25 });
    expect(withFrame(2.5).thumbnail!.frame).toMatchObject({ shotId: "02", shotTime: 0.5 });
    expect(getAssetEntry(video, THUMBNAIL_FRAME_ADDRESS)).toMatchObject({
      kind: "local",
      operation: "cutFrame",
      deterministic: true,
      inputs: { shot: "01", at: 1.25, refs: [makeAddressPlaceholder("video:shot.01.motion")] },
    });
    expect(thumbnailCoverAddress(video.thumbnail!)).toBe(THUMBNAIL_FRAME_ADDRESS);
    expect(listAddresses(video, "video")).toContain(THUMBNAIL_FRAME_ADDRESS);
    expect(listAddresses(video, "video")).not.toContain(THUMBNAIL_STILL_ADDRESS);
    const graph = buildDependencyGraph(video);
    expect(graph.dependencies.get(THUMBNAIL_FRAME_ADDRESS)).toEqual(["video:shot.01.motion"]);
    expect(listUnusedAddresses(video, null, graph)).not.toContain(THUMBNAIL_FRAME_ADDRESS);
  });

  it("refuses an `at` off the timeline, and a frame nothing shows", () => {
    expect(() => withFrame(4)).toThrow(/outside the timeline's 0–4s/);
    expect(() => withFrame(-1)).toThrow(/outside the timeline/);
    const bare = (thumbnail: ThumbnailSpec) =>
      defineVideo(direction(), {
        timeline: ({ shot }) => ({
          shots: shot("01", () => <Composition />).nextShot("02", () => <Composition />),
        }),
        thumbnail: thumbnail as never,
      });
    expect(() => bare({})).toThrow(/neither `at` nor `compose`/);
    expect(() =>
      bare({
        compose: ({ frame }) => (
          <Composition>
            <Image src={frame} />
          </Composition>
        ),
      }),
    ).toThrow(/declares no `at`/);
    expect(() =>
      bare({
        at: 1,
        compose: () => (
          <Composition>
            <h1>Hi</h1>
          </Composition>
        ),
      }),
    ).toThrow(/never draws/);
    const throughAsset = bare({
      at: 1,
      compose: ({ frame }) => {
        const fit = asset("fit", adapters.imageResize, { image: frame, width: 640, height: 360 });
        return (
          <Composition>
            <Image src={fit} />
          </Composition>
        );
      },
    });
    expect(throughAsset.thumbnail!.frame).toMatchObject({ at: 1 });
  });

  it("moves its definition with the picture of the shot it is cut from, once loaded", () => {
    const hash = (video: ReturnType<typeof withFrame>) =>
      definitionHashForAddress(withThumbnailFrameHashes(video), THUMBNAIL_FRAME_ADDRESS);
    expect(hash(withFrame(1))).toBe(hash(withFrame(1)));
    expect(hash(withFrame(1, "b"))).not.toBe(hash(withFrame(1)));
    expect(hash(withFrame(1.5))).not.toBe(hash(withFrame(1)));
    expect(hash(withFrame(3, "b"))).toBe(hash(withFrame(3)));
  });

  it("is the cover a video with no compose holds its export to", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-thumbnail-frame-"));
    try {
      const manager = await StateManager.init(dir);
      const video = withFrame(1);
      expect(unacceptedThumbnailRefs(video, manager)).toEqual([THUMBNAIL_FRAME_ADDRESS]);
      const vid = manager.reserveVariantId(THUMBNAIL_FRAME_ADDRESS);
      const variant = manager.getAssetState(THUMBNAIL_FRAME_ADDRESS).variants![vid]!;
      variant.file = "frame.png";
      variant.outputHash = "hash-frame";
      manager.setAccepted(THUMBNAIL_FRAME_ADDRESS, vid);
      expect(unacceptedThumbnailRefs(video, manager)).toEqual([]);
      expect(commentSubjectAddresses(video, "video:thumbnail")).toEqual({
        assets: [THUMBNAIL_FRAME_ADDRESS],
        leaves: [],
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
