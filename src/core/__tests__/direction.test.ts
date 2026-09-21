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
  assertDirectionGate,
  checkDirection,
  classifyDirectionFinding,
  directionWaiverKey,
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
      // Every terse location declares one landmark, minted the same way (see `locationsFor`).
      holds: framing === "insert" ? [] : [`${location}Mark`],
      // One landmark held by every frame of the place makes each narrower one a `within` candidate.
      // Nothing terse is about windows, so each frame is declared a root of its own axis.
      within: null,
    };
  }
  return out;
}

// Build a leaf-root direction (one arc over shots). Piece-wide fields (characters/lenses, and the
// speech rule under `policy`) stay at the top; the arc (lens/pleasure/shots/waivers) lives in the
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
  speech?: "none" | "no-dialogue";
  lenses?: unknown[];
}): Direction {
  const node: DirectionNode = {
    lens: opts.lens ?? "mini-drama",
    pleasure: opts.pleasure ?? "cute",
    shots: opts.shots,
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
  };
  return {
    ...(opts.characters ? { characters: opts.characters } : {}),
    locations: opts.locations ?? defaultLocations,
    setups: opts.setups ?? setupsFor(opts.shots),
    ...(opts.narrator ? { narrator: opts.narrator } : {}),
    ...(opts.speech ? { policy: { speech: opts.speech } } : {}),
    ...(opts.lenses ? { lenses: opts.lenses } : {}),
    sequence: node,
  } as Direction;
}

// A one-act container lens. No built-in declares a function-less beat — opting out of the arc
// engine is a project's own `defineLens` call — so a test that wants a branch root wrapping a single
// act brings its own.
const ONE_ACT = defineLens({ name: "one-act", payoff: "whole", beats: [{ role: "whole" }] });

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
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
  };
  return {
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

// Override the root node's shots / waivers (they live in `sequence`, not at the top level). The
// setups roster follows the new shots, since a fixture's frames are derived from them.
function withShots(base: Direction, shots: NarrativeShot[]): Direction {
  return {
    ...base,
    setups: { ...base.setups, ...setupsFor(shots) },
    sequence: { ...base.sequence, shots },
  };
}
function withWaivers(base: Direction, waivers: Record<string, string>): Direction {
  return { ...base, sequence: { ...base.sequence, waivers } };
}

const cat: Character = { name: "the cat", promptDepiction: "cat", description: "a black cat" };

// completeMiniDrama with the cat named in its opening action, so only the reference-pool axis varies.
const withCat: Direction = leaf({
  characters: { cat },
  shots: [
    shot("01", "ordinary", 3, "the cat wakes on the sill"),
    shot("02", "disruption", 2),
    shot("03", "pressure"),
    shot("04", "hero", 4),
  ],
});

// completeMiniDrama with a recurring prop named in its opening action, so only the reference-pool
// axis varies. Props share the shape of the characters; `leaf` does not carry them, so it is spread on.
const patty = { name: "the patty", description: "a golden fish patty" };
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
      lenses: [{ name: "broken", payoff: "release", beats: [{ role: "hero" }] }],
    });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("payoff-not-in-beats");
  });

  it("flags a custom lens whose declared payoff is not a payoff-function role", () => {
    // The payoff beat declares a grounding `fn`, so the checker knows the declared climax is a
    // grounding role — a definition bug.
    const dir = leaf({
      lens: "vibes",
      shots: [shot("01", "atmosphere")],
      lenses: [
        { name: "vibes", payoff: "atmosphere", beats: [{ role: "atmosphere", fn: "ground" }] },
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
      props: { "fish:patty": { name: "the patty", description: "a fish patty" } },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("prop-invalid-id");
  });

  it("flags an empty prop name and description", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      props: { patty: { name: "  ", description: "" } },
    };
    const codes = validateDirectionStructure(dir).map((e) => e.code);
    expect(codes).toContain("prop-empty-name");
    expect(codes).toContain("prop-empty-description");
  });

  it("flags a prop id that collides with a character id (both map to reference:<id>)", () => {
    const dir: Direction = {
      ...completeMiniDrama,
      characters: { cat: { name: "the cat", description: "a black cat", promptDepiction: "cat" } },
      props: { cat: { name: "the toy cat", description: "a plush cat" } },
    };
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("reference-id-conflict");
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
          holds: ["hereMark"],
        },
        empty: {
          name: "  ",
          description: "",
          location: "here",
          framing: "wide",
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
      props: { patty: { name: "the patty", description: "a fish patty" } },
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

  // Telop is not speech, so it never demands a voice and never trips the speech policy — the case
  // the old subtitles-only waiver existed for.
  it("passes telop-only shots under speech: none, with no cast voice", () => {
    const dir = leaf({
      characters: { cat },
      speech: "none",
      shots: [
        { ...shot("01", "ordinary", 3, "the cat wakes"), telop: ["第一話"] },
        shot("02", "disruption", 2),
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
    expect(validateDirectionStructure(dir)).toEqual([]);
    expect(checkDirection(dir).active.map((f) => f.code)).not.toContain("unexpected-script");
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
      waivers: { "missing-beat_disruption": "intentional unbroken loop" },
    });
    const { active, waived } = checkDirection(dir);
    expect(active.map((f) => f.code)).not.toContain("missing-beat");
    expect(waived.map(directionWaiverKey)).toContain("missing-beat_disruption");
  });

  it("flags a waiver whose finding is gone as stale", () => {
    const dir = withWaivers(completeMiniDrama, {
      "missing-beat_disruption": "stale — disruption now exists",
    });
    expect(checkDirection(dir).staleWaivers.map((w) => w.key)).toContain("missing-beat_disruption");
  });

  it("does not flag a completeness waiver stale on a direction-only pass", () => {
    const dir = withWaivers(completeMiniDrama, {
      unrealized_04: "shot dropped from this stage on purpose",
    });
    expect(checkDirection(dir).staleWaivers).toEqual([]);
  });

  it("fails a waiver key whose code is written with underscores, naming the key meant", () => {
    const dir = withWaivers(completeMiniDrama, { beat_overweight_problem: "deliberate overrun" });
    const errors = validateDirectionStructure(dir).filter((e) => e.code === "waiver-unknown-code");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.subject).toBe("beat_overweight_problem");
    expect(errors[0]?.message).toContain('"beat-overweight_problem"');
  });

  it("passes a correctly keyed waiver, subject-less or with a subject", () => {
    const dir = withWaivers(completeMiniDrama, {
      "no-payoff": "cold open",
      "missing-beat_disruption": "intentional unbroken loop",
    });
    expect(validateDirectionStructure(dir).filter((e) => e.code === "waiver-unknown-code")).toEqual(
      [],
    );
  });

  it("fails a waiver key naming a structural error code, which is never waivable", () => {
    const dir = withWaivers(completeMiniDrama, { "duplicate-id_01": "no" });
    expect(
      validateDirectionStructure(dir)
        .map((e) => e.code)
        .filter((c) => c === "waiver-unknown-code"),
    ).toEqual(["waiver-unknown-code"]);
  });
});

describe("defineLens (custom lenses)", () => {
  it("registers a custom shot lens that resolves and passes the arc checks", () => {
    const tutorial = defineLens({
      name: "tutorial",
      payoff: "completion",
      beats: [
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
      beats: [
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
    expect(checkDirection(dir).active.map((f) => f.code)).toContain("missing-beat");
  });

  it("registers a custom lens resolved at the meta (sequence) scale", () => {
    const twoAct = defineLens({
      name: "two-act",
      payoff: "climax-act",
      beats: [
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
      beats: [{ role: "hero", maxShare: 1.5 }],
    });
    const dir = leaf({ lens: "bad", shots: [shot("01", "hero")], lenses: [bad] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("invalid-share");
  });

  it("rejects a lens beat whose minShare exceeds its maxShare", () => {
    const bad = defineLens({
      name: "bad",
      payoff: "hero",
      beats: [{ role: "hero", minShare: 0.8, maxShare: 0.2 }],
    });
    const dir = leaf({ lens: "bad", shots: [shot("01", "hero")], lenses: [bad] });
    expect(validateDirectionStructure(dir).map((e) => e.code)).toContain("invalid-share");
  });
});

describe("assertDirectionGate", () => {
  it("aborts on an unwaived arc hole", () => {
    const dir = leaf({
      shots: [shot("01", "ordinary", 3), shot("03", "pressure", 2), shot("04", "hero", 4)],
    });
    expect(() =>
      assertDirectionGate(dir, { command: "generate", stage: "video", directionAccepted: true }),
    ).toThrow(/missing-beat_disruption/);
  });

  it("passes once the arc hole is waived", () => {
    const dir = leaf({
      shots: [shot("01", "ordinary", 3), shot("03", "pressure", 2), shot("04", "hero", 4)],
      waivers: { "missing-beat_disruption": "ok" },
    });
    expect(() =>
      assertDirectionGate(dir, { command: "generate", stage: "video", directionAccepted: true }),
    ).not.toThrow();
  });

  it("allows partial coverage on generate but enforces it on a video export", () => {
    const realizedIds = ["01", "02", "03"]; // 04 (hero) not yet realized
    expect(() =>
      assertDirectionGate(completeMiniDrama, {
        command: "generate",
        stage: "video",
        realizedIds,
        directionAccepted: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertDirectionGate(completeMiniDrama, {
        command: "export",
        stage: "video",
        realizedIds,
        directionAccepted: true,
      }),
    ).toThrow(/unrealized_04/);
  });

  it("aborts on a structural error regardless of scope", () => {
    const dir = leaf({ shots: [] });
    expect(() =>
      assertDirectionGate(dir, {
        command: "generate",
        stage: "animatic",
        directionAccepted: true,
      }),
    ).toThrow(/empty-direction/);
  });

  it("qualifies a stage-order finding by stage so a per-stage waiver matches", () => {
    const realizedIds = ["02", "01", "03", "04"]; // reordered vs the direction
    expect(() =>
      assertDirectionGate(completeMiniDrama, {
        command: "generate",
        stage: "video",
        realizedIds,
        directionAccepted: true,
      }),
    ).toThrow(/stage-order-mismatch_video/);

    const waived = withWaivers(completeMiniDrama, {
      "stage-order-mismatch_video": "intentional re-cut",
    });
    expect(() =>
      assertDirectionGate(waived, {
        command: "generate",
        stage: "video",
        realizedIds,
        directionAccepted: true,
      }),
    ).not.toThrow();
  });

  it("enforces completeness on a sequenced video export but not on generate", () => {
    const sequenced = branch({
      lens: "one-act",
      lenses: [ONE_ACT],
      pleasure: "cute",
      sequences: [
        {
          id: "act1",
          role: "whole",
          synopsis: "open",
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            shot("01", "ordinary"),
            shot("02", "disruption", 2),
            shot("03", "pressure"),
            shot("04", "hero", 4),
          ],
        },
      ],
    });
    const realizedIds = ["01", "02", "03"]; // 04 (hero) not yet realized
    expect(() =>
      assertDirectionGate(sequenced, {
        command: "generate",
        stage: "video",
        realizedIds,
        directionAccepted: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertDirectionGate(sequenced, {
        command: "export",
        stage: "video",
        realizedIds,
        directionAccepted: true,
      }),
    ).toThrow(/unrealized_04/);
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
      (f) => f.code === "missing-beat" && f.subject === "confrontation-act",
    );
    // The meta arc is the root node, so its findings carry the root's field path — a child node's
    // would read ["sequence", "sequences", "act1"].
    expect(finding?.path).toEqual(["sequence"]);
  });

  it("waives a meta-arc finding via the root waivers", () => {
    const dir = threeActDirection(
      [seq("act1", "setup-act", "a", 1), seq("act3", "climax-act", "c", 1)],
      { "missing-beat_confrontation-act": "folded into act1" },
    );
    const res = checkDirection(dir);
    expect(res.active.map((f) => f.subject)).not.toContain("confrontation-act");
    expect(res.waived.map(directionWaiverKey)).toContain("missing-beat_confrontation-act");
  });

  it("flags a thin payoff act from derived durations (act-ratio)", () => {
    const dir = threeActDirection([
      seq("act1", "setup-act", "a", 1),
      seq("act2", "confrontation-act", "b", 30),
      seq("act3", "climax-act", "c", 1),
    ]);
    expect(
      checkDirection(dir).active.some(
        (f) => f.code === "beat-underweight" && f.subject === "climax-act",
      ),
    ).toBe(true);
  });

  it("does not flag a valid meta-arc waiver stale on a direction-only pass", () => {
    const dir = threeActDirection(balancedSequences, {
      "missing-beat_confrontation-act": "stale?",
    });
    // balanced HAS confrontation-act, so this waiver has no finding — it is genuinely stale, and a
    // direction-only pass evaluates the arc class, so it must be reported (the guard is for classes NOT run).
    expect(checkDirection(dir).staleWaivers.map((w) => w.key)).toContain(
      "missing-beat_confrontation-act",
    );
  });

  it("reports an unknown-code node waiver as a structural error, not as stale", () => {
    const dir = threeActDirection(balancedSequences, { "missing-beats_x": "typo" });
    const { structureErrors, staleWaivers } = checkDirection(dir, { referenceAssetNames: [] });
    expect(structureErrors.filter((e) => e.code === "waiver-unknown-code")).toHaveLength(1);
    expect(staleWaivers.map((w) => w.key)).not.toContain("missing-beats_x");
  });
});

describe("checkDirection function checks", () => {
  it("flags a one-beat custom lens as an unearned payoff, waivable as a cold open", () => {
    const hollow = defineLens({
      name: "hollow",
      payoff: "peak",
      beats: [{ role: "peak", fn: "payoff" }],
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

describe("checkDirection space checks", () => {
  // A wide→medium cut inside the one default location; the tail sizes vary so nothing else fires.
  const exposedShots = () => [
    shot("01", "ordinary", 3, "shot", "wide"),
    shot("02", "disruption", 2, "shot", "medium"),
    shot("03", "pressure", 4, "shot", "close"),
    shot("04", "hero", 5, "shot", "insert"),
  ];

  it("flags an undeclared wide→medium cut in one location", () => {
    const finding = checkDirection(leaf({ shots: exposedShots() })).active.find(
      (f) => f.code === "undeclared-continuity",
    );
    expect(finding?.subject).toBe("01-02");
  });

  it("is waivable via undeclared-continuity_<pair>", () => {
    const dir = withWaivers(leaf({ shots: exposedShots() }), {
      "undeclared-continuity_01-02": "an axial punch-in landing the turn",
    });
    const res = checkDirection(dir);
    expect(res.active.map((f) => f.code)).not.toContain("undeclared-continuity");
    expect(res.waived.map(directionWaiverKey)).toContain("undeclared-continuity_01-02");
  });

  it("flags a second wide of one location inside a role, and waives it by subject", () => {
    const shots = [
      shot("01", "ordinary", 3, "shot", "wide"),
      shot("02", "ordinary", 2, "shot", "close"),
      shot("03", "ordinary", 4, "shot", "wide"),
      shot("04", "disruption", 3, "shot", "close"),
      shot("05", "pressure", 4, "shot", "medium"),
      shot("06", "hero", 5, "shot", "insert"),
    ];
    const bare = checkDirection(leaf({ shots })).active.find(
      (f) => f.code === "re-established-wide",
    );
    expect(bare?.subject).toBe("03");
    const waived = withWaivers(leaf({ shots }), {
      "re-established-wide_03": "the set itself changed — the shelf came down between the two",
    });
    const res = checkDirection(waived);
    expect(res.active.map((f) => f.code)).not.toContain("re-established-wide");
    expect(res.waived.map(directionWaiverKey)).toContain("re-established-wide_03");
  });
});

describe("checkCharacters", () => {
  it("flags a character with no matching reference asset", () => {
    const findings = checkCharacters(
      [{ id: "cat", name: "黒猫" }],
      [],
      ["黒猫 stretches"],
      new Set(),
    );
    expect(findings.map((f) => f.code)).toContain("character-unreferenced");
  });

  it("passes a character exposed in the pool and named in an action", () => {
    expect(
      checkCharacters([{ id: "cat", name: "黒猫" }], ["cat"], ["黒猫 stretches"], new Set()),
    ).toEqual([]);
  });

  it("flags a character never named in any action, keyed by id", () => {
    const findings = checkCharacters(
      [{ id: "cat", name: "黒猫" }],
      ["cat"],
      ["a quiet room"],
      new Set(),
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
    } = {},
  ): AnimaticSetupState => ({
    plateIds: ids,
    unanchoredPlateIds: gaps.unanchored ?? [],
    unnestedPlateIds: gaps.unnested ?? [],
    unconsumedBy: new Map(Object.entries(gaps.ignoring ?? {})),
    deterministicShotsPerSetup: new Map(Object.entries(gaps.deterministic ?? {})),
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
        holds: ["hereMark"],
      },
      solo: {
        name: "the solo",
        description: "in close",
        location: "here",
        framing: "close",
        holds: ["hereMark"],
      },
      solo2: {
        name: "the other",
        description: "wide",
        location: "here",
        framing: "wide",
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
    waived.sequence.waivers = { "axis-unrealized_medium.wide": "cut as two separate frames" };
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

  it("flags a roster setup no shot points at", () => {
    const withUnused = leaf({
      shots: [shot("01", "hero", 3, "shot", "wide")],
      setups: {
        "here-wide": {
          name: "a",
          description: "b",
          location: "here",
          framing: "wide",
          holds: ["hereMark"],
        },
        spare: {
          name: "spare",
          description: "unused",
          location: "here",
          framing: "close",
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

  it("classifies both setup findings as setups findings", () => {
    expect(classifyDirectionFinding("setup-unrealized")).toBe("setups");
    expect(classifyDirectionFinding("unused-setup")).toBe("setups");
    expect(classifyDirectionFinding("setup-indistinct")).toBe("setups");
    expect(classifyDirectionFinding("setup-atomized")).toBe("setups");
  });

  const frame = (location: string, framing: Framing, holds: readonly string[]): Setup => ({
    name: `a ${framing}`,
    description: `a ${framing} of ${location}`,
    location,
    framing,
    holds,
  });

  it("flags two setups of one place nothing tells apart, blaming the later id", () => {
    const twins = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "a" },
        { ...shot("02", "hero", 3), setup: "b" },
      ],
      setups: {
        a: frame("here", "medium", ["hereMark"]),
        b: frame("here", "medium", ["hereMark"]),
      },
    });
    const indistinct = checkDirection(twins).active.filter((f) => f.code === "setup-indistinct");
    expect(indistinct.map((f) => f.subject)).toEqual(["b"]);
    expect(indistinct[0]?.message).toContain('setup "a"');
  });

  it("tells two frames apart on framing, on holds order, and on place", () => {
    const distinct = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "size" },
        { ...shot("02", "disruption", 2), setup: "reverse" },
        { ...shot("03", "pressure", 3), setup: "elsewhere" },
        { ...shot("04", "hero", 4), setup: "base" },
      ],
      locations: {
        here: {
          ...defaultLocations.here!,
          landmarks: {
            ...defaultLocations.here!.landmarks,
            hereDesk: { name: "the desk", promptDepiction: "desk", description: "a plain desk" },
          },
        },
        there: {
          name: "there",
          description: "another place",
          landmarks: {
            thereMark: { name: "m", promptDepiction: "m", description: "a mark only there has" },
          },
        },
      },
      setups: {
        base: frame("here", "medium", ["hereMark", "hereDesk"]),
        size: frame("here", "close", ["hereMark", "hereDesk"]),
        reverse: frame("here", "medium", ["hereDesk", "hereMark"]),
        elsewhere: frame("there", "medium", ["thereMark"]),
      },
    });
    expect(checkDirection(distinct).active.map((f) => f.code)).not.toContain("setup-indistinct");
  });

  it("never calls two inserts of one place indistinct — an insert holds nothing to compare", () => {
    const inserts = leaf({
      shots: [
        { ...shot("01", "ordinary", 3), setup: "a" },
        { ...shot("02", "hero", 3), setup: "b" },
      ],
      setups: { a: frame("here", "insert", []), b: frame("here", "insert", []) },
    });
    expect(checkDirection(inserts).active.map((f) => f.code)).not.toContain("setup-indistinct");
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
    // Every frame here is medium on the same landmark, so the duplicate scan would fire on all of
    // them — this fixture is about the share, so read only the code under test.
    return leaf({ shots: list, setups });
  };

  it("flags a place the piece lives in and never returns to a frame of", () => {
    const findings = checkDirection(atomized(8, 0)).active.filter(
      (f) => f.code === "setup-atomized",
    );
    expect(findings.map((f) => f.subject)).toEqual(["here"]);
    expect(findings[0]?.message).toContain("8 shots");
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
            shot("01", "ordinary", 3, "the cat wakes"),
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

describe("assertDirectionGate characters", () => {
  it("blocks generate when a declared character has no reference asset", () => {
    expect(() =>
      assertDirectionGate(withCat, {
        command: "generate",
        stage: "animatic",
        referenceAssetNames: [],
        directionAccepted: true,
      }),
    ).toThrow(/character-unreferenced_cat/);
  });

  it("defers a characters finding while the direction is unaccepted", () => {
    expect(() =>
      assertDirectionGate(withCat, {
        command: "generate",
        stage: "animatic",
        referenceAssetNames: [],
        directionAccepted: false,
      }),
    ).not.toThrow();
  });

  it("passes once the reference asset is exposed", () => {
    expect(() =>
      assertDirectionGate(withCat, {
        command: "generate",
        stage: "animatic",
        // The default location `here` is a roster entry too, so expose it alongside the character —
        // an unexposed location would itself block the gate (location-unreferenced).
        referenceAssetNames: ["cat", "here"],
        directionAccepted: true,
      }),
    ).not.toThrow();
  });

  it("does not enforce the characters when reference names are unavailable", () => {
    expect(() =>
      assertDirectionGate(withCat, {
        command: "generate",
        stage: "animatic",
        directionAccepted: true,
      }),
    ).not.toThrow();
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
    expect(classifyDirectionFinding("missing-beat")).toBe("arc");
    expect(classifyDirectionFinding("unearned-payoff")).toBe("arc");
    expect(classifyDirectionFinding("beat-overweight")).toBe("pacing");
    expect(classifyDirectionFinding("stage-order-mismatch")).toBe("stage");
    expect(classifyDirectionFinding("unrealized")).toBe("completeness");
    expect(classifyDirectionFinding("character-unreferenced")).toBe("characters");
    expect(classifyDirectionFinding("unused-character")).toBe("characters");
    expect(classifyDirectionFinding("prop-unreferenced")).toBe("props");
    expect(classifyDirectionFinding("unused-prop")).toBe("props");
    expect(classifyDirectionFinding("location-unreferenced")).toBe("locations");
    expect(classifyDirectionFinding("unused-location")).toBe("locations");
    expect(classifyDirectionFinding("unexpected-script")).toBe("arc");
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
      sequence: { ...dir.sequence, waivers: { "fonts-undeclared": "the piece carries no text" } },
    } as Direction;
    const res = checkDirection(waived);
    expect(res.active.map((f) => f.code)).not.toContain("fonts-undeclared");
    expect(res.waived.map((f) => f.code)).toContain("fonts-undeclared");
  });
});

describe("checkDirection speech", () => {
  function withScript(speech: "none" | "no-dialogue", script: readonly ScriptLine[]): Direction {
    return leaf({
      speech,
      shots: [
        shot("01", "ordinary"),
        { ...shot("02", "disruption", 2), script },
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
  }

  it('flags a shot with any script line under speech "none"', () => {
    const dir = withScript("none", [{ narration: "morning light" }]);
    expect(checkDirection(dir).active.find((f) => f.code === "unexpected-script")?.subject).toBe(
      "02",
    );
  });

  it("does not flag when no shot declares a script", () => {
    const dir = leaf({
      speech: "none",
      shots: [
        shot("01", "ordinary"),
        shot("02", "disruption", 2),
        shot("03", "pressure"),
        shot("04", "hero", 4),
      ],
    });
    expect(checkDirection(dir).active.map((f) => f.code)).not.toContain("unexpected-script");
  });

  it('under "no-dialogue" allows narration but flags a spoken line', () => {
    const narrated = withScript("no-dialogue", [{ narration: "morning light" }]);
    expect(checkDirection(narrated).active.map((f) => f.code)).not.toContain("unexpected-script");

    const spoken = withScript("no-dialogue", [{ speaker: "受付", text: "いらっしゃいませ" }]);
    expect(checkDirection(spoken).active.find((f) => f.code === "unexpected-script")?.subject).toBe(
      "02",
    );
  });

  it("is waivable via unexpected-script_<shotId>", () => {
    const dir = withWaivers(withScript("none", [{ narration: "morning light" }]), {
      "unexpected-script_02": "one deliberate title card",
    });
    const res = checkDirection(dir);
    expect(res.active.map((f) => f.code)).not.toContain("unexpected-script");
    expect(res.waived.map(directionWaiverKey)).toContain("unexpected-script_02");
  });

  it("blocks generate as an arc-class finding until waived", () => {
    const dir = withScript("none", [{ narration: "morning light" }]);
    expect(() =>
      assertDirectionGate(dir, { command: "generate", stage: "video", directionAccepted: true }),
    ).toThrow(/unexpected-script_02/);
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
    expect(() =>
      assertDirectionGate(dir, { command: "generate", stage: "video", directionAccepted: true }),
    ).toThrow(/multi-sentence-action_02/);
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

  it("is waivable via off-grid-duration_<shotId>", () => {
    const dir = withWaivers(withDuration(1.2), {
      "off-grid-duration_02": "trimmed from a 2s take",
    });
    const res = checkDirection(dir);
    expect(res.active.map((f) => f.code)).not.toContain("off-grid-duration");
    expect(res.waived.map(directionWaiverKey)).toContain("off-grid-duration_02");
  });

  it("blocks generate as a pacing-class finding until waived", () => {
    expect(() =>
      assertDirectionGate(withDuration(1.2), {
        command: "generate",
        stage: "video",
        directionAccepted: true,
      }),
    ).toThrow(/off-grid-duration_02/);
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
