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
  listPlateDescriptionUses,
  listShotContinuity,
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

const sheets = defineReference(plainDirection, () => ({
  ferryDeck: asset("ferryDeck", keyframe, { prompt: "the deck, empty" }),
  ane: asset("ane", keyframe, { prompt: "the elder sister" }),
  imouto: asset("imouto", keyframe, { prompt: "the younger sister" }),
}));

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
        front: {
          image: asset("front", keyframe, { prompt: "the deck, empty", place: sheets.ferryDeck }),
          prompt: "the ferry deck, the rail along its far side",
        },
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

// The plate's own sentence against the panels standing on it — the text half of the anchor rule.
describe("listPlateDescriptionUses", () => {
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

  const PLATE_PROMPT = "a plain studio, the desk under the window at the right edge";
  const frames = [{ shotId: "01", lane: "main" as const, setup: "front" }];

  // The build closure captures the plates `timeline` was handed, which the terse `shot()` helper
  // cannot pass itself.
  const board = (build: (plate: { image: never; prompt: string }) => React.ReactElement) =>
    defineAnimatic(testDirection(format), {
      plates: () => ({
        front: {
          image: asset("front", keyframe, { prompt: "the studio, empty", place: sheets.ferryDeck }),
          prompt: PLATE_PROMPT,
        },
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => build(plates.front as unknown as { image: never; prompt: string }),
          }),
        ]),
    });

  it("reads a panel whose prompt carries the plate's sentence", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", plated, {
            image1: plate.image,
            prompt: `<Picture 1> is the empty frame: ${plate.prompt}. She is at the desk.`,
          })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateDescriptionUses(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: true },
    ]);
  });

  // Which slot the picture arrives in is the adapter's grammar, not this finding's.
  it("reads the sentence whatever slot the plate arrives in", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", plated, {
            image2: plate.image,
            prompt: `<Picture 2> is the empty frame: ${plate.prompt}.`,
          })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateDescriptionUses(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: true },
    ]);
  });

  // The author rewrote the sentence and left the panel behind, or never wrote it in.
  it("marks a panel whose prompt does not carry the sentence", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", plated, {
            image1: plate.image,
            prompt: "the studio, her at the desk",
          })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateDescriptionUses(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: false },
    ]);
  });

  // Which panel reaches the plate is the shot's business; the sentence is read only off the panels
  // that DO reach it, since one written into a panel the plate never reached conditions nothing.
  it("does not let a panel outside the plate's reach carry the sentence", () => {
    const animatic = defineAnimatic(testDirection(format), {
      plates: () => ({
        front: {
          image: asset("front", keyframe, { prompt: "the studio, empty", place: sheets.ferryDeck }),
          prompt: PLATE_PROMPT,
        },
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", plated, {
                    image1: (plates.front as unknown as { image: never }).image,
                    prompt: "her at the desk",
                  })}
                  {...moves}
                />
                <Panel
                  src={asset("last", plated, {
                    image1: sheets.ane,
                    prompt: `she stands: ${PLATE_PROMPT}`,
                  })}
                />
              </Composition>
            ),
          }),
        ]),
    });

    expect(listPlateDescriptionUses(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: false },
    ]);
  });

  // A wrapper panel carries no text of its own, so reading the panel address alone would exempt a
  // shot whose real keyframe took the plate and dropped the sentence.
  it("reads the sentence off an intermediate the panel is derived from", () => {
    const board = (prompt: string) =>
      defineAnimatic(testDirection(format), {
        plates: () => ({
          front: {
            image: asset("front", keyframe, {
              prompt: "the studio, empty",
              place: sheets.ferryDeck,
            }),
            prompt: PLATE_PROMPT,
          },
        }),
        timeline: ({ plates }) =>
          animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                const base = asset("base", plated, {
                  image1: (plates.front as unknown as { image: never }).image,
                  prompt,
                });
                return (
                  <Composition>
                    <Panel
                      src={asset("first", adapters.imageResize, {
                        image: base,
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

    expect(listPlateDescriptionUses(board("her at the desk"), frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: false },
    ]);
    expect(listPlateDescriptionUses(board(`the frame holds ${PLATE_PROMPT}`), frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: true },
    ]);
  });

  // A branch the plate never entered conditions a picture of its own, so its prompt does not answer
  // for the frame.
  it("does not read a sibling branch that never stands on the plate", () => {
    const animatic = defineAnimatic(testDirection(format), {
      plates: () => ({
        front: {
          image: asset("front", keyframe, { prompt: "the studio, empty", place: sheets.ferryDeck }),
          prompt: PLATE_PROMPT,
        },
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const aside = asset("aside", plated, { prompt: `she stands: ${PLATE_PROMPT}` });
              return (
                <Composition>
                  <Panel
                    src={asset("first", plated, {
                      image1: (plates.front as unknown as { image: never }).image,
                      image2: aside,
                      prompt: "her at the desk",
                    })}
                    {...moves}
                  />
                </Composition>
              );
            },
          }),
        ]),
    });

    expect(listPlateDescriptionUses(animatic, frames)).toEqual([
      { setupId: "front", shotId: "01", lane: "main", describes: false },
    ]);
  });

  // No text the sentence could go in.
  it("steps over a keyframe that conditions on no prompt", () => {
    const animatic = board((plate) => (
      <Composition>
        <Panel
          src={asset("first", adapters.imageResize, { image: plate.image, width: 64, height: 64 })}
          {...moves}
        />
      </Composition>
    ));

    expect(listPlateDescriptionUses(animatic, frames)).toEqual([]);
  });
});

// The text half of the same panels — what `subject-unnamed` reads for each subject's
// `promptDepiction`.
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
        front: {
          image: asset("front", platePrevPanel, { prompt: "the deck, empty" }),
          prompt: "an empty deck",
        },
      }),
      timeline: ({ plates }) =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel
                  src={asset("first", keyframe, { prompt: "her", place: plates.front.image })}
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
