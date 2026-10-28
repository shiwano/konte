import { describe, expect, it } from "vitest";
import {
  checkCharacterVoices,
  checkCharacters,
  checkLocations,
  checkNarrator,
  checkProps,
  type AnimaticSetupState,
} from "../direction-check.js";
import type { Pleasure } from "../lenses.js";
import { defineLens } from "../lenses.js";
import {
  checkDirection,
  classifyDirectionFinding,
  continuousFrameKeys,
  directionFindings,
  directionWaiverKey,
  panelRole,
  reportableDirectionFindings,
  validateDirectionStructure,
} from "../direction.js";
import type {
  Character,
  Direction,
  DirectionNode,
  Framing,
  Location,
  Setup,
} from "../dsl/direction.js";
import type { NarrativeShot, ScriptLine } from "../dsl/direction.js";
import { assertCanvasFormat } from "../dsl/direction.js";
import { deriveCanvasBase } from "../canvas.js";
import type { AssetStage } from "../address.js";
import { type SpendCommand, findingTraits, formatFindingLine, spendHold } from "../finding.js";

// What a spend on `stage` is held by, from the direction check alone: one line per finding.
function spendHeldBy(
  dir: Direction,
  opts: { command: SpendCommand; stage: AssetStage; directionAccepted: boolean } & Parameters<
    typeof checkDirection
  >[1],
): string {
  return directionFindings(checkDirection(dir, opts), dir)
    .filter(
      (f) => opts.directionAccepted || findingTraits(f.code).onset !== "after-direction-accepted",
    )
    .filter((f) => spendHold(f, { command: opts.command, stage: opts.stage }) !== null)
    .map(formatFindingLine)
    .join("\n");
}

// Framing defaults by cycling the id's numeric suffix through the four sizes. Pass `framing` to
// override.
const FRAMING_CYCLE: Framing[] = ["wide", "medium", "close", "insert"];
function shot(
  id: string,
  role: string,
  duration = 3,
  action = "shot",
  framing?: Framing,
  location = "here",
): NarrativeShot {
  const n = Number.parseInt(id.replace(/\D/g, ""), 10);
  const cycled = FRAMING_CYCLE[(Number.isFinite(n) ? n : 0) % FRAMING_CYCLE.length]!;
  // A shot names a frame, and the frame carries the size and the place — so the terse fixtures encode
  // both in the setup id and `setupsFor` below reads them back out. Nothing here declares a roster.
  return { id, role, action, setup: `${location}-${framing ?? cycled}`, duration, lineup: [] };
}

// The setups the terse fixtures need, derived from the ids `shot()` minted so no fixture restates a
// roster. `<location>-<framing>` is the shape it writes, so splitting on the last `-` recovers both.
function setupsFor(shots: readonly NarrativeShot[]): Record<string, Setup> {
  const out: Record<string, Setup> = {};
  for (const s of shots) {
    const cut = s.setup.lastIndexOf("-");
    const location = s.setup.slice(0, cut);
    const framing = s.setup.slice(cut + 1) as Framing;
    out[s.setup] = {
      name: `the ${framing}`,
      description: `a ${framing} of ${location}`,
      location,
      framing,
      view: "front",
      // Every terse location declares one landmark, minted the same way (see `locationsFor`).
      holds: framing === "insert" ? [] : [`${location}Mark`],
      // One landmark held by every frame of the place makes each narrower one a `within` candidate.
      // Nothing terse is about windows, so each frame is declared a root of its own axis.
      within: null,
    };
  }
  return out;
}

// Build a leaf-root direction (one arc over shots). Piece-wide fields (characters/lenses, waivers)
// stay at the top; the arc (lens/pleasure/shots) lives in the
// `sequence` root node.
// The default location roster the terse fixtures satisfy: `shot()` points every shot at a frame set
// in `here`, so a leaf/branch that does not override `locations` carries exactly this one entry —
// enough for the structural check (every shot resolves) without every fixture restating a roster.
const defaultLocations: Record<string, Location> = {
  here: {
    name: "the place",
    description: "a plain place",
    landmarks: {
      hereMark: {
        name: "the mark",
        promptDepiction: "mark",
        description: "a mark only this place has",
      },
    },
  },
};

function leaf(opts: {
  lens?: string;
  pleasure?: Pleasure;
  shots: NarrativeShot[];
  waivers?: Record<string, string>;
  characters?: Record<string, Character>;
  locations?: Record<string, Location>;
  setups?: Record<string, Setup>;
  narrator?: { id: string; description: string };
  lenses?: unknown[];
}): Direction {
  const node: DirectionNode = {
    lens: opts.lens ?? "mini-drama",
    pleasure: opts.pleasure ?? "cute",
    shots: opts.shots,
  };
  return {
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
    ...(opts.characters ? { characters: opts.characters } : {}),
    locations: opts.locations ?? defaultLocations,
    setups: opts.setups ?? setupsFor(opts.shots),
    ...(opts.narrator ? { narrator: opts.narrator } : {}),
    ...(opts.lenses ? { lenses: opts.lenses } : {}),
    sequence: node,
  } as Direction;
}

// A one-act container lens. No built-in declares a function-less beat — opting out of the arc
// engine is a project's own `defineLens` call — so a test that wants a branch root wrapping a single
// act brings its own.
const ONE_ACT = defineLens({ name: "one-act", payoff: "whole", roles: [{ role: "whole" }] });

// Build a branch-root direction (a meta lens over child act nodes).
function branch(opts: {
  lens: string;
  pleasure?: Pleasure;
  sequences: DirectionNode[];
  waivers?: Record<string, string>;
  characters?: Record<string, Character>;
  locations?: Record<string, Location>;
  setups?: Record<string, Setup>;
  lenses?: unknown[];
}): Direction {
  const node: DirectionNode = {
    lens: opts.lens,
    pleasure: opts.pleasure ?? "cool",
    sequences: opts.sequences,
  };
  return {
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
    ...(opts.characters ? { characters: opts.characters } : {}),
    locations: opts.locations ?? defaultLocations,
    setups: opts.setups ?? setupsFor(collectLeafShots(opts.sequences)),
    ...(opts.lenses ? { lenses: opts.lenses } : {}),
    sequence: node,
  } as Direction;
}

// A branch's shots live one or more levels down, so its setups are derived from the whole subtree.
function collectLeafShots(nodes: readonly DirectionNode[]): NarrativeShot[] {
  return nodes.flatMap(
    (n) => (n.shots as NarrativeShot[] | undefined) ?? collectLeafShots(n.sequences ?? []),
  );
}

// Override the root node's shots (they live in `sequence`, not at the top level). The setups roster
// follows the new shots, since a fixture's frames are derived from them.
function withShots(base: Direction, shots: NarrativeShot[]): Direction {
  return {
    ...base,
    setups: { ...base.setups, ...setupsFor(shots) },
    sequence: { ...base.sequence, shots },
  };
}
function withWaivers(base: Direction, waivers: Record<string, string>): Direction {
  return { ...base, waivers };
}

const cat: Character = { name: "the cat", promptDepiction: "cat", description: "a black cat" };

// completeMiniDrama with the cat named in its opening action, so only the reference-pool axis varies.
const withCat: Direction = leaf({
  characters: { cat },
  shots: [
    { ...shot("01", "ordinary", 3, "the cat wakes on the sill"), lineup: ["cat"] },
    shot("02", "disruption", 2),
    shot("03", "pressure"),
    shot("04", "hero", 4),
  ],
});

// completeMiniDrama with a recurring prop named in its opening action, so only the reference-pool
// axis varies. Props share the shape of the characters; `leaf` does not carry them, so it is spread on.
const patty = { name: "the patty", promptDepiction: "patty", description: "a golden fish patty" };
const withPatty: Direction = {
  ...leaf({
    shots: [
      shot("01", "ordinary", 3, "the patty rests on a tray"),
      shot("02", "disruption", 2),
      shot("03", "pressure"),
      shot("04", "hero", 4),
    ],
  }),
  props: { patty },
};

// A complete mini-drama direction (release is optional).
const completeMiniDrama: Direction = leaf({
  shots: [
    shot("01", "ordinary"),
    shot("02", "disruption", 2),
    shot("03", "pressure"),
    shot("04", "hero", 4),
  ],
});

describe("panelRole", () => {
  it("makes a frame's only panel its key, or its opening where a continuous seam runs in", () => {
    expect(panelRole(1, 1, false)).toBe("key");
    expect(panelRole(1, 1, true)).toBe("opening");
  });

  it("opens on the first of several panels and lands on the last", () => {
    expect([1, 2, 3].map((i) => panelRole(i, 3, false))).toEqual(["opening", "mid", "landing"]);
    expect(panelRole(1, 2, true)).toBe("opening");
  });
});

describe("continuousFrameKeys", () => {
  it("keys each frame a continuous seam runs into, and none without a direction", () => {
    const direction = leaf({
      shots: [
        shot("01", "ordinary"),
        { ...shot("02", "disruption", 2), join: "continuous" },
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
    expect([...continuousFrameKeys(direction)]).toEqual(["02/main"]);
    expect(continuousFrameKeys(null).size).toBe(0);
  });
});

describe("validateDirectionStructure", () => {
  it("passes a sound flat direction", () => {
    expect(validateDirectionStructure(completeMiniDrama)).toEqual([]);
  });

  it("flags an empty direction", () => {
    const dir = leaf({ shots: [] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("empty-direction");
  });

  it("flags a duplicate shot id", () => {
    const dir = leaf({ shots: [shot("01", "ordinary"), shot("01", "hero")] });
    const err = validateDirectionStructure(dir).find((e) => e.code === "duplicate-id");
    expect(err?.subject).toBe("01");
  });

  it("flags an unknown lens", () => {
    const dir = leaf({ lens: "nope", shots: [shot("01", "hero")] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("unknown-lens");
  });

  it("flags a custom lens whose payoff is not among its beats", () => {
    const dir = leaf({
      lens: "broken",
      shots: [shot("01", "hero")],
      lenses: [{ name: "broken", payoff: "release", roles: [{ role: "hero" }] }],
    });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("payoff-not-in-roles");
  });

  it("flags a custom lens whose declared payoff is not a payoff-function role", () => {
    // The payoff beat declares a grounding `fn`, so the checker knows the declared climax is a
    // grounding role — a definition bug.
    const dir = leaf({
      lens: "vibes",
      shots: [shot("01", "atmosphere")],
      lenses: [
        { name: "vibes", payoff: "atmosphere", roles: [{ role: "atmosphere", fn: "ground" }] },
      ],
    });
    const err = validateDirectionStructure(dir).find((e) => e.code === "payoff-function-mismatch");
    expect(err?.subject).toBe("vibes");
  });

  it("flags a character id that is not a valid asset name", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      characters: {
        "cat:hero": { name: "the cat", promptDepiction: "cat", description: "black cat" },
      },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("character-invalid-id");
  });

  it("flags an empty character name (which would silently pass the unused-character scan)", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      characters: { cat: { name: "  ", description: "black cat", promptDepiction: "cat" } },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("character-empty-name");
  });

  it("flags an empty character description", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      characters: { cat: { name: "the cat", description: "", promptDepiction: "cat" } },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain(
      "character-empty-description",
    );
  });

  it("passes a well-formed roster", () => {
    expect(validateDirectionStructure(withCat)).toEqual([]);
  });

  it("flags a prop id that is not a valid asset name", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      props: {
        "fish:patty": { name: "the patty", promptDepiction: "patty", description: "a fish patty" },
      },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("prop-invalid-id");
  });

  it("flags an empty prop name, prompt depiction and description", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      props: { patty: { name: "  ", promptDepiction: "  ", description: "" } },
    };
    const codes = validateDirectionStructure(dir).map((e) => e.code);
    expect(codes).toContain("prop-empty-name");
    expect(codes).toContain("prop-empty-description");
    expect(codes).toContain("prop-empty-prompt-depiction");
  });

  it("flags a prop id that collides with a character id (both map to reference:<id>)", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      characters: { cat: { name: "the cat", description: "a black cat", promptDepiction: "cat" } },
      props: {
        cat: { name: "the toy cat", promptDepiction: "toy cat", description: "a plush cat" },
      },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("reference-id-conflict");
  });

  it("flags a prop depiction one a character's contains", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      characters: { cat: { name: "the cat", description: "a black cat", promptDepiction: "cat" } },
      props: { toy: { name: "the toy", promptDepiction: "toy cat", description: "a plush cat" } },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain(
      "prompt-depiction-conflict",
    );
  });

  it("passes a well-formed props roster", () => {
    expect(validateDirectionStructure(withPatty)).toEqual([]);
  });

  // A shot names no place of its own, so an unknown place is caught one level up: the setup it points
  // at is the thing set somewhere undeclared.
  it("flags a setup set in a location that is not in the roster", () => {
    const dir = leaf({
      locations: {
        room: {
          name: "the room",
          description: "a plain room",
          landmarks: {
            roomMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      shots: [shot("01", "hero", 3, "shot", undefined, "nowhere")],
    });
    const codes = validateDirectionStructure(dir).map((e) => e.code);
    expect(codes).toContain("setup-unknown-location");
  });

  it("flags a shot whose setup is not in the roster", () => {
    const dir = leaf({
      shots: [shot("01", "hero")],
      setups: {
        elsewhere: {
          name: "elsewhere",
          description: "some other frame",
          location: "here",
          framing: "wide",
          view: "front",
          holds: ["hereMark"],
        },
      },
    });
    const codes = validateDirectionStructure(dir).map((e) => e.code);
    expect(codes).toContain("setup-unknown");
  });

  it("flags an empty setup roster while shots exist", () => {
    const dir = leaf({ shots: [shot("01", "hero")], setups: {} });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("setup-empty");
  });

  it("flags an invalid setup id, an empty name, and an empty description", () => {
    const dir = leaf({
      shots: [shot("01", "hero")],
      setups: {
        "bad:id": {
          name: "ok",
          description: "ok",
          location: "here",
          framing: "wide",
          view: "front",
          holds: ["hereMark"],
        },
        empty: {
          name: "  ",
          description: "",
          location: "here",
          framing: "wide",
          view: "front",
          holds: ["hereMark"],
        },
      },
    });
    const codes = validateDirectionStructure(dir).map((e) => e.code);
    expect(codes).toContain("setup-invalid-id");
    expect(codes).toContain("setup-empty-name");
    expect(codes).toContain("setup-empty-description");
  });

  // The three identity rosters share `reference:<id>`; a setup's plate lives at `animatic:plate.<id>`,
  // so its id is in its own namespace and colliding with a character is not a conflict.
  it("allows a setup id equal to a character id", () => {
    const dir = leaf({
      characters: { cat: { name: "the cat", description: "a black cat", promptDepiction: "cat" } },
      shots: [shot("01", "hero", 3, "the cat sits")],
      setups: {
        cat: {
          name: "on the cat",
          description: "low",
          location: "here",
          framing: "close",
          view: "front",
          holds: ["hereMark"],
        },
      },
    });
    expect(
      validateDirectionStructure({
        ...dir,
        sequence: { ...dir.sequence, shots: [{ ...shot("01", "hero"), setup: "cat" }] },
      }).map((e) => e.code),
    ).not.toContain("reference-id-conflict");
  });

  it("passes a well-formed setup roster", () => {
    const dir = leaf({
      locations: {
        garden: {
          name: "the garden",
          description: "a walled garden",
          landmarks: {
            gardenMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      shots: [shot("01", "hero", 3, "shot", undefined, "garden")],
    });
    expect(validateDirectionStructure(dir)).toEqual([]);
  });

  it("flags an empty location roster while shots exist", () => {
    const dir = leaf({ locations: {}, shots: [shot("01", "hero")] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("location-empty");
  });

  it("flags an invalid location id, an empty name, and an empty description", () => {
    const dir = leaf({
      locations: {
        "bad:id": {
          name: "the room",
          description: "a room",
          landmarks: {
            badMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
        empty: {
          name: "  ",
          description: "",
          landmarks: {
            emptyMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      shots: [shot("01", "hero", 3, "shot", undefined, "empty")],
    });
    const codes = validateDirectionStructure(dir).map((e) => e.code);
    expect(codes).toContain("location-invalid-id");
    expect(codes).toContain("location-empty-name");
    expect(codes).toContain("location-empty-description");
  });

  it("flags a location id that collides with a character or a prop (shared reference namespace)", () => {
    const withChar = leaf({
      characters: { cat: { name: "the cat", description: "a black cat", promptDepiction: "cat" } },
      locations: {
        cat: {
          name: "the cattery",
          description: "a room of cats",
          landmarks: {
            catMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      shots: [shot("01", "hero", 3, "the cat sits", undefined, "cat")],
    });
    expect(validateDirectionStructure(withChar).map((e) => e.code)).toContain(
      "reference-id-conflict",
    );

    const withProp: Direction = {
      ...leaf({
        locations: {
          patty: {
            name: "the diner",
            description: "a diner",
            landmarks: {
              pattyMark: {
                name: "the mark",
                promptDepiction: "mark",
                description: "a mark only this place has",
              },
            },
          },
        },
        shots: [shot("01", "hero", 3, "shot", undefined, "patty")],
      }),
      props: {
        patty: { name: "the patty", promptDepiction: "patty", description: "a fish patty" },
      },
    };
    expect(validateDirectionStructure(withProp).map((e) => e.code)).toContain(
      "reference-id-conflict",
    );
  });

  it("passes a well-formed location roster", () => {
    const dir = leaf({
      locations: {
        garden: {
          name: "the garden",
          description: "a walled garden",
          landmarks: {
            gardenMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      shots: [shot("01", "hero", 3, "shot", undefined, "garden")],
    });
    expect(validateDirectionStructure(dir)).toEqual([]);
  });

  it("flags a script line spoken by an undeclared character", () => {
    const dir = withShots(withCat, [
      {
        ...shot("01", "ordinary", 3, "the cat wakes"),
        script: [{ character: "dog", text: "woof" }],
      },
      shot("02", "disruption", 2),
      shot("03", "pressure"),
      shot("04", "hero", 4),
    ]);
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain(
      "script-unknown-character",
    );
  });

  it("flags a script line with empty text", () => {
    const dir = withShots(withCat, [
      {
        ...shot("01", "ordinary", 3, "the cat wakes"),
        script: [{ character: "cat", text: "  " }],
      },
      shot("02", "disruption", 2),
      shot("03", "pressure"),
      shot("04", "hero", 4),
    ]);
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("script-empty-text");
  });

  it("flags a telop entry with empty text", () => {
    const dir = withShots(withCat, [
      { ...shot("01", "ordinary", 3, "the cat wakes"), telop: ["  "] },
      shot("02", "disruption", 2),
      shot("03", "pressure"),
      shot("04", "hero", 4),
    ]);
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("telop-empty-text");
  });

  // Telop is not speech, so it never demands a voice.
  it("passes telop-only shots with no cast voice", () => {
    const dir = leaf({
      characters: { cat },
      shots: [
        { ...shot("01", "ordinary", 3, "the cat wakes"), telop: ["第一話"] },
        shot("02", "disruption", 2),
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
    expect(validateDirectionStructure(dir)).toEqual([]);
  });

  it("passes a script line by a declared character, and a bare narration line", () => {
    const dir = withShots(withCat, [
      {
        ...shot("01", "ordinary", 3, "the cat wakes"),
        script: [{ character: "cat", text: "meow" }, { narration: "morning breaks" }],
      },
      shot("02", "disruption", 2),
      shot("03", "pressure"),
      shot("04", "hero", 4),
    ]);
    expect(validateDirectionStructure(dir)).toEqual([]);
  });
});

describe("checkDirection waivers", () => {
  it("moves a waived finding out of active and into waived", () => {
    const dir = leaf({
      shots: [shot("01", "ordinary"), shot("03", "pressure"), shot("04", "hero")],
      waivers: { "missing-role_disruption": "intentional unbroken loop" },
    });
    const { active, waived } = checkDirection(dir);
    expect(active.map((f) => f.code)).not.toContain("missing-role");
    expect(waived.map(directionWaiverKey)).toContain("missing-role_disruption");
  });

  it("flags a waiver whose finding is gone as stale", () => {
    const dir = withWaivers(completeMiniDrama, {
      "missing-role_disruption": "stale — disruption now exists",
    });
    expect(checkDirection(dir).staleWaivers.map((w) => w.key)).toContain("missing-role_disruption");
  });

  it("flags a waiver key naming no finding code stale, never a structural error", () => {
    const dir = withWaivers(completeMiniDrama, {
      role_overweight_problem: "deliberate overrun",
      "duplicate-id_01": "no",
    });
    const { structureErrors, staleWaivers } = checkDirection(dir);
    expect(structureErrors).toEqual([]);
    expect(staleWaivers.map((w) => w.key)).toEqual(["role_overweight_problem", "duplicate-id_01"]);
  });
});

describe("defineLens (custom lenses)", () => {
  it("registers a custom shot lens that resolves and passes the arc checks", () => {
    const tutorial = defineLens({
      name: "tutorial",
      payoff: "completion",
      roles: [
        { role: "before", fn: "ground" },
        { role: "method", fn: "build" },
        { role: "completion", fn: "payoff" },
      ],
    });
    const dir = leaf({
      lens: "tutorial",
      pleasure: "satisfying",
      shots: [shot("01", "before", 3), shot("02", "method", 2), shot("03", "completion", 4)],
      lenses: [tutorial],
    });
    expect(validateDirectionStructure(dir)).toEqual([]);
    expect(checkDirection(dir).active).toEqual([]);
  });

  it("runs a custom lens through the same findings — a missing required beat is flagged", () => {
    const tutorial = defineLens({
      name: "tutorial",
      payoff: "completion",
      roles: [
        { role: "before", fn: "ground" },
        { role: "method", fn: "build" },
        { role: "completion", fn: "payoff" },
      ],
    });
    const dir = leaf({
      lens: "tutorial",
      pleasure: "satisfying",
      shots: [shot("01", "before", 3), shot("03", "completion", 4)],
      lenses: [tutorial],
    });
    expect(checkDirection(dir).active.map((f) => f.code)).toContain("missing-role");
  });

  it("registers a custom lens resolved at the meta (sequence) scale", () => {
    const twoAct = defineLens({
      name: "two-act",
      payoff: "climax-act",
      roles: [
        { role: "setup-act", fn: "ground" },
        { role: "climax-act", fn: "payoff" },
      ],
    });
    const dir = branch({
      lens: "two-act",
      sequences: [
        {
          id: "s1",
          role: "setup-act",
          synopsis: "open",
          lens: "comedy",
          pleasure: "funny",
          shots: [shot("01", "setup")],
        },
      ],
      lenses: [twoAct],
    });
    expect(validateDirectionStructure(dir).map((e) => e.code)).not.toContain("unknown-lens");
  });

  it("rejects a lens beat whose share is out of [0, 1]", () => {
    const bad = defineLens({
      name: "bad",
      payoff: "hero",
      roles: [{ role: "hero", maxShare: 1.5 }],
    });
    const dir = leaf({ lens: "bad", shots: [shot("01", "hero")], lenses: [bad] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("invalid-share");
  });

  it("rejects a lens beat whose minShare exceeds its maxShare", () => {
    const bad = defineLens({
      name: "bad",
      payoff: "hero",
      roles: [{ role: "hero", minShare: 0.8, maxShare: 0.2 }],
    });
    const dir = leaf({ lens: "bad", shots: [shot("01", "hero")], lenses: [bad] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("invalid-share");
  });
});

describe("the direction findings holding a spend", () => {
  it("aborts on an unwaived arc hole", () => {
    const dir = leaf({
      shots: [shot("01", "ordinary", 3), shot("03", "pressure", 2), shot("04", "hero", 4)],
    });
    expect(
      spendHeldBy(dir, { command: "generate", stage: "video", directionAccepted: true }),
    ).toMatch(/missing-role_disruption/);
  });

  it("passes once the arc hole is waived", () => {
    const dir = leaf({
      shots: [shot("01", "ordinary", 3), shot("03", "pressure", 2), shot("04", "hero", 4)],
      waivers: { "missing-role_disruption": "ok" },
    });
    expect(spendHeldBy(dir, { command: "generate", stage: "video", directionAccepted: true })).toBe(
      "",
    );
  });

  it("aborts on a structural error regardless of scope", () => {
    const dir = leaf({ shots: [] });
    expect(
      spendHeldBy(dir, {
        command: "generate",
        stage: "animatic",
        directionAccepted: true,
      }),
    ).toMatch(/empty-direction/);
  });
});

describe("checkDirection meta arc (sequenced)", () => {
  // A complete mini-drama whose hero shot carries `heroDur`, so the sequence's derived duration
  // (and thus its act-ratio share) is tunable.
  function seq(id: string, role: string, prefix: string, heroDur: number): DirectionNode {
    return {
      id,
      role,
      synopsis: "act",
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        shot(`${prefix}1`, "ordinary", 2),
        shot(`${prefix}2`, "disruption", 1),
        shot(`${prefix}3`, "pressure", 2),
        shot(`${prefix}4`, "hero", heroDur),
      ],
    };
  }

  function threeActDirection(
    sequences: DirectionNode[],
    waivers?: Record<string, string>,
  ): Direction {
    return branch({ lens: "three-act", pleasure: "cool", sequences, waivers });
  }

  const balancedSequences = [
    seq("act1", "setup-act", "a", 1),
    seq("act2", "confrontation-act", "b", 5),
    seq("act3", "climax-act", "c", 1),
  ];

  it("passes a balanced, complete three-act", () => {
    expect(checkDirection(threeActDirection(balancedSequences)).active).toEqual([]);
  });

  it("flags a missing sequence beat, addressed to the meta (root) arc", () => {
    const dir = threeActDirection([
      seq("act1", "setup-act", "a", 1),
      seq("act3", "climax-act", "c", 1),
    ]);
    const finding = checkDirection(dir).active.find(
      (f) => f.code === "missing-role" && f.subject === "confrontation-act",
    );
    // The meta arc is the root node, so its findings carry the root's field path — a child node's
    // would read ["sequence", "sequences", "act1"].
    expect(finding?.path).toEqual(["sequence"]);
  });

  it("waives a meta-arc finding via the root waivers", () => {
    const dir = threeActDirection(
      [seq("act1", "setup-act", "a", 1), seq("act3", "climax-act", "c", 1)],
      { "missing-role_confrontation-act": "folded into act1" },
    );
    const res = checkDirection(dir);
    expect(res.active.map((f) => f.subject)).not.toContain("confrontation-act");
    expect(res.waived.map(directionWaiverKey)).toContain("missing-role_confrontation-act");
  });

  it("flags a thin payoff act from derived durations (act-ratio)", () => {
    const dir = threeActDirection([
      seq("act1", "setup-act", "a", 1),
      seq("act2", "confrontation-act", "b", 30),
      seq("act3", "climax-act", "c", 1),
    ]);
    expect(
      checkDirection(dir).active.some(
        (f) => f.code === "role-underweight" && f.subject === "climax-act",
      ),
    ).toBe(true);
  });

  it("does not flag a valid meta-arc waiver stale on a direction-only pass", () => {
    const dir = threeActDirection(balancedSequences, {
      "missing-role_confrontation-act": "stale?",
    });
    // balanced HAS confrontation-act, so this waiver has no finding — it is genuinely stale, and a
    // direction-only pass evaluates the arc class, so it must be reported (the guard is for classes NOT run).
    expect(checkDirection(dir).staleWaivers.map((w) => w.key)).toContain(
      "missing-role_confrontation-act",
    );
  });

  // Two acts on one lens fire the same role finding, so below the root the key names the act.
  it("qualifies an act's role finding with the act's id, so one waiver cancels one act", () => {
    const noDisruption = (id: string, role: string, prefix: string): DirectionNode => ({
      ...seq(id, role, prefix, 1),
      shots: [
        shot(`${prefix}1`, "ordinary", 2),
        shot(`${prefix}3`, "pressure", 2),
        shot(`${prefix}4`, "hero", 1),
      ],
    });
    const dir = threeActDirection(
      [
        noDisruption("act1", "setup-act", "a"),
        seq("act2", "confrontation-act", "b", 5),
        noDisruption("act3", "climax-act", "c"),
      ],
      { "missing-role_act1.disruption": "the act opens mid-trouble" },
    );
    const res = checkDirection(dir);
    expect(res.waived.map(directionWaiverKey)).toEqual(["missing-role_act1.disruption"]);
    expect(res.active.filter((f) => f.code === "missing-role").map(directionWaiverKey)).toEqual([
      "missing-role_act3.disruption",
    ]);
    expect(res.staleWaivers).toEqual([]);
  });

  it("reports an unknown-code node waiver as stale", () => {
    const dir = threeActDirection(balancedSequences, { "missing-roles_x": "typo" });
    const { structureErrors, staleWaivers } = checkDirection(dir, { referenceAssetNames: [] });
    expect(structureErrors).toEqual([]);
    expect(staleWaivers.map((w) => w.key)).toContain("missing-roles_x");
  });
});

describe("checkDirection function checks", () => {
  it("flags a one-beat custom lens as an unearned payoff, waivable as a cold open", () => {
    const hollow = defineLens({
      name: "hollow",
      payoff: "peak",
      roles: [{ role: "peak", fn: "payoff" }],
    });
    const dir = leaf({
      lens: "hollow",
      pleasure: "beautiful",
      shots: [shot("01", "peak")],
      lenses: [hollow],
    });
    const finding = checkDirection(dir).active.find((f) => f.code === "unearned-payoff");
    expect(finding?.subject).toBe("peak");

    const waived = withWaivers(dir, {
      "unearned-payoff_peak": "a cold open — the piece is the peak",
    });
    expect(checkDirection(waived).active.map((f) => f.code)).not.toContain("unearned-payoff");
  });

  it("exempts a container act from every function check", () => {
    const dir = branch({
      lens: "one-act",
      lenses: [ONE_ACT],
      pleasure: "cute",
      sequences: [
        {
          id: "act1",
          role: "whole",
          synopsis: "the whole piece",
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            shot("01", "ordinary", 2),
            shot("02", "disruption", 1),
            shot("03", "pressure", 2),
            shot("04", "hero", 4),
          ],
        },
      ],
    });
    const codes = checkDirection(dir).active.map((f) => f.code);
    expect(codes).not.toContain("unearned-payoff");
  });
});

describe("checkDirection camera choices", () => {
  it("allows a wide-to-medium cut between separate camera axes", () => {
    const dir = leaf({
      shots: [
        shot("01", "ordinary", 3, "shot", "wide"),
        shot("02", "disruption", 2, "shot", "medium"),
        shot("03", "pressure", 4, "shot", "close"),
        shot("04", "hero", 5, "shot", "insert"),
      ],
    });
    expect(checkDirection(dir).active).toEqual([]);
    expect(
      spendHeldBy(dir, { command: "generate", stage: "animatic", directionAccepted: true }),
    ).toBe("");
  });

  it("allows repeated wide shots within one role", () => {
    const dir = leaf({
      lens: "one-act",
      lenses: [ONE_ACT],
      shots: [
        shot("01", "whole", 3, "the street is gray", "wide"),
        shot("02", "whole", 2, "a shoe leaves a yellow line", "insert"),
        shot("03", "whole", 4, "the street fills with color", "wide"),
      ],
    });
    expect(checkDirection(dir).active).toEqual([]);
    expect(
      spendHeldBy(dir, { command: "generate", stage: "animatic", directionAccepted: true }),
    ).toBe("");
  });
});

describe("checkCharacters", () => {
  it("flags a character with no matching reference asset", () => {
    const findings = checkCharacters(
      [{ id: "cat", name: "黒猫" }],
      [],
      ["黒猫 stretches"],
      new Set(),
      new Set(["cat"]),
    );
    expect(findings.map((f) => f.code)).toContain("character-unreferenced");
  });

  it("asks no reference of a character no lineup holds", () => {
    const findings = checkCharacters(
      [{ id: "singer", name: "歌い手" }],
      [],
      ["a quiet room"],
      new Set(["singer"]),
      new Set(),
    );
    expect(findings).toEqual([]);
  });

  it("passes a character exposed in the pool and named in an action", () => {
    expect(
      checkCharacters(
        [{ id: "cat", name: "黒猫" }],
        ["cat"],
        ["黒猫 stretches"],
        new Set(),
        new Set(["cat"]),
      ),
    ).toEqual([]);
  });

  it("flags a character never named in any action, keyed by id", () => {
    const findings = checkCharacters(
      [{ id: "cat", name: "黒猫" }],
      ["cat"],
      ["a quiet room"],
      new Set(),
      new Set(["cat"]),
    );
    const unused = findings.find((f) => f.code === "unused-character");
    expect(unused?.subject).toBe("cat");
  });

  it("treats a character with a script line as used even if unnamed in any action", () => {
    const findings = checkCharacters(
      [{ id: "cat", name: "黒猫" }],
      ["cat"],
      ["a quiet room"],
      new Set(["cat"]),
      new Set(["cat"]),
    );
    expect(findings.map((f) => f.code)).not.toContain("unused-character");
  });
});

describe("checkProps", () => {
  it("flags a prop with no matching reference asset", () => {
    const findings = checkProps([{ id: "patty", name: "the patty" }], [], ["the patty on a tray"]);
    expect(findings.map((f) => f.code)).toContain("prop-unreferenced");
  });

  it("passes a prop exposed in the pool and named in an action", () => {
    expect(
      checkProps([{ id: "patty", name: "the patty" }], ["patty"], ["the patty on a tray"]),
    ).toEqual([]);
  });

  it("flags a prop never named in any action, keyed by id", () => {
    const findings = checkProps([{ id: "patty", name: "the patty" }], ["patty"], ["a quiet room"]);
    const unused = findings.find((f) => f.code === "unused-prop");
    expect(unused?.subject).toBe("patty");
  });
});

describe("checkLocations", () => {
  it("flags a location with no matching reference asset", () => {
    const findings = checkLocations(
      [{ id: "garden", name: "the garden" }],
      [],
      new Set(["garden"]),
    );
    expect(findings.map((f) => f.code)).toContain("location-unreferenced");
  });

  it("passes a location exposed in the pool and used by a shot", () => {
    expect(
      checkLocations([{ id: "garden", name: "the garden" }], ["garden"], new Set(["garden"])),
    ).toEqual([]);
  });

  // "Used" is exact id membership (a shot's `location` field), not a prose scan — a place is named by
  // id, never written into the action sentence.
  it("flags a location no shot points at, keyed by id", () => {
    const findings = checkLocations(
      [{ id: "garden", name: "the garden" }],
      ["garden"],
      new Set(["hall"]),
    );
    const unused = findings.find((f) => f.code === "unused-location");
    expect(unused?.subject).toBe("garden");
  });
});

describe("checkDirection setups", () => {
  // The board state the setups class reads. Which pictures reach which anchor is the graph walk's
  // business (listSetupAnchorGaps); these cases state the outcome directly.
  const plates = (
    ids: readonly string[] = [],
    gaps: {
      unanchored?: readonly string[];
      unnested?: readonly string[];
      ignoring?: Record<string, string[]>;
      deterministic?: Record<string, number>;
      deterministicPlates?: readonly string[];
      unviewed?: readonly string[];
      unviewedBy?: Record<string, string[]>;
      unanchoredViews?: readonly string[];
      accepted?: readonly string[];
    } = {},
  ): AnimaticSetupState => ({
    plateIds: ids,
    unanchoredPlateIds: gaps.unanchored ?? [],
    unnestedPlateIds: gaps.unnested ?? [],
    unconsumedBy: new Map(Object.entries(gaps.ignoring ?? {})),
    deterministicShotsPerSetup: new Map(Object.entries(gaps.deterministic ?? {})),
    deterministicPlateIds: gaps.deterministicPlates ?? [],
    unviewedPlateIds: gaps.unviewed ?? [],
    unviewedBy: new Map(Object.entries(gaps.unviewedBy ?? {})),
    unanchoredViews: gaps.unanchoredViews ?? [],
    acceptedPlateIds: gaps.accepted ?? [],
  });

  // Two shots on one frame, one shot on another: exactly the split `setup-unrealized` draws.
  const shared = leaf({
    shots: [
      { ...shot("01", "ordinary", 3), setup: "wall" },
      { ...shot("02", "disruption", 2), setup: "wall" },
      { ...shot("03", "pressure", 3), setup: "solo" },
      { ...shot("04", "hero", 4), setup: "solo2" },
    ],
    setups: {
      wall: {
        name: "the wall",
        description: "flat on",
        location: "here",
        framing: "medium",
        view: "front",
        holds: ["hereMark"],
      },
      solo: {
        name: "the solo",
        description: "in close",
        location: "here",
        framing: "close",
        view: "front",
        holds: ["hereMark"],
      },
      solo2: {
        name: "the other",
        description: "wide",
        location: "here",
        framing: "wide",
        view: "front",
        holds: ["hereMark"],
      },
    },
  });

  // One camera axis: `close` is a window of `medium`, which is a window of `wide`.
  const axis = (shots: NarrativeShot[]) =>
    leaf({
      shots,
      setups: {
        wide: {
          name: "the room",
          description: "from the door",
          location: "here",
          framing: "wide",
          view: "front",
          holds: ["hereMark"],
          within: null,
        },
        medium: {
          name: "the desk",
          description: "in from the door",
          location: "here",
          framing: "medium",
          holds: ["hereMark"],
          within: "wide",
        },
        // A second camera in the same place, on its own axis.
        across: {
          name: "the desk from the side",
          description: "from the window",
          location: "here",
          framing: "medium",
          view: "front",
          holds: ["hereMark"],
          within: null,
        },
      },
    });

  const axial = axis([
    { ...shot("01", "ordinary", 3), setup: "wide" },
    { ...shot("02", "disruption", 2), setup: "medium" },
  ]);
  const found = (d: Direction, ids: readonly string[] = []) =>
    checkDirection(d, { referenceAssetNames: ["here"], animaticSetups: plates(ids) }).active.filter(
      (f) => f.code === "axis-unrealized",
    );

  it("demands the plates that hold an axial cut to one master", () => {
    const findings = found(axial);
    expect(findings.map((f) => f.subject)).toEqual(["medium.wide"]);
    expect(findings[0]?.message).toContain('"wide", "medium"');
  });

  it("names only the end that is missing one", () => {
    expect(found(axial, ["wide"])[0]?.message).toContain('"medium" has no plate');
  });

  // The plates a pair owes are the same whichever end the cut starts from, so one waiver answers for
  // both directions rather than the author writing two.
  it("reports one pair however often and whichever way round it is cut", () => {
    const dir = axis([
      { ...shot("01", "ordinary", 3), setup: "wide" },
      { ...shot("02", "disruption", 2), setup: "medium" },
      { ...shot("03", "pressure", 3), setup: "wide" },
    ]);
    expect(found(dir).map((f) => f.subject)).toEqual(["medium.wide"]);
  });

  it("says nothing once both ends are plated", () => {
    expect(found(axial, ["wide", "medium"])).toEqual([]);
  });

  it("says nothing of a cut between two cameras", () => {
    const dir = axis([
      { ...shot("01", "ordinary", 3), setup: "wide" },
      { ...shot("02", "disruption", 2), setup: "across" },
    ]);
    expect(found(dir)).toEqual([]);
  });

  it("stays silent with no board to read", () => {
    expect(checkDirection(axial).active.map((f) => f.code)).not.toContain("axis-unrealized");
  });

  it("is waived by the pair's key", () => {
    const waived = axis([
      { ...shot("01", "ordinary", 3), setup: "wide" },
      { ...shot("02", "disruption", 2), setup: "medium" },
    ]);
    waived.waivers = { "axis-unrealized_medium.wide": "cut as two separate frames" };
    expect(found(waived)).toEqual([]);
  });

  it("does not demand a plate without the animatic's timeline names", () => {
    expect(checkDirection(shared).active.map((f) => f.code)).not.toContain("setup-unrealized");
  });

  it("demands a plate for a frame two or more shots share", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(),
    });
    const unrealized = active.filter((f) => f.code === "setup-unrealized");
    expect(unrealized.map((f) => f.subject)).toEqual(["wall"]);
  });

  it("demands no plate for a frame only one shot uses", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(),
    });
    expect(active.filter((f) => f.subject === "solo").map((f) => f.code)).toEqual([]);
  });

  it("clears once the plate is declared", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall"]),
    });
    expect(active.map((f) => f.code)).not.toContain("setup-unrealized");
  });

  // A plate holds GENERATED frames together. Two supplied `file` keyframes take no inputs at all, so
  // a plate demanded of them is one nothing could ever build from — and no accept could reach.
  it("demands no plate for a frame only deterministic shots use", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates([], { deterministic: { wall: 2 } }),
    });
    expect(active.map((f) => f.code)).not.toContain("setup-unrealized");
  });

  // One of the two still generates, so there is nothing for the plate to hold it to.
  it("demands no plate once only one shot on the frame generates", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates([], { deterministic: { wall: 1 } }),
    });
    expect(active.map((f) => f.code)).not.toContain("setup-unrealized");
  });

  describe("plate-unowed", () => {
    const unowed = (d: Direction, state: AnimaticSetupState) =>
      checkDirection(d, { referenceAssetNames: ["here"], animaticSetups: state })
        .active.filter((f) => f.code === "plate-unowed")
        .map((f) => f.subject);

    it("flags a plate only one generated shot stands on", () => {
      expect(unowed(shared, plates(["wall", "solo"]))).toEqual(["solo"]);
    });

    it("says nothing of an accepted plate one generated shot stands on", () => {
      expect(unowed(shared, plates(["wall", "solo"], { accepted: ["solo"] }))).toEqual([]);
    });

    it("flags an accepted plate no generated shot stands on", () => {
      const state = plates(["wall"], { deterministic: { wall: 2 }, accepted: ["wall"] });
      expect(unowed(shared, state)).toEqual(["wall"]);
    });

    it("says nothing of a plate two generated shots share", () => {
      expect(unowed(shared, plates(["wall"]))).toEqual([]);
    });

    it("flags a shared plate once all but one of its shots are deterministic", () => {
      expect(unowed(shared, plates(["wall"], { deterministic: { wall: 1 } }))).toEqual(["wall"]);
    });

    it("says nothing of a plate with no generative step", () => {
      expect(unowed(shared, plates(["solo"], { deterministicPlates: ["solo"] }))).toEqual([]);
    });

    it("says nothing of the plates an axial cut nests, its ends and the frame between", () => {
      const dir = axis([
        { ...shot("01", "ordinary", 3), setup: "wide" },
        { ...shot("02", "disruption", 2), setup: "medium" },
      ]);
      expect(unowed(dir, plates(["wide", "medium"]))).toEqual([]);
    });

    it("flags the parent plate of a window no axial cut reaches", () => {
      const dir = axis([
        { ...shot("01", "ordinary", 3), setup: "medium" },
        { ...shot("02", "disruption", 2), setup: "across" },
        { ...shot("03", "pressure", 3), setup: "medium" },
      ]);
      expect(unowed(dir, plates(["wide", "medium"]))).toEqual(["wide"]);
    });

    it("is waived by the setup's key", () => {
      const waived = { ...shared, waivers: { "plate-unowed_solo": "a still held for a match" } };
      expect(unowed(waived, plates(["wall", "solo"]))).toEqual([]);
    });
  });

  it("flags a roster setup no shot points at", () => {
    const withUnused = leaf({
      shots: [shot("01", "hero", 3, "shot", "wide")],
      setups: {
        "here-wide": {
          name: "a",
          description: "b",
          location: "here",
          framing: "wide",
          view: "front",
          holds: ["hereMark"],
        },
        spare: {
          name: "spare",
          description: "unused",
          location: "here",
          framing: "close",
          view: "front",
          holds: ["hereMark"],
          within: null,
        },
      },
    });
    const { active } = checkDirection(withUnused);
    expect(active.filter((f) => f.code === "unused-setup").map((f) => f.subject)).toEqual([
      "spare",
    ]);
  });

  it("counts a master as used when a setup a shot stands on is a window of it", () => {
    const masters = leaf({
      shots: [shot("01", "hero", 3, "shot", "close")],
      setups: {
        master: {
          name: "the room",
          description: "the whole room",
          location: "here",
          framing: "wide",
          view: "front",
          holds: ["hereMark"],
          within: null,
        },
        "here-close": {
          name: "in close",
          description: "in on the table",
          location: "here",
          framing: "close",
          holds: ["hereMark"],
          within: "master",
        },
      },
    });
    const { active } = checkDirection(masters, { referenceAssetNames: ["here"] });
    expect(active.map((f) => f.code)).not.toContain("unused-setup");
    expect(active.map((f) => f.code)).not.toContain("unused-location");
  });

  it("says nothing unused before any shot is written", () => {
    const shotless = leaf({ shots: [], setups: setupsFor([shot("01", "hero")]) });
    const codes = checkDirection(shotless, { referenceAssetNames: [] }).active.map((f) => f.code);
    expect(codes.filter((c) => c.startsWith("unused-"))).toEqual([]);
  });

  it("waives a setup finding via the root waivers", () => {
    const waived = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "wall" },
        { ...shot("02", "hero", 3), setup: "wall" },
      ],
      setups: {
        wall: {
          name: "the wall",
          description: "flat on",
          location: "here",
          framing: "medium",
          view: "front",
          holds: ["hereMark"],
        },
      },
      waivers: { "setup-unrealized_wall": "the two takes are meant to differ" },
    });
    const { active, waived: waivedFindings } = checkDirection(waived, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(),
    });
    expect(active.map((f) => f.code)).not.toContain("setup-unrealized");
    expect(waivedFindings.map((f) => f.code)).toContain("setup-unrealized");
  });

  it("flags a plate that stands on no location reference", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall"], { unanchored: ["wall"] }),
    });
    const unanchored = active.filter((f) => f.code === "plate-unanchored");
    expect(unanchored.map((f) => f.subject)).toEqual(["wall"]);
    expect(unanchored[0]?.message).toContain("reference.here");
  });

  // The window axis, declared in the direction and answered by the plates. `nesting` is `shared`
  // with `solo` declared a window of `wall`, which is what gives the finding something to read.
  const nesting = leaf({
    shots: [
      { ...shot("01", "ordinary", 3), setup: "wall" },
      { ...shot("02", "disruption", 2), setup: "wall" },
      { ...shot("03", "pressure", 3), setup: "solo" },
      { ...shot("04", "hero", 4), setup: "solo" },
    ],
    setups: {
      wall: {
        name: "the wall",
        description: "flat on",
        location: "here",
        framing: "medium",
        view: "front",
        holds: ["hereMark"],
        within: null,
      },
      solo: {
        name: "the solo",
        description: "in close",
        location: "here",
        framing: "close",
        holds: ["hereMark"],
        within: "wall",
      },
    },
  });

  it("flags a window whose plate is not cut inside the frame it is a window of", () => {
    const { active } = checkDirection(nesting, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall", "solo"], { unnested: ["solo"] }),
    });
    const unnested = active.filter((f) => f.code === "plate-unnested");
    expect(unnested.map((f) => f.subject)).toEqual(["solo"]);
    expect(unnested[0]?.message).toContain('"wall"');
  });

  it("says nothing about a frame that declares itself a root", () => {
    const { active } = checkDirection(nesting, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall", "solo"], { unnested: ["wall"] }),
    });
    expect(active.map((f) => f.code)).not.toContain("plate-unnested");
  });

  // `setup-unrealized` stops it, exactly as it stops the anchor findings: there is no plate yet to
  // have been cut in the wrong place.
  it("waits behind the demand for the plate itself", () => {
    const { active } = checkDirection(nesting, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall"], { unnested: ["solo"] }),
    });
    expect(active.filter((f) => f.subject === "solo").map((f) => f.code)).toEqual([
      "setup-unrealized",
    ]);
  });

  // The two are independent: the plate invented its place AND the shots ignore the plate.
  it("reports an unanchored plate alongside the shots ignoring it", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall"], { unanchored: ["wall"], ignoring: { wall: ["01"] } }),
    });
    expect(active.filter((f) => f.subject === "wall").map((f) => f.code)).toEqual([
      "plate-unanchored",
      "setup-unconsumed",
    ]);
  });

  // A one-shot setup owes no plate, so what its keyframe stands on is the location reference itself.
  it("demands the location reference of a shot whose setup has no plate", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates([], { ignoring: { solo: ["03"] } }),
    });
    const unconsumed = active.filter((f) => f.code === "setup-unconsumed");
    expect(unconsumed.map((f) => f.subject)).toEqual(["solo"]);
    expect(unconsumed[0]?.message).toContain("reference.here");
    expect(unconsumed[0]?.message).not.toContain("plates.solo");
    expect(unconsumed[0]?.message).not.toContain("regenerate");
  });

  // Seen by no other shot, the location reference can be the frame itself.
  it("offers regenerating the location reference when one shot alone sees the place", () => {
    const lone = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "wall" },
        { ...shot("02", "disruption", 2), setup: "wall" },
        { ...shot("03", "pressure", 3), setup: "faraway" },
        { ...shot("04", "hero", 4), setup: "wall" },
      ],
      locations: {
        ...defaultLocations,
        there: {
          name: "the far place",
          description: "seen once",
          landmarks: {
            thereMark: { name: "the far mark", promptDepiction: "tower", description: "a tower" },
          },
        },
      },
      setups: {
        wall: {
          name: "the wall",
          description: "flat on",
          location: "here",
          framing: "medium",
          view: "front",
          holds: ["hereMark"],
        },
        faraway: {
          name: "the far view",
          description: "wide",
          location: "there",
          framing: "wide",
          view: "front",
          holds: ["thereMark"],
        },
      },
    });
    const { active } = checkDirection(lone, {
      referenceAssetNames: ["here", "there"],
      animaticSetups: plates(["wall"], { ignoring: { faraway: ["03"] } }),
    });
    const unconsumed = active.filter((f) => f.code === "setup-unconsumed");
    expect(unconsumed.map((f) => f.subject)).toEqual(["faraway"]);
    expect(unconsumed[0]?.message).toContain("regenerate `reference.there`");
  });

  it("names the plate, not the location, once the setup has one", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(["wall"], { ignoring: { wall: ["01", "02"] } }),
    });
    const unconsumed = active.filter((f) => f.code === "setup-unconsumed");
    expect(unconsumed[0]?.message).toContain("plates.wall");
    expect(unconsumed[0]?.message).not.toContain("reference.here");
  });

  // The plate a shared setup still owes is what its shots will stand on, so demanding the location
  // of them too would name a fix that the plate is about to replace.
  it("reports only the missing plate for a shared setup, not the anchor its shots lack", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates([], { ignoring: { wall: ["01", "02"] } }),
    });
    expect(active.filter((f) => f.subject === "wall").map((f) => f.code)).toEqual([
      "setup-unrealized",
    ]);
  });

  // Like the three rosters, setup findings point at post-acceptance wiring — the plate is written in
  // animatic.tsx — so they stay out of the direction review until it is signed off.
  it("defers setup findings until the direction is accepted", () => {
    const { active } = checkDirection(shared, {
      referenceAssetNames: ["here"],
      animaticSetups: plates(),
    });
    expect(reportableDirectionFindings(active, false).map((f) => f.code)).not.toContain(
      "setup-unrealized",
    );
    expect(reportableDirectionFindings(active, true).map((f) => f.code)).toContain(
      "setup-unrealized",
    );
  });

  // Stale-waiver detection is per class, so marking `setups` evaluated without the plate pool would
  // call a live `setup-unrealized` waiver stale — `checkSetups` emitted nothing to match it.
  it("does not flag a plate waiver stale on a pass with no animatic pool", () => {
    const waived = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "wall" },
        { ...shot("02", "hero", 3), setup: "wall" },
      ],
      setups: {
        wall: {
          name: "the wall",
          description: "flat on",
          location: "here",
          framing: "medium",
          view: "front",
          holds: ["hereMark"],
        },
      },
      waivers: { "setup-unrealized_wall": "the two takes are meant to differ" },
    });
    expect(checkDirection(waived).staleWaivers.map((w) => w.key)).not.toContain(
      "setup-unrealized_wall",
    );
    // With the pool, and the plate now declared, the same waiver IS stale.
    expect(
      checkDirection(waived, {
        referenceAssetNames: ["here"],
        animaticSetups: plates(["wall"]),
      }).staleWaivers.map((w) => w.key),
    ).toContain("setup-unrealized_wall");
  });

  it("classifies setup findings as setups findings", () => {
    expect(classifyDirectionFinding("setup-unrealized")).toBe("setups");
    expect(classifyDirectionFinding("unused-setup")).toBe("setups");
    expect(classifyDirectionFinding("setup-atomized")).toBe("setups");
  });

  const frame = (location: string, framing: Framing, holds: readonly string[]): Setup => ({
    name: `a ${framing}`,
    description: `a ${framing} of ${location}`,
    location,
    framing,
    view: "front",
    holds,
  });

  it("allows separate camera angles with the same place, framing and holds", () => {
    const dir = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "oblique" },
        { ...shot("02", "disruption", 2), setup: "overhead" },
        { ...shot("03", "pressure", 4), setup: "oblique" },
        { ...shot("04", "hero", 5), setup: "overhead" },
      ],
      setups: {
        oblique: {
          ...frame("here", "wide", ["hereMark"]),
          description: "looking down from a corner",
        },
        overhead: { ...frame("here", "wide", ["hereMark"]), description: "looking straight down" },
      },
    });
    expect(checkDirection(dir).active).toEqual([]);
    expect(
      spendHeldBy(dir, { command: "generate", stage: "animatic", directionAccepted: true }),
    ).toBe("");
  });

  // One shot per frame across eight shots in one room: the place is lived in and no frame is ever
  // returned to, which is the gap `setup-unrealized` cannot see.
  const atomized = (shots: number, sharedPairs: number) => {
    const roles = ["ordinary", "disruption", "pressure", "hero"];
    const setups: Record<string, Setup> = {};
    const list = [];
    for (let i = 0; i < shots; i += 1) {
      // The first `sharedPairs * 2` shots pair up onto shared frames; the rest each take their own.
      const id = i < sharedPairs * 2 ? `pair${Math.floor(i / 2)}` : `solo${i}`;
      setups[id] = frame("here", "medium", ["hereMark"]);
      list.push({
        ...shot(String(i + 1).padStart(2, "0"), roles[i % roles.length]!, 3),
        setup: id,
      });
    }
    return leaf({ shots: list, setups });
  };

  it("flags a place the piece lives in and never returns to a frame of", () => {
    const findings = checkDirection(atomized(8, 0)).active.filter(
      (f) => f.code === "setup-atomized",
    );
    expect(findings.map((f) => f.subject)).toEqual(["here"]);
    expect(findings[0]?.message).toContain("8 shots");
    expect(findings[0]?.message).toContain("at least 4 of its 8 on a shared frame");
  });

  it("stays silent on a short scene, where varied sizes force one frame per shot", () => {
    expect(checkDirection(atomized(4, 0)).active.map((f) => f.code)).not.toContain(
      "setup-atomized",
    );
  });

  it("still flags a place where one shared frame carries a handful of a long scene's shots", () => {
    expect(checkDirection(atomized(12, 1)).active.map((f) => f.code)).toContain("setup-atomized");
  });

  it("clears once most of the place's shots stand on a frame something else stands on", () => {
    expect(checkDirection(atomized(8, 2)).active.map((f) => f.code)).not.toContain(
      "setup-atomized",
    );
  });

  describe("views", () => {
    // `desk` faces the master's way; `top` looks straight down on the desk and `topClose` is a
    // window of it, so it faces down too.
    const viewed = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "desk" },
        { ...shot("02", "disruption", 2), setup: "top" },
        { ...shot("03", "pressure", 3), setup: "top" },
        { ...shot("04", "hero", 4), setup: "topClose" },
      ],
      setups: {
        desk: {
          name: "the desk",
          description: "straight on",
          location: "here",
          framing: "medium",
          view: "front",
          holds: ["hereMark"],
          within: null,
        },
        top: {
          name: "the desk from above",
          description: "straight down",
          location: "here",
          framing: "medium",
          view: "top",
          holds: ["hereMark"],
          within: null,
        },
        topClose: {
          name: "the desk top",
          description: "in from above",
          location: "here",
          framing: "close",
          holds: ["hereMark"],
          within: "top",
        },
      },
    });
    const codes = (
      d: Direction,
      referenceAssetNames: readonly string[],
      state: AnimaticSetupState = plates(["top"]),
    ) =>
      checkDirection(d, { referenceAssetNames, animaticSetups: state }).active.filter((f) =>
        ["view-unrealized", "plate-unviewed", "view-unanchored"].includes(f.code),
      );

    it("demands an image of every way a used setup faces but front", () => {
      const findings = codes(viewed, ["here"]);
      expect(findings.map((f) => [f.code, f.subject])).toEqual([["view-unrealized", "here.top"]]);
      expect(findings[0]?.message).toContain('"top"');
      expect(findings[0]?.message).toContain("`views`");
    });

    it("is satisfied by the view image the reference stage files", () => {
      expect(codes(viewed, ["here", "view.here.top"])).toEqual([]);
    });

    it("waits for the board", () => {
      const findings = checkDirection(viewed, { referenceAssetNames: ["here"] }).active;
      expect(findings.map((f) => f.code)).not.toContain("view-unrealized");
    });

    it("demands a plate stand on its own view's image", () => {
      const findings = codes(
        viewed,
        ["here", "view.here.top"],
        plates(["top"], { unviewed: ["top"] }),
      );
      expect(findings.map((f) => [f.code, f.subject])).toEqual([["plate-unviewed", "top"]]);
      expect(findings[0]?.message).toContain("reference.view.here.top");
    });

    it("holds a plate-less setup's keyframes to its view's image", () => {
      const findings = codes(
        viewed,
        ["here", "view.here.top"],
        plates(["top"], { unviewedBy: { desk: ["01"] } }),
      );
      expect(findings.map((f) => [f.code, f.subject])).toEqual([["plate-unviewed", "desk"]]);
      expect(findings[0]?.message).toContain('"01"');
      expect(findings[0]?.message).toContain("`reference.here`");
    });

    it("waits for the view image before naming it", () => {
      const findings = codes(viewed, ["here"], plates(["top"], { unviewed: ["top"] }));
      expect(findings.map((f) => f.code)).toEqual(["view-unrealized"]);
    });

    it("demands a view image be made from its location's master", () => {
      const findings = codes(
        viewed,
        ["here", "view.here.top"],
        plates(["top"], { unanchoredViews: ["here.top"] }),
      );
      expect(findings.map((f) => [f.code, f.subject])).toEqual([["view-unanchored", "here.top"]]);
      expect(findings[0]?.message).toContain("reference.here");
    });

    it("names the image of the way a setup faces as its anchor, before it exists", () => {
      const findings = checkDirection(viewed, {
        referenceAssetNames: ["here"],
        animaticSetups: plates(["top"], { unanchored: ["top"] }),
      }).active.filter((f) => f.code === "plate-unanchored");
      expect(findings[0]?.message).toContain("reference.view.here.top");
    });
  });
});

describe("checkDirection locations", () => {
  const withPlace = leaf({
    locations: {
      garden: {
        name: "the garden",
        description: "a walled garden",
        landmarks: {
          gardenMark: {
            name: "the mark",
            promptDepiction: "mark",
            description: "a mark only this place has",
          },
        },
      },
    },
    shots: [
      shot("01", "ordinary", 3, "shot", undefined, "garden"),
      shot("02", "disruption", 2, "shot", undefined, "garden"),
      shot("03", "pressure", 3, "shot", undefined, "garden"),
      shot("04", "hero", 4, "shot", undefined, "garden"),
    ],
  });

  it("does not evaluate locations without referenceAssetNames", () => {
    expect(checkDirection(withPlace).active.map((f) => f.code)).not.toContain(
      "location-unreferenced",
    );
  });

  it("flags an unreferenced location when the pool is supplied", () => {
    const { active } = checkDirection(withPlace, { referenceAssetNames: [] });
    expect(active.map((f) => f.code)).toContain("location-unreferenced");
  });

  it("clears once the reference asset is exposed and the location is used", () => {
    const { active } = checkDirection(withPlace, { referenceAssetNames: ["garden"] });
    expect(active.map((f) => f.code)).not.toContain("location-unreferenced");
    expect(active.map((f) => f.code)).not.toContain("unused-location");
  });

  it("flags a roster location no shot points at", () => {
    const withUnused = leaf({
      locations: {
        garden: {
          name: "the garden",
          description: "a walled garden",
          landmarks: {
            gardenMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
        attic: {
          name: "the attic",
          description: "a dusty attic",
          landmarks: {
            atticMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
        },
      },
      shots: [
        shot("01", "ordinary", 3, "shot", undefined, "garden"),
        shot("02", "disruption", 2, "shot", undefined, "garden"),
        shot("03", "pressure", 3, "shot", undefined, "garden"),
        shot("04", "hero", 4, "shot", undefined, "garden"),
      ],
    });
    const { active } = checkDirection(withUnused, { referenceAssetNames: ["garden", "attic"] });
    const unused = active.find((f) => f.code === "unused-location");
    expect(unused?.subject).toBe("attic");
  });

  it("waives an unreferenced location via the root waivers", () => {
    const waived = withWaivers(withPlace, {
      "location-unreferenced_garden": "the plate arrives later",
    });
    const res = checkDirection(waived, { referenceAssetNames: [] });
    expect(res.active.map((f) => f.code)).not.toContain("location-unreferenced");
    expect(res.waived.map(directionWaiverKey)).toContain("location-unreferenced_garden");
  });

  it("defers location findings until the direction is accepted, like the characters and props", () => {
    const { active } = checkDirection(withPlace, { referenceAssetNames: [] });
    const codes = (accepted: boolean) =>
      reportableDirectionFindings(active, accepted).map((f) => f.code);
    expect(codes(true)).toContain("location-unreferenced");
    expect(codes(false)).not.toContain("location-unreferenced");
  });

  it("does not flag a location waiver stale on a pass that can't evaluate locations", () => {
    const dir = withWaivers(withPlace, { "location-unreferenced_garden": "later" });
    expect(checkDirection(dir).staleWaivers).toEqual([]);
  });
});

describe("checkDirection props", () => {
  it("does not evaluate props without referenceAssetNames", () => {
    expect(checkDirection(withPatty).active.map((f) => f.code)).not.toContain("prop-unreferenced");
  });

  it("flags an unreferenced prop when the pool is supplied", () => {
    const { active } = checkDirection(withPatty, { referenceAssetNames: [] });
    expect(active.map((f) => f.code)).toContain("prop-unreferenced");
  });

  it("clears once the reference asset is exposed and the prop is named", () => {
    const { active } = checkDirection(withPatty, { referenceAssetNames: ["patty"] });
    expect(active.map((f) => f.code)).not.toContain("prop-unreferenced");
    expect(active.map((f) => f.code)).not.toContain("unused-prop");
  });

  it("waives an unreferenced prop via the root waivers", () => {
    const waived = withWaivers(withPatty, { "prop-unreferenced_patty": "the file arrives later" });
    const res = checkDirection(waived, { referenceAssetNames: [] });
    expect(res.active.map((f) => f.code)).not.toContain("prop-unreferenced");
    expect(res.waived.map(directionWaiverKey)).toContain("prop-unreferenced_patty");
  });
});

describe("checkDirection characters", () => {
  it("does not evaluate the characters without referenceAssetNames", () => {
    expect(checkDirection(withCat).active.map((f) => f.code)).not.toContain(
      "character-unreferenced",
    );
  });

  it("flags an unreferenced character when the pool is supplied", () => {
    const { active } = checkDirection(withCat, { referenceAssetNames: [] });
    expect(active.map((f) => f.code)).toContain("character-unreferenced");
  });

  it("clears once the reference asset is exposed", () => {
    const { active } = checkDirection(withCat, { referenceAssetNames: ["cat"] });
    expect(active.map((f) => f.code)).not.toContain("character-unreferenced");
    expect(active.map((f) => f.code)).not.toContain("unused-character");
  });

  it("counts a character a frame holds as used, whatever the action names", () => {
    const framed = leaf({
      characters: { cat },
      shots: [{ ...shot("01", "ordinary", 3, "the sill at dawn"), lineup: ["cat"] }],
    });
    const { active } = checkDirection(framed, { referenceAssetNames: ["cat"] });
    expect(active.map((f) => f.code)).not.toContain("unused-character");
  });

  it("reports an unused character before the direction is accepted, on its part", () => {
    const unused = leaf({
      characters: { cat },
      shots: [shot("01", "ordinary", 3, "the sill at dawn")],
    });
    const findings = directionFindings(
      checkDirection(unused, { referenceAssetNames: ["cat"] }),
      unused,
    ).filter((f) => f.code === "unused-character");
    expect(findings.map((f) => f.targets)).toEqual([["direction:characters.cat"]]);
    expect(reportableDirectionFindings(findings, false)).toHaveLength(1);
  });

  it("waives an unreferenced character via the root waivers", () => {
    const waived = withWaivers(withCat, {
      "character-unreferenced_cat": "the file arrives later",
    });
    const res = checkDirection(waived, { referenceAssetNames: [] });
    expect(res.active.map((f) => f.code)).not.toContain("character-unreferenced");
    expect(res.waived.map(directionWaiverKey)).toContain("character-unreferenced_cat");
  });

  it("folds a sequenced direction's characters against its root waivers", () => {
    const sequenced = branch({
      lens: "three-act",
      pleasure: "cute",
      characters: { cat },
      waivers: { "character-unreferenced_cat": "later" },
      sequences: [
        {
          id: "act1",
          role: "setup-act",
          synopsis: "open",
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            { ...shot("01", "ordinary", 3, "the cat wakes"), lineup: ["cat"] },
            shot("02", "disruption", 2),
            shot("03", "pressure"),
            shot("04", "hero", 4),
          ],
        },
      ],
    });
    const res = checkDirection(sequenced, { referenceAssetNames: [] });
    expect(res.active.map((f) => f.code)).not.toContain("character-unreferenced");
    expect(res.waived.map(directionWaiverKey)).toContain("character-unreferenced_cat");
  });

  it("does not flag a characters waiver stale on a pass that can't evaluate the characters", () => {
    const dir = withWaivers(withCat, { "character-unreferenced_cat": "later" });
    expect(checkDirection(dir).staleWaivers).toEqual([]);
  });
});

describe("the characters findings holding a spend", () => {
  it("blocks generate when a declared character has no reference asset", () => {
    expect(
      spendHeldBy(withCat, {
        command: "generate",
        stage: "animatic",
        referenceAssetNames: [],
        directionAccepted: true,
      }),
    ).toMatch(/character-unreferenced_cat/);
  });

  it("defers a characters finding while the direction is unaccepted", () => {
    expect(
      spendHeldBy(withCat, {
        command: "generate",
        stage: "animatic",
        referenceAssetNames: [],
        directionAccepted: false,
      }),
    ).toBe("");
  });

  it("passes once the reference asset is exposed", () => {
    expect(
      spendHeldBy(withCat, {
        command: "generate",
        stage: "animatic",
        // The default location `here` is a roster entry too, so expose it alongside the character —
        // an unexposed location would itself block the gate (location-unreferenced).
        referenceAssetNames: ["cat", "here"],
        directionAccepted: true,
      }),
    ).toBe("");
  });

  it("does not enforce the characters when reference names are unavailable", () => {
    expect(
      spendHeldBy(withCat, {
        command: "generate",
        stage: "animatic",
        directionAccepted: true,
      }),
    ).toBe("");
  });
});

describe("reportableDirectionFindings", () => {
  it("drops characters findings until the direction is accepted, keeping the rest", () => {
    const { active } = checkDirection(withCat, { referenceAssetNames: [] });
    const codes = (accepted: boolean) =>
      reportableDirectionFindings(active, accepted).map((f) => f.code);
    expect(codes(true)).toContain("character-unreferenced");
    expect(codes(false)).not.toContain("character-unreferenced");
    // The default location `here` is unexposed here too, so its `location-unreferenced` is a second
    // deferred-class finding — both drop while unaccepted, and everything else is kept.
    expect(codes(false)).toEqual(
      codes(true).filter((c) => c !== "character-unreferenced" && c !== "location-unreferenced"),
    );
  });

  it("drops prop findings until the direction is accepted, like the characters", () => {
    const { active } = checkDirection(withPatty, { referenceAssetNames: [] });
    const codes = (accepted: boolean) =>
      reportableDirectionFindings(active, accepted).map((f) => f.code);
    expect(codes(true)).toContain("prop-unreferenced");
    expect(codes(false)).not.toContain("prop-unreferenced");
  });
});

describe("classifyDirectionFinding", () => {
  it("maps codes to their classes", () => {
    expect(classifyDirectionFinding("missing-role")).toBe("arc");
    expect(classifyDirectionFinding("unearned-payoff")).toBe("arc");
    expect(classifyDirectionFinding("role-overweight")).toBe("pacing");
    expect(classifyDirectionFinding("character-unreferenced")).toBe("characters");
    expect(classifyDirectionFinding("unused-character")).toBe("characters");
    expect(classifyDirectionFinding("prop-unreferenced")).toBe("props");
    expect(classifyDirectionFinding("unused-prop")).toBe("props");
    expect(classifyDirectionFinding("location-unreferenced")).toBe("locations");
    expect(classifyDirectionFinding("unused-location")).toBe("locations");
    expect(classifyDirectionFinding("multi-sentence-action")).toBe("arc");
    expect(classifyDirectionFinding("off-grid-duration")).toBe("pacing");
  });
});

describe("checkDirection typesetting", () => {
  // The check reads `policy` directly, so these build one rather than going through `leaf`.
  function withPolicy(lang: string, fonts?: readonly string[]): Direction {
    const dir = leaf({ shots: [shot("01", "ordinary"), shot("02", "disruption")] });
    return {
      ...dir,
      policy: { ...dir.policy, lang, ...(fonts ? { fonts } : {}) },
    } as Direction;
  }

  it("raises fonts-undeclared for a script no default face carries", () => {
    expect(checkDirection(withPolicy("ja")).active.map((f) => f.code)).toContain(
      "fonts-undeclared",
    );
  });

  it("resolves the script, so a region rides along", () => {
    expect(checkDirection(withPolicy("zh-CN")).active.map((f) => f.code)).toContain(
      "fonts-undeclared",
    );
    expect(checkDirection(withPolicy("zh-Hant")).active.map((f) => f.code)).toContain(
      "fonts-undeclared",
    );
  });

  // The tag decides, not the language: a script subtag overrides the language's default either way.
  it("reads an explicit script subtag over the language's default", () => {
    expect(checkDirection(withPolicy("hi-Latn")).active.map((f) => f.code)).not.toContain(
      "fonts-undeclared",
    );
    expect(checkDirection(withPolicy("en-Arab")).active.map((f) => f.code)).toContain(
      "fonts-undeclared",
    );
  });

  // Cyrillic rides on the faces every host ships, so it is exempt like Latin.
  it("stays quiet for Cyrillic", () => {
    expect(checkDirection(withPolicy("ru")).active.map((f) => f.code)).not.toContain(
      "fonts-undeclared",
    );
  });

  it("stays quiet once a family is named", () => {
    expect(
      checkDirection(withPolicy("ja", ["Noto Sans JP"])).active.map((f) => f.code),
    ).not.toContain("fonts-undeclared");
  });

  // Latin, Cyrillic and Greek ride on faces every host ships, so an undeclared `fonts` there is a
  // choice, not a defect.
  it("stays quiet for a script the default stack carries", () => {
    expect(checkDirection(withPolicy("en")).active.map((f) => f.code)).not.toContain(
      "fonts-undeclared",
    );
  });

  // `typesetting` has one check and so one owner: were its group pushed only when it emits, a
  // sequenced root's filtered bag would not own the class and the leftover waiver would go
  // unreported once the family was declared.
  it("reports a leftover waiver stale once a family is declared, on a sequenced direction", () => {
    const dir = branch({
      lens: "three-act",
      sequences: [
        {
          id: "act1",
          role: "setup-act",
          synopsis: "open",
          lens: "mini-drama",
          pleasure: "cute",
          shots: [shot("01", "ordinary"), shot("02", "disruption")],
        },
      ],
      waivers: { "fonts-undeclared": "the piece carries no text" },
    });
    const declared = {
      ...dir,
      policy: { ...dir.policy, lang: "en", fonts: ["Inter"] },
    } as Direction;

    expect(checkDirection(declared).staleWaivers.map((w) => w.key)).toContain("fonts-undeclared");
  });

  it("is waivable, and rides its own class", () => {
    expect(classifyDirectionFinding("fonts-undeclared")).toBe("typesetting");
    const dir = withPolicy("ja");
    const waived = {
      ...dir,
      waivers: { "fonts-undeclared": "the piece carries no text" },
    } as Direction;
    const res = checkDirection(waived);
    expect(res.active.map((f) => f.code)).not.toContain("fonts-undeclared");
    expect(res.waived.map((f) => f.code)).toContain("fonts-undeclared");
  });
});

describe("checkDirection fused shots", () => {
  function withAction(action: string): Direction {
    return leaf({
      shots: [
        shot("01", "ordinary"),
        shot("02", "disruption", 2, action),
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
  }

  it("flags an action that reads as two sentences", () => {
    const dir = withAction("扉が開く。少女が驚く。");
    expect(
      checkDirection(dir).active.find((f) => f.code === "multi-sentence-action")?.subject,
    ).toBe("02");
  });

  it("counts ASCII terminators too", () => {
    const dir = withAction("The door opens. She gasps.");
    expect(checkDirection(dir).active.map((f) => f.code)).toContain("multi-sentence-action");
  });

  it("flags a boundary whatever ends the last sentence", () => {
    for (const action of [
      "扉が開く。少女が驚く",
      "Bang! The door slams",
      "扉が開く！少女が驚く。",
    ]) {
      expect(checkDirection(withAction(action)).active.map((f) => f.code)).toContain(
        "multi-sentence-action",
      );
    }
  });

  it("does not read a terminator inside quoted speech", () => {
    for (const action of [
      "「えっ！」と少女が振り返る。",
      "『待って！』と叫ぶ。",
      'She shouts "Stop!" and grabs his arm.',
      "She shouts “Stop!” and grabs his arm.",
    ]) {
      expect(checkDirection(withAction(action)).active.map((f) => f.code)).not.toContain(
        "multi-sentence-action",
      );
    }
  });

  it("does not read an initial's dot, or an ASCII dot before lowercase, as a boundary", () => {
    for (const action of [
      "A U.S. agent kicks the door open.",
      "J. K. opens the letter.",
      "She checks the clock at 7 a.m. and leaves.",
      "He grabs a tool, e.g. a hammer.",
    ]) {
      expect(checkDirection(withAction(action)).active.map((f) => f.code)).not.toContain(
        "multi-sentence-action",
      );
    }
  });

  it("does not flag a single-sentence action", () => {
    expect(checkDirection(withAction("扉が開く。")).active.map((f) => f.code)).not.toContain(
      "multi-sentence-action",
    );
    expect(checkDirection(withAction("The door opens.")).active.map((f) => f.code)).not.toContain(
      "multi-sentence-action",
    );
  });

  it("does not miscount an ellipsis, a decimal, or a Latin abbreviation", () => {
    for (const action of [
      "扉がゆっくりと開く……",
      "Mr. Smith opens the door.",
      "3.5秒かけて開く。",
    ]) {
      expect(checkDirection(withAction(action)).active.map((f) => f.code)).not.toContain(
        "multi-sentence-action",
      );
    }
  });

  it("collapses a mixed terminator run into one sentence end", () => {
    expect(checkDirection(withAction("扉が開く！？")).active.map((f) => f.code)).not.toContain(
      "multi-sentence-action",
    );
  });

  it("is waivable via multi-sentence-action_<shotId>", () => {
    const dir = withWaivers(withAction("扉が開く。少女が驚く。"), {
      "multi-sentence-action_02": "one deliberate two-sentence action",
    });
    const res = checkDirection(dir);
    expect(res.active.map((f) => f.code)).not.toContain("multi-sentence-action");
    expect(res.waived.map(directionWaiverKey)).toContain("multi-sentence-action_02");
  });

  it("blocks generate as an arc-class finding until waived", () => {
    const dir = withAction("扉が開く。少女が驚く。");
    expect(
      spendHeldBy(dir, { command: "generate", stage: "video", directionAccepted: true }),
    ).toMatch(/multi-sentence-action_02/);
  });
});

describe("checkDirection off-grid durations", () => {
  function withDuration(duration: number): Direction {
    return leaf({
      shots: [
        shot("01", "ordinary"),
        shot("02", "disruption", duration),
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
  }

  it("flags a shot whose duration is off the 0.5s grid", () => {
    expect(
      checkDirection(withDuration(1.2)).active.find((f) => f.code === "off-grid-duration")?.subject,
    ).toBe("02");
  });

  it("flags a non-positive duration", () => {
    expect(checkDirection(withDuration(0)).active.map((f) => f.code)).toContain(
      "off-grid-duration",
    );
  });

  it("does not flag a half second or a whole second", () => {
    for (const d of [0.5, 1, 2.5, 3]) {
      expect(checkDirection(withDuration(d)).active.map((f) => f.code)).not.toContain(
        "off-grid-duration",
      );
    }
  });

  it("fires once per shot, not again on the enclosing arc's derived total", () => {
    const codes = checkDirection(withDuration(1.2)).active.filter(
      (f) => f.code === "off-grid-duration",
    );
    expect(codes).toHaveLength(1);
  });

  it("is not cancelled by a waiver", () => {
    const dir = withWaivers(withDuration(1.2), {
      "off-grid-duration_02": "trimmed from a 2s take",
    });
    const res = checkDirection(dir);
    expect(res.active.map(directionWaiverKey)).toContain("off-grid-duration_02");
    expect(res.staleWaivers.map((w) => w.key)).toEqual(["off-grid-duration_02"]);
  });

  it("blocks generate as a pacing-class finding until waived", () => {
    expect(
      spendHeldBy(withDuration(1.2), {
        command: "generate",
        stage: "video",
        directionAccepted: true,
      }),
    ).toMatch(/off-grid-duration_02/);
  });
});

describe("checkCharacterVoices", () => {
  const speaking = (voiceAssetId: string | null) => [
    { id: "cat", name: "黒猫", voiceAssetId, speaks: true },
  ];

  it("flags a speaking character with no voice cast", () => {
    const finding = checkCharacterVoices(speaking(null), []).find(
      (f) => f.code === "character-voice-missing",
    );
    expect(finding?.subject).toBe("cat");
  });

  it("says nothing about a silent character with no voice", () => {
    expect(
      checkCharacterVoices([{ id: "cat", name: "黒猫", voiceAssetId: null, speaks: false }], []),
    ).toEqual([]);
  });

  it("flags a cast voice whose sample is not exposed", () => {
    const codes = checkCharacterVoices(speaking("catVoice"), []).map((f) => f.code);
    expect(codes).toContain("character-voice-unreferenced");
    expect(codes).not.toContain("character-voice-missing");
  });

  it("passes a cast voice exposed in the pool", () => {
    expect(checkCharacterVoices(speaking("catVoice"), ["catVoice"])).toEqual([]);
  });

  // The `unused-character` prose scan does not cover this: a character named in an action reads as
  // used there while the voice generated for them sits idle.
  it("flags a voice cast for a character who never speaks", () => {
    const finding = checkCharacterVoices(
      [{ id: "cat", name: "黒猫", voiceAssetId: "catVoice", speaks: false }],
      ["catVoice"],
    ).find((f) => f.code === "unused-character-voice");
    expect(finding?.subject).toBe("cat");
  });
});

describe("checkNarrator", () => {
  it("flags narration lines with no narrator cast", () => {
    expect(checkNarrator(null, [], true).map((f) => f.code)).toEqual(["narrator-missing"]);
  });

  it("says nothing when there is neither narration nor a narrator", () => {
    expect(checkNarrator(null, [], false)).toEqual([]);
  });

  it("flags a narrator whose sample is not exposed", () => {
    expect(checkNarrator("narratorVoice", [], true).map((f) => f.code)).toEqual([
      "narrator-unreferenced",
    ]);
  });

  it("passes a narrator exposed in the pool", () => {
    expect(checkNarrator("narratorVoice", ["narratorVoice"], true)).toEqual([]);
  });

  it("flags a narrator cast over a piece with no narration line", () => {
    expect(checkNarrator("narratorVoice", ["narratorVoice"], false).map((f) => f.code)).toEqual([
      "unused-narrator",
    ]);
  });

  // Singular by construction: a `{ narration }` line names no speaker, so there is only ever one
  // narrator to cast and the findings carry no subject.
  it("carries no subject", () => {
    expect(checkNarrator(null, [], true)[0]?.subject).toBeUndefined();
  });
});

describe("checkDirection voices", () => {
  const cat: Record<string, Character> = {
    cat: { name: "黒猫", promptDepiction: "black cat", description: "a black cat" },
  };
  const spoken: ScriptLine[] = [{ character: "cat", text: "にゃあ" }];
  const speaks = leaf({
    characters: cat,
    shots: [
      { ...shot("01", "ordinary"), script: spoken },
      shot("02", "disruption", 2),
      shot("03", "pressure"),
      shot("04", "hero", 4),
    ],
  });

  it("does not evaluate voices without referenceAssetNames", () => {
    expect(checkDirection(speaks).active.map((f) => f.code)).not.toContain(
      "character-voice-missing",
    );
  });

  it("flags a speaking character with no voice once the pool is supplied", () => {
    const { active } = checkDirection(speaks, { referenceAssetNames: ["cat"] });
    expect(active.map((f) => f.code)).toContain("character-voice-missing");
  });

  it("clears once a voice is cast and its sample exposed", () => {
    const withVoice = leaf({
      characters: {
        cat: {
          ...cat.cat!,
          voice: { id: "catVoice", description: "small, quick" },
          promptDepiction: "cat",
        },
      },
      shots: speaks.sequence.shots as NarrativeShot[],
    });
    const { active } = checkDirection(withVoice, { referenceAssetNames: ["cat", "catVoice"] });
    expect(active.map((f) => f.code)).not.toContain("character-voice-missing");
    expect(active.map((f) => f.code)).not.toContain("character-voice-unreferenced");
  });

  // The intended exit for a piece whose lines are subtitles, or whose TTS takes a preset voice name
  // rather than a sample.
  it("waives a missing voice via the root waivers", () => {
    const waived = withWaivers(speaks, {
      "character-voice-missing_cat": "the lines are subtitles, never spoken",
    });
    const res = checkDirection(waived, { referenceAssetNames: ["cat"] });
    expect(res.active.map((f) => f.code)).not.toContain("character-voice-missing");
    expect(res.waived.map(directionWaiverKey)).toContain("character-voice-missing_cat");
  });

  it("defers voice findings until the direction is accepted, like the rest of the cast", () => {
    const { active } = checkDirection(speaks, { referenceAssetNames: ["cat"] });
    const codes = (accepted: boolean) =>
      reportableDirectionFindings(active, accepted).map((f) => f.code);
    expect(codes(true)).toContain("character-voice-missing");
    expect(codes(false)).not.toContain("character-voice-missing");
  });

  it("classifies every voice finding as a characters finding", () => {
    for (const code of [
      "character-voice-missing",
      "character-voice-unreferenced",
      "unused-character-voice",
      "narrator-missing",
      "narrator-unreferenced",
      "unused-narrator",
    ] as const) {
      expect(classifyDirectionFinding(code)).toBe("characters");
    }
  });

  it("demands a narrator once a shot declares a narration line", () => {
    const narrated = leaf({
      shots: [
        { ...shot("01", "ordinary"), script: [{ narration: "むかしむかし" }] as ScriptLine[] },
        shot("02", "disruption", 2),
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
    expect(
      checkDirection(narrated, { referenceAssetNames: [] }).active.map((f) => f.code),
    ).toContain("narrator-missing");
    const cast = { ...narrated, narrator: { id: "narratorVoice", description: "warm, unhurried" } };
    expect(
      checkDirection(cast, { referenceAssetNames: ["narratorVoice"] }).active.map((f) => f.code),
    ).not.toContain("narrator-missing");
  });
});

describe("validateDirectionStructure voices", () => {
  const codesOf = (dir: Direction) => validateDirectionStructure(dir).map((e) => e.code);
  const withCharacterVoice = (voice: { id: string; description: string }): Direction =>
    leaf({
      characters: {
        cat: { name: "黒猫", description: "a black cat", voice, promptDepiction: "cat" },
      },
      shots: [shot("01", "ordinary"), shot("02", "disruption"), shot("03", "hero")],
    });

  it("flags a voice id that is not a valid asset name", () => {
    expect(codesOf(withCharacterVoice({ id: "cat:voice", description: "small" }))).toContain(
      "character-voice-invalid-id",
    );
  });

  // Without this, an agent silences `character-voice-missing` by casting a voice that says nothing
  // about how it sounds.
  it("flags an empty voice description", () => {
    expect(codesOf(withCharacterVoice({ id: "catVoice", description: "  " }))).toContain(
      "character-voice-empty-description",
    );
  });

  it("flags an empty narrator description", () => {
    const dir = leaf({
      narrator: { id: "narratorVoice", description: "" },
      shots: [shot("01", "ordinary")],
    });
    expect(codesOf(dir)).toContain("narrator-empty-description");
  });

  it("flags a voice id colliding with a roster id", () => {
    const dir = leaf({
      characters: {
        cat: {
          name: "黒猫",
          description: "a black cat",
          voice: { id: "here", description: "小" },
          promptDepiction: "cat",
        },
      },
      shots: [shot("01", "ordinary")],
    });
    const conflict = validateDirectionStructure(dir).find(
      (e) => e.code === "reference-id-conflict",
    );
    expect(conflict?.subject).toBe("here");
  });

  // One sample cast twice is deliberate — a narrator who is the protagonist, twins — and the two
  // `description`s are performance briefs on one sample, not a contradiction.
  it("allows two cast members to share one voice id", () => {
    const twoCharacters = leaf({
      characters: {
        cat: {
          name: "黒猫",
          description: "a black cat",
          voice: { id: "v", description: "小" },
          promptDepiction: "cat",
        },
        dog: {
          name: "白犬",
          description: "a white dog",
          voice: { id: "v", description: "低" },
          promptDepiction: "dog",
        },
      },
      shots: [shot("01", "ordinary")],
    });
    expect(codesOf(twoCharacters)).not.toContain("reference-id-conflict");

    const characterAndNarrator = leaf({
      characters: {
        cat: {
          name: "黒猫",
          description: "a black cat",
          voice: { id: "v", description: "小" },
          promptDepiction: "cat",
        },
      },
      narrator: { id: "v", description: "低" },
      shots: [shot("01", "ordinary")],
    });
    expect(codesOf(characterAndNarrator)).not.toContain("reference-id-conflict");
  });
});

describe("assertCanvasFormat", () => {
  const format = (megapixels: number, delivery = { width: 1920, height: 1080 }) => ({
    fps: 24,
    size: { megapixels, delivery },
  });

  // The canvas clock every stage derives its fps from. Left unchecked, each consumer read a broken
  // value its own way — a sampler falling back to 30, a capture passing it straight through — and
  // the disagreement surfaced only after the spend.
  it("demands a positive, finite fps", () => {
    const withFps = (fps: number) => ({ ...format(0.9), fps });
    expect(() => assertCanvasFormat(withFps(24))).not.toThrow();
    expect(() => assertCanvasFormat(withFps(29.97))).not.toThrow();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertCanvasFormat(withFps(bad))).toThrow(/positive, finite number of frames/);
    }
  });

  it("accepts any positive budget up to the cap", () => {
    for (const mp of [0.02, 0.6, 0.9, 2.07, 16]) {
      expect(() => assertCanvasFormat(format(mp))).not.toThrow();
    }
  });

  // The one number an author states in a unit they could get wrong: pixels typed for megapixels.
  it("rejects a non-positive, non-finite or oversized budget", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 921600]) {
      expect(() => assertCanvasFormat(format(bad))).toThrow(/megapixels must be a positive number/);
    }
  });

  // The delivered frame is encoded as yuv420p. The derived canvas and the cover frame land even on
  // their own; the authored delivery is the one axis that can be odd.
  // A budget only means what it says while the size it asks for clears the grid on both axes. Below
  // that the short axis floors at 32, the long one stretches to hold the aspect, and the canvas
  // walks away from the budget — which is also what stops the ceiling above from bounding anything.
  it("refuses a budget too small to hold the delivery's aspect on the grid", () => {
    expect(() => assertCanvasFormat(format(0.5, { width: 2, height: 4000 }))).toThrow(
      /too small to hold the 1:2000 aspect/,
    );
    expect(() => assertCanvasFormat(format(0.001, { width: 1920, height: 1080 }))).toThrow(
      /under the 32-pixel grid/,
    );
    // A square delivery holds a tiny budget fine — 32×32 is on the grid.
    expect(() => assertCanvasFormat(format(0.001024, { width: 32, height: 32 }))).not.toThrow();
  });

  it("holds the delivery to even dimensions", () => {
    expect(() => assertCanvasFormat(format(0.9, { width: 1921, height: 1080 }))).toThrow(
      /delivery\.width must be even/,
    );
    expect(() => assertCanvasFormat(format(0.9, { width: 1920, height: 1081 }))).toThrow(
      /delivery\.height must be even/,
    );
  });

  it("holds the delivery to positive integers", () => {
    expect(() => assertCanvasFormat(format(0.9, { width: 1920, height: 0 }))).toThrow(
      /delivery\.height must be a positive integer/,
    );
    expect(() => assertCanvasFormat(format(0.9, { width: 1920.5, height: 1080 }))).toThrow(
      /delivery\.width must be a positive integer/,
    );
  });
});

// These ARE the sizes every piece generates at, and they feed the definition hash — so the
// expectations here are exact, never approximate.
describe("deriveCanvasBase", () => {
  const HD = { width: 1920, height: 1080 };

  it("lands every axis on the 32-pixel grid models sample on", () => {
    for (const mp of [0.2, 0.35, 0.6, 0.77, 0.9, 1.0, 1.4, 2.07]) {
      const base = deriveCanvasBase({ megapixels: mp, delivery: HD });
      expect(base.width % 32).toBe(0);
      expect(base.height % 32).toBe(0);
    }
  });

  it("resolves the budget to the canvas the rule pins", () => {
    const at = (mp: number) => deriveCanvasBase({ megapixels: mp, delivery: HD });
    expect(at(0.6)).toEqual({ width: 1024, height: 576 });
    expect(at(0.9)).toEqual({ width: 1248, height: 704 });
    expect(at(1.0)).toEqual({ width: 1312, height: 736 });
  });

  // The delivered frame is cropped out of the canvas, so drifting off the delivery's shape costs
  // picture.
  it("tracks the delivery's aspect within a grid step", () => {
    for (const mp of [0.3, 0.5, 0.7, 0.9, 1.2]) {
      const base = deriveCanvasBase({ megapixels: mp, delivery: HD });
      expect(Math.abs(base.width / base.height / (16 / 9) - 1)).toBeLessThan(0.01);
    }
  });

  it("takes its orientation from the delivery, so a portrait piece states it once", () => {
    const portrait = deriveCanvasBase({
      megapixels: 0.6,
      delivery: { width: 1080, height: 1920 },
    });
    expect(portrait).toEqual({ width: 576, height: 1024 });
  });

  it("stays near the requested area", () => {
    for (const mp of [0.3, 0.6, 0.9, 1.5]) {
      const base = deriveCanvasBase({ megapixels: mp, delivery: HD });
      expect(Math.abs((base.width * base.height) / (mp * 1e6) - 1)).toBeLessThan(0.12);
    }
  });

  // Aspect error is scored on the log of the ratio, so too-wide and too-narrow by the same factor
  // score the same. A relative error scores them differently and picks a non-transposed canvas.
  it("transposes — a portrait delivery resolves to the landscape canvas, turned", () => {
    for (const mp of [0.3, 0.6, 0.9, 1.4]) {
      const landscape = deriveCanvasBase({ megapixels: mp, delivery: HD });
      const portrait = deriveCanvasBase({
        megapixels: mp,
        delivery: { width: HD.height, height: HD.width },
      });
      expect(portrait).toEqual({ width: landscape.height, height: landscape.width });
    }
  });

  it("is reproducible — the same budget resolves to the same canvas every time", () => {
    const budget = { megapixels: 0.9, delivery: HD };
    expect(deriveCanvasBase(budget)).toEqual(deriveCanvasBase(budget));
  });
});
