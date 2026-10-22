import { describe, expect, it } from "vitest";
import { makeMediaAsset, type MediaAsset } from "../dsl/builders.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import {
  Composition,
  Panel,
  adapters,
  asset,
  defineAnimatic,
  defineReference,
} from "../dsl/index.js";
import {
  listPanelPromptText,
  listPanelReferenceReach,
  listPanelReferenceSlots,
  listPlateRecrops,
  listPlateTexts,
  listShotContinuity,
  listShownReferences,
} from "../graph.js";
import { plainDirection, testDirection } from "./helpers/direction.js";
import { animaticTimeline, moves, shot } from "./helpers/shot.js";

// The stage-side half of the staging class — what `loadStagingStageState` hands `checkDirection`.
// Built through the real DSL rather than by hand, since the order a panel's inputs arrive in is
// exactly what `slot-order-mismatch` reads.
const keyframe = defineComfyAsset({
  workflow: "keyframe.json",
  description: "test keyframe adapter",
  inputs: {
    prompt: { nodeId: "1", field: "text", type: "prompt" },
    place: { nodeId: "2", field: "image", type: "image" },
    left: { nodeId: "3", field: "image", type: "image" },
    right: { nodeId: "4", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const format = { fps: 24, size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } } };

const sheets = defineReference(plainDirection, {
  references: () => ({
    ferryDeck: asset("ferryDeck", keyframe, { prompt: "the deck, empty" }),
    ane: asset("ane", keyframe, { prompt: "the elder sister" }),
    imouto: asset("imouto", keyframe, { prompt: "the younger sister" }),
  }),
});

describe("listPanelReferenceSlots", () => {
  it("reads each keyframe's reference inputs in declaration order, panels in panel order", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const first = asset("first", keyframe, {
                prompt: "the two of them",
                place: sheets.ferryDeck,
                left: sheets.ane,
                right: sheets.imouto,
              });
              // The order the shot LEAVES on: the two have swapped, so this call's inputs swap too.
              const last = asset("last", keyframe, {
                prompt: "they have traded places",
                place: sheets.ferryDeck,
                left: sheets.imouto,
                right: sheets.ane,
              });
              return (
                <Composition>
                  <Panel src={first} {...moves} />
                  <Panel src={last} />
                </Composition>
              );
            },
          }),
        ]),
    });

    expect(listPanelReferenceSlots(animatic)).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        slots: ["ferryDeck", "ane", "imouto"],
      },
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.last",
        slots: ["ferryDeck", "imouto", "ane"],
      },
    ]);
  });
});

// The other reading of the same panels — what `character-unconsumed` asks.
describe("listPanelReferenceReach", () => {
  const board = (build: Parameters<typeof shot>[1]["build"]) =>
    defineAnimatic(testDirection(format), {
      plates: () => ({
        front: asset("front", keyframe, { prompt: "the deck, empty", place: sheets.ferryDeck }),
      }),
      timeline: () => animaticTimeline([shot("01", { duration: 5, build })]),
    });

  it("carries a keyframe's references down into one drawn from it", () => {
    const animatic = board(() => {
      const first = asset("first", keyframe, {
        prompt: "the two of them",
        left: sheets.ane,
        right: sheets.imouto,
      });
      const last = asset("last", keyframe, { prompt: "they have moved", place: first });
      return (
        <Composition>
          <Panel src={first} {...moves} />
          <Panel src={last} />
        </Composition>
      );
    });

    // `refs` is a set in list form, so it is compared as one.
    expect(
      listPanelReferenceReach(animatic).map((p) => ({ ...p, refs: [...p.refs].sort() })),
    ).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        refs: ["ane", "imouto"],
        generative: true,
      },
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.last",
        refs: ["ane", "imouto"],
        generative: true,
      },
    ]);
  });

  it("reaches a reference through the plate a keyframe stands on", () => {
    // Hand-built: the terse `shot()` helper bypasses `timeline`, so a build cannot be handed the
    // plate handle.
    const plated = {
      shots: [
        {
          id: "01",
          panels: [{ assetPath: "animatic:shot.01.first" }],
          assets: {
            first: { kind: "comfy", inputs: { image: "__konte:animatic:plate.front__" } },
          },
        },
      ],
      plates: {
        front: { kind: "comfy", inputs: { image: "__konte:reference:ferryDeck__" } },
      },
    } as unknown as Parameters<typeof listPanelReferenceReach>[0];

    expect(listPanelReferenceReach(plated)).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        refs: ["ferryDeck"],
        generative: true,
      },
    ]);
  });

  it("reports a chain that generates nothing", () => {
    // Every step deterministic, so `character-unconsumed` steps over the panel.
    const animatic = board(() => {
      const first = asset("first", adapters.imageResize, {
        image: sheets.ane,
        width: 640,
        height: 480,
      });
      return (
        <Composition>
          <Panel src={first} {...moves} />
        </Composition>
      );
    });

    expect(listPanelReferenceReach(animatic)[0]).toMatchObject({
      refs: ["ane"],
      generative: false,
    });
  });

  it("stops at a reference rather than walking what the sheet was built from", () => {
    // `sheets.ferryDeck` is itself a generative asset with inputs of its own.
    const animatic = board(() => {
      const first = asset("first", keyframe, {
        prompt: "on the deck",
        place: sheets.ferryDeck,
        left: sheets.ane,
      });
      return (
        <Composition>
          <Panel src={first} {...moves} />
        </Composition>
      );
    });

    expect([...listPanelReferenceReach(animatic)[0]!.refs].sort()).toEqual(["ane", "ferryDeck"]);
  });

  it("terminates on a chain that loops back on itself", () => {
    // Not reachable through the DSL (a cycle is a load error), so the guard is exercised on a
    // hand-built definition.
    const looped = {
      shots: [
        {
          id: "01",
          panels: [{ assetPath: "animatic:shot.01.a" }],
          assets: {
            a: { kind: "comfy", inputs: { image: "__konte:animatic:shot.01.b__" } },
            b: { kind: "comfy", inputs: { image: "__konte:animatic:shot.01.a__" } },
          },
        },
      ],
    } as unknown as Parameters<typeof listPanelReferenceReach>[0];

    expect(listPanelReferenceReach(looped)).toEqual([
      { shotId: "01", lane: "main", panel: "animatic:shot.01.a", refs: [], generative: true },
    ]);
  });
});

// The text half of the same panels — what `subject-unnamed` reads for each subject's
// `promptDepiction`.
describe("listPlateRecrops", () => {
  const plated = defineComfyAsset({
    workflow: "plated.json",
    description: "test keyframe adapter taking its pictures in numbered slots",
    inputs: {
      prompt: { nodeId: "1", field: "text", type: "prompt" },
      image1: { nodeId: "2", field: "image", type: "image" },
      image2: { nodeId: "3", field: "image", type: "image" },
    },
    outputs: { result: { nodeId: "9", type: "image" } },
  });

  const frames = [{ shotId: "01", lane: "main" as const, setup: "front" }];

  // The build closure captures the plates `timeline` was handed, which the terse `shot()` helper
  // cannot pass itself.
  const board = (build: (plate: never) => React.ReactElement) =>
    defineAnimatic(testDirection(format), {
      plates: () => ({
        front: asset("front", keyframe, { prompt: "the studio, empty", place: sheets.ferryDeck }),
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => build(plates.front as never),
          }),
        ]),
    });

  const window = { x: 0, y: 0, width: 32, height: 32 };

  it("lists a keyframe that crops the plate", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", plated, {
            image1: asset("stage", adapters.imageCrop, { image: plate, ...window }),
            prompt: "her at the desk",
          })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateRecrops(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", panel: "animatic:shot.01.first" },
    ]);
  });

  it("lists a panel that is the crop itself", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel src={asset("first", adapters.imageCrop, { image: plate, ...window })} {...moves} />
      </Composition>
    ));

    expect(listPlateRecrops(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", panel: "animatic:shot.01.first" },
    ]);
  });

  it("says nothing of a keyframe that takes the plate whole", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", plated, {
            image1: asset("fit", adapters.imageResize, {
              image: plate,
              width: 64,
              height: 64,
            }),
            prompt: "her at the desk",
          })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateRecrops(animatic, frames)).toEqual([]);
  });

  // A crop of the plate's whole stated frame changes nothing in it.
  it("says nothing of a crop that takes the whole plate", () => {
    const croppedPlate = (crop: { x: number; y: number; width: number; height: number }) =>
      defineAnimatic(testDirection(format), {
        plates: () => ({
          front: asset("front", adapters.imageCrop, { image: sheets.ferryDeck, ...window }),
        }),
        timeline: ({ plates }) =>
          animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Panel
                    src={asset("first", adapters.imageCrop, {
                      image: plates.front,
                      ...crop,
                    })}
                    {...moves}
                  />
                </Composition>
              ),
            }),
          ]),
      });

    expect(listPlateRecrops(croppedPlate({ x: 0, y: 0, width: 640, height: 480 }), frames)).toEqual(
      [],
    );
    expect(
      listPlateRecrops(croppedPlate({ x: 0, y: 0, width: 320, height: 240 }), frames),
    ).toHaveLength(1);
  });

  it("reads a resize's stated size as the frame a crop takes whole", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", adapters.imageCrop, {
            image: asset("fit", adapters.imageResize, {
              image: plate,
              width: 320,
              height: 240,
            }),
            x: 0,
            y: 0,
            width: 320,
            height: 240,
          })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateRecrops(animatic, frames)).toEqual([]);
  });

  // The plate's own window of its master is the setup's frame.
  it("does not count the crop the plate itself is", () => {
    const animatic = defineAnimatic(testDirection(format), {
      plates: () => ({
        front: asset("front", adapters.imageCrop, { image: sheets.ferryDeck, ...window }),
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", plated, {
                    image1: plates.front,
                    prompt: "her at the desk",
                  })}
                  {...moves}
                />
              </Composition>
            ),
          }),
        ]),
    });

    expect(listPlateRecrops(animatic, frames)).toEqual([]);
  });
});

// What `plate-unnamed` reads: the prompts a plate is generated with.
describe("listPlateTexts", () => {
  it("reads the plate's own prompt and those of the intermediates it is built from", () => {
    const animatic = defineAnimatic(testDirection(format), {
      plates: () => {
        const master = asset("master", keyframe, {
          prompt: "the whole deck",
          place: sheets.ferryDeck,
        });
        return { front: asset("front", keyframe, { prompt: "the bench, close", place: master }) };
      },
      timeline: () => animaticTimeline([]),
    });

    expect(listPlateTexts(animatic)).toEqual({ front: ["the bench, close", "the whole deck"] });
  });

  it("gives a plate whose chain reads no prompt an empty entry", () => {
    const animatic = defineAnimatic(testDirection(format), {
      plates: () => ({
        front: asset("front", adapters.imageCrop, {
          image: sheets.ferryDeck,
          x: 0,
          y: 0,
          width: 32,
          height: 32,
        }),
      }),
      timeline: () => animaticTimeline([]),
    });

    expect(listPlateTexts(animatic)).toEqual({ front: [] });
  });

  // A child plate cut in from its parent's frame.
  it("stops at another returned plate", () => {
    const occurrence = (address: string, value: string) => ({ address, input: "prompt", value });
    const nested = {
      shots: [],
      plates: {
        wide: { kind: "comfy", inputs: { image: "__konte:reference:ferryDeck__" } },
        close: { kind: "comfy", inputs: { image: "__konte:animatic:plate.wide__" } },
      },
      exposedPlateIds: ["wide", "close"],
      prompts: [
        occurrence("animatic:plate.wide", "the deck, the bench and the mast"),
        occurrence("animatic:plate.close", "in on the bench"),
      ],
    } as unknown as Parameters<typeof listPlateTexts>[0];

    expect(listPlateTexts(nested)).toEqual({
      wide: ["the deck, the bench and the mast"],
      close: ["in on the bench"],
    });
  });
});

describe("listPanelPromptText", () => {
  it("carries the prompts of every step behind a panel, panels in panel order", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const first = asset("first", keyframe, {
                prompt: "the elder sister on the bench",
                place: sheets.ferryDeck,
              });
              // Drawn from the first, so it stands on that frame's own prompt as well as its own.
              const last = asset("last", keyframe, { prompt: "she has stood up", place: first });
              return (
                <Composition>
                  <Panel src={first} {...moves} />
                  <Panel src={last} />
                </Composition>
              );
            },
          }),
        ]),
    });

    const panels = listPanelPromptText(animatic).map((p) => ({
      ...p,
      texts: [...p.texts].sort(),
    }));
    expect(panels).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        texts: ["the elder sister on the bench"],
        generative: true,
      },
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.last",
        texts: ["she has stood up", "the elder sister on the bench"],
        generative: true,
      },
    ]);
  });

  it("reports a chain that generates nothing", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", adapters.imageResize, {
                    image: sheets.ane,
                    width: 640,
                    height: 480,
                  })}
                  {...moves}
                />
              </Composition>
            ),
          }),
        ]),
    });

    expect(listPanelPromptText(animatic)[0]).toMatchObject({ texts: [], generative: false });
  });
});

describe("listShownReferences", () => {
  it("keeps a reference reaching the picture through no generative step", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              // Resized and then handed to a model: on screen only as the model redrew it.
              const fed = asset("fed", adapters.imageResize, {
                image: sheets.imouto,
                width: 640,
                height: 480,
              });
              const first = asset("first", keyframe, { prompt: "the deck", place: fed });
              const shown = asset("shown", adapters.imageResize, {
                image: sheets.ane,
                width: 640,
                height: 480,
              });
              return (
                <Composition>
                  <Panel src={first} {...moves} />
                  <Panel src={shown} />
                </Composition>
              );
            },
          }),
        ]),
    });

    expect(listShownReferences(animatic)).toEqual({ "01": ["ane"] });
  });
});

// The seam adapter: a model that reads another shot's panel as the frame the cut comes from.
const seamKeyframe = defineComfyAsset({
  workflow: "seam.json",
  description: "test seam keyframe adapter",
  inputs: {
    prompt: { nodeId: "1", field: "text", type: "prompt" },
    place: { nodeId: "2", field: "image", type: "image" },
    frame: { nodeId: "3", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
  readsPrevPanel: true,
});

describe("listShotContinuity", () => {
  const board = (frame?: string) =>
    defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", seamKeyframe, { prompt: "the two of them" })}
                  {...moves}
                />
                <Panel src={asset("last", seamKeyframe, { prompt: "she is alone" })} />
              </Composition>
            ),
          }),
          shot("02", {
            duration: 5,
            // The test `shot()` helper mints each shot off its own inline direction, so the ctx
            // accessor cannot reach across; the address the real one hands back is what matters here.
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", seamKeyframe, {
                    prompt: "in on her",
                    place: sheets.ferryDeck,
                    ...(frame ? { frame: makeMediaAsset<"image">(`__konte:${frame}__`) } : {}),
                  })}
                  {...moves}
                />
              </Composition>
            ),
          }),
        ]),
    });

  it("reads the seam panels of every developed shot, and what the opening one was handed", () => {
    const read = listShotContinuity(board("animatic:shot.01.last"));
    expect(read.map((entry) => entry.shotId)).toEqual(["01", "02"]);
    expect(read[0]?.lastPanel).toBe("animatic:shot.01.last");
    expect(read[1]?.carries).toBe(true);
    expect(read[1]?.linked).toContain("animatic:shot.01.last");
  });

  it("records a keyframe whose model reads a previous panel and was handed none", () => {
    const read = listShotContinuity(board());
    expect(read[1]?.carries).toBe(true);
    expect(read[1]?.linked).toEqual([]);
  });

  it("links nothing through an input that carries no other shot's panel", () => {
    const read = listShotContinuity(board("reference:ferryDeck"));
    expect(read[1]?.linked).toEqual([]);
  });
});

// A plate baked by a model that reads a previous panel (H3 R2I) under a panel drawn by one that does
// not.
const platePrevPanel = defineComfyAsset({
  workflow: "plate.json",
  description: "plate adapter reading a previous panel",
  inputs: {
    prompt: { nodeId: "1", field: "text", type: "prompt" },
    image: { nodeId: "2", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
  readsPrevPanel: true,
});

describe("a plate's own model is not the shot's", () => {
  it("does not report carries for a panel whose model reads no previous panel", () => {
    const animatic = defineAnimatic(testDirection(format), {
      plates: () => ({
        front: asset("front", platePrevPanel, { prompt: "the deck, empty" }),
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", keyframe, { prompt: "her", place: plates.front })}
                  {...moves}
                />
              </Composition>
            ),
          }),
        ]),
    });
    expect(listShotContinuity(animatic)[0]?.carries).toBe(false);
  });
});

// The seam of a long take is the opening keyframe, which the video's end pin is read against — so
// the panels are listed off a board on which no adapter reads a previous panel at all.
describe("a board reading no previous panel still lists its panels", () => {
  it("reads first and last panels, carrying nothing", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", keyframe, { prompt: "her" })} {...moves} />
                <Panel src={asset("last", keyframe, { prompt: "her, closer" })} />
              </Composition>
            ),
          }),
        ]),
    });
    expect(listShotContinuity(animatic)).toEqual([
      {
        shotId: "01",
        lane: "main",
        firstPanel: "animatic:shot.01.first",
        lastPanel: "animatic:shot.01.last",
        carries: false,
        linked: [],
      },
    ]);
  });
});

describe("a wrapped keyframe still answers for the seam", () => {
  it("reads the previous panel through a resize declared in the same shot", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const real = asset("real", seamKeyframe, {
                prompt: "in on her",
                frame: makeMediaAsset<"image">("__konte:animatic:shot.00.last__"),
              });
              return (
                <Composition>
                  <Panel
                    src={asset("wrapped", adapters.imageResize, {
                      image: real,
                      width: 64,
                      height: 64,
                    })}
                    {...moves}
                  />
                </Composition>
              );
            },
          }),
        ]),
    });
    const read = listShotContinuity(animatic)[0];
    expect(read?.firstPanel).toBe("animatic:shot.01.wrapped");
    expect(read?.carries).toBe(true);
    expect(read?.linked).toContain("animatic:shot.00.last");
  });
});

describe("the previous panel handed through a wrapper", () => {
  const board = (source: () => MediaAsset<"image">) =>
    defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", seamKeyframe, { prompt: "in on her", frame: source() })}
                  {...moves}
                />
              </Composition>
            ),
          }),
        ]),
    });

  it("does not link through a deterministic step of the shot's own", () => {
    const read = listShotContinuity(
      board(() =>
        asset("small", adapters.imageResize, {
          image: makeMediaAsset<"image">("__konte:animatic:shot.00.last__"),
          width: 64,
          height: 64,
        }),
      ),
    )[0];
    expect(read?.linked).toEqual([]);
  });

  it("does not link through a generative keyframe of the shot's own", () => {
    const read = listShotContinuity(
      board(() =>
        asset("sketch", keyframe, {
          prompt: "her",
          place: makeMediaAsset<"image">("__konte:animatic:shot.00.last__"),
        }),
      ),
    )[0];
    expect(read?.linked).toEqual([]);
  });
});
