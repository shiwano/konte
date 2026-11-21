import { describe, expect, it } from "vitest";
import { directionHash, directionPartHashes } from "../direction-hash.js";
import type { Direction } from "../dsl/direction.js";

// The frames the shots are taken from. A fixture's shots name one by id; its `location`/`framing` are
// read through it, so nothing here is restated on a shot.
const setups = {
  "bedroom-medium": {
    name: "the bedroom, medium",
    description: "straight on, eye level",
    location: "bedroom",
    framing: "medium",
    view: "front",
    holds: ["bedroomMark"],
  },
  "bedroom-close": {
    name: "the bedroom, close",
    description: "in on the face",
    location: "bedroom",
    framing: "close",
    view: "front",
    holds: ["bedroomMark"],
  },
  "bedroom-wide": {
    name: "the bedroom, wide",
    description: "the whole room",
    location: "bedroom",
    framing: "wide",
    view: "front",
    holds: ["bedroomMark"],
  },
} as const;

// A minimal, type-valid direction whose root is a leaf node (a run of shots). Tests clone-and-tweak it
// to assert which edits move the hash (structural) and which leave it standing (prose).
function flat(): Direction {
  return {
    brief: { logline: "a girl wakes and leaves", tone: "quiet" },
    characters: {
      alice: { name: "Alice", description: "a girl in red", promptDepiction: "alice" },
      cat: { name: "Cat", description: "a black cat", promptDepiction: "cat" },
    },
    locations: {
      bedroom: {
        name: "the bedroom",
        description: "a sunlit bedroom",
        landmarks: {
          bedroomMark: {
            name: "the mark",
            promptDepiction: "mark",
            description: "a mark only this place has",
          },
        },
        views: { front: { holds: ["bedroomMark"] } },
      },
    },
    setups: structuredClone(setups),
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
    },
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      shots: [
        {
          id: "01",
          role: "hero",
          action: "she wakes",
          setup: "bedroom-medium",
          duration: 4,
          lineup: [],
        },
        {
          id: "02",
          role: "hero",
          action: "she leaves",
          setup: "bedroom-close",
          duration: 6,
          lineup: [],
        },
      ],
    },
    waivers: { "multi-sentence-action_02": "intentional — a quiet shot" },
  } as Direction;
}

// A direction whose root is a branch node (a run of sub-sequences) — one act, itself a run of shots.
function sequenced(): Direction {
  return {
    brief: { logline: "an act of acts" },
    characters: {},
    locations: {
      bedroom: {
        name: "the bedroom",
        description: "a sunlit bedroom",
        landmarks: {
          bedroomMark: {
            name: "the mark",
            promptDepiction: "mark",
            description: "a mark only this place has",
          },
        },
        views: { front: { holds: ["bedroomMark"] } },
      },
    },
    setups,
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
    },
    sequence: {
      lens: "three-act",
      pleasure: "emotional",
      sequences: [
        {
          id: "s1",
          role: "setup-act",
          synopsis: "ordinary world",
          lens: "kishotenketsu",
          pleasure: "emotional",
          shots: [
            {
              id: "01",
              role: "hero",
              action: "intro",
              setup: "bedroom-medium",
              duration: 5,
              lineup: [],
            },
          ],
        },
      ],
    },
    waivers: { "empty-synopsis_s1": "deliberate" },
  } as Direction;
}

describe("directionHash", () => {
  it("is stable across repeated calls", () => {
    expect(directionHash(flat())).toBe(directionHash(flat()));
  });

  // A person accepts the page they read, prose included. An agent that rewrites a synopsis or the
  // brief behind their back has changed what they agreed to, so the gate re-blocks.
  describe("prose edits move the hash — the reviewer read those words", () => {
    it("reacts to a shot action change", () => {
      const d = flat();
      (d as { sequence: { shots: { action: string }[] } }).sequence.shots[0]!.action =
        "completely rewritten shot";
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to a character name/description change", () => {
      const d = flat();
      const chars = (d as { characters: Record<string, { name: string; description: string }> })
        .characters;
      chars.alice!.name = "Alicia";
      chars.alice!.description = "a girl in blue";
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to a brief rewrite", () => {
      const d = flat();
      (d as { brief: { logline: string } }).brief.logline = "completely reframed";
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to a sequence synopsis change", () => {
      const d = sequenced();
      (d as { sequence: { sequences: { synopsis: string }[] } }).sequence.sequences[0]!.synopsis =
        "rewritten act";
      expect(directionHash(d)).not.toBe(directionHash(sequenced()));
    });
  });

  // Layout, not content: nothing a reviewer could have read differently.
  describe("re-arrangements that change nothing leave the hash standing", () => {
    it("ignores characters reordering (roster is a set, not a sequence)", () => {
      const d = flat() as { characters: Record<string, unknown> };
      d.characters = Object.fromEntries(Object.entries(d.characters).reverse());
      expect(directionHash(d as Direction)).toBe(directionHash(flat()));
    });

    it("reads a view left undefined as undeclared", () => {
      const d = flat();
      d.locations.bedroom!.views.back = undefined;
      expect(directionHash(d)).toBe(directionHash(flat()));
    });

    it("ignores custom-lens reordering (a lens registry is a lookup, not a list)", () => {
      const withLenses = () => {
        const base = flat();
        return {
          ...base,
          lenses: [
            { name: "a", payoff: "hero", roles: [{ role: "ordinary" }, { role: "hero" }] },
            { name: "b", payoff: "hero", roles: [{ role: "hero" }] },
          ],
          sequence: { ...base.sequence, lens: "a" },
        } as Direction;
      };
      const d = withLenses();
      (d as { lenses: unknown[] }).lenses.reverse();
      expect(directionHash(d)).toBe(directionHash(withLenses()));
    });
  });

  // The node still names lens "a", but "a" is a different arc now. The name is not the shape.
  it("reacts to a custom lens's roles being rewritten under an unchanged name", () => {
    const withLens = (roles: unknown[]) => {
      const base = flat();
      return {
        ...base,
        lenses: [{ name: "a", payoff: "hero", roles }],
        sequence: { ...base.sequence, lens: "a" },
      } as Direction;
    };
    const before = withLens([{ role: "ordinary" }, { role: "hero" }]);
    const after = withLens([{ role: "ordinary" }, { role: "pressure" }, { role: "hero" }]);
    expect(directionHash(after)).not.toBe(directionHash(before));
  });

  describe("structural edits move the hash", () => {
    it("reacts to a duration change", () => {
      const d = flat();
      (d as { sequence: { shots: { duration: number }[] } }).sequence.shots[0]!.duration = 5;
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to a role change", () => {
      const d = flat();
      (d as { sequence: { shots: { role: string }[] } }).sequence.shots[1]!.role = "closer";
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to shot reordering (shot order is structural)", () => {
      const d = flat();
      (d as { sequence: { shots: unknown[] } }).sequence.shots.reverse();
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to adding a character", () => {
      const d = flat();
      (d as { characters: Record<string, unknown> }).characters.dog = {
        name: "Dog",
        description: "a dog",
      };
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    // An act's own pleasure is the reviewer's business: retargeting one from `scary` to `emotional`
    // changes the piece they signed off on, so the gate re-blocks.
    it("reacts to an act retargeting its own pleasure", () => {
      const scary = sequenced();
      (
        scary as { sequence: { sequences: { pleasure: string }[] } }
      ).sequence.sequences[0]!.pleasure = "scary";
      expect(directionHash(scary)).not.toBe(directionHash(sequenced()));

      const funny = sequenced();
      (
        funny as { sequence: { sequences: { pleasure: string }[] } }
      ).sequence.sequences[0]!.pleasure = "funny";
      expect(directionHash(funny)).not.toBe(directionHash(scary));
    });

    it("reacts to lens and pleasure changes", () => {
      const lens = flat();
      (lens as { sequence: { lens: string } }).sequence.lens = "kishotenketsu";
      expect(directionHash(lens)).not.toBe(directionHash(flat()));

      const pleasure = flat();
      (pleasure as { sequence: { pleasure: string } }).sequence.pleasure = "cool";
      expect(directionHash(pleasure)).not.toBe(directionHash(flat()));
    });

    it("reacts to a new waiver key", () => {
      const d = flat();
      d.waivers!["empty-synopsis:01"] = "on purpose";
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to an edited waiver reason (the human's justification)", () => {
      const d = flat();
      d.waivers!["multi-sentence-action_02"] = "different reason";
      expect(directionHash(d)).not.toBe(directionHash(flat()));
    });

    it("reacts to changing the canvas aspect or fps", () => {
      const declared = flat();
      declared.policy.format = {
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 576, height: 1024 } },
      };
      expect(directionHash(declared)).not.toBe(directionHash(flat()));

      const slower = flat();
      slower.policy.format = {
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 576, height: 1024 } },
      };
      expect(directionHash(slower)).not.toBe(directionHash(declared));
    });

    it("reacts to retyping the piece's language", () => {
      const ja = flat();
      ja.policy.lang = "ja";
      expect(directionHash(ja)).not.toBe(directionHash(flat()));
    });
  });

  describe("branch-rooted direction", () => {
    it("is stable and differs from an equivalent leaf-rooted one", () => {
      expect(directionHash(sequenced())).toBe(directionHash(sequenced()));
    });

    it("reacts to a per-sequence lens change", () => {
      const d = sequenced();
      (d as { sequence: { sequences: { lens: string }[] } }).sequence.sequences[0]!.lens =
        "three-act";
      expect(directionHash(d)).not.toBe(directionHash(sequenced()));
    });
  });
});

describe("directionPartHashes", () => {
  // Each key is the field path of the part it hashes, so a fixture's addresses read straight back
  // into the `Direction` literal above.
  const shot01 = "direction:sequence.shots.01";
  const sequence = "direction:sequence";
  const alice = "direction:characters.alice";
  const bedroomMedium = "direction:setups.bedroom-medium";
  const bedroomClose = "direction:setups.bedroom-close";

  const logline = "direction:brief.logline";
  const tone = "direction:brief.tone";

  // Only the prose fields the fixture's brief fills in are keyed — an omitted one has nothing to
  // review, so `audience`/`look` never reach the map, while the two list fields are keyed even
  // though the fixture declares neither. The root is a leaf (no id), so it contributes no nested
  // `sequence.sequences.<id>` part — only its shots.
  it("keys one hash per reviewable part, each brief field, policy field, and waivers included", () => {
    expect([...directionPartHashes(flat()).keys()].sort()).toEqual([
      logline,
      "direction:brief.outOfScope",
      "direction:brief.tolerances",
      tone,
      alice,
      "direction:characters.cat",
      "direction:locations.bedroom",
      "direction:policy.fonts",
      "direction:policy.format",
      "direction:policy.lang",
      sequence,
      shot01,
      "direction:sequence.shots.02",
      "direction:setups.bedroom-close",
      bedroomMedium,
      "direction:setups.bedroom-wide",
      "direction:waivers.multi-sentence-action_02",
    ]);
  });

  // The policy fields are always declared, so each is keyed unconditionally — a note on the language
  // ages out on a language edit, not when the canvas changes.
  it("moves only the edited policy field's hash, leaving its siblings standing", () => {
    const format = "direction:policy.format";
    const lang = "direction:policy.lang";
    const fonts = "direction:policy.fonts";
    const d = flat();
    d.policy.format.fps = 60;
    expect(directionPartHashes(d).get(format)).not.toBe(directionPartHashes(flat()).get(format));
    expect(directionPartHashes(d).get(fonts)).toBe(directionPartHashes(flat()).get(fonts));
    expect(directionPartHashes(d).get(lang)).toBe(directionPartHashes(flat()).get(lang));

    const retyped = flat();
    retyped.policy.lang = "ja";
    expect(directionPartHashes(retyped).get(lang)).not.toBe(directionPartHashes(flat()).get(lang));
    expect(directionPartHashes(retyped).get(format)).toBe(directionPartHashes(flat()).get(format));
    expect(directionPartHashes(retyped).get(fonts)).toBe(directionPartHashes(flat()).get(fonts));
  });

  it("moves only the rewritten brief field's hash, leaving its siblings and the sequence standing", () => {
    const d = flat();
    (d as { brief: { logline: string } }).brief.logline = "reframed";
    expect(directionPartHashes(d).get(logline)).not.toBe(directionPartHashes(flat()).get(logline));
    expect(directionPartHashes(d).get(tone)).toBe(directionPartHashes(flat()).get(tone));
    expect(directionPartHashes(d).get(sequence)).toBe(directionPartHashes(flat()).get(sequence));
  });

  // The list fields are the exception to "an unwritten field is not a part": an empty `outOfScope`
  // or `tolerances` is a position the reviewer argues with (and adds to), so it stays reviewable.
  it("keys only the prose brief fields the direction fills in, plus both list fields", () => {
    const keys = [...directionPartHashes(sequenced()).keys()];
    expect(keys.filter((k) => k.startsWith("direction:brief."))).toEqual([
      "direction:brief.logline",
      "direction:brief.outOfScope",
      "direction:brief.tolerances",
    ]);
  });

  it("moves an empty list field's hash once an entry is added to it", () => {
    const tolerances = "direction:brief.tolerances";
    const d = flat();
    (d as { brief: { tolerances?: string[] } }).brief.tolerances = ["the wandering brand mark"];
    expect(directionPartHashes(d).get(tolerances)).not.toBe(
      directionPartHashes(flat()).get(tolerances),
    );
  });

  it("keys the references once the brief names a clip, moving when what it takes is reworded", () => {
    const key = "direction:brief.references";
    expect(directionPartHashes(flat()).has(key)).toBe(false);
    const withRef = (take: string) => {
      const d = flat();
      (d as { brief: { references?: unknown[] } }).brief.references = [
        { clip: "studies/ref.mp4", take, avoid: "the lyric captions" },
      ];
      return directionPartHashes(d).get(key);
    };
    expect(withRef("the chorus cut rate")).toBeDefined();
    expect(withRef("the chorus cut rate")).not.toBe(withRef("the backlit silhouettes"));
  });

  it("moves a waiver's hash when its reason is reworded", () => {
    const d = flat();
    d.waivers!["multi-sentence-action_02"] = "reworded";
    const key = "direction:waivers.multi-sentence-action_02";
    expect(directionPartHashes(d).get(key)).not.toBe(directionPartHashes(flat()).get(key));
  });

  it("holds the root sequence's hash when a waiver is removed", () => {
    const d = flat();
    delete d.waivers;
    const key = "direction:sequence";
    expect(directionPartHashes(d).get(key)).toBe(directionPartHashes(flat()).get(key));
  });

  // A nested part is keyed by the path that reaches it: the act's shot hangs off
  // `sequence.sequences.s1`, not off the root. A waiver has no node, whatever arc it fired on.
  it("keys a sequence and its shots under the act's path, and its waiver at the top", () => {
    const keys = [...directionPartHashes(sequenced()).keys()];
    expect(keys).toContain("direction:sequence.sequences.s1");
    expect(keys).toContain("direction:sequence.sequences.s1.shots.01");
    expect(keys).toContain("direction:waivers.empty-synopsis_s1");
    expect(keys).not.toContain(shot01);
  });

  // A note on an act argues with what that act is aiming for, so retargeting its pleasure ages the
  // note out — the same way rewording its synopsis does.
  it("moves a sequence's hash when the act retargets its pleasure", () => {
    const d = sequenced();
    (d as { sequence: { sequences: { pleasure: string }[] } }).sequence.sequences[0]!.pleasure =
      "scary";
    const key = "direction:sequence.sequences.s1";
    expect(directionPartHashes(d).get(key)).not.toBe(directionPartHashes(sequenced()).get(key));
  });

  // A comment lives on the part it was written about, so a part hash covers the prose the
  // acceptance hash deliberately ignores.
  // The sequence part hash is narrower than the acceptance hash on purpose: the sequence section shows the
  // arc's shape, so a note written there outlives the prose reword that re-blocks the gate.
  it("holds the sequence's hash through a prose edit that does move the acceptance hash", () => {
    const d = flat();
    (d as { brief: { logline: string } }).brief.logline = "reframed";
    expect(directionPartHashes(d).get(sequence)).toBe(directionPartHashes(flat()).get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  // The lineup is the shot's own declaration, so it ages out that shot and nothing else — and never
  // the sequence shape: moving someone across the frame re-cuts no size or space cadence.
  it("ages out the shot alone on a lineup edit", () => {
    const shot = "direction:sequence.shots.01";
    const base = directionPartHashes(flat());
    const d = flat();
    (d.sequence.shots![0] as { lineup?: unknown }).lineup = ["cat"];
    const after = directionPartHashes(d);
    expect(after.get(shot)).not.toBe(base.get(shot));
    expect(after.get(sequence)).toBe(base.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  it("ages out the shot when an empty lineupTo is declared", () => {
    const shot = "direction:sequence.shots.01";
    const withLineupTo = (lineupTo?: string[]) => {
      const d = flat();
      Object.assign(d.sequence.shots![0] as object, { lineup: ["cat"], lineupTo });
      return d;
    };
    expect(directionPartHashes(withLineupTo([])).get(shot)).not.toBe(
      directionPartHashes(withLineupTo()).get(shot),
    );
    expect(directionHash(withLineupTo([]))).not.toBe(directionHash(withLineupTo()));
  });

  // A line's acting note is direction on the words, so it rides with the script it annotates.
  it("moves the shot's hash when a line's acting note is rewritten", () => {
    const withActing = (acting: string) => {
      const d = flat();
      (d.sequence.shots![0] as { script?: unknown[] }).script = [
        { character: "cat", text: "meow", acting },
      ];
      return directionPartHashes(d).get("direction:sequence.shots.01");
    };
    expect(withActing("flat")).not.toBe(withActing("wheedling"));
  });

  // A shot's script is dialogue the reviewer read, so it rides with the action: editing it moves
  // the acceptance hash and that shot's part hash, but not the prose-free sequence shape.
  it("moves the acceptance and shot hashes on a script edit, holding the sequence", () => {
    const withScript = () => {
      const d = flat();
      (d as { sequence: { shots: { script?: unknown[] }[] } }).sequence.shots[0]!.script = [
        { character: "cat", text: "meow" },
      ];
      return d;
    };
    const edited = () => {
      const d = flat();
      (d as { sequence: { shots: { script?: unknown[] }[] } }).sequence.shots[0]!.script = [
        { character: "cat", text: "hiss" },
      ];
      return d;
    };
    expect(directionHash(edited())).not.toBe(directionHash(withScript()));
    expect(directionPartHashes(edited()).get(shot01)).not.toBe(
      directionPartHashes(withScript()).get(shot01),
    );
    expect(directionPartHashes(edited()).get(sequence)).toBe(
      directionPartHashes(withScript()).get(sequence),
    );
  });

  // Telop is words on screen the reviewer read, so it rides with the script: same part, same rule.
  it("moves the acceptance and shot hashes on a telop edit, holding the sequence", () => {
    const withTelop = (text: string) => {
      const d = flat();
      (d as { sequence: { shots: { telop?: string[] }[] } }).sequence.shots[0]!.telop = [text];
      return d;
    };
    expect(directionHash(withTelop("第一話"))).not.toBe(directionHash(withTelop("第二話")));
    expect(directionPartHashes(withTelop("第一話")).get(shot01)).not.toBe(
      directionPartHashes(withTelop("第二話")).get(shot01),
    );
    expect(directionPartHashes(withTelop("第一話")).get(sequence)).toBe(
      directionPartHashes(withTelop("第二話")).get(sequence),
    );
  });

  it("moves a shot's hash on an action rewrite, leaving the sequence and its siblings standing", () => {
    const d = flat();
    (d as { sequence: { shots: { action: string }[] } }).sequence.shots[0]!.action = "rewritten";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(shot01)).not.toBe(before.get(shot01));
    expect(after.get("direction:sequence.shots.02")).toBe(
      before.get("direction:sequence.shots.02"),
    );
    expect(after.get(sequence)).toBe(before.get(sequence));
  });

  // A setup's framing is arc shape, not prose: retuning it re-cuts the size cadence, so the sequence
  // shape and the acceptance hash both move. The shots on it do NOT — the frame changed, not the
  // shot, and the frame is re-read on its own part (the same split that keeps a character's voice out
  // of the character's hash).
  it("moves the setup and sequence hashes on a setup's framing edit, holding the shots", () => {
    const d = flat();
    (d.setups as Record<string, { framing: string }>)["bedroom-medium"]!.framing = "wide";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(bedroomMedium)).not.toBe(before.get(bedroomMedium));
    expect(after.get(sequence)).not.toBe(before.get(sequence));
    expect(after.get(shot01)).toBe(before.get(shot01));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  // Re-pointing a shot at another frame IS a shot edit: the shot's own part moves with the sequence.
  it("moves the shot and sequence hashes when a shot is re-pointed at another setup", () => {
    const d = flat();
    (d as { sequence: { shots: { setup: string }[] } }).sequence.shots[0]!.setup = "bedroom-wide";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(shot01)).not.toBe(before.get(shot01));
    expect(after.get(sequence)).not.toBe(before.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  it("moves a setup's hash on a description rewrite, holding the sequence (prose, not shape)", () => {
    const d = flat();
    (d.setups as Record<string, { description: string }>)["bedroom-medium"]!.description = "lower";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(bedroomMedium)).not.toBe(before.get(bedroomMedium));
    expect(after.get(sequence)).toBe(before.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  it("moves a character's hash on a description rewrite", () => {
    const d = flat();
    (d as { characters: Record<string, { description: string }> }).characters.alice!.description =
      "in blue";
    expect(directionPartHashes(d).get(alice)).not.toBe(directionPartHashes(flat()).get(alice));
  });

  it("keys one hash per prop and moves it on a description rewrite", () => {
    const withProp = (): Direction => ({
      ...flat(),
      props: {
        patty: { name: "the patty", promptDepiction: "patty", description: "a golden fish patty" },
      },
    });
    const key = "direction:props.patty";
    expect([...directionPartHashes(withProp()).keys()]).toContain(key);
    const d = withProp();
    (d.props as Record<string, { description: string }>).patty!.description = "a charred patty";
    expect(directionPartHashes(d).get(key)).not.toBe(directionPartHashes(withProp()).get(key));
  });

  it("leaves directionHash standing when props are only reordered (a roster, not a sequence)", () => {
    const withProps = (): Direction => ({
      ...flat(),
      props: {
        patty: { name: "the patty", promptDepiction: "patty", description: "a fish patty" },
        tray: { name: "the tray", promptDepiction: "tray", description: "a steel tray" },
      },
    });
    const d = withProps() as { props: Record<string, unknown> };
    d.props = Object.fromEntries(Object.entries(d.props).reverse());
    expect(directionHash(d as Direction)).toBe(directionHash(withProps()));
  });

  it("keys one hash per location and moves it on a description rewrite", () => {
    const key = "direction:locations.bedroom";
    expect([...directionPartHashes(flat()).keys()]).toContain(key);
    const d = flat();
    (d.locations as Record<string, { description: string }>).bedroom!.description = "a dim bedroom";
    expect(directionPartHashes(d).get(key)).not.toBe(directionPartHashes(flat()).get(key));
  });

  // A setup's `location` is space structure like its framing: moving a frame to another set re-cuts
  // the space cadence, so the sequence shape and the acceptance hash move with the setup's own part.
  it("moves the setup, sequence, and acceptance hashes on a setup's location edit", () => {
    const d = flat();
    (d.locations as Record<string, { name: string; description: string }>).kitchen = {
      name: "the kitchen",
      description: "a bright kitchen",
    };
    (d.setups as Record<string, { location: string }>)["bedroom-medium"]!.location = "kitchen";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(bedroomMedium)).not.toBe(before.get(bedroomMedium));
    expect(after.get(sequence)).not.toBe(before.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  // What only a place has is part of what the place looks like, so it rides the location's own part —
  // and the arc's shape, which reads the setups' place and size, never sees it.
  it("moves a location's hash on a landmark edit, holding the sequence shape", () => {
    const d = flat();
    (
      d.locations as Record<string, { landmarks: Record<string, { description: string }> }>
    ).bedroom!.landmarks.bedroomMark!.description = "a mark by the door";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get("direction:locations.bedroom")).not.toBe(
      before.get("direction:locations.bedroom"),
    );
    expect(after.get(sequence)).toBe(before.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  // The word a prompt calls a character by is the character's, exactly as their name is.
  it("moves a character's hash on a promptDepiction edit", () => {
    const d = flat();
    (
      d as { characters: Record<string, { promptDepiction: string }> }
    ).characters.alice!.promptDepiction = "girl";
    expect(directionPartHashes(d).get(alice)).not.toBe(directionPartHashes(flat()).get(alice));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  // `holds` is the frame's contents, not its place or its size — so the setup's part moves and the
  // arc shape stands.
  it("moves a setup's hash on a holds edit, holding the sequence shape", () => {
    const d = flat();
    (d.setups as unknown as Record<string, { holds: string[] }>)["bedroom-medium"]!.holds = [];
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(bedroomMedium)).not.toBe(before.get(bedroomMedium));
    expect(after.get(sequence)).toBe(before.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  // `within` is the camera axis, not the size or the place — so it moves the setup's part and the
  // arc shape, which is what a note about the size cadence is written against, stands.
  it("moves a setup's hash on a within edit, holding the sequence shape", () => {
    const d = flat();
    (d.setups as unknown as Record<string, { within: string | null }>)["bedroom-close"]!.within =
      "bedroom-wide";
    const before = directionPartHashes(flat());
    const after = directionPartHashes(d);
    expect(after.get(bedroomClose)).not.toBe(before.get(bedroomClose));
    expect(after.get(sequence)).toBe(before.get(sequence));
    expect(directionHash(d)).not.toBe(directionHash(flat()));
  });

  it("leaves directionHash standing when locations are only reordered (a roster, not a sequence)", () => {
    const withLocations = (): Direction => ({
      ...flat(),
      locations: {
        bedroom: {
          name: "the bedroom",
          description: "a sunlit bedroom",
          landmarks: {
            bedroomMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
          views: { front: { holds: ["bedroomMark"] } },
        },
        hall: {
          name: "the hall",
          description: "a long hall",
          landmarks: {
            hallMark: {
              name: "the mark",
              promptDepiction: "mark",
              description: "a mark only this place has",
            },
          },
          views: { front: { holds: ["hallMark"] } },
        },
      },
    });
    const d = withLocations() as { locations: Record<string, unknown> };
    d.locations = Object.fromEntries(Object.entries(d.locations).reverse());
    expect(directionHash(d as Direction)).toBe(directionHash(withLocations()));
  });

  it("moves the sequence's hash on a structural edit", () => {
    const d = flat();
    (d as { sequence: { shots: { duration: number }[] } }).sequence.shots[0]!.duration = 9;
    expect(directionPartHashes(d).get(sequence)).not.toBe(
      directionPartHashes(flat()).get(sequence),
    );
  });

  it("moves a sequence's hash when it gains a shot", () => {
    const d = sequenced();
    (d as { sequence: { sequences: { shots: unknown[] }[] } }).sequence.sequences[0]!.shots.push({
      id: "02",
      role: "release",
      action: "she rests",
      duration: 2,
    });
    const key = "direction:sequence.sequences.s1";
    expect(directionPartHashes(d).get(key)).not.toBe(directionPartHashes(sequenced()).get(key));
  });
});

describe("directionPartHashes voices", () => {
  const alice = "direction:characters.alice";
  const aliceVoice = "direction:characters.alice.voice";
  const narrator = "direction:narrator";

  const cast = (): Direction => {
    const d = flat();
    (d.characters as Record<string, { voice?: unknown }>).alice!.voice = {
      id: "aliceVoice",
      description: "bright, quick",
    };
    (d as { narrator?: unknown }).narrator = { id: "narratorVoice", description: "warm" };
    return d;
  };

  it("keys a part per cast voice, and none for a character with no voice", () => {
    const keys = [...directionPartHashes(cast()).keys()];
    expect(keys).toContain(aliceVoice);
    expect(keys).toContain(narrator);
    expect(keys).not.toContain("direction:characters.cat.voice");
  });

  // The look and the voice are two assets accepted separately, so each must age out on its own edit
  // alone — the whole reason the voice is a part rather than a field of the entry.
  it("moves only the voice's hash on a voice rewrite", () => {
    const d = cast();
    (d.characters as Record<string, { voice: { description: string } }>).alice!.voice.description =
      "gravelly";
    expect(directionPartHashes(d).get(aliceVoice)).not.toBe(
      directionPartHashes(cast()).get(aliceVoice),
    );
    expect(directionPartHashes(d).get(alice)).toBe(directionPartHashes(cast()).get(alice));
  });

  it("leaves the voice's hash standing when the look is reworded", () => {
    const d = cast();
    (d.characters as Record<string, { description: string }>).alice!.description = "a girl in blue";
    expect(directionPartHashes(d).get(alice)).not.toBe(directionPartHashes(cast()).get(alice));
    expect(directionPartHashes(d).get(aliceVoice)).toBe(
      directionPartHashes(cast()).get(aliceVoice),
    );
  });

  it("moves directionHash on a voice edit", () => {
    const d = cast();
    (d as { narrator: { description: string } }).narrator.description = "clipped";
    expect(directionHash(d)).not.toBe(directionHash(cast()));
  });
});

// Every part a direction can hold, so a refactor of the projections is held to the exact hashes
// earlier accepts and comments were stamped with.
function everyPart(): Direction {
  return {
    brief: {
      logline: "a girl wakes and leaves",
      hook: "the door is open",
      audience: "teens",
      tone: "quiet",
      look: "pastel",
      outOfScope: ["no dialogue"],
      tolerances: ["soft focus"],
      references: [
        { clip: "studies/ref.mp4", link: "https://example.com", take: "cuts", avoid: "captions" },
      ],
      source: { span: "ch1", keep: ["the door"], drop: ["the dog"] },
    },
    characters: {
      cat: { name: "Cat", description: "a black cat", promptDepiction: "cat" },
      alice: {
        name: "Alice",
        description: "a girl in red",
        promptDepiction: "alice",
        voice: { id: "aliceVoice", description: "bright" },
      },
    },
    narrator: { id: "narratorVoice", description: "warm" },
    props: { key: { name: "the key", promptDepiction: "key", description: "a brass key" } },
    locations: {
      bedroom: {
        name: "the bedroom",
        description: "a sunlit bedroom",
        landmarks: {
          window: { name: "window", promptDepiction: "window", description: "a tall window" },
          bedroomMark: { name: "the mark", promptDepiction: "mark", description: "a mark" },
        },
        views: { front: { holds: ["window", "bedroomMark"] }, reverse: { holds: ["bedroomMark"] } },
      },
    },
    setups: {
      ...structuredClone(setups),
      "bedroom-window": {
        name: "the window",
        description: "in on the glass",
        location: "bedroom",
        framing: "close",
        holds: ["window"],
        within: "bedroom-wide",
      },
      "bedroom-root": {
        name: "the root",
        description: "a root",
        location: "bedroom",
        framing: "wide",
        view: "reverse",
        holds: [],
        within: null,
      },
    },
    lenses: [
      { name: "zz-custom", roles: ["a", "b"] },
      { name: "aa-custom", roles: ["c"] },
    ],
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "ja",
      fonts: ["Noto Sans JP", "M PLUS 1p"],
      song: "song",
    },
    lyrics: [
      {
        label: "verse",
        singer: "alice",
        lines: ["la la", { text: "lu lu", singer: ["alice", "cat"] }],
      },
    ],
    waivers: { "empty-synopsis_s1": "deliberate", "multi-sentence-action_03": "quiet" },
    sequence: {
      lens: "three-act",
      pleasure: "emotional",
      sequences: [
        {
          id: "s1",
          role: "setup-act",
          synopsis: "ordinary world",
          lens: "kishotenketsu",
          pleasure: "emotional",
          shots: [
            { id: "00", kind: "aside", label: "title", beats: 8, telop: ["第一話"] },
            {
              id: "01",
              role: "hero",
              action: "she wakes",
              setup: "bedroom-medium",
              beats: 4,
              lineup: ["alice", "cat"],
              lineupTo: ["cat", "alice"],
              passing: ["cat"],
              props: ["key"],
              join: "continuous",
              coverage: true,
              script: [{ character: "alice", text: "morning", acting: "sleepy" }],
              telop: ["朝"],
              cutin: {
                setup: "bedroom-window",
                lineup: ["cat"],
                lineupTo: ["cat"],
                passing: ["cat"],
                props: ["key"],
                join: "continuous",
              },
            },
          ],
        },
        {
          id: "s2",
          role: "climax-act",
          synopsis: "the door",
          lens: "mini-drama",
          pleasure: "cute",
          sequences: [
            {
              id: "s2a",
              role: "hook",
              synopsis: "inner act",
              lens: "mini-drama",
              pleasure: "cute",
              shots: [
                {
                  id: "02",
                  kind: "graphic",
                  role: "hero",
                  action: "a map",
                  beats: 2,
                  script: [{ narration: "far away" }],
                  cutin: { setup: "bedroom-close", lineup: ["alice"] },
                },
                {
                  id: "03",
                  role: "hero",
                  action: "she leaves. the door shuts.",
                  setup: "bedroom-root",
                  duration: 3,
                  lineup: [],
                },
              ],
            },
          ],
        },
      ],
    },
  } as unknown as Direction;
}

describe("direction hashes", () => {
  it("hash every part as they were stamped", () => {
    expect(Object.fromEntries(directionPartHashes(everyPart()))).toEqual({
      "direction:brief.audience": "0e2f87db917a",
      "direction:brief.hook": "08cb6f2faf7f",
      "direction:brief.logline": "5a53642a8ea4",
      "direction:brief.look": "4df3b614ea3f",
      "direction:brief.outOfScope": "53408cd07821",
      "direction:brief.references": "3ba29b096d33",
      "direction:brief.source": "bb8c380e6e22",
      "direction:brief.tolerances": "c25630587bb6",
      "direction:brief.tone": "7024344971a6",
      "direction:characters.alice": "ce95ecbb6a04",
      "direction:characters.alice.voice": "c4afe95fbc22",
      "direction:characters.cat": "84906acb09b4",
      "direction:locations.bedroom": "bd963c677a26",
      "direction:lyrics": "05a2878a7ca2",
      "direction:narrator": "1b97fd6e7b18",
      "direction:policy.fonts": "6e471ce68112",
      "direction:policy.format": "5d06507a2664",
      "direction:policy.lang": "4a86a3eca477",
      "direction:policy.song": "89b6baca4b55",
      "direction:props.key": "1a63a212d8eb",
      "direction:sequence": "154706ae79ab",
      "direction:sequence.sequences.s1": "7a10e4632cbb",
      "direction:sequence.sequences.s1.shots.00": "0ea18c459bfd",
      "direction:sequence.sequences.s1.shots.01": "bd1d428d40f0",
      "direction:sequence.sequences.s2": "86514ab42412",
      "direction:sequence.sequences.s2.sequences.s2a": "9fbf7a327146",
      "direction:sequence.sequences.s2.sequences.s2a.shots.02": "4f27de7a7cd7",
      "direction:sequence.sequences.s2.sequences.s2a.shots.03": "4f00c977f9e0",
      "direction:setups.bedroom-close": "1c85183c06c5",
      "direction:setups.bedroom-medium": "3a9421ae9921",
      "direction:setups.bedroom-root": "5edd4a739bce",
      "direction:setups.bedroom-wide": "f4a6ee58954e",
      "direction:setups.bedroom-window": "58d9dfee2de4",
      "direction:waivers.empty-synopsis_s1": "85fc30a052fc",
      "direction:waivers.multi-sentence-action_03": "0871bca310a6",
    });
  });
});
