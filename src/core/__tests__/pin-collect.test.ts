import { describe, expect, it } from "vitest";
import { Composition } from "../dsl/composition/composition.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { Video, asset, defineReference, defineVideo, definePatch } from "../dsl/index.js";
import { checkPins } from "../pin-check.js";
import { listVideoShotPins } from "../graph.js";
import { harvestShotPictureCues } from "../composition-builder.js";
import { pendingShot, shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";

const FORMAT = { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } };

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test image adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const motionComfy = defineComfyAsset({
  workflow: "motion.json",
  description: "test motion adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt" },
    // Conditioning, not a pin — never collected.
    image1: { nodeId: "1", field: "image", type: "image" },
    startImage: { nodeId: "2", field: "image", type: "image", pin: "start" },
    endImage: { nodeId: "4", field: "image", type: "image", pin: "end" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

function el(...children: unknown[]): React.ReactElement {
  return { type: Composition, props: { children } } as unknown as React.ReactElement;
}

function videoLayer(src: unknown): React.ReactElement {
  return { type: Video, props: { src } } as unknown as React.ReactElement;
}

const stillMotion = defineComfyAsset({
  workflow: "still-motion.json",
  description: "test motion adapter with no pin input",
  inputs: { prompt: { nodeId: "3", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

describe("pin collection", () => {
  it("collects a video stage's pins, addressed, and nothing else", () => {
    const reference = defineReference(plainDirection, () => ({
      hero: asset("hero", imageComfy, { prompt: "a woman in a red coat" }),
    }));

    const video = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              const key = asset("key", imageComfy, { prompt: "a lit desk" });
              asset("motion", motionComfy, {
                prompt: "she turns",
                image1: reference.hero,
                startImage: key,
                endImage: reference.hero,
              });
              return el();
            },
          }),
        ]),
    });

    expect(video.pins).toEqual([
      {
        address: "video:shot.01.motion",
        input: "startImage",
        pin: "start",
        source: "video:shot.01.key",
      },
      {
        address: "video:shot.01.motion",
        input: "endImage",
        pin: "end",
        source: "reference:hero",
      },
    ]);
    // The sheet is a finding; the shot's own keyframe is not, and neither is the sheet at `image1`.
    expect(checkPins(video.pins ?? []).active.map((f) => f.source)).toEqual(["reference:hero"]);
  });

  // A slot the adapter declares and the call left empty is recorded with no `source`: that is what
  // tells `join-unpinned` this model COULD have carried a seam.
  it("collects a patch's pins under the step's own address, empty slots included", () => {
    const patch = definePatch<"video">(({ source }) =>
      asset("fixed", motionComfy, {
        prompt: "hold the landing",
        startImage: source as never,
      }),
    );
    const built = patch.build({
      stage: "video",
      sourceVariantId: "v-abc",
      sourceAddress: "video:shot.01.motion",
      format: { size: { width: 1024, height: 576 }, fps: 24 },
    });
    expect(built.pins).toEqual([
      {
        address: "video:patch.v-abc.fixed",
        input: "startImage",
        pin: "start",
        source: "video:shot.01.motion",
      },
      { address: "video:patch.v-abc.fixed", input: "endImage", pin: "end" },
    ]);
  });

  it("leaves `pins` off a stage that wires none", () => {
    const video = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              asset("key", imageComfy, { prompt: "a lit desk" });
              return el();
            },
          }),
        ]),
    });
    expect(video.pins).toBeUndefined();
  });
});

// A slot is what the rendered take COULD pin. A pin-capable asset the shot declares and never renders
// is no evidence about that take, so it must not make the seam look answerable.
describe("listVideoShotPins slots", () => {
  it("counts a slot only on an asset the frame renders", () => {
    const v = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2,
            build: () => {
              const take = asset("take", stillMotion, { prompt: "she turns" });
              asset("unused", motionComfy, { prompt: "an alternate, not rendered" });
              return el(videoLayer(take));
            },
          }),
        ]),
    });

    expect(listVideoShotPins(v)).toEqual([{ shotId: "01", lane: "main", pins: [], slots: [] }]);
  });
});

// The seam half of `join-unpinned`: the collected pins folded per shot, which is all the check reads.
describe("listVideoShotPins", () => {
  const video = defineVideo(testDirection(FORMAT), {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 2,
          build: () => {
            const key = asset("key", imageComfy, { prompt: "a lit desk" });
            return el(
              videoLayer(asset("motion", motionComfy, { prompt: "she turns", endImage: key })),
            );
          },
        }),
        shot("02", {
          duration: 2,
          build: () => el(videoLayer(asset("motion", motionComfy, { prompt: "she reaches" }))),
        }),
        pendingShot("03", { duration: 2 }),
      ]),
  });

  // `slots` is what the model can pin, `pins` what this take does — `join-unpinned` needs both to
  // tell a model that cannot carry a seam from an author who did not.
  it("folds each developed shot's pins under its shot id, pinning nothing included", () => {
    expect(listVideoShotPins(video)).toEqual([
      {
        shotId: "01",
        lane: "main",
        pins: [{ pin: "end", reaches: ["video:shot.01.key"] }],
        slots: ["start", "end"],
      },
      { shotId: "02", lane: "main", pins: [], slots: ["start", "end"] },
    ]);
  });
});

// The window half of `join-unshown`: where each shot plays its pinned take, in the take's own seconds.
describe("listVideoShotPins windows", () => {
  // H3's clock and grid: a 2.5s beat derives a 73-frame take.
  const gridMotion = defineComfyAsset({
    workflow: "grid-motion.json",
    description: "test motion adapter on a frame grid",
    inputs: {
      prompt: { nodeId: "3", field: "text", type: "prompt" },
      startImage: { nodeId: "2", field: "image", type: "image", pin: "start" },
      endImage: { nodeId: "4", field: "image", type: "image", pin: "end" },
      length: {
        nodeId: "5",
        field: "length",
        type: "frames",
        clock: 24,
        default: 120,
        grid: { step: 17, offset: 5 },
      },
    },
    outputs: { result: { nodeId: "9", type: "video" } },
  });
  const cue = (src: unknown, props: Record<string, unknown> = {}) =>
    ({ type: Video, props: { src, ...props } }) as unknown as React.ReactElement;

  const video = defineVideo(testDirection(FORMAT), {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 2.5,
          build: () => {
            const key = asset("key", imageComfy, { prompt: "a lit desk" });
            return el(
              cue(asset("motion", gridMotion, { prompt: "she turns", endImage: key }), {
                duration: 2.5,
              }),
            );
          },
        }),
        shot("02", {
          duration: 2,
          build: () => {
            const key = asset("key", imageComfy, { prompt: "a lit desk" });
            return el(
              cue(asset("motion", gridMotion, { prompt: "she laughs", startImage: key }), {
                mediaStart: 1.5,
              }),
            );
          },
        }),
      ]),
  });
  const pins = listVideoShotPins(video, (id) => harvestShotPictureCues(video, id));

  it("measures the take before against its declared length, landing on its last frame", () => {
    const w = pins.find((p) => p.shotId === "01")!.pins[0]!.window!;
    expect(w.clipSec).toBeCloseTo(73 / 24);
    expect(w.landsAt).toBeCloseTo(72 / 24);
    expect([w.opensAt, w.closesAt, w.from, w.to]).toEqual([0, 2.5, 0, 2.5]);
  });

  // The workflow anchors the image at the frame past the shot, and konte writes that frame.
  it("lands an anchored end image at the frame past the shot", () => {
    const anchored = defineComfyAsset({
      workflow: "anchored-motion.json",
      description: "test motion adapter anchoring its end image by frame index",
      inputs: {
        prompt: { nodeId: "3", field: "text", type: "prompt" },
        endImage: {
          nodeId: "4",
          field: "image",
          type: "image",
          pin: { end: { nodeId: "6", field: "frame_idx" } },
        },
        length: {
          nodeId: "5",
          field: "length",
          type: "frames",
          clock: 24,
          default: 120,
          grid: { step: 17, offset: 5 },
        },
      },
      outputs: { result: { nodeId: "9", type: "video" } },
    });
    const v = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2.5,
            build: () => {
              const key = asset("key", imageComfy, { prompt: "a lit desk" });
              return el(cue(asset("motion", anchored, { prompt: "she turns", endImage: key })));
            },
          }),
        ]),
    });
    const w = listVideoShotPins(v, (id) => harvestShotPictureCues(v, id))[0]!.pins[0]!.window!;
    expect(w.landsAt).toBeCloseTo(60 / 24);
    expect(w.to).toBeCloseTo(2.5);
  });

  // The shot cuts at its end, whatever duration the cue declares.
  it("cuts a window at the shot's end", () => {
    const v = defineVideo(testDirection(FORMAT), {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 2.5,
            build: () => {
              const key = asset("key", imageComfy, { prompt: "a lit desk" });
              return el(
                cue(asset("motion", gridMotion, { prompt: "she turns", endImage: key }), {
                  start: 1,
                }),
              );
            },
          }),
        ]),
    });
    const w = listVideoShotPins(v, (id) => harvestShotPictureCues(v, id))[0]!.pins[0]!.window!;
    expect([w.opensAt, w.closesAt, w.to]).toEqual([1, 2.5, 1.5]);
  });

  it("reads the take after's mediaStart", () => {
    const w = pins.find((p) => p.shotId === "02")!.pins[0]!.window!;
    expect(w.from).toBe(1.5);
    expect(w.opensAt).toBe(0);
  });
});

describe("pin declaration", () => {
  const define = (input: Record<string, unknown>) =>
    defineComfyAsset({
      workflow: "invalid.json",
      description: "test adapter",
      inputs: { knob: { nodeId: "1", field: "value", ...input } as never },
      outputs: { video: { nodeId: "9", type: "video" } },
    });

  it("rejects a pin on anything but an image", () => {
    expect(() => define({ type: "video", pin: "start" })).toThrow(/pins no frame/);
    expect(() => define({ type: "prompt", pin: "start" })).toThrow(/pins no frame/);
  });

  it("rejects two inputs pinning the same end", () => {
    expect(() =>
      defineComfyAsset({
        workflow: "invalid.json",
        description: "test adapter",
        inputs: {
          startImage: { nodeId: "1", field: "image", type: "image", pin: "start" },
          firstFrame: { nodeId: "2", field: "image", type: "image", pin: "start" },
        },
        outputs: { video: { nodeId: "9", type: "video" } },
      }),
    ).toThrow(/both pin the clip's start/);
  });

  it("accepts one input per end", () => {
    expect(() =>
      defineComfyAsset({
        workflow: "valid.json",
        description: "test adapter",
        inputs: {
          startImage: { nodeId: "1", field: "image", type: "image", pin: "start" },
          endImage: { nodeId: "2", field: "image", type: "image", pin: "end" },
        },
        outputs: { video: { nodeId: "9", type: "video" } },
      }),
    ).not.toThrow();
  });
});
