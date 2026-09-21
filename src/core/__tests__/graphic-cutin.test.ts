import { describe, expect, it } from "vitest";
import type { AnimaticSetupState } from "../direction-check.js";
import {
  checkDirection,
  directionWaiverKey,
  validateDirectionStructure,
  type StagingStageState,
} from "../direction.js";
import { directionShotCascadeTargets } from "../direction-acceptance.js";
import { directionPartHashes } from "../direction-hash.js";
import { directionPartContents } from "../direction-parts.js";
import type {
  Cutin,
  Direction,
  GraphicShot,
  NarrativeShot,
  Setup,
  Shot,
} from "../dsl/direction.js";

// A product demo: a studio desk where the presenter sits, a sofa across the room, and a UI screen
// shot between them. `desk` is the wipe's frame; `sofa` a second frame of the same studio.
const setups: Record<string, Setup> = {
  desk: {
    name: "the desk",
    description: "straight on at the desk",
    location: "studio",
    framing: "medium",
    holds: ["deskTop"],
    within: null,
  },
  sofa: {
    name: "the sofa",
    description: "across the room, at the sofa",
    location: "studio",
    framing: "medium",
    holds: ["couch"],
    within: null,
  },
  wide: {
    name: "the room",
    description: "from the door",
    location: "studio",
    framing: "wide",
    holds: ["deskTop", "couch"],
    within: null,
  },
  deskClose: {
    name: "the desk, close",
    description: "in on the desk",
    location: "studio",
    framing: "close",
    holds: ["deskTop"],
    within: null,
  },
};

const narrative = (id: string, extra: Partial<NarrativeShot> = {}): NarrativeShot => ({
  id,
  role: "ordinary",
  action: `shot ${id}`,
  setup: "desk",
  duration: 3,
  lineup: [],
  ...extra,
});

const graphic = (id: string, extra: Partial<GraphicShot> = {}): GraphicShot => ({
  kind: "graphic",
  id,
  role: "ordinary",
  action: `screen ${id}`,
  duration: 4,
  ...extra,
});

const wipe = (extra: Partial<Cutin> = {}): Cutin => ({
  setup: "desk",
  lineup: ["nazuna"],
  ...extra,
});

function direction(shots: Shot[], extra: Partial<Direction> = {}): Direction {
  return {
    brief: { logline: "a demo" },
    characters: {
      nazuna: { name: "Nazuna", promptDepiction: "girl in a maid apron", description: "presenter" },
      shogo: { name: "Shogo", promptDepiction: "man in a grey hoodie", description: "the user" },
    },
    locations: {
      studio: {
        name: "the studio",
        description: "a small studio",
        landmarks: {
          deskTop: { name: "the desk", promptDepiction: "desk", description: "centre" },
          couch: { name: "the sofa", promptDepiction: "sofa", description: "back wall" },
        },
      },
    },
    setups,
    policy: {
      format: { fps: 24, size: { megapixels: 0.52224, delivery: { width: 960, height: 544 } } },
      lang: "en",
      speech: "free",
    },
    sequence: { lens: "mini-drama", pleasure: "cute", shots },
    ...extra,
  };
}

const noStage: StagingStageState = {
  panelSlots: [],
  panelReach: [],
  plateUses: [],
  panelPrompts: [],
  platePrompts: {},
  videoPins: [],
  shotPanels: [],
};

const structure = (dir: Direction) => validateDirectionStructure(dir).map((e) => e.code);
const active = (dir: Direction, code: string, opts: Parameters<typeof checkDirection>[1] = {}) =>
  checkDirection(dir, opts).active.filter((f) => f.code === code);

describe("a graphic shot", () => {
  it("is structurally whole with no setup or lineup of its own", () => {
    expect(structure(direction([narrative("01"), graphic("02")]))).toEqual([]);
  });

  it("stays in the arc, so the narrative shots either side of it are not adjacent", () => {
    // medium → wide in one studio on two cameras binds backgrounds when cut adjacently.
    const cut = direction([narrative("01"), narrative("02", { setup: "wide" })]);
    expect(active(cut, "undeclared-continuity").map((f) => f.subject)).toEqual(["01-02"]);
    const split = direction([narrative("01"), graphic("02"), narrative("03", { setup: "wide" })]);
    expect(active(split, "undeclared-continuity")).toEqual([]);
  });

  it("breaks a main-frame long take: `continuous` after it is impossible", () => {
    const dir = direction([graphic("01"), narrative("02", { join: "continuous" })]);
    const errors = validateDirectionStructure(dir).filter((e) => e.code === "join-impossible");
    expect(errors.map((e) => e.subject)).toEqual(["02"]);
    expect(errors[0]!.message).toContain("graphic shot");
  });

  it("casts a voice for a character only a graphic shot gives lines to", () => {
    const dir = direction([
      narrative("01"),
      graphic("02", { script: [{ character: "nazuna", text: "drag it here" }] }),
    ]);
    const missing = active(dir, "character-voice-missing", { referenceAssetNames: [] });
    expect(missing.map((f) => f.subject)).toEqual(["nazuna"]);
  });

  it("is signed off with its act and no setup", () => {
    const dir = direction([narrative("01"), graphic("02")]);
    expect(directionShotCascadeTargets(dir).get("02")).toEqual([
      "direction:sequence.shots.02",
      "direction:sequence",
    ]);
  });
});

describe("cutin structure", () => {
  it("checks the cutin's setup and lineup like a shot's own", () => {
    const dir = direction([
      graphic("01", { cutin: wipe({ setup: "nowhere", lineup: ["nazuna", "ghost", "nazuna"] }) }),
    ]);
    const errors = validateDirectionStructure(dir);
    expect(errors.map((e) => [e.code, e.subject])).toEqual(
      expect.arrayContaining([
        ["setup-unknown", "01.cutin"],
        ["lineup-unknown-id", "01.cutin:ghost"],
        ["lineup-duplicate", "01.cutin:nazuna"],
      ]),
    );
    expect(errors.find((e) => e.code === "setup-unknown")!.message).toContain("cutin");
  });

  it("runs a wipe on only from the wipe over the shot before it", () => {
    const opening = direction([graphic("01", { cutin: wipe({ join: "continuous" }) })]);
    expect(structure(opening)).toContain("join-impossible");

    const noWipeBefore = direction([
      narrative("01"),
      graphic("02", { cutin: wipe({ join: "continuous" }) }),
    ]);
    const impossible = validateDirectionStructure(noWipeBefore).find(
      (e) => e.code === "join-impossible",
    )!;
    expect(impossible.subject).toBe("02.cutin");
    expect(impossible.message).toContain("carries no cutin");

    const otherSetup = direction([
      graphic("01", { cutin: wipe({ setup: "sofa" }) }),
      graphic("02", { cutin: wipe({ join: "continuous" }) }),
    ]);
    expect(structure(otherSetup)).toContain("join-impossible");
  });

  it("demands the wipe's join where the wipe before it is on the same setup", () => {
    const undeclared = direction([
      graphic("01", { cutin: wipe() }),
      graphic("02", { cutin: wipe() }),
    ]);
    const errors = validateDirectionStructure(undeclared).filter(
      (e) => e.code === "join-undeclared",
    );
    expect(errors.map((e) => e.subject)).toEqual(["02.cutin"]);
    expect(errors[0]!.message).toContain("cutin.join");

    const declared = direction([
      graphic("01", { cutin: wipe() }),
      graphic("02", { cutin: wipe({ join: "continuous" }) }),
    ]);
    expect(structure(declared)).toEqual([]);
  });

  it("keeps the main frame's join apart from the wipe's", () => {
    // Same setup for both frames, one after the other: each lane owes its own declaration.
    const dir = direction([
      narrative("01", { cutin: wipe({ setup: "sofa" }) }),
      narrative("02", { join: "jump-forward", cutin: wipe({ setup: "sofa" }) }),
    ]);
    expect(validateDirectionStructure(dir).map((e) => [e.code, e.subject])).toEqual([
      ["join-undeclared", "02.cutin"],
    ]);
  });
});

describe("cutin staging", () => {
  it("shares the place's accumulation with the main frame", () => {
    const dir = direction([
      narrative("01", { lineup: ["nazuna", "shogo"] }),
      graphic("02", { cutin: wipe({ setup: "sofa", lineup: ["shogo", "nazuna"] }) }),
    ]);
    expect(active(dir, "lineup-flipped").map((f) => f.subject)).toEqual(["02.cutin"]);
  });

  it("empties every place on a jump in either frame", () => {
    const dir = direction([
      narrative("01", { lineup: ["nazuna", "shogo"] }),
      narrative("02", {
        setup: "sofa",
        lineup: ["shogo", "nazuna"],
        cutin: wipe({ setup: "wide", lineup: [], join: "jump-forward" }),
      }),
    ]);
    expect(active(dir, "lineup-flipped")).toEqual([]);
  });

  it("names the main frame and the wipe apart, so one waiver never silences the other", () => {
    const shots = [
      narrative("01", {
        lineup: ["nazuna"],
        lineupTo: ["nazuna"],
        cutin: wipe({ setup: "sofa", lineup: ["shogo"], lineupTo: ["shogo"] }),
      }),
    ];
    const vacuous = active(direction(shots), "lineup-vacuous");
    expect(vacuous.map(directionWaiverKey)).toEqual([
      "lineup-vacuous_01",
      "lineup-vacuous_01.cutin",
    ]);

    const waived = direction(shots);
    waived.sequence.waivers = { "lineup-vacuous_01": "kept on purpose" };
    expect(active(waived, "lineup-vacuous").map((f) => f.subject)).toEqual(["01.cutin"]);
  });

  it("reads a continuous wipe's seam against the wipe before it, not the main frame between", () => {
    const dir = direction([
      narrative("01", { lineup: ["shogo"], cutin: wipe({ lineup: ["nazuna"] }) }),
      narrative("02", {
        setup: "sofa",
        lineup: ["shogo"],
        cutin: wipe({ lineup: ["nazuna"], join: "continuous" }),
      }),
    ]);
    expect(active(dir, "join-lineup-mismatch")).toEqual([]);

    const mismatch = direction([
      narrative("01", { lineup: ["nazuna"], cutin: wipe({ lineup: ["shogo"] }) }),
      narrative("02", {
        setup: "sofa",
        lineup: ["nazuna"],
        cutin: wipe({ lineup: ["nazuna"], join: "continuous" }),
      }),
    ]);
    expect(active(mismatch, "join-lineup-mismatch").map((f) => f.subject)).toEqual(["02.cutin"]);
  });

  it("holds the wipe's keyframes to the wipe's lineup", () => {
    const dir = direction([graphic("01", { cutin: wipe() })]);
    const stagingStage: StagingStageState = {
      ...noStage,
      panelReach: [
        {
          shotId: "01",
          lane: "cutin",
          panel: "animatic:shot.01.presenter",
          refs: [],
          generative: true,
        },
      ],
      panelPrompts: [
        {
          shotId: "01",
          lane: "cutin",
          panel: "animatic:shot.01.presenter",
          texts: ["a desk"],
          generative: true,
        },
      ],
    };
    const opts = { stagingStage, referenceAssetNames: ["nazuna"] };
    expect(active(dir, "character-unconsumed", opts).map((f) => f.subject)).toEqual([
      "01.cutin.nazuna",
    ]);
    expect(active(dir, "subject-unnamed", opts).map((f) => f.subject)).toEqual(["01.cutin.nazuna"]);

    // A main-lane panel of the same shot answers for nothing the wipe declares.
    const mainOnly: StagingStageState = {
      ...noStage,
      panelReach: [{ ...stagingStage.panelReach[0]!, lane: "main", refs: ["nazuna"] }],
    };
    expect(
      active(dir, "character-unconsumed", {
        stagingStage: mainOnly,
        referenceAssetNames: ["nazuna"],
      }),
    ).toEqual([]);
  });

  it("judges a continuous wipe's seam off the video's cutin pins, at the wipe's own seam frame", () => {
    const dir = direction([
      graphic("01", { cutin: wipe() }),
      graphic("02", { cutin: wipe({ join: "continuous" }) }),
    ]);
    const shotPanels: StagingStageState["shotPanels"] = ["01", "02"].map((shotId) => ({
      shotId,
      lane: "cutin" as const,
      firstPanel: `animatic:shot.${shotId}.presenter`,
      lastPanel: `animatic:shot.${shotId}.presenter`,
      carries: false,
      linked: [],
    }));
    const pins = (before: string[]): StagingStageState => ({
      ...noStage,
      shotPanels,
      videoPins: [
        // The main frame's end pin answers for no wipe.
        {
          shotId: "01",
          lane: "main",
          pins: [{ pin: "end", reaches: ["animatic:shot.02.presenter"] }],
          slots: ["start", "end"],
        },
        {
          shotId: "01",
          lane: "cutin",
          pins: before.map((reach) => ({ pin: "end" as const, reaches: [reach] })),
          slots: ["start", "end"],
        },
        { shotId: "02", lane: "cutin", pins: [], slots: ["start", "end"] },
      ],
    });
    expect(active(dir, "join-unpinned", { stagingStage: pins([]) }).map((f) => f.subject)).toEqual([
      "02.cutin",
    ]);
    expect(
      active(dir, "join-unpinned", { stagingStage: pins(["animatic:shot.02.presenter"]) }),
    ).toEqual([]);
  });
});

describe("cutin setups", () => {
  const plates = (): AnimaticSetupState => ({
    plateIds: [],
    unanchoredPlateIds: [],
    unnestedPlateIds: [],
    unconsumedBy: new Map(),
    deterministicShotsPerSetup: new Map(),
  });

  it("counts a wipe as a shot on its setup", () => {
    const dir = direction([
      narrative("01", { setup: "sofa" }),
      graphic("02", { cutin: wipe() }),
      graphic("03", { cutin: wipe({ join: "jump-forward" }) }),
    ]);
    const { active: found } = checkDirection(dir, {
      referenceAssetNames: ["studio"],
      animaticSetups: plates(),
    });
    expect(found.filter((f) => f.code === "unused-setup").map((f) => f.subject)).not.toContain(
      "desk",
    );
    expect(found.filter((f) => f.code === "setup-unrealized").map((f) => f.subject)).toEqual([
      "desk",
    ]);
  });

  it("owes plates for two wipes cut along one camera axis", () => {
    const dir = direction([
      graphic("01", { cutin: wipe({ setup: "wide", lineup: [] }) }),
      graphic("02", { cutin: wipe({ setup: "deskClose" }) }),
    ]);
    // `deskClose` names no `within`, so the pair is two cameras, not one axis.
    expect(
      active(dir, "axis-unrealized", { referenceAssetNames: ["studio"], animaticSetups: plates() }),
    ).toEqual([]);
    const onAxis = direction(
      [
        graphic("01", { cutin: wipe({ setup: "wide", lineup: [] }) }),
        graphic("02", { cutin: wipe({ setup: "desk" }) }),
      ],
      { setups: { ...setups, desk: { ...setups.desk!, within: "wide" } } },
    );
    expect(
      active(onAxis, "axis-unrealized", {
        referenceAssetNames: ["studio"],
        animaticSetups: plates(),
      }).map((f) => f.subject),
    ).toEqual(["desk.wide"]);
  });

  it("signs a wipe's setup off with the shot it is over", () => {
    const dir = direction([narrative("01", { setup: "sofa", cutin: wipe() })]);
    expect(directionShotCascadeTargets(dir).get("01")).toEqual([
      "direction:sequence.shots.01",
      "direction:setups.sofa",
      "direction:setups.desk",
      "direction:sequence",
    ]);
  });
});

describe("cutin and graphic hashes", () => {
  const shotPart = "direction:sequence.shots.02";
  const rootPart = "direction:sequence";
  const hashes = (shots: Shot[]) => directionPartHashes(direction(shots));
  const base = [narrative("01"), graphic("02", { cutin: wipe() })];

  it("ages out the shot and the arc on a wipe's setup or join", () => {
    const before = hashes(base);
    for (const edited of [
      [narrative("01"), graphic("02", { cutin: wipe({ setup: "sofa" }) })],
      [narrative("01"), graphic("02", { cutin: wipe({ join: "jump-forward" }) })],
      [narrative("01"), graphic("02")],
    ]) {
      const after = hashes(edited);
      expect(after.get(shotPart)).not.toBe(before.get(shotPart));
      expect(after.get(rootPart)).not.toBe(before.get(rootPart));
    }
  });

  it("ages out only the shot on who the wipe holds", () => {
    const before = hashes(base);
    const after = hashes([narrative("01"), graphic("02", { cutin: wipe({ lineup: ["shogo"] }) })]);
    expect(after.get(shotPart)).not.toBe(before.get(shotPart));
    expect(after.get(rootPart)).toBe(before.get(rootPart));
  });

  it("ages out a graphic shot on its action, and not the arc", () => {
    const before = hashes(base);
    const after = hashes([narrative("01"), graphic("02", { action: "another", cutin: wipe() })]);
    expect(after.get(shotPart)).not.toBe(before.get(shotPart));
    expect(after.get(rootPart)).toBe(before.get(rootPart));
  });

  it("shows a graphic shot with its cutin and no frame of its own", () => {
    expect(directionPartContents(direction(base)).get(shotPart)).toEqual({
      kind: "graphic",
      id: "02",
      role: "ordinary",
      duration: 4,
      action: "screen 02",
      script: [],
      telop: [],
      cutin: { setup: "desk", lineup: ["nazuna"], lineupTo: [], join: null },
    });
  });
});
