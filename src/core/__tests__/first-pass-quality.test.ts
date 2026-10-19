import { describe, expect, it } from "vitest";
import {
  checkDirection,
  assertDirectionGate,
  directionWaiverKey,
  collectFramedCharacterIds,
  validateDirectionStructure,
  type StagingStageState,
} from "../direction.js";
import { directionShotCascadeTargets } from "../direction-acceptance.js";
import { directionPartHashes } from "../direction-hash.js";
import {
  defineDirection,
  deriveShotHinges,
  getDirectionIndex,
  type Direction,
} from "../dsl/direction.js";
import { listVideoPasserInputs } from "../graph.js";
import type { AnimaticDefinition, VideoDefinition } from "../types/index.js";
import { directionDefaults } from "./helpers/direction.js";

const characters = {
  cat: { name: "cat", promptDepiction: "orange cat", description: "a cat" },
  crow: { name: "crow", promptDepiction: "black crow", description: "a crow" },
};
const shot = {
  id: "01",
  role: "ordinary",
  action: "crow passes cat over the desk",
  setup: "front",
  duration: 2,
  lineup: ["cat"],
  passing: ["crow"],
} as const;
const entry = defineDirection({
  ...directionDefaults,
  characters,
  sequence: { lens: "mini-drama", pleasure: "cute", shots: [shot] },
});
const direction = entry as unknown as Direction;
const noStage: StagingStageState = {
  panelSlots: [],
  panelReach: [],
  plateRecrops: [],
  panelPrompts: [],
  plateTexts: {},
  videoPins: [],
  shotPanels: [],
};
const board = {
  shots: [
    {
      id: "01",
      assets: { first: { kind: "comfy", inputs: { image: "__konte:reference:cat__" } } },
    },
  ],
} as unknown as AnimaticDefinition;
const video = (
  refs: string[],
  texts: string[],
  extra: Record<string, unknown> = {},
): VideoDefinition =>
  ({
    shots: [
      {
        id: "01",
        assets: {
          motion: { kind: "comfy", inputs: { images: refs.map((ref) => `__konte:${ref}__`) } },
        },
        pictureRefs: ["video:shot.01.motion"],
        ...extra,
      },
    ],
    prompts: texts.map((value) => ({ address: "video:shot.01.motion", value })),
  }) as unknown as VideoDefinition;
const cuesOf = () => [
  { src: "video:shot.01.motion", start: null, duration: null, mediaStart: null },
];
const passers = (v: VideoDefinition) =>
  checkDirection(direction, {
    referenceAssetNames: ["cat", "crow"],
    stagingStage: { ...noStage, videoPassers: listVideoPasserInputs(v, board, cuesOf) },
  }).active.filter((finding) => finding.code.startsWith("passer-"));

describe("action hinges", () => {
  it("indexes a literal substring of the location's landmark name", () => {
    expect(getDirectionIndex(entry).hingeById.get("01")).toEqual([
      { name: "the desk", notInSet: false },
    ]);
  });
  it("marks an unheld landmark and never marks a prop or another location's landmark", () => {
    const d: Direction = {
      ...direction,
      props: { bun: { name: "bun", promptDepiction: "bun", description: "a bun" } },
      setups: { ...direction.setups, front: { ...direction.setups.front!, holds: [] } },
      locations: {
        ...direction.locations,
        street: {
          name: "street",
          description: "street",
          landmarks: { gap: { name: "gap", description: "gap", promptDepiction: "roof gap" } },
        },
      },
    };
    expect(deriveShotHinges(d, "cross the desk carrying a bun over a gap", "front")).toEqual([
      { name: "the desk", notInSet: true },
      { name: "bun", notInSet: false },
    ]);
    expect(deriveShotHinges(d, "cross a desk", "front")).toEqual([]);
  });
});

describe("passing", () => {
  it("rejects an endpoint character in passing at its element", () => {
    defineDirection({
      ...directionDefaults,
      characters,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            ...shot,
            // @ts-expect-error a passer is absent from the opening lineup
            passing: ["cat"],
          },
        ],
      },
    });
    defineDirection({
      ...directionDefaults,
      characters,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            ...shot,
            lineupTo: ["crow"],
            // @ts-expect-error a passer is absent from the closing lineup
            passing: ["crow"],
          },
        ],
      },
    });
    defineDirection({
      ...directionDefaults,
      characters,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            ...shot,
            passing: [],
            cutin: {
              setup: "front",
              lineup: ["cat"],
              // @ts-expect-error cutins have the same endpoint constraint
              passing: ["cat"],
            },
          },
        ],
      },
    });
  });
  it("catches computed overlaps and unknown or duplicate ids", () => {
    const d = {
      ...direction,
      sequence: { ...direction.sequence, shots: [{ ...shot, passing: ["cat", "ghost", "ghost"] }] },
    } as Direction;
    expect(validateDirectionStructure(d).map((e) => e.code)).toEqual(
      expect.arrayContaining(["passing-overlap", "lineup-unknown-id", "lineup-duplicate"]),
    );
  });
  it("signs off and acceptance-gates passers without requiring them in board panels", () => {
    expect(collectFramedCharacterIds(direction)).toEqual(new Set(["cat", "crow"]));
    expect(directionShotCascadeTargets(direction).get("01")).toContain("direction:characters.crow");
    const active = checkDirection(direction, {
      referenceAssetNames: ["cat", "crow"],
      stagingStage: {
        ...noStage,
        panelReach: [
          {
            shotId: "01",
            lane: "main",
            panel: "animatic:shot.01.first",
            refs: ["cat"],
            generative: true,
          },
        ],
        panelPrompts: [
          {
            shotId: "01",
            lane: "main",
            panel: "animatic:shot.01.first",
            texts: ["orange cat"],
            generative: true,
          },
        ],
      },
    }).active;
    expect(
      active.filter((f) =>
        ["character-unconsumed", "subject-unnamed", "lineup-gap", "lineup-flipped"].includes(
          f.code,
        ),
      ),
    ).toEqual([]);
  });
  it("requires both the reference chain and positive naming in the video", () => {
    expect(
      passers(video(["animatic:shot.01.first"], ["orange cat"])).map((f) => [f.code, f.subject]),
    ).toEqual([
      ["passer-unconsumed", "01.crow"],
      ["passer-unnamed", "01.crow"],
    ]);
    expect(
      passers(video(["animatic:shot.01.first", "reference:crow"], ["BLACK CROW crosses"])),
    ).toEqual([]);
    const v = video(["reference:crow"], []);
    v.prompts = [
      { address: "video:shot.01.motion", value: "black crow", input: "negative", negative: true },
    ];
    expect(passers(v).map((f) => f.code)).toEqual(["passer-unnamed"]);
  });
  it("reads rendered chains, including board references, and ignores pending or deterministic pictures", () => {
    const v = video(["animatic:shot.01.first", "reference:crow"], ["black crow"]);
    expect(listVideoPasserInputs(v, board, cuesOf)[0]?.refs.sort()).toEqual(["cat", "crow"]);
    expect(passers(video([], [], { pending: true }))).toEqual([]);
    v.shots[0]!.assets.motion!.deterministic = true;
    expect(passers(v)).toEqual([]);
  });
  it("does not require a passer in an independent generated background image", () => {
    const v = video(["reference:crow"], ["black crow crosses"]);
    v.shots[0]!.assets.background = { kind: "comfy", workflow: "background.json", inputs: {} };
    v.shots[0]!.pictureRefs!.push("video:shot.01.background");
    expect(listVideoPasserInputs(v, board, cuesOf)).toHaveLength(1);
    expect(passers(v)).toEqual([]);
    const motion = v.shots[0]!.assets.motion!;
    if (motion.kind === "comfy") motion.inputs = {};
    expect(passers(v).map((f) => f.code)).toEqual(["passer-unconsumed"]);
  });

  it("gates video spends without blocking animatic work", () => {
    const options = {
      referenceAssetNames: ["cat", "crow"],
      stagingStage: {
        ...noStage,
        videoPassers: listVideoPasserInputs(video([], []), board, cuesOf),
      },
      realizedIds: ["01"],
      directionAccepted: true,
    };
    const d = {
      ...direction,
      waivers: Object.fromEntries(
        checkDirection(direction, options)
          .active.filter((f) => !f.code.startsWith("passer-"))
          .map((f) => [directionWaiverKey(f), "fixture"]),
      ),
    };
    for (const command of ["generate", "reroll", "patch", "export"] as const) {
      expect(() =>
        assertDirectionGate(d, { ...options, command, stage: "animatic" }),
      ).not.toThrow();
      expect(() => assertDirectionGate(d, { ...options, command, stage: "video" })).toThrow(
        "passer-unconsumed",
      );
    }
  });

  it("hashes passing membership but not its order", () => {
    const hash = (passing: readonly string[]) =>
      directionPartHashes({
        ...direction,
        sequence: { ...direction.sequence, shots: [{ ...shot, passing }] },
      } as Direction);
    expect(hash([])).not.toEqual(hash(["crow"]));
    expect(hash(["crow", "cat"])).toEqual(hash(["cat", "crow"]));
  });
});
