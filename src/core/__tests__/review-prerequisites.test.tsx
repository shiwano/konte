import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineAnimatic, Composition, Panel } from "../dsl/index.js";
import { findAllUnmetPrerequisites, type UnmetPrerequisite } from "../review-prerequisites.js";
import type { KonteState } from "../types/index.js";
import type { AnimaticDefinition } from "../types/animatic.js";
import { defineDirection } from "../dsl/direction.js";
import { directionDefaults, testDirection } from "./helpers/direction.js";
import { moves, pendingShot, shot, animaticTimeline } from "./helpers/shot.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const board = (build: () => React.ReactElement) =>
  defineAnimatic(
    testDirection({
      fps: 24,
      size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
    }),
    {
      timeline: () => animaticTimeline([shot("01", { duration: 5, build })]),
    },
  );

// A take that resolves: an unaccepted variant with a file on disk.
function stateWithVariants(...addresses: string[]): KonteState {
  const assets: KonteState["assets"] = {};
  for (const [i, address] of addresses.entries()) {
    assets[address] = {
      variants: {
        [`v-take${i}`]: {
          status: "none",
          file: `/tmp/take${i}.png`,
          definitionHash: null,
          outputHash: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          inputFingerprints: {},
          metadata: {},
        },
      },
    };
  }
  return { schemaVersion: 1, assets } as KonteState;
}

describe("findAllUnmetPrerequisites — animatic panel movement", () => {
  it("reports a panel holding a take with no movement", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} />
      </Composition>
    ));
    expect(
      findAllUnmetPrerequisites({ animatic: sb }, stateWithVariants("animatic:shot.01.first")),
    ).toEqual([
      {
        stage: "animatic",
        shotId: "01",
        address: "animatic:shot.01.first",
        variantId: "v-take0",
        missing: ["blocking", "camera"],
        writeIn: "animatic.tsx",
      },
    ]);
  });

  it("names only the half that is missing", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} blocking="she crosses the room" />
      </Composition>
    ));
    expect(
      findAllUnmetPrerequisites({ animatic: sb }, stateWithVariants("animatic:shot.01.first"))[0]
        ?.missing,
    ).toEqual(["camera"]);
  });

  // The whole point of deferring: you cannot write the transit out of a frame that does not exist
  // yet, so a panel with nothing generated is unbuilt, not unbound. Without this, `konte preview
  // animatic` would refuse before the first take ever came back.
  it("ignores a panel with no take yet", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} />
      </Composition>
    ));
    expect(findAllUnmetPrerequisites({ animatic: sb }, stateWithVariants())).toEqual([]);
  });

  it("ignores a bound panel", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} {...moves} />
      </Composition>
    ));
    expect(
      findAllUnmetPrerequisites({ animatic: sb }, stateWithVariants("animatic:shot.01.first")),
    ).toEqual([]);
  });

  it("ignores the landing keyframe, which nothing moves out of", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} {...moves} />
        <Panel src={asset("last", imageComfy, { prompt: "b" })} />
      </Composition>
    ));
    expect(
      findAllUnmetPrerequisites(
        { animatic: sb },
        stateWithVariants("animatic:shot.01.first", "animatic:shot.01.last"),
      ),
    ).toEqual([]);
  });

  it("still requires the panel before a landing keyframe", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} />
        <Panel src={asset("last", imageComfy, { prompt: "b" })} />
      </Composition>
    ));
    expect(
      findAllUnmetPrerequisites(
        { animatic: sb },
        stateWithVariants("animatic:shot.01.first", "animatic:shot.01.last"),
      ).map((u: UnmetPrerequisite) => u.address),
    ).toEqual(["animatic:shot.01.first"]);
  });

  // The seam of a long take is the next shot's opening keyframe, so the last panel before it is no
  // landing frame: it moves into that keyframe and owes its transit.
  it("requires the last panel of a shot the next shot runs on from", () => {
    const longTake = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "she waits",
            setup: "front",
            duration: 5,
            lineup: [],
          },
          {
            id: "02",
            role: "disruption",
            action: "she turns",
            setup: "front",
            join: "continuous",
            duration: 5,
            lineup: [],
          },
        ],
      },
    });
    const sb = defineAnimatic(longTake, {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", imageComfy, { prompt: "a" })} {...moves} />
                <Panel src={asset("last", imageComfy, { prompt: "b" })} />
              </Composition>
            ),
          }),
          shot("02", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", imageComfy, { prompt: "c" })} {...moves} />
              </Composition>
            ),
          }),
        ]),
    });
    expect(
      findAllUnmetPrerequisites(
        { animatic: sb },
        stateWithVariants(
          "animatic:shot.01.first",
          "animatic:shot.01.last",
          "animatic:shot.02.first",
        ),
      ).map((u: UnmetPrerequisite) => u.address),
    ).toEqual(["animatic:shot.01.last"]);
  });

  it("ignores an undeveloped shot, which carries no movement to place", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
      }),
      { timeline: () => animaticTimeline([pendingShot("01", { duration: 5 })]) },
    );
    expect(findAllUnmetPrerequisites({ animatic: sb }, stateWithVariants())).toEqual([]);
  });

  it("narrows to the given addresses", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} />
        <Panel src={asset("mid", imageComfy, { prompt: "b" })} />
        <Panel src={asset("last", imageComfy, { prompt: "c" })} />
      </Composition>
    ));
    const state = stateWithVariants(
      "animatic:shot.01.first",
      "animatic:shot.01.mid",
      "animatic:shot.01.last",
    );
    expect(
      findAllUnmetPrerequisites({ animatic: sb }, state, new Set(["animatic:shot.01.mid"])).map(
        (u: UnmetPrerequisite) => u.address,
      ),
    ).toEqual(["animatic:shot.01.mid"]);
  });
});

// A shared reference image used as a panel is reviewed on the board, so its staging is owed there —
// but its ADDRESS belongs to the reference stage, which declares no prerequisites. Asking by the
// address's own stage would wave it through, and nothing downstream would catch it: the video spend
// gate's acceptance walk stops at reference nodes too. So an accept has to sweep every collector.
describe("findAllUnmetPrerequisites — a reference asset used as a panel", () => {
  const referencePanel = "reference:bg";
  const sb: AnimaticDefinition = {
    stage: "animatic" as const,
    typography: { lang: "en" as const },
    format: { size: { width: 100, height: 100 }, fps: 30 },
    shots: [
      {
        id: "01",
        duration: 5,
        action: "test shot",
        assets: {},
        panels: [{ assetName: "bg", assetPath: referencePanel, start: 0, duration: 1 }],
      },
    ],
  };
  const state = stateWithVariants(referencePanel);

  it("is caught by the sweep an accept uses", () => {
    expect(
      findAllUnmetPrerequisites({ animatic: sb }, state, new Set([referencePanel])).map(
        (u: UnmetPrerequisite) => [u.stage, u.address, u.missing],
      ),
    ).toEqual([["animatic", referencePanel, ["blocking", "camera"]]]);
  });
});
