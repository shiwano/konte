import { describe, expect, it } from "vitest";
import { checkDirection, validateDirectionStructure } from "../direction.js";
import type { StagingStageState } from "../direction.js";
import type { PinWindow } from "../direction-check.js";
import { defineDirection } from "../dsl/direction.js";
import type { Direction, DirectionNode, NarrativeShot, Setup } from "../dsl/direction.js";
import { directionDefaults } from "./helpers/direction.js";

// A ferry deck the way the amedama board is cut: three children along the port gunwale, the mother a
// step to their left, and two frames taken of them — one from inside the boat, one from the stern.
const deck: Setup = {
  name: "the children, close",
  description: "in the boat, across at the port bench",
  location: "ferryDeck",
  framing: "medium",
  holds: ["bench"],
};
const stern: Setup = {
  name: "the deck from the stern",
  description: "from the stern seat, the whole bench",
  location: "ferryDeck",
  framing: "wide",
  holds: ["bench", "mast"],
};
const shore: Setup = {
  name: "the landing",
  description: "on the jetty, looking back at the boat",
  location: "landing",
  framing: "wide",
  holds: ["jetty"],
};

function direction(opts: {
  shots: NarrativeShot[];
  setups?: Record<string, Setup>;
  characters?: Record<string, { name: string; promptDepiction: string; description: string }>;
  waivers?: Record<string, string>;
}): Direction {
  const node: DirectionNode = {
    lens: "mini-drama",
    pleasure: "cute",
    shots: opts.shots,
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
  };
  return {
    characters: opts.characters ?? {
      mother: { name: "the mother", promptDepiction: "mother", description: "the mother" },
      ane: { name: "the sister", promptDepiction: "elder sister", description: "the elder sister" },
      imouto: {
        name: "the little one",
        promptDepiction: "little sister",
        description: "the younger sister",
      },
    },
    props: { ame: { name: "the sweet", description: "a paper-wrapped sweet" } },
    locations: {
      ferryDeck: {
        name: "the ferry deck",
        description: "a flat-bottomed ferry",
        landmarks: {
          bench: {
            name: "the port bench",
            promptDepiction: "bench",
            description: "the long bench down the port side",
          },
          mast: {
            name: "the mast",
            promptDepiction: "mast",
            description: "the stubby mast amidships",
          },
        },
      },
      landing: {
        name: "the landing",
        description: "a wooden jetty",
        landmarks: {
          jetty: {
            name: "the jetty",
            promptDepiction: "jetty",
            description: "the wooden jetty the boat ties to",
          },
        },
      },
    },
    setups: opts.setups ?? { deck, stern, shore },
    sequence: node,
  } as unknown as Direction;
}

// The board half of the staging class with nothing in it — each case fills in the one reading it
// exercises, and the readings it does not name stay silent rather than absent (an absent one would
// leave the whole class unevaluated).
const noStage: StagingStageState = {
  panelSlots: [],
  panelReach: [],
  plateUses: [],
  panelPrompts: [],
  platePrompts: {},
  videoPins: [],
  shotPanels: [],
};

const shot = (id: string, setup: string, extra: Partial<NarrativeShot> = {}): NarrativeShot =>
  ({
    id,
    role: "ordinary",
    action: "a shot",
    setup,
    duration: 3,
    lineup: [],
    ...extra,
  }) as NarrativeShot;

const codes = (dir: Direction, code: string) =>
  checkDirection(dir).active.filter((f) => f.code === code);

describe("the accumulated order", () => {
  it("passes a later shot that agrees with what an earlier one declared", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane", "imouto"] }),
        shot("02", "stern", { lineup: ["ane", "imouto"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toEqual([]);
  });

  it("flags a later shot that reverses a pair, naming the shot that said otherwise", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane", "imouto"] }),
        shot("02", "stern", { lineup: ["imouto", "ane"] }),
      ],
    });
    const found = codes(dir, "lineup-flipped");
    expect(found).toHaveLength(1);
    expect(found[0]!.subject).toBe("02");
    expect(found[0]!.message).toContain("shot 01");
  });

  it("takes a declared `lineupTo` as the change, so the shots after it read against the new order", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"], lineupTo: ["imouto", "ane"] }),
        shot("02", "stern", { lineup: ["imouto", "ane"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toEqual([]);
  });

  it("flushes every place on a story-time jump", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"] }),
        shot("02", "deck", { lineup: ["imouto", "ane"], join: "jump-forward" }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toEqual([]);
  });

  it("keeps each place's order to itself", () => {
    // The jetty says nothing about the deck: standing somewhere else is not a move.
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"] }),
        shot("02", "shore", { lineup: ["imouto", "ane"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toEqual([]);
  });

  it("still holds a place's order across a cutaway to another place", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"] }),
        shot("02", "shore", { lineup: ["mother"] }),
        shot("03", "deck", { lineup: ["imouto", "ane"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toHaveLength(1);
  });

  it("reads a frame the camera moved to as the same place", () => {
    // Two setups in one location share one accumulation — which is what makes crossing the line
    // between them visible at all.
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"] }),
        shot("02", "stern", { lineup: ["imouto", "ane"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toHaveLength(1);
  });

  it("says nothing about a one-subject frame that crossed the line", () => {
    // The amedama 24→25 case: a single figure re-framed from the other side leaves no pair to
    // settle, so the accumulation has nothing to contradict. Two or more is the whole limit.
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"] }),
        shot("02", "stern", { lineup: ["ane"] }),
        shot("03", "deck", { lineup: ["ane", "imouto"] }),
      ],
    });
    expect(checkDirection(dir).active.filter((f) => f.code.startsWith("lineup-"))).toEqual([]);
  });
});

describe("lineup-vacuous", () => {
  it("flags a `lineupTo` identical to the `lineup`", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: ["ane", "imouto"], lineupTo: ["ane", "imouto"] })],
    });
    expect(codes(dir, "lineup-vacuous")[0]?.subject).toBe("01");
  });

  it("passes an exit, which changes the members rather than the order", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: ["ane", "imouto"], lineupTo: ["ane"] })],
    });
    expect(codes(dir, "lineup-vacuous")).toEqual([]);
  });
});

describe("a `lineupTo` states the whole exit frame", () => {
  it("drops whoever walked out of frame, so their place stops being known", () => {
    // ane is in the opening frame and not the closing one, so she left it.
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane", "imouto"], lineupTo: ["imouto", "mother"] }),
        shot("02", "stern", { lineup: ["ane", "mother"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toEqual([]);
    expect(codes(dir, "lineup-inconsistent")).toEqual([]);
  });

  it("still holds whoever the exit frame does name", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane", "imouto"], lineupTo: ["imouto", "mother"] }),
        shot("02", "stern", { lineup: ["mother", "imouto"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toHaveLength(1);
  });
});

describe("lineup-inconsistent", () => {
  it("flags a seating no single shot gets wrong but the three together cannot hold", () => {
    // Each pair reads fine on its own, and no two of them were ever framed together before, so
    // nothing is flipped — yet a < b, b < c and c < a cannot be laid on one line.
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane"] }),
        shot("02", "stern", { lineup: ["ane", "imouto"] }),
        shot("03", "deck", { lineup: ["imouto", "mother"] }),
      ],
    });
    const found = codes(dir, "lineup-inconsistent");
    expect(found).toHaveLength(1);
    expect(found[0]!.subject).toBe("03");
    expect(codes(dir, "lineup-flipped")).toEqual([]);
  });

  it("reports the ring once and keeps reading the shots after it", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane"] }),
        shot("02", "stern", { lineup: ["ane", "imouto"] }),
        shot("03", "deck", { lineup: ["imouto", "mother"] }),
        shot("04", "stern", { lineup: ["imouto", "mother"] }),
      ],
    });
    expect(codes(dir, "lineup-inconsistent")).toHaveLength(1);
  });
});

describe("lineup-gap", () => {
  it("flags a frame that spans someone it does not hold", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "mother", "imouto"] }),
        shot("02", "stern", { lineup: ["ane", "imouto"] }),
      ],
    });
    const found = codes(dir, "lineup-gap");
    expect(found).toHaveLength(1);
    expect(found[0]!.subject).toBe("02");
    expect(found[0]!.message).toContain("mother");
  });

  it("says nothing once the frame holds them", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "mother", "imouto"] }),
        shot("02", "stern", { lineup: ["ane", "mother", "imouto"] }),
      ],
    });
    expect(codes(dir, "lineup-gap")).toEqual([]);
  });

  it("says nothing about someone standing outside the span", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["mother", "ane", "imouto"] }),
        shot("02", "stern", { lineup: ["ane", "imouto"] }),
      ],
    });
    expect(codes(dir, "lineup-gap")).toEqual([]);
  });

  it("says nothing once a `lineupTo` has walked them out of frame", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", {
          lineup: ["ane", "mother", "imouto"],
          lineupTo: ["ane", "imouto"],
        }),
        shot("02", "stern", { lineup: ["ane", "imouto"] }),
      ],
    });
    expect(codes(dir, "lineup-gap")).toEqual([]);
  });

  it("reads the span end to end, not neighbour by neighbour", () => {
    // mother's place beside boatman was never declared, so a neighbour-by-neighbour read would
    // miss her; the frame still runs from ane to imouto and she is inside it.
    const dir = direction({
      characters: {
        mother: { name: "the mother", description: "the mother", promptDepiction: "mother" },
        ane: { name: "the sister", description: "the elder sister", promptDepiction: "ane" },
        imouto: {
          name: "the little one",
          description: "the younger sister",
          promptDepiction: "imouto",
        },
        boatman: { name: "the boatman", description: "the boatman", promptDepiction: "boatman" },
      },
      shots: [
        shot("01", "deck", { lineup: ["ane", "mother", "imouto"] }),
        shot("02", "stern", { lineup: ["ane", "boatman", "imouto"] }),
      ],
    });
    expect(codes(dir, "lineup-gap")[0]?.message).toContain("mother");
  });

  it("says nothing where the order itself is already contradicted", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "mother", "imouto"] }),
        shot("02", "stern", { lineup: ["imouto", "ane"] }),
      ],
    });
    expect(codes(dir, "lineup-flipped")).toHaveLength(1);
    expect(codes(dir, "lineup-gap")).toEqual([]);
  });

  it("forgets the span across a story-time jump", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "mother", "imouto"] }),
        shot("02", "deck", { lineup: ["ane", "imouto"], join: "jump-forward" }),
      ],
    });
    expect(codes(dir, "lineup-gap")).toEqual([]);
  });
});

describe("character-unconsumed", () => {
  const dir = direction({ shots: [shot("01", "deck", { lineup: ["ane", "imouto"] })] });
  const refs = ["ane", "imouto", "ferryDeck"];
  const reach = (refsHeld: string[], generative = true): StagingStageState => ({
    ...noStage,
    panelSlots: [],
    plateUses: [],
    panelReach: [
      { shotId: "01", lane: "main", panel: "animatic:shot.01.first", refs: refsHeld, generative },
    ],
  });
  const found = (d: Direction, stagingStage: StagingStageState) =>
    checkDirection(d, { stagingStage, referenceAssetNames: refs }).active.filter(
      (f) => f.code === "character-unconsumed",
    );

  it("flags a subject the frame holds that the keyframe is built from no reference to", () => {
    expect(found(dir, reach(["ferryDeck", "ane"])).map((f) => f.subject)).toEqual(["01.imouto"]);
  });

  it("says nothing once every subject's reference is in the chain", () => {
    expect(found(dir, reach(["ferryDeck", "ane", "imouto"]))).toEqual([]);
  });

  it("reads the chain, so a keyframe inherits what an earlier one stood on", () => {
    expect(found(dir, reach(["ane", "imouto"]))).toEqual([]);
  });

  it("asks nothing of a keyframe that generates nothing", () => {
    expect(found(dir, reach([], false))).toEqual([]);
  });

  it("waits on the reference existing", () => {
    const findings = checkDirection(dir, {
      stagingStage: reach(["ferryDeck"]),
      referenceAssetNames: ["ferryDeck"],
    }).active.filter((f) => f.code === "character-unconsumed");
    expect(findings).toEqual([]);
  });

  it("holds the last keyframe to the `lineupTo`", () => {
    const moved = direction({
      shots: [shot("01", "deck", { lineup: ["ane"], lineupTo: ["ane", "imouto"] })],
    });
    const findings = found(moved, {
      ...noStage,
      panelSlots: [],
      plateUses: [],
      panelReach: [
        {
          shotId: "01",
          lane: "main",
          panel: "animatic:shot.01.first",
          refs: ["ane"],
          generative: true,
        },
        {
          shotId: "01",
          lane: "main",
          panel: "animatic:shot.01.last",
          refs: ["ane"],
          generative: true,
        },
      ],
    });
    expect(findings.map((f) => f.subject)).toEqual(["01.imouto"]);
  });

  // The frame a `lineupTo` describes is the seam of the long take, which is the NEXT shot's opening
  // keyframe — read there against its `lineup`, which `join-lineup-mismatch` makes the same.
  it("reads no last keyframe of a shot the next shot runs on from", () => {
    const longTake = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane"], lineupTo: ["ane", "imouto"] }),
        shot("02", "deck", { lineup: ["ane", "imouto"], join: "continuous" }),
      ],
    });
    const panel = (shotId: string, name: string, refs: string[]) => ({
      shotId,
      lane: "main" as const,
      panel: `animatic:shot.${shotId}.${name}`,
      refs,
      generative: true,
    });
    const stage = (opening: string[]): StagingStageState => ({
      ...noStage,
      panelReach: [
        panel("01", "first", ["ane"]),
        panel("01", "last", ["ane"]),
        panel("02", "first", opening),
      ],
    });
    expect(found(longTake, stage(["ane", "imouto"]))).toEqual([]);
    expect(found(longTake, stage(["ane"])).map((f) => f.subject)).toEqual(["02.imouto"]);
  });

  it("reports a subject once for a shot, however many keyframes miss it", () => {
    const moved = direction({
      shots: [shot("01", "deck", { lineup: ["ane"], lineupTo: ["ane"] })],
    });
    const findings = found(moved, {
      ...noStage,
      panelSlots: [],
      plateUses: [],
      panelReach: [
        { shotId: "01", lane: "main", panel: "animatic:shot.01.first", refs: [], generative: true },
        { shotId: "01", lane: "main", panel: "animatic:shot.01.last", refs: [], generative: true },
      ],
    });
    expect(findings.map((f) => f.subject)).toEqual(["01.ane"]);
  });

  it("asks nothing of an undeveloped shot", () => {
    expect(found(dir, noStage)).toEqual([]);
  });

  it("stays silent with no board to read", () => {
    expect(
      checkDirection(dir, { referenceAssetNames: refs }).active.filter(
        (f) => f.code === "character-unconsumed",
      ),
    ).toEqual([]);
  });
});

describe("slot-order-mismatch", () => {
  const dir = direction({
    shots: [shot("01", "deck", { lineup: ["ane", "imouto"] })],
  });

  it("flags a keyframe passing its references in an order the shot does not declare", () => {
    const found = checkDirection(dir, {
      stagingStage: {
        ...noStage,
        panelReach: [],
        plateUses: [],
        panelSlots: [
          {
            shotId: "01",
            lane: "main",
            panel: "animatic:shot.01.first",
            slots: ["ferryDeck", "imouto", "ane"],
          },
        ],
      },
    }).active.filter((f) => f.code === "slot-order-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("animatic:shot.01.first");
  });

  it("steps over the anchors the lineup has no opinion about", () => {
    const found = checkDirection(dir, {
      stagingStage: {
        ...noStage,
        panelReach: [],
        plateUses: [],
        panelSlots: [
          {
            shotId: "01",
            lane: "main",
            panel: "animatic:shot.01.first",
            slots: ["ane", "ferryDeck", "imouto"],
          },
        ],
      },
    }).active.filter((f) => f.code === "slot-order-mismatch");
    expect(found).toEqual([]);
  });

  it("holds the last keyframe to the `lineupTo`", () => {
    const moved = direction({
      shots: [shot("01", "deck", { lineup: ["ane", "imouto"], lineupTo: ["imouto", "ane"] })],
    });
    const found = checkDirection(moved, {
      stagingStage: {
        ...noStage,
        panelReach: [],
        plateUses: [],
        panelSlots: [
          { shotId: "01", lane: "main", panel: "animatic:shot.01.first", slots: ["ane", "imouto"] },
          { shotId: "01", lane: "main", panel: "animatic:shot.01.last", slots: ["ane", "imouto"] },
        ],
      },
    }).active.filter((f) => f.code === "slot-order-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("animatic:shot.01.last");
  });

  it("holds a lone keyframe to the `lineup` alone", () => {
    // One panel is the frame the shot OPENS on; where it ends is carried by that panel's `blocking`
    // into a picture no keyframe holds, so demanding both orders of one call would be nonsense.
    const moved = direction({
      shots: [shot("01", "deck", { lineup: ["ane", "imouto"], lineupTo: ["imouto", "ane"] })],
    });
    const found = checkDirection(moved, {
      stagingStage: {
        ...noStage,
        panelReach: [],
        plateUses: [],
        panelSlots: [
          { shotId: "01", lane: "main", panel: "animatic:shot.01.first", slots: ["ane", "imouto"] },
        ],
      },
    }).active.filter((f) => f.code === "slot-order-mismatch");
    expect(found).toEqual([]);
  });

  it("keeps two single-subject keyframes from inventing a slot order", () => {
    const found = checkDirection(dir, {
      stagingStage: {
        ...noStage,
        panelReach: [],
        plateUses: [],
        panelSlots: [
          { shotId: "01", lane: "main", panel: "animatic:shot.01.first", slots: ["imouto"] },
          { shotId: "01", lane: "main", panel: "animatic:shot.01.last", slots: ["ane"] },
        ],
      },
    }).active.filter((f) => f.code === "slot-order-mismatch");
    expect(found).toEqual([]);
  });

  it("stays silent with no board to read", () => {
    expect(codes(dir, "slot-order-mismatch")).toEqual([]);
  });
});

// A computed list has no literal for the type layer to blame, so it passes through exactly as a
// computed id does — and the structural check is what receives it.
describe("a lineup the type layer cannot read", () => {
  const cast: string[] = ["ane", "chichi"];
  const built = defineDirection({
    ...directionDefaults,
    characters: {
      ane: { name: "the sister", description: "the elder sister", promptDepiction: "ane" },
    },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        { id: "01", role: "ordinary", action: "a shot", setup: "front", duration: 3, lineup: cast },
      ],
    },
  });

  it("is caught at runtime instead", () => {
    const errors = validateDirectionStructure(built as unknown as Direction);
    expect(errors.map((e) => e.code)).toContain("lineup-unknown-id");
    expect(errors.find((e) => e.code === "lineup-unknown-id")?.subject).toBe("01:chichi");
  });
});

describe("lineup structure errors", () => {
  const errorCodes = (dir: Direction) => validateDirectionStructure(dir).map((e) => e.code);

  it("rejects an id in neither roster", () => {
    const dir = direction({ shots: [shot("01", "deck", { lineup: ["ane", "chichi"] })] });
    expect(errorCodes(dir)).toContain("lineup-unknown-id");
  });

  it("rejects a prop — a lineup is one axis, and a prop is as often in front as beside", () => {
    const dir = direction({ shots: [shot("01", "deck", { lineup: ["ane", "ame"] })] });
    expect(errorCodes(dir)).toContain("lineup-unknown-id");
  });

  it("rejects one subject listed twice", () => {
    const dir = direction({ shots: [shot("01", "deck", { lineup: ["ane", "ane"] })] });
    expect(errorCodes(dir)).toContain("lineup-duplicate");
  });

  it("rejects a shot that says nothing about its frame at all", () => {
    const bare = { id: "01", role: "ordinary", action: "a shot", setup: "deck", duration: 3 };
    const dir = direction({ shots: [bare as unknown as NarrativeShot] });
    expect(errorCodes(dir)).toContain("lineup-missing");
  });

  it("takes an empty lineup as the frame that holds no one", () => {
    const dir = direction({ shots: [shot("01", "deck", { lineup: [] })] });
    expect(errorCodes(dir)).not.toContain("lineup-missing");
  });

  it("rejects a blank acting note", () => {
    const dir = direction({
      shots: [shot("01", "deck", { script: [{ character: "ane", text: "はい。", acting: "  " }] })],
    });
    expect(errorCodes(dir)).toContain("script-empty-text");
  });
});

describe("the staging class is waivable and gates a spend", () => {
  it("takes a waiver keyed by the finding", () => {
    const dir = direction({
      shots: [
        shot("01", "deck", { lineup: ["ane", "imouto"] }),
        shot("02", "stern", { lineup: ["imouto", "ane"] }),
      ],
      waivers: { "lineup-flipped_02": "the camera comes round on purpose here" },
    });
    expect(codes(dir, "lineup-flipped")).toEqual([]);
    expect(checkDirection(dir).waived.map((f) => f.code)).toContain("lineup-flipped");
  });
});

describe("plate-undescribed", () => {
  const dir = direction({ shots: [shot("01", "deck", { lineup: [] })] });
  const state = (use: Partial<StagingStageState["plateUses"][number]>): StagingStageState => ({
    ...noStage,
    panelSlots: [],
    panelReach: [],
    plateUses: [{ setupId: "deck", shotId: "01", lane: "main", describes: true, ...use }],
  });
  const found = (stagingStage: StagingStageState) =>
    checkDirection(dir, { stagingStage }).active.filter((f) => f.code === "plate-undescribed");

  it("says nothing of a shot whose prompt carries the plate's sentence", () => {
    expect(found(state({}))).toEqual([]);
  });

  it("flags a shot whose prompt does not carry the plate's sentence", () => {
    const findings = found(state({ describes: false }));
    expect(findings.map((f) => f.subject)).toEqual(["deck"]);
    expect(findings[0]?.message).toContain("`plates.deck.prompt`");
  });

  // The sentence is the plate's, so one waiver answers for the frame rather than for one shot on it.
  it("is waived by the setup's key", () => {
    const waived = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      waivers: { "plate-undescribed_deck": "the crop is unmistakable on its own" },
    });
    expect(
      checkDirection(waived, { stagingStage: state({ describes: false }) }).active.filter(
        (f) => f.code === "plate-undescribed",
      ),
    ).toEqual([]);
  });

  it("stays silent with no board to read", () => {
    expect(checkDirection(dir).active.filter((f) => f.code === "plate-undescribed")).toEqual([]);
  });
});

describe("panel-unlinked", () => {
  // One camera axis over the bench: the stern frame is the whole boat, the deck frame a window cut
  // out of it. `shore` is a second place and stands on its own axis.
  const axis: Record<string, Setup> = {
    stern: { ...stern, within: null },
    deck: { ...deck, within: "stern" },
    shore: { ...shore, within: null },
  };
  // A second frame of the bench from its own camera position — same place and wider than `deck`, and
  // no window of anything.
  const offAxis: Record<string, Setup> = {
    ...axis,
    bow: { ...stern, name: "the deck from the bow", framing: "medium", within: null },
  };

  const board = (
    ...entries: { shotId: string; carries?: boolean; linked?: string[] }[]
  ): StagingStageState => ({
    ...noStage,
    shotPanels: entries.map(({ shotId, carries = true, linked = [] }) => ({
      shotId,
      lane: "main" as const,
      firstPanel: `animatic:shot.${shotId}.first`,
      lastPanel: `animatic:shot.${shotId}.last`,
      carries,
      linked,
    })),
  });

  const found = (dir: Direction, stagingStage: StagingStageState) =>
    checkDirection(dir, { stagingStage }).active.filter((f) => f.code === "panel-unlinked");

  // The camera has not moved, only the focal length.
  const pushIn = () =>
    direction({ setups: axis, shots: [shot("01", "stern"), shot("02", "deck")] });

  it("passes a cut along one axis whose opening keyframe was handed the frame before it", () => {
    expect(
      found(pushIn(), board({ shotId: "01" }, { shotId: "02", linked: ["animatic:shot.01.last"] })),
    ).toEqual([]);
  });

  it("flags a cut along one axis whose opening keyframe takes no frame at all", () => {
    const findings = found(pushIn(), board({ shotId: "01" }, { shotId: "02" }));
    expect(findings.map((f) => f.subject)).toEqual(["01-02"]);
    expect(findings[0]?.message).toContain("one camera axis");
    expect(findings[0]?.message).toContain("animatic:shot.01.last");
  });

  it("flags one cut from some other frame, saying so", () => {
    const findings = found(
      pushIn(),
      board({ shotId: "01" }, { shotId: "02", linked: ["animatic:shot.07.last"] }),
    );
    expect(findings[0]?.message).toContain("cuts from another frame");
  });

  // A long take is no cut: its seam is the next shot's own opening keyframe, which the video lands
  // on (`join-unpinned`), so the board is asked nothing.
  it("says nothing of a long take", () => {
    const dir = direction({
      setups: axis,
      shots: [shot("01", "deck"), shot("02", "deck", { join: "continuous" })],
    });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" }))).toEqual([]);
  });

  it("says nothing of a cut between two frames on their own axes", () => {
    const dir = direction({ setups: offAxis, shots: [shot("01", "stern"), shot("02", "bow")] });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" }))).toEqual([]);
  });

  it("says nothing of a cut along one axis from one subject to another", () => {
    const dir = direction({
      setups: axis,
      shots: [shot("01", "stern", { lineup: ["ane"] }), shot("02", "deck", { lineup: ["imouto"] })],
    });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" }))).toEqual([]);
  });

  it("reads the frame before at its lineupTo", () => {
    const dir = direction({
      setups: axis,
      shots: [
        shot("01", "stern", { lineup: ["ane"], lineupTo: ["ane", "imouto"] }),
        shot("02", "deck", { lineup: ["imouto"] }),
      ],
    });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" })).map((f) => f.subject)).toEqual([
      "01-02",
    ]);
  });

  it("flags a cut along one axis where one frame declares no subject", () => {
    const dir = direction({
      setups: axis,
      shots: [shot("01", "stern", { lineup: ["ane"] }), shot("02", "deck")],
    });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" })).map((f) => f.subject)).toEqual([
      "01-02",
    ]);
  });

  it("says nothing across a story-time jump on one axis", () => {
    const dir = direction({
      setups: axis,
      shots: [shot("01", "stern"), shot("02", "deck", { join: "jump-forward" })],
    });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" }))).toEqual([]);
  });

  it("says nothing of a cut to another place", () => {
    const dir = direction({ setups: axis, shots: [shot("01", "deck"), shot("02", "shore")] });
    expect(found(dir, board({ shotId: "01" }, { shotId: "02" }))).toEqual([]);
  });

  // A model with no slot for the frame cannot carry it, so the finding would be uniformly waived.
  it("says nothing of a keyframe whose adapter carries no slot", () => {
    expect(found(pushIn(), board({ shotId: "01" }, { shotId: "02", carries: false }))).toEqual([]);
  });

  it("says nothing while the shot before it is still undeveloped", () => {
    expect(found(pushIn(), board({ shotId: "02" }))).toEqual([]);
  });

  it("is waived by the seam's key", () => {
    const waived = direction({
      setups: axis,
      shots: [shot("01", "stern"), shot("02", "deck")],
      waivers: { "panel-unlinked_01-02": "the cut re-opens the frame on purpose" },
    });
    const stagingStage = board({ shotId: "01" }, { shotId: "02" });
    expect(found(waived, stagingStage)).toEqual([]);
    expect(checkDirection(waived, { stagingStage }).waived.map((f) => f.code)).toContain(
      "panel-unlinked",
    );
  });

  it("stays silent with no board to read", () => {
    expect(checkDirection(pushIn()).active.filter((f) => f.code === "panel-unlinked")).toEqual([]);
  });
});

const aside = (id: string) =>
  ({ kind: "aside", id, label: "eyecatch", duration: 3 }) as unknown as NarrativeShot;

describe("an aside between two same-axis frames", () => {
  const axis: Record<string, Setup> = {
    stern: { ...stern, within: null },
    deck: { ...deck, within: "stern" },
  };
  const across = direction({
    setups: axis,
    shots: [shot("01", "stern"), aside("ec"), shot("02", "deck")],
  });

  // The seam check reads an aside as no seam, so nothing would be left asking whether the room comes
  // back the same.
  it("keeps undeclared-continuity, which the axis would otherwise have answered", () => {
    expect(codes(across, "undeclared-continuity").map((f) => f.subject)).toEqual(["01-02"]);
  });

  it("still skips the same pair with no aside between them", () => {
    const dir = direction({ setups: axis, shots: [shot("01", "stern"), shot("02", "deck")] });
    expect(codes(dir, "undeclared-continuity")).toEqual([]);
  });

  it("and panel-unlinked stays silent across it", () => {
    const stagingStage = {
      ...noStage,
      shotPanels: ["01", "02"].map((shotId) => ({
        shotId,
        lane: "main" as const,
        firstPanel: `animatic:shot.${shotId}.first`,
        lastPanel: `animatic:shot.${shotId}.last`,
        carries: true,
        linked: [],
      })),
    };
    expect(
      checkDirection(across, { stagingStage }).active.filter((f) => f.code === "panel-unlinked"),
    ).toEqual([]);
  });
});

describe("undeclared-continuity reads the axis", () => {
  const axis: Record<string, Setup> = {
    stern: { ...stern, within: null },
    deck: { ...deck, within: "stern" },
  };

  it("says nothing of two exposed sizes that are one camera at two focal lengths", () => {
    const dir = direction({ setups: axis, shots: [shot("01", "stern"), shot("02", "deck")] });
    expect(codes(dir, "undeclared-continuity")).toEqual([]);
  });

  it("still flags two exposed sizes shot from two camera positions", () => {
    const dir = direction({
      setups: { stern: { ...stern, within: null }, deck: { ...deck, within: null } },
      shots: [shot("01", "stern"), shot("02", "deck")],
    });
    expect(codes(dir, "undeclared-continuity").map((f) => f.subject)).toEqual(["01-02"]);
  });
});

describe("landmark-flipped", () => {
  // The stern frame is the deck from the other end, so it reverses the pair the deck frame declares.
  const sternReverse: Setup = {
    name: "the deck from the bow",
    description: "from the bow seat, back down the bench",
    location: "ferryDeck",
    framing: "wide",
    holds: ["mast", "bench"],
  };

  it("flags two frames of one place that disagree about an axis nothing can move", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck, stern, shore, sternReverse },
    });
    expect(codes(dir, "landmark-flipped").map((f) => f.subject)).toEqual(["sternReverse"]);
  });

  it("says nothing where every frame holds the same order", () => {
    const dir = direction({ shots: [shot("01", "deck", { lineup: [] })] });
    expect(codes(dir, "landmark-flipped")).toEqual([]);
  });

  // The first frame to state a pair fixes the axis. Overwriting it would make one waived reverse
  // angle report every frame after it — each agreeing with the original and each needing a waiver.
  // The ids sort normal / reversed / normal, so the third frame is the one an overwrite would flag.
  it("holds the first order, so a frame after a reversed one is not flagged for agreeing", () => {
    const bench = (id: string, holds: readonly string[]): Setup => ({
      name: `the bench, ${id}`,
      description: "across at the port bench",
      location: "ferryDeck",
      framing: "medium",
      holds,
    });
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: {
        deck,
        shore,
        aBench: bench("a", ["bench", "mast"]),
        bBench: bench("b", ["mast", "bench"]),
        cBench: bench("c", ["bench", "mast"]),
      },
    });
    expect(codes(dir, "landmark-flipped").map((f) => f.subject)).toEqual(["bBench"]);
  });

  // A roster is a set: its record order moves no hash, so it must not decide which frame is blamed
  // — the waiver key would silently go stale on a reorder.
  it("blames the same setup however the roster is ordered", () => {
    const ordered = (setups: Record<string, Setup>) =>
      codes(
        direction({ shots: [shot("01", "deck", { lineup: [] })], setups }),
        "landmark-flipped",
      ).map((f) => f.subject);
    expect(ordered({ deck, stern, shore, sternReverse })).toEqual(["sternReverse"]);
    expect(ordered({ sternReverse, shore, stern, deck })).toEqual(["sternReverse"]);
  });

  it("accumulates per place, so another location's order is its own", () => {
    const elsewhere: Setup = {
      name: "the jetty, close",
      description: "on the boards",
      location: "landing",
      framing: "close",
      holds: ["jetty"],
    };
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck, stern, shore, elsewhere },
    });
    expect(codes(dir, "landmark-flipped")).toEqual([]);
  });

  it("needs no board", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck, stern, shore, sternReverse },
    });
    expect(checkDirection(dir).active.map((f) => f.code)).toContain("landmark-flipped");
  });

  it("takes a waiver keyed by the setup that reverses it", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck, stern, shore, sternReverse },
      waivers: { "landmark-flipped_sternReverse": "the reverse angle is the point of this frame" },
    });
    expect(codes(dir, "landmark-flipped")).toEqual([]);
  });
});

describe("subject-unnamed", () => {
  const dir = direction({ shots: [shot("01", "deck", { lineup: ["ane", "imouto"] })] });
  const prompts = (texts: string[], generative = true): StagingStageState => ({
    ...noStage,
    panelPrompts: [
      { shotId: "01", lane: "main", panel: "animatic:shot.01.first", texts, generative },
    ],
  });
  const found = (d: Direction, stagingStage: StagingStageState) =>
    checkDirection(d, { stagingStage }).active.filter((f) => f.code === "subject-unnamed");

  it("flags a subject the frame holds that no prompt behind the keyframe names", () => {
    const findings = found(dir, prompts(["the elder sister looks up from the bench"]));
    expect(findings.map((f) => f.subject)).toEqual(["01.imouto"]);
    expect(findings[0]?.message).toContain("little sister");
  });

  it("says nothing once every subject is named", () => {
    expect(found(dir, prompts(["the elder sister and the little sister on the bench"]))).toEqual(
      [],
    );
  });

  it("reads the noun case-blind and inside a longer phrase", () => {
    expect(found(dir, prompts(["The Elder Sister beside a Little Sister of six"]))).toEqual([]);
  });

  it("passes on a name carried by an earlier step of the chain", () => {
    expect(
      found(dir, prompts(["<Subject 1> is the elder sister", "the little sister turns"])),
    ).toEqual([]);
  });

  it("asks nothing of a keyframe that generates nothing", () => {
    expect(found(dir, prompts([], false))).toEqual([]);
  });

  it("holds the last keyframe to the `lineupTo`", () => {
    const moved = direction({
      shots: [shot("01", "deck", { lineup: ["ane"], lineupTo: ["ane", "imouto"] })],
    });
    const findings = found(moved, {
      ...noStage,
      panelPrompts: [
        {
          shotId: "01",
          lane: "main",
          panel: "animatic:shot.01.first",
          texts: ["the elder sister alone"],
          generative: true,
        },
        {
          shotId: "01",
          lane: "main",
          panel: "animatic:shot.01.last",
          texts: ["the elder sister alone"],
          generative: true,
        },
      ],
    });
    expect(findings.map((f) => f.subject)).toEqual(["01.imouto"]);
  });

  it("stays silent with no board to read", () => {
    expect(checkDirection(dir).active.filter((f) => f.code === "subject-unnamed")).toEqual([]);
  });

  it("takes a waiver keyed by shot and subject", () => {
    const waived = direction({
      shots: [shot("01", "deck", { lineup: ["ane", "imouto"] })],
      waivers: { "subject-unnamed_01.imouto": "this adapter names its subjects by slot" },
    });
    expect(found(waived, prompts(["the elder sister looks up"]))).toEqual([]);
  });
});

describe("plate-unnamed", () => {
  const dir = direction({ shots: [shot("01", "deck", { lineup: [] })] });
  const state = (platePrompts: Record<string, string>): StagingStageState => ({
    ...noStage,
    platePrompts,
  });
  const found = (d: Direction, stagingStage: StagingStageState) =>
    checkDirection(d, { stagingStage }).active.filter((f) => f.code === "plate-unnamed");

  it("flags a sentence that does not say what its frame holds", () => {
    const findings = found(dir, state({ deck: "the boat, empty, from across the water" }));
    expect(findings.map((f) => f.subject)).toEqual(["deck.bench"]);
  });

  it("says nothing once the sentence names it", () => {
    expect(found(dir, state({ deck: "the empty bench down the port side" }))).toEqual([]);
  });

  it("reports one finding per landmark, so a waiver covers only its own", () => {
    const findings = found(dir, state({ stern: "the boat, empty" }));
    expect(findings.map((f) => f.subject)).toEqual(["stern.bench", "stern.mast"]);
  });

  it("asks nothing of a setup with no plate", () => {
    expect(found(dir, state({}))).toEqual([]);
  });

  it("asks nothing of an insert, which holds nothing", () => {
    const insert: Setup = {
      name: "the sweet",
      description: "the sweet filling frame",
      location: "ferryDeck",
      framing: "insert",
      holds: [],
    };
    const withInsert = direction({
      shots: [shot("01", "insert", { lineup: [] })],
      setups: { deck, stern, shore, insert },
    });
    expect(
      found(withInsert, state({ insert: "a paper-wrapped sweet, filling the frame" })),
    ).toEqual([]);
  });

  it("stays silent with no board to read", () => {
    expect(checkDirection(dir).active.filter((f) => f.code === "plate-unnamed")).toEqual([]);
  });

  it("takes a waiver keyed by setup and landmark", () => {
    const waived = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      waivers: { "plate-unnamed_deck.bench": "this crop cuts the bench out of frame" },
    });
    expect(found(waived, state({ deck: "the boat, empty" }))).toEqual([]);
  });
});

describe("the set's structure errors", () => {
  const errorCodes = (dir: Direction) => validateDirectionStructure(dir).map((e) => e.code);
  const withLocations = (locations: unknown): Direction =>
    ({
      ...direction({ shots: [shot("01", "deck", { lineup: [] })] }),
      locations,
    }) as Direction;

  it("rejects a place with no landmarks", () => {
    const dir = withLocations({
      ferryDeck: { name: "the ferry deck", description: "a flat-bottomed ferry", landmarks: {} },
      landing: {
        name: "the landing",
        description: "a wooden jetty",
        landmarks: {
          jetty: { name: "the jetty", promptDepiction: "jetty", description: "the jetty" },
        },
      },
    });
    expect(errorCodes(dir)).toContain("landmarks-empty");
  });

  it("rejects a landmark with no `promptDepiction`", () => {
    const dir = withLocations({
      ferryDeck: {
        name: "the ferry deck",
        description: "a flat-bottomed ferry",
        landmarks: {
          bench: { name: "the bench", promptDepiction: "  ", description: "the bench" },
        },
      },
      landing: {
        name: "the landing",
        description: "a wooden jetty",
        landmarks: {
          jetty: { name: "the jetty", promptDepiction: "jetty", description: "the jetty" },
        },
      },
    });
    expect(errorCodes(dir)).toContain("landmark-empty-prompt-depiction");
  });

  it("rejects a character with no `promptDepiction`", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      characters: {
        ane: { name: "the sister", promptDepiction: "", description: "the elder sister" },
      },
    });
    expect(errorCodes(dir)).toContain("character-empty-prompt-depiction");
  });

  it("rejects a landmark id another place already declares", () => {
    const dir = withLocations({
      ferryDeck: {
        name: "the ferry deck",
        description: "a flat-bottomed ferry",
        landmarks: {
          jetty: { name: "the bench", promptDepiction: "bench", description: "the bench" },
        },
      },
      landing: {
        name: "the landing",
        description: "a wooden jetty",
        landmarks: {
          jetty: { name: "the jetty", promptDepiction: "jetty", description: "the jetty" },
        },
      },
    });
    expect(errorCodes(dir)).toContain("landmark-id-conflict");
  });

  it("rejects a `promptDepiction` another character's noun sits inside", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      characters: {
        ane: { name: "the sister", promptDepiction: "girl", description: "the elder sister" },
        imouto: {
          name: "the little one",
          promptDepiction: "girl in a red coat",
          description: "the younger sister",
        },
      },
    });
    expect(errorCodes(dir)).toContain("prompt-depiction-conflict");
  });

  it("rejects a character's `promptDepiction` a landmark's noun sits inside", () => {
    const dir = withLocations({
      ferryDeck: {
        name: "the ferry deck",
        description: "a flat-bottomed ferry",
        landmarks: {
          statue: {
            name: "the statue",
            promptDepiction: "mother and child statue",
            description: "the statue amidships",
          },
        },
      },
      landing: {
        name: "the landing",
        description: "a wooden jetty",
        landmarks: {
          jetty: { name: "the jetty", promptDepiction: "jetty", description: "the jetty" },
        },
      },
    });
    expect(errorCodes(dir)).toContain("prompt-depiction-conflict");
  });

  it("rejects two nouns that differ only in case and padding", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      characters: {
        ane: { name: "the sister", promptDepiction: "boatman", description: "the elder sister" },
        imouto: {
          name: "the little one",
          promptDepiction: " Boatman ",
          description: "the younger",
        },
      },
    });
    expect(errorCodes(dir)).toContain("prompt-depiction-conflict");
  });

  it("rejects a frame that holds nothing", () => {
    const empty: Setup = { ...deck, holds: [] };
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck: empty, stern, shore },
    });
    expect(errorCodes(dir)).toContain("holds-empty");
  });

  it("lets an insert hold nothing — it fills the frame with an object and shows no set", () => {
    const insert: Setup = { ...deck, framing: "insert", holds: [] };
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck: insert, stern, shore },
    });
    expect(errorCodes(dir)).not.toContain("holds-empty");
  });

  // A computed `holds` reaches this check with no literal to blame, so the membership test must read
  // own keys: `in` would answer true for an inherited function name.
  it("rejects a frame holding an inherited property name", () => {
    const strayed: Setup = { ...deck, holds: ["toString"] };
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck: strayed, stern, shore },
    });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("holds-unknown-id");
  });

  it("rejects a frame holding a landmark of another place", () => {
    const strayed: Setup = { ...deck, holds: ["jetty"] };
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: { deck: strayed, stern, shore },
    });
    const errors = validateDirectionStructure(dir);
    expect(errors.map((e) => e.code)).toContain("holds-unknown-id");
    expect(errors.find((e) => e.code === "holds-unknown-id")?.subject).toBe("deck:jetty");
  });
});

describe("the join", () => {
  const errorCodes = (dir: Direction) => validateDirectionStructure(dir).map((e) => e.code);
  // An aside is not a `NarrativeShot`, and the fixture's shot list is typed as one.
  const aside = (id: string) =>
    ({ kind: "aside", id, label: "eyecatch", duration: 2 }) as unknown as NarrativeShot;

  describe("join-undeclared", () => {
    it("demands a choice where the shot before is on the same setup", () => {
      const dir = direction({ shots: [shot("01", "deck"), shot("02", "deck")] });
      expect(errorCodes(dir)).toContain("join-undeclared");
    });

    it("takes any of the three as the choice", () => {
      for (const join of ["continuous", "jump-back", "jump-forward"] as const) {
        const dir = direction({ shots: [shot("01", "deck"), shot("02", "deck", { join })] });
        expect(errorCodes(dir)).not.toContain("join-undeclared");
      }
    });

    it("asks nothing where a long take is not possible", () => {
      // Another setup, an aside in between, and the opening shot — three boundaries no unbroken take
      // could cross, so omission decides nothing.
      const dir = direction({
        shots: [shot("01", "deck"), shot("02", "stern"), aside("op"), shot("03", "stern")],
      });
      expect(errorCodes(dir)).not.toContain("join-undeclared");
    });
  });

  describe("join-impossible", () => {
    it("refuses a long take across two setups", () => {
      const dir = direction({
        shots: [shot("01", "deck"), shot("02", "stern", { join: "continuous" })],
      });
      expect(errorCodes(dir)).toContain("join-impossible");
    });

    it("refuses a long take through an aside", () => {
      const dir = direction({
        shots: [shot("01", "deck"), aside("op"), shot("02", "deck", { join: "continuous" })],
      });
      expect(errorCodes(dir)).toContain("join-impossible");
    });

    it("refuses one on the opening shot", () => {
      const dir = direction({ shots: [shot("01", "deck", { join: "continuous" })] });
      expect(errorCodes(dir)).toContain("join-impossible");
    });

    it("leaves the seam findings out of it — there is no seam to read", () => {
      const dir = direction({
        shots: [
          shot("01", "deck", { lineup: ["ane", "imouto"] }),
          aside("op"),
          shot("02", "deck", { lineup: ["ane"], join: "continuous" }),
        ],
      });
      expect(errorCodes(dir)).toContain("join-impossible");
      expect(codes(dir, "join-lineup-mismatch")).toEqual([]);
    });
  });

  it("says nothing about a shot whose setup is not declared", () => {
    // `setup-unknown` owns that shot; asking it about its join on top names the wrong fix.
    const dir = direction({ shots: [shot("01", "nowhere"), shot("02", "nowhere")] });
    expect(errorCodes(dir)).toContain("setup-unknown");
    expect(errorCodes(dir)).not.toContain("join-undeclared");
  });

  describe("join-lineup-mismatch", () => {
    it("flags two takes that do not agree on the frame between them", () => {
      const dir = direction({
        shots: [
          shot("01", "deck", { lineup: ["ane", "imouto"] }),
          shot("02", "deck", { lineup: ["ane"], join: "continuous" }),
        ],
      });
      const found = codes(dir, "join-lineup-mismatch");
      expect(found).toHaveLength(1);
      expect(found[0]!.subject).toBe("02");
    });

    it("reads the exit frame, so a `lineupTo` is what the next shot answers to", () => {
      const dir = direction({
        shots: [
          shot("01", "deck", { lineup: ["ane", "imouto"], lineupTo: ["ane"] }),
          shot("02", "deck", { lineup: ["ane"], join: "continuous" }),
        ],
      });
      expect(codes(dir, "join-lineup-mismatch")).toEqual([]);
    });

    it("says nothing where the boundary is a cut", () => {
      const dir = direction({
        shots: [
          shot("01", "deck", { lineup: ["ane", "imouto"] }),
          shot("02", "deck", { lineup: ["ane"], join: "jump-forward" }),
        ],
      });
      expect(codes(dir, "join-lineup-mismatch")).toEqual([]);
    });
  });

  describe("join-unshown", () => {
    const dir = direction({
      shots: [shot("01", "deck"), shot("02", "deck", { join: "continuous" })],
    });
    const seam = "animatic:shot.02.first";
    const shotPanels: StagingStageState["shotPanels"] = ["01", "02"].map((shotId) => ({
      shotId,
      lane: "main" as const,
      firstPanel: `animatic:shot.${shotId}.first`,
      lastPanel: `animatic:shot.${shotId}.last`,
      carries: false,
      linked: [],
    }));
    const found = (pins: StagingStageState["videoPins"]) =>
      checkDirection(dir, {
        stagingStage: { ...noStage, videoPins: pins, shotPanels },
      }).active.filter((f) => f.code === "join-unshown");
    const window = (w: Partial<PinWindow>): PinWindow => ({
      take: "video:shot.01.motion",
      shotSec: 2.5,
      opensAt: 0,
      closesAt: 2.5,
      from: 0,
      to: 2.5,
      frameSec: 1 / 24,
      ...w,
    });
    const before = (w: Partial<PinWindow>): StagingStageState["videoPins"][number] => ({
      shotId: "01",
      lane: "main",
      pins: [{ pin: "end", reaches: [seam], window: window(w) }],
      slots: ["start", "end"],
    });
    const after = (w: Partial<PinWindow>): StagingStageState["videoPins"][number] => ({
      shotId: "02",
      lane: "main",
      pins: [
        {
          pin: "start",
          reaches: [seam],
          window: window({ take: "video:shot.02.motion", shotSec: 2, closesAt: 2, to: 2, ...w }),
        },
      ],
      slots: ["start", "end"],
    });

    // H3 anchors the end image at the frame past the shot, so a 73-frame take played from its head
    // cuts on the landing.
    it("passes a take anchored at the frame past the shot, played from its head", () => {
      expect(found([before({ clipSec: 73 / 24, landsAt: 2.5 }), after({})])).toEqual([]);
    });

    // Pinned to its last frame instead, the same head window cuts 13 frames short of the landing.
    it("flags a take whose window stops short of its landing", () => {
      const f = found([before({ clipSec: 73 / 24, landsAt: 72 / 24 }), after({})]);
      expect(f).toHaveLength(1);
      expect(f[0]!.subject).toBe("02");
      expect(f[0]!.message).toContain("mediaStart={0.5}");
    });

    it("passes a take played to the landing", () => {
      const clipSec = 73 / 24;
      expect(
        found([before({ clipSec, landsAt: 72 / 24, from: clipSec - 2.5, to: clipSec }), after({})]),
      ).toEqual([]);
    });

    it("flags a take played past its landing", () => {
      expect(
        found([before({ clipSec: 73 / 24, landsAt: 2, from: 0.5, to: 3 }), after({})]),
      ).toHaveLength(1);
    });

    it("flags a take after started past its first frame", () => {
      const f = found([before({ clipSec: 73 / 24, landsAt: 2.5 }), after({ from: 1.5, to: 3.5 })]);
      expect(f).toHaveLength(1);
      expect(f[0]!.message).toContain("starts it 1.5s in");
    });

    it("flags a take after placed later than the shot's start", () => {
      const f = found([before({ clipSec: 73 / 24, landsAt: 2.5 }), after({ opensAt: 0.5 })]);
      expect(f[0]!.message).toContain("does not start it until 0.5s");
    });

    // Without a declared length the landing cannot be located, so the end is not judged.
    it("does not judge an end whose take declares no length", () => {
      expect(found([before({}), after({})])).toEqual([]);
    });

    it("is waived by the seam's key like the other join findings", () => {
      const waived = direction({
        shots: [shot("01", "deck"), shot("02", "deck", { join: "continuous" })],
        waivers: { "join-unshown_02": "the jump is the joke" },
      });
      expect(
        checkDirection(waived, {
          stagingStage: {
            ...noStage,
            videoPins: [before({ clipSec: 73 / 24, landsAt: 72 / 24 }), after({ from: 1.5 })],
            shotPanels,
          },
        }).active.filter((f) => f.code === "join-unshown"),
      ).toEqual([]);
    });
  });

  describe("join-unpinned", () => {
    const dir = direction({
      shots: [shot("01", "deck"), shot("02", "deck", { join: "continuous" })],
    });
    // The seam frame: the opening keyframe of the shot that owns the boundary.
    const seam = "animatic:shot.02.first";
    const shotPanels: StagingStageState["shotPanels"] = ["01", "02"].map((shotId) => ({
      shotId,
      lane: "main" as const,
      firstPanel: `animatic:shot.${shotId}.first`,
      lastPanel: `animatic:shot.${shotId}.last`,
      carries: false,
      linked: [],
    }));
    const pinned = (
      pins: StagingStageState["videoPins"],
      panels: StagingStageState["shotPanels"] = shotPanels,
    ) =>
      checkDirection(dir, {
        stagingStage: { ...noStage, videoPins: pins, shotPanels: panels },
      }).active.filter((f) => f.code === "join-unpinned");
    const after: StagingStageState["videoPins"][number] = {
      shotId: "02",
      lane: "main",
      pins: [{ pin: "start", reaches: [seam] }],
      slots: ["start", "end"],
    };

    it("flags a declared long take the take before does not land on", () => {
      const found = pinned([
        { shotId: "01", lane: "main", pins: [], slots: ["start", "end"] },
        after,
      ]);
      expect(found).toHaveLength(1);
      expect(found[0]!.subject).toBe("02");
      expect(found[0]!.message).toContain(seam);
      expect(found[0]!.message).toContain("pins nothing at its end");
    });

    it("passes where the take before pins its end to the seam frame", () => {
      expect(
        pinned([
          {
            shotId: "01",
            lane: "main",
            pins: [{ pin: "end", reaches: [seam] }],
            slots: ["start", "end"],
          },
          after,
        ]),
      ).toEqual([]);
    });

    // A resize of the seam frame declared in video.tsx still pins that frame.
    it("reads the pinned source down its chain", () => {
      expect(
        pinned([
          {
            shotId: "01",
            lane: "main",
            pins: [{ pin: "end", reaches: ["video:shot.01.seam", seam] }],
            slots: ["start", "end"],
          },
          after,
        ]),
      ).toEqual([]);
    });

    // Pinned to its own last panel, the seam is two pictures: the check reads what is pinned, not
    // that something is.
    it("flags an end pinned to another frame, naming it", () => {
      const found = pinned([
        {
          shotId: "01",
          lane: "main",
          pins: [{ pin: "end", reaches: ["animatic:shot.01.last"] }],
          slots: ["start", "end"],
        },
        after,
      ]);
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain("pins its end to another frame (animatic:shot.01.last)");
    });

    // The next take opening on its own first panel is what any start-pinning model does, so its
    // pin is never the seam's answer.
    it("does not take the next take's start pin for the seam", () => {
      expect(
        pinned([{ shotId: "01", lane: "main", pins: [], slots: ["start", "end"] }, after]),
      ).toHaveLength(1);
    });

    // The line `panel-unlinked` already draws: a model with no pin input has no wiring to forget, so
    // the demand is silent rather than a waiver every such piece carries.
    it("is silent where the take before cannot pin its end", () => {
      expect(pinned([{ shotId: "01", lane: "main", pins: [], slots: ["start"] }, after])).toEqual(
        [],
      );
      expect(pinned([{ shotId: "01", lane: "main", pins: [], slots: [] }, after])).toEqual([]);
    });

    // The take after need not exist: the demand is on the take before, and lands before it is spent on.
    it("waits on the board holding the seam frame, not on the take after", () => {
      expect(
        pinned([{ shotId: "01", lane: "main", pins: [], slots: ["start", "end"] }]),
      ).toHaveLength(1);
      expect(
        pinned(
          [{ shotId: "01", lane: "main", pins: [], slots: ["start", "end"] }, after],
          shotPanels.filter((p) => p.shotId === "01"),
        ),
      ).toEqual([]);
    });

    it("names the frame behind a wrapper declared in video.tsx", () => {
      const found = pinned([
        {
          shotId: "01",
          lane: "main",
          pins: [{ pin: "end", reaches: ["video:shot.01.seam", "animatic:shot.01.last"] }],
          slots: ["start", "end"],
        },
        after,
      ]);
      expect(found[0]!.message).toContain("another frame (animatic:shot.01.last)");
    });
  });
});

// Whether a frame is a window on a wider one is a declaration, like the join. The fixture already
// carries the shape that asks for it: `stern` holds ["bench", "mast"] and `deck` holds ["bench"],
// so the narrower frame could be the inside of the wider one.
describe("the within axis", () => {
  const errorCodes = (dir: Direction) => validateDirectionStructure(dir).map((e) => e.code);
  const errorFor = (dir: Direction, code: string) =>
    validateDirectionStructure(dir).find((e) => e.code === code);

  describe("within-undeclared", () => {
    it("names the frames this one could be a window of", () => {
      const dir = direction({ shots: [shot("01", "deck", { lineup: [] })] });
      const error = errorFor(dir, "within-undeclared");
      expect(error?.subject).toBe("deck");
      expect(error?.message).toContain('"stern"');
    });

    it("says nothing once the frame declares itself a root", () => {
      const dir = direction({
        shots: [shot("01", "deck", { lineup: [] })],
        setups: { deck: { ...deck, within: null }, stern, shore },
      });
      expect(errorCodes(dir)).not.toContain("within-undeclared");
    });

    // A reverse angle carries the same landmarks the other way round, which is exactly what a window
    // cannot do — so it is never asked to declare one.
    it("says nothing about a frame that reverses the wider one's holds", () => {
      const reversed: Setup = { ...deck, holds: ["mast", "bench"] };
      const dir = direction({
        shots: [shot("01", "deck", { lineup: [] })],
        setups: { deck: reversed, stern, shore },
      });
      expect(errorCodes(dir)).not.toContain("within-undeclared");
    });

    it("says nothing about a frame nothing in its place is wider than", () => {
      const dir = direction({
        shots: [shot("01", "stern", { lineup: [] })],
        setups: { stern, shore },
      });
      expect(errorCodes(dir)).not.toContain("within-undeclared");
    });

    // An insert fills the frame with one object, so its empty `holds` nests inside everything and
    // means nothing. It is off the axis at both ends.
    it("says nothing about an insert", () => {
      const insert: Setup = { ...deck, framing: "insert", holds: [] };
      const dir = direction({
        shots: [shot("01", "deck", { lineup: [] })],
        setups: { deck: insert, stern, shore },
      });
      expect(errorCodes(dir)).not.toContain("within-undeclared");
    });
  });

  // The candidate set decides who must declare, never whether the declaration is right: a window may
  // hold a landmark the frame it is cut from was too wide to declare.
  it("takes a `within` whose holds the wider frame does not carry", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: {
        deck: { ...deck, within: "stern" },
        stern,
        shore,
        page: {
          name: "the mast, close",
          description: "in on the mast",
          location: "ferryDeck",
          framing: "close",
          holds: ["mast"],
          within: "deck",
        },
      },
    });
    expect(errorCodes(dir)).not.toContain("within-impossible");
  });

  describe("within-impossible", () => {
    const impossible = (within: string, framing: Setup["framing"] = "medium") =>
      errorFor(
        direction({
          shots: [shot("01", "deck", { lineup: [] })],
          setups: {
            deck: { ...deck, framing, holds: framing === "insert" ? [] : deck.holds, within },
            stern,
            shore,
          },
        }),
        "within-impossible",
      );

    it("rejects a `within` naming no declared setup", () => {
      expect(impossible("bowsprit")?.subject).toBe("deck");
    });

    it("rejects a `within` set in another place", () => {
      expect(impossible("shore")?.message).toContain("landing");
    });

    it("rejects a `within` no wider than the frame itself", () => {
      expect(impossible("deck")?.message).toContain("medium");
    });

    it("rejects a `within` on an insert", () => {
      expect(impossible("stern", "insert")?.message).toContain("insert");
    });
  });

  // The framing order is strict, so a literal roster cannot close on itself — only a computed one
  // that walked past the type layer gets here.
  it("rejects a `within` chain that leads back to its own frame", () => {
    const dir = direction({
      shots: [shot("01", "deck", { lineup: [] })],
      setups: {
        deck: { ...deck, within: "stern" },
        stern: { ...stern, within: "deck" as string },
        shore,
      },
    });
    expect(errorCodes(dir).filter((c) => c === "within-cyclic")).toHaveLength(2);
  });
});
