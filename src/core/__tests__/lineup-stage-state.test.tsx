import { describe, expect, it } from "vitest";
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

// The seam of a long take is the opening keyframe, which the video's end pin is read against.
describe("listShotContinuity", () => {
  it("reads the first and last panel of every developed shot", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", keyframe, { prompt: "the two of them" })} {...moves} />
                <Panel src={asset("last", keyframe, { prompt: "she is alone" })} />
              </Composition>
            ),
          }),
          shot("02", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", keyframe, { prompt: "in on her" })} {...moves} />
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
      },
      {
        shotId: "02",
        lane: "main",
        firstPanel: "animatic:shot.02.first",
        lastPanel: "animatic:shot.02.first",
      },
    ]);
  });

  it("names the panel the shot shows, not the keyframe a resize wraps", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const real = asset("real", keyframe, { prompt: "in on her" });
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
    expect(listShotContinuity(animatic)[0]?.firstPanel).toBe("animatic:shot.01.wrapped");
  });
});
