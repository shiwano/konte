import { describe, expect, it } from "vitest";
import { inBuild } from "./helpers/build.js";
import {
  Composition,
  Image,
  Video,
  asset,
  defineDirection,
  defineAnimatic,
  defineLens,
  Panel,
} from "../dsl/index.js";
import type { PendingShotInput, ShotHandle } from "../dsl/builders.js";
import { isPendingShotInput } from "../dsl/builders.js";
import {
  getDirectionIndex,
  makeAnimaticShotStarter,
  makeVideoShotStarter,
} from "../dsl/direction.js";
import type { Framing, ScriptLine } from "../dsl/direction.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { directionDefaults } from "./helpers/direction.js";
import type { LanguageTag } from "../typography.js";
import { moves } from "./helpers/shot.js";

// The stage-bound `shot` starter is what `defineAnimatic`/`defineVideo` inject into their timeline.
// These tests exercise the starter's runtime directly (duration/action/script/framing injection, the
// chain, the `shot` handle), so they build the starter from a direction's index the same way.
const vShot = (d: Parameters<typeof getDirectionIndex>[0]) =>
  makeVideoShotStarter(getDirectionIndex(d));
const sbShot = (d: Parameters<typeof getDirectionIndex>[0]) =>
  makeAnimaticShotStarter(getDirectionIndex(d));

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const videoComfy = defineComfyAsset({
  workflow: "video.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

describe("defineDirection", () => {
  const withLang = (lang: LanguageTag) =>
    defineDirection({
      ...directionDefaults,
      policy: { ...directionDefaults.policy, lang },
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
    });

  it("accepts a declared language", () => {
    for (const lang of ["ja", "en", "zh-Hans", "en-US", "zh-TW"] as const) {
      expect(() => withLang(lang)).not.toThrow();
    }
  });

  // The union is the first gate, the throw the second — for a tag that reaches the runtime as a
  // plain string (a computed value, a definition assembled outside `defineDirection`).
  it("rejects a language it does not declare", () => {
    expect(() =>
      defineDirection({
        ...directionDefaults,
        // @ts-expect-error -- intentionally passing a language name rather than a declared tag
        policy: { ...directionDefaults.policy, lang: "Japanese" },
        sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
      }),
    ).toThrow("Invalid `policy.lang`");
    for (const lang of ["ja_JP", "en-", ""]) {
      expect(() => withLang(lang as LanguageTag)).toThrow("Invalid `policy.lang`");
    }
  });

  it("injects the direction duration and action into a video shot", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm open",
            setup: "front",
            duration: 3,
            lineup: [],
          },
          {
            id: "02",
            role: "hero",
            action: "the payoff",
            setup: "front",
            duration: 5,
            lineup: [],
          },
        ],
      },
    });

    // The video chain starts at the first direction shot; `.nextShot("02", …)` mints the successor.
    const chain = vShot(direction)
      .shot("01", () => (
        <Composition>
          <div />
        </Composition>
      ))
      .nextShot("02", () => (
        <Composition>
          <div />
        </Composition>
      ));

    const s = chain.__shots[1]!;
    expect(s.id).toBe("02");
    expect(s.options.duration).toBe(5);
    expect((s.options as { action: string }).action).toBe("the payoff");
  });

  it("passes the injected direction duration to the video build callback", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 7,
            lineup: [],
          },
        ],
      },
    });

    let seen: number | undefined;
    const chain = vShot(direction).shot("01", ({ duration }) => {
      seen = duration;
      return (
        <Composition>
          <div />
        </Composition>
      );
    });

    (chain.__shots[0] as { fn: () => unknown }).fn();
    expect(seen).toBe(7);
  });

  it("passes the injected direction script to the video build callback", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 7,
            script: [{ narration: "morning" }],
            lineup: [],
          },
        ],
      },
    });

    let seen: unknown;
    const chain = vShot(direction).shot("01", ({ script }) => {
      seen = script;
      return (
        <Composition>
          <div />
        </Composition>
      );
    });

    (chain.__shots[0] as { fn: () => unknown }).fn();
    expect({ ...(seen as object) }).toEqual({ narration: ["morning"] });
  });

  it("gives both stages' callbacks a script keyed by speaker", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 7,
            script: [{ character: "cat", text: "meow" }, { narration: "morning" }],
            lineup: [],
          },
        ],
      },
    });

    const read: string[] = [];
    const video = vShot(direction).shot("01", ({ script }) => {
      read.push(script.cat![0]!, script.narration![0]!);
      return (
        <Composition>
          <div />
        </Composition>
      );
    });
    const animatic = sbShot(direction).shot("01", ({ script }) => {
      read.push(script.narration![0]!);
      return (
        <Composition>
          <div />
        </Composition>
      );
    });

    (video.__shots[0] as { fn: () => unknown }).fn();
    (animatic.__shots[0] as { fn: () => unknown }).fn();
    expect(read).toEqual(["meow", "morning", "morning"]);
  });

  // The declaration reaches the build as the literal tuple it was typed as, so a prompt written from
  // it cannot name a subject the shot never listed. The annotations below are the assertion — a
  // widened `readonly string[]` would not assign.
  it("hands the build its lineup as a literal tuple, and the empty tuple where the frame holds no one", () => {
    const direction = defineDirection({
      ...directionDefaults,
      characters: {
        ane: { name: "the sister", description: "the elder sister", promptDepiction: "ane" },
        imouto: {
          name: "the little one",
          description: "the younger sister",
          promptDepiction: "imouto",
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: ["ane", "imouto"],
            lineupTo: ["imouto", "ane"],
          },
          { id: "02", role: "ordinary", action: "calm", setup: "front", duration: 3, lineup: [] },
        ],
      },
    });

    const seen: unknown[] = [];
    defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", (ctx) => {
          const lineup: readonly ["ane", "imouto"] = ctx.lineup;
          const lineupTo: readonly ["imouto", "ane"] = ctx.lineupTo;
          seen.push(lineup, lineupTo);
          return (
            <Composition>
              <Panel src={{ src: "__konte:animatic:shot.01.k__" } as never} />
            </Composition>
          );
        }).nextShot("02", (ctx) => {
          const lineup: readonly [] = ctx.lineup;
          const lineupTo: null = ctx.lineupTo;
          seen.push(lineup, lineupTo);
          return (
            <Composition>
              <Panel src={{ src: "__konte:animatic:shot.02.k__" } as never} />
            </Composition>
          );
        }),
      }),
    });

    expect(seen).toEqual([["ane", "imouto"], ["imouto", "ane"], [], null]);
  });

  // The roster is the vocabulary: a lineup id outside it is blamed at the id, not at the shot.
  it("refuses a lineup id in neither roster, at the id's own position", () => {
    defineDirection({
      ...directionDefaults,
      characters: {
        ane: { name: "the sister", description: "the elder sister", promptDepiction: "ane" },
      },
      props: { ame: { name: "the sweet", description: "a sweet" } },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            // @ts-expect-error "chichi" is in neither roster
            lineup: ["ane", "ame", "chichi"],
          },
        ],
      },
    });
  });

  // A setup's `holds` names its OWN place's landmarks, so the vocabulary is reached through the
  // setup's `location` literal and each element is blamed where it was typed.
  it("refuses a `holds` id the setup's location does not declare, at the id's own position", () => {
    defineDirection({
      ...directionDefaults,
      locations: {
        studio: {
          name: "the studio",
          description: "a plain studio",
          landmarks: {
            desk: {
              name: "the desk",
              promptDepiction: "desk",
              description: "a plain desk, centre",
            },
          },
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "calm", setup: "front", duration: 3, lineup: [] },
        ],
      },
      setups: {
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          // @ts-expect-error "sofa" is not a landmark of "studio"
          holds: ["desk", "sofa"],
        },
      },
    });
  });

  // The insert exemption is the emptiness demand alone: what an insert holds is still its own place's.
  it("refuses a `holds` id on an insert too", () => {
    defineDirection({
      ...directionDefaults,
      locations: {
        studio: {
          name: "the studio",
          description: "a plain studio",
          landmarks: {
            desk: {
              name: "the desk",
              promptDepiction: "desk",
              description: "a plain desk, centre",
            },
          },
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "calm", setup: "front", duration: 3, lineup: [] },
        ],
      },
      setups: {
        front: {
          name: "the front angle",
          description: "the page filling the frame",
          location: "studio",
          framing: "insert",
          // @ts-expect-error "sofa" is not a landmark of "studio"
          holds: ["sofa"],
        },
      },
    });
  });

  it("refuses an empty `holds` on every framing but `insert`", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "calm", setup: "front", duration: 3, lineup: [] },
        ],
      },
      setups: {
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          // @ts-expect-error a frame that is not an insert carries something of its place
          holds: [],
        },
      },
    });
  });

  // A computed value has no literal to blame, so it passes the type layer and `holds-empty` receives
  // it — the same door `ConstrainLineup` leaves open for a widened id.
  it("lets a computed framing through with an empty `holds`", () => {
    const chooseFraming = (): Framing => "insert";
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "calm", setup: "front", duration: 3, lineup: [] },
        ],
      },
      setups: {
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: chooseFraming(),
          holds: [],
        },
      },
    });
  });

  // `join: "continuous"` is refused where no unbroken take could cross the boundary, read off the
  // whole arc flattened so the shot before on the clock is found across leaves and asides. The
  // runtime `join-impossible` has its own cases.
  const twoSetups = {
    ...directionDefaults.setups,
    back: {
      name: "the back angle",
      description: "from behind",
      location: "studio",
      framing: "wide",
      holds: ["desk"],
    },
  } as const;
  const onSetup = <TId extends string, TSetup extends string>(id: TId, setup: TSetup) =>
    ({ id, role: "ordinary", action: "calm", setup, duration: 3, lineup: [] }) as const;

  it("accepts a `continuous` shot on the setup of the shot before it", () => {
    defineDirection({
      ...directionDefaults,
      setups: twoSetups,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [onSetup("01", "front"), { ...onSetup("02", "front"), join: "continuous" }],
      },
    });
  });

  it("refuses a `continuous` shot across two setups", () => {
    defineDirection({
      ...directionDefaults,
      setups: twoSetups,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          onSetup("01", "front"),
          // @ts-expect-error one take is one camera position
          { ...onSetup("02", "back"), join: "continuous" },
        ],
      },
    });
  });

  it("refuses a `continuous` shot opening the piece", () => {
    defineDirection({
      ...directionDefaults,
      setups: twoSetups,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        // @ts-expect-error nothing before it to run on from
        shots: [{ ...onSetup("01", "front"), join: "continuous" }],
      },
    });
  });

  it("refuses a `continuous` shot after an aside, across leaves", () => {
    defineDirection({
      ...directionDefaults,
      setups: twoSetups,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        sequences: [
          {
            id: "a",
            role: "ordinary",
            synopsis: "before",
            lens: "mini-drama",
            pleasure: "cute",
            shots: [
              onSetup("01", "front"),
              { kind: "aside", id: "ec", label: "eyecatch", duration: 2 },
            ],
          },
          {
            id: "b",
            role: "disruption",
            synopsis: "after",
            lens: "mini-drama",
            pleasure: "cute",
            // @ts-expect-error a take does not run through an aside
            shots: [{ ...onSetup("02", "front"), join: "continuous" }],
          },
        ],
      },
    });
  });

  it("refuses a `continuous` cutin where the shot before carries no cutin", () => {
    defineDirection({
      ...directionDefaults,
      setups: twoSetups,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          onSetup("01", "front"),
          {
            ...onSetup("02", "front"),
            join: "jump-forward",
            // @ts-expect-error no wipe before it to run on from
            cutin: { setup: "back", lineup: [], join: "continuous" },
          },
        ],
      },
    });
  });

  // The `within` axis is checked against the whole `setups` roster, so the named entry is looked up
  // and its place and size read back out. A one-shot sequence throughout: these are type assertions,
  // and the runtime `within-*` errors have their own cases.
  const oneShotSequence = {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      { id: "01", role: "ordinary", action: "calm", setup: "front", duration: 3, lineup: [] },
    ],
  } as const;

  it("refuses a `within` naming no declared setup", () => {
    defineDirection({
      ...directionDefaults,
      sequence: oneShotSequence,
      setups: {
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          holds: ["desk"],
          // @ts-expect-error "establishing" is not a declared setup
          within: "establishing",
        },
      },
    });
  });

  it("refuses a `within` set in another place", () => {
    defineDirection({
      ...directionDefaults,
      locations: {
        ...directionDefaults.locations,
        hall: {
          name: "the hall",
          description: "a plain hall",
          landmarks: {
            door: { name: "the door", promptDepiction: "door", description: "at the far end" },
          },
        },
      },
      sequence: oneShotSequence,
      setups: {
        hallWide: {
          name: "the hall, wide",
          description: "the length of it",
          location: "hall",
          framing: "wide",
          holds: ["door"],
        },
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          holds: ["desk"],
          // @ts-expect-error a window is cut out of a frame of the same place
          within: "hallWide",
        },
      },
    });
  });

  it("refuses a `within` that is not strictly wider", () => {
    defineDirection({
      ...directionDefaults,
      sequence: oneShotSequence,
      setups: {
        other: {
          name: "the other angle",
          description: "from the side",
          location: "studio",
          framing: "medium",
          holds: ["desk"],
          within: null,
        },
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          holds: ["desk"],
          // @ts-expect-error "other" is medium, the same size as this frame
          within: "other",
        },
      },
    });
  });

  // An insert fills the frame with one object and shows no set, so it is off the axis at both ends.
  it("refuses a `within` on an insert", () => {
    defineDirection({
      ...directionDefaults,
      sequence: oneShotSequence,
      setups: {
        wide: {
          name: "the wide",
          description: "the whole room",
          location: "studio",
          framing: "wide",
          holds: ["desk"],
        },
        front: {
          name: "the page",
          description: "the page filling the frame",
          location: "studio",
          framing: "insert",
          holds: [],
          // @ts-expect-error an insert holds nothing, so it is no window
          within: "wide",
        },
      },
    });
  });

  // A step may be skipped — a close is as legitimately a window of a wide as of the medium between
  // them — and `null` says the frame is the root of its own axis.
  it("takes a skipped step and a declared root", () => {
    defineDirection({
      ...directionDefaults,
      sequence: oneShotSequence,
      setups: {
        wide: {
          name: "the wide",
          description: "the whole room",
          location: "studio",
          framing: "wide",
          holds: ["desk"],
          within: null,
        },
        front: {
          name: "the front angle",
          description: "in on the page",
          location: "studio",
          framing: "close",
          holds: ["desk"],
          within: "wide",
        },
      },
    });
  });

  // A computed roster has no literal to look up, so the type layer stands aside and the runtime
  // `within-impossible` receives it — the same door a widened id walks through.
  it("lets a computed `within` through", () => {
    const parentOf = (): string => "nowhere";
    defineDirection({
      ...directionDefaults,
      sequence: oneShotSequence,
      setups: {
        front: {
          name: "the front angle",
          description: "straight on, eye level",
          location: "studio",
          framing: "medium",
          holds: ["desk"],
          within: parentOf(),
        },
      },
    });
  });

  it("resolves the shot's framing through its setup for the video build callback", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "detail",
            duration: 7,
            lineup: [],
          },
        ],
      },
      setups: {
        detail: {
          name: "the detail",
          description: "filling the frame",
          location: "studio",
          framing: "insert",
          holds: [],
        },
      },
    });

    let seen: unknown;
    const chain = vShot(direction).shot("01", ({ framing }) => {
      seen = framing;
      return (
        <Composition>
          <div />
        </Composition>
      );
    });

    (chain.__shots[0] as { fn: () => unknown }).fn();
    expect(seen).toBe("insert");
  });

  it("resolves the shot's framing through its setup for the animatic build callback", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "establishing",
            duration: 4,
            lineup: [],
          },
        ],
      },
      setups: {
        establishing: {
          name: "the establishing",
          description: "the whole room",
          location: "studio",
          framing: "wide",
          holds: ["studioMark"],
        },
      },
    });

    let seen: unknown;
    // The animatic build is wrapped in the shot input's `fn` and runs lazily, so invoke it.
    const chain = sbShot(direction).shot("01", ({ framing }) => {
      seen = framing;
      // A shared reference panel — the one panel form that needs no surrounding shot context, which
      // this bare `fn()` call runs outside of.
      return (
        <Composition>
          <Panel src={{ src: "__konte:reference:bg__" }} />
        </Composition>
      );
    });
    const first = chain.__shots[0]!;
    if (isPendingShotInput(first) || !first.fn) throw new Error("expected a developed shot");
    first.fn();
    expect(seen).toBe("wide");
  });

  // A stage file's builds run when the definition loads, which every command does before the direction
  // gate — so an unknown setup must fail here by name, not reach the author's prompt as `undefined`.
  it("throws by name when a shot's setup is not a declared one", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "calm", setup: "nosuch", duration: 4, lineup: [] },
        ],
      },
    });

    const chain = sbShot(direction).shot("01", () => (
      <Composition>
        <Panel src={{ src: "__konte:reference:bg__" }} />
      </Composition>
    ));
    const first = chain.__shots[0]!;
    if (isPendingShotInput(first) || !first.fn) throw new Error("expected a developed shot");
    expect(() => first.fn!()).toThrow(/setup "nosuch"/);
  });

  it("injects the direction duration into an animatic shot", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 4,
            lineup: [],
          },
        ],
      },
    });

    // The animatic starter mints the shot chain; the shot input is its single `__shots` entry.
    const chain = sbShot(direction).shot("01", () => (
      <Composition>
        <Panel src={{ src: "__konte:reference:bg__" }} />
      </Composition>
    ));

    expect(chain.__shots[0]!.id).toBe("01");
    expect(chain.__shots[0]!.options.duration).toBe(4);
  });

  it("mints a pending video shot with the direction duration and action, and no build fn", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
          },
          {
            id: "02",
            role: "hero",
            action: "the payoff",
            setup: "front",
            duration: 5,
            lineup: [],
          },
        ],
      },
    });

    // `.nextPendingShot("02", …)` mints an undeveloped video shot, its duration injected from the direction.
    const chain = vShot(direction)
      .shot("01", () => (
        <Composition>
          <div />
        </Composition>
      ))
      .nextPendingShot("02");

    const s = chain.__shots[1] as PendingShotInput;
    expect(s.id).toBe("02");
    expect(s.__pendingShot).toBe(true);
    expect(s.options.duration).toBe(5);
    expect(s.options.action).toBe("the payoff");
    expect("fn" in s).toBe(false);
  });

  it("derives durations for a sequenced direction across sequences", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "three-act",
        pleasure: "mysterious",
        sequences: [
          {
            id: "act1",
            role: "setup-act",
            lens: "mood-piece",
            pleasure: "mysterious",
            synopsis: "open",
            shots: [
              {
                id: "01",
                role: "atmosphere",
                action: "x",
                setup: "front",
                duration: 2,
                lineup: [],
              },
            ],
          },
          {
            id: "act2",
            role: "climax-act",
            lens: "mini-drama",
            pleasure: "cute",
            synopsis: "peak",
            shots: [
              {
                id: "02",
                role: "hero",
                action: "y",
                setup: "front",
                duration: 6,
                lineup: [],
              },
            ],
          },
        ],
      },
    });

    // The chain flattens sequenced shots into direction order [01, 02], so "02" follows "01".
    const chain = vShot(direction)
      .shot("01", () => (
        <Composition>
          <div />
        </Composition>
      ))
      .nextShot("02", () => (
        <Composition>
          <div />
        </Composition>
      ));
    expect(chain.__shots[1]!.options.duration).toBe(6);
  });

  it("throws on an id not in the direction (defensive runtime guard)", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
          },
        ],
      },
    });

    const callStray = (vShot(direction).shot as (id: string, o: unknown) => unknown).bind(
      null,
      "99",
      () => null,
    );
    expect(callStray).toThrow(/not a declared direction shot/);
  });

  it("constrains shot ids to the direction and preserves animatic part-name inference", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
          },
        ],
      },
    });

    // Type-only: a stray id must not type-check on the injected starter. Never invoked.
    const _strayIsTypeError = () =>
      defineAnimatic(direction, {
        // @ts-expect-error "99" is not a declared direction id
        timeline: ({ pendingShot }) => pendingShot("99"),
      });
    void _strayIsTypeError;

    const animatic = defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          const first = asset("first", imageComfy, { prompt: "a" });
          return (
            <Composition>
              <Panel src={first} {...moves} />
            </Composition>
          );
        }),
      }),
    });

    expect(inBuild(() => animatic.shot("01").image("first").src)).toContain(
      "animatic:shot.01.first",
    );
    // A `<Composition>` build hides its asset names from the type system, so an unknown one is a
    // load-time throw rather than a type error.
    expect(() => inBuild(() => animatic.shot("01").image("missing"))).toThrow(
      /declares no asset named "missing"/,
    );
  });

  // A cast voice's `id` sits in a value rather than a roster key, so it needs its own constraint —
  // without one it slips past the type check and is caught only at load.
  it("constrains a cast voice id to a valid asset name", () => {
    // Type-only: never invoked.
    const _voiceIdIsTyped = () => {
      defineDirection({
        ...directionDefaults,
        characters: {
          a: {
            name: "A",
            promptDepiction: "a",
            description: "d",
            // @ts-expect-error "bad:id" is not a valid asset name
            voice: { id: "bad:id", description: "v" },
          },
        },
        sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
      });
      defineDirection({
        ...directionDefaults,
        // @ts-expect-error "bad:id" is not a valid asset name
        narrator: { id: "bad:id", description: "v" },
        sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
      });
      defineDirection({
        ...directionDefaults,
        characters: {
          a: {
            name: "A",
            description: "d",
            voice: { id: "a_voice", description: "v" },
            promptDepiction: "a",
          },
        },
        narrator: { id: "narrator-voice", description: "v" },
        sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
      });
    };
    void _voiceIdIsTyped;
  });

  it("constrains framing to the closed vocabulary and requires it on every shot", () => {
    // Type-only: never invoked. Spread the full policy so the `const D extends DirectionInput`
    // constraint actually checks the shot shape (a bare `{ sequence }` leaves it loose).
    const _framingIsTyped = () => {
      defineDirection({
        ...directionDefaults,
        sequence: {
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            // @ts-expect-error "wide-angle" is not a Framing token
            { id: "01", role: "ordinary", action: "x", framing: "wide-angle", duration: 3 },
          ],
        },
      });
      defineDirection({
        ...directionDefaults,
        sequence: {
          lens: "mini-drama",
          pleasure: "cute",
          // @ts-expect-error framing is required on every shot
          shots: [{ id: "01", role: "ordinary", action: "x", duration: 3 }],
        },
      });
    };
    void _framingIsTyped;
  });
});

// A video build returns JSX, so its asset names never reach the type system the way an animatic
// shot's panel names do. `shot` therefore checks name and media kind against what the named shot's
// build actually declared, and does it while the definition loads.
// The shot-local declarations the type settles, each the front line of a waivable finding: the span
// grid, the empty sentence, a `lineupTo` that repeats its `lineup`, and a line the speech policy
// forbids. A computed value has no literal to blame and falls through to the finding.
describe("the shot a direction declares", () => {
  it("takes a span on the 0.5s grid", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "ordinary", action: "calm", setup: "front", duration: 2.5, lineup: [] },
          { id: "02", role: "hero", action: "loud", setup: "front", duration: 3, lineup: [] },
        ],
      },
    });
  });

  it("refuses a span off it, at the duration", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            // @ts-expect-error -- 2.25s lands no whole frame at every legal fps
            duration: 2.25,
            lineup: [],
          },
        ],
      },
    });
  });

  it("refuses an empty action", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            // @ts-expect-error -- the one sentence the shot lands cannot be empty
            action: "",
            setup: "front",
            duration: 3,
            lineup: [],
          },
        ],
      },
    });
  });

  it("refuses an empty synopsis on a child node", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        sequences: [
          {
            id: "act1",
            role: "ordinary",
            // @ts-expect-error -- a child node's own summary cannot be empty
            synopsis: "",
            lens: "mini-drama",
            pleasure: "cute",
            shots: [
              {
                id: "01",
                role: "ordinary",
                action: "calm",
                setup: "front",
                duration: 3,
                lineup: [],
              },
            ],
          },
        ],
      },
    });
  });

  it("refuses a `lineupTo` that repeats the `lineup`", () => {
    defineDirection({
      ...directionDefaults,
      characters: {
        ane: { name: "the sister", description: "the elder sister", promptDepiction: "ane" },
        imouto: {
          name: "the younger",
          description: "the younger sister",
          promptDepiction: "imouto",
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: ["ane", "imouto"],
            // @ts-expect-error -- the frame ends where it began, which leaving it out already says
            lineupTo: ["ane", "imouto"],
          },
          {
            id: "02",
            role: "hero",
            action: "loud",
            setup: "front",
            duration: 3,
            lineup: ["ane", "imouto"],
            lineupTo: ["imouto", "ane"],
          },
        ],
      },
    });
  });

  it("pins a role to the beats its node's lens declares", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            // @ts-expect-error -- "button" is a comedy role, and this node's lens is mini-drama
            role: "button",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
          },
        ],
      },
    });
  });

  // A computed value has no literal to judge, so it reaches the runtime finding instead: an array typed
  // `ScriptLine[]` or `string[]` may be empty or hold anything, and rejecting it at the startup
  // type-check would block every command on a direction that is valid at runtime.
  it("lets a computed script through under a speech policy", () => {
    const noLines: ScriptLine[] = [];
    const lines: readonly ScriptLine[] = [];
    defineDirection({
      ...directionDefaults,
      policy: { ...directionDefaults.policy, speech: "none" },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
            script: noLines,
          },
        ],
      },
    });
    defineDirection({
      ...directionDefaults,
      policy: { ...directionDefaults.policy, speech: "no-dialogue" },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
            script: lines,
          },
        ],
      },
    });
  });

  it("lets a computed lineup pair through, mutable arrays included", () => {
    const opening: string[] = ["ane", "imouto"];
    const closing: string[] = ["imouto", "ane"];
    defineDirection({
      ...directionDefaults,
      characters: {
        ane: { name: "the sister", description: "the elder sister", promptDepiction: "ane" },
        imouto: {
          name: "the younger",
          description: "the younger sister",
          promptDepiction: "imouto",
        },
      },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: opening,
            lineupTo: closing,
          },
        ],
      },
    });
  });

  // `resolveLens` prefers a direction's own lens over the built-in of the same name, so a role that lens
  // declares is legal even where the built-in would reject it.
  it("lets a role through when a custom lens shadows the built-in of that name", () => {
    defineDirection({
      ...directionDefaults,
      lenses: [
        defineLens({ name: "mini-drama", payoff: "peak", beats: [{ role: "peak", fn: "payoff" }] }),
      ],
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          { id: "01", role: "peak", action: "calm", setup: "front", duration: 3, lineup: [] },
        ],
      },
    });
  });

  // A child node is an item in its PARENT's arc, so its role answers to the parent's lens while its
  // own shots answer to its own.
  it("reads a child node's role against the parent's lens and its shots against its own", () => {
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "three-act",
        pleasure: "cute",
        sequences: [
          {
            id: "act1",
            role: "setup-act",
            synopsis: "the sister asks",
            lens: "comedy",
            pleasure: "funny",
            shots: [
              {
                id: "01",
                role: "setup",
                action: "calm",
                setup: "front",
                duration: 3,
                lineup: [],
              },
            ],
          },
        ],
      },
    });
  });

  it("refuses a script line the speech policy forbids", () => {
    defineDirection({
      ...directionDefaults,
      policy: { ...directionDefaults.policy, speech: "none" },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
            // @ts-expect-error -- policy.speech is "none", so no shot declares a line
            script: [{ narration: "she waits" }],
          },
        ],
      },
    });
  });

  it("lets narration through under no-dialogue and refuses a spoken line", () => {
    defineDirection({
      ...directionDefaults,
      policy: { ...directionDefaults.policy, speech: "no-dialogue" },
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm",
            setup: "front",
            duration: 3,
            lineup: [],
            script: [{ narration: "she waits" }],
          },
          {
            id: "02",
            role: "hero",
            action: "loud",
            setup: "front",
            duration: 3,
            lineup: [],
            // @ts-expect-error -- policy.speech is "no-dialogue", so nobody speaks
            script: [{ speaker: "a voice", text: "wait" }],
          },
        ],
      },
    });
  });
});

describe("video shot", () => {
  const twoShots = () =>
    defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm open",
            setup: "front",
            duration: 3,
            lineup: [],
          },
          {
            id: "02",
            role: "hero",
            action: "the payoff",
            setup: "front",
            duration: 5,
            lineup: [],
          },
        ],
      },
    });

  const openWith = (direction: ReturnType<typeof twoShots>) =>
    vShot(direction).shot("01", () => {
      const motion = asset("motion", videoComfy, { prompt: "a" });
      const still = asset("still", imageComfy, { prompt: "b" });
      return (
        <Composition>
          <Video src={motion} />
          <Image src={still} />
        </Composition>
      );
    });

  // The chain holds only each shot's closure, so the handle re-runs it in discovery mode.
  it("resolves a declared asset to its shot-local placeholder, by kind", () => {
    const chain = openWith(twoShots()).nextShot("02", ({ shot }) => (
      <Composition>
        <Video src={shot("01").video("motion")} />
        <Image src={shot("01").image("still")} />
      </Composition>
    ));
    expect(() => (chain.__shots[1] as { fn: () => unknown }).fn()).not.toThrow();
  });

  it("throws naming the declared assets when the name is unknown", () => {
    const chain = openWith(twoShots()).nextShot("02", ({ shot }) => (
      <Composition>
        <Video src={shot("01").video("mtoin")} />
      </Composition>
    ));
    expect(() => (chain.__shots[1] as { fn: () => unknown }).fn()).toThrow(
      /declares no asset named "mtoin".*Declared: motion, still/s,
    );
  });

  it("throws pointing at the right accessor when the kind mismatches", () => {
    const chain = openWith(twoShots()).nextShot("02", ({ shot }) => (
      <Composition>
        <Video src={shot("01").video("still")} />
      </Composition>
    ));
    expect(() => (chain.__shots[1] as { fn: () => unknown }).fn()).toThrow(
      /"still" is image, not video.*Use shot\("01"\)\.image\("still"\)/s,
    );
  });

  it("throws when the named shot is an undeveloped pendingShot", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm open",
            setup: "front",
            duration: 3,
            lineup: [],
          },
          {
            id: "02",
            role: "pressure",
            action: "not yet",
            setup: "front",
            duration: 4,
            lineup: [],
          },
          {
            id: "03",
            role: "hero",
            action: "the payoff",
            setup: "front",
            duration: 5,
            lineup: [],
          },
        ],
      },
    });
    const chain = vShot(direction)
      .shot("01", () => (
        <Composition>
          <div />
        </Composition>
      ))
      .nextPendingShot("02")
      .nextShot("03", ({ shot }) => (
        <Composition>
          <Video src={shot("02").video("motion")} />
        </Composition>
      ));
    expect(() => (chain.__shots[2] as { fn: () => unknown }).fn()).toThrow(
      /shot "02" is still an undeveloped pendingShot/,
    );
  });

  it("reaches back past the immediate predecessor", () => {
    const direction = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "calm open",
            setup: "front",
            duration: 3,
            lineup: [],
          },
          {
            id: "02",
            role: "pressure",
            action: "the turn",
            setup: "front",
            duration: 4,
            lineup: [],
          },
          { id: "03", role: "hero", action: "the payoff", setup: "front", duration: 5, lineup: [] },
        ],
      },
    });
    const chain = vShot(direction)
      .shot("01", () => {
        const motion = asset("motion", videoComfy, { prompt: "a" });
        return (
          <Composition>
            <Video src={motion} />
          </Composition>
        );
      })
      .nextShot("02", () => (
        <Composition>
          <div />
        </Composition>
      ))
      .nextShot("03", ({ shot }) => (
        <Composition>
          <Video src={shot("01").video("motion")} />
        </Composition>
      ));
    expect(() => (chain.__shots[2] as { fn: () => unknown }).fn()).not.toThrow();
  });

  // The type pins `shot` to the ids the chain has already placed; this is the runtime twin, for a
  // computed id that named a shot still ahead.
  it("throws naming the placed shots when the shot has not been reached yet", () => {
    const chain = openWith(twoShots()).nextShot("02", ({ shot }) => (
      <Composition>
        <Video src={(shot as (id: string) => ShotHandle)("02").video("motion")} />
      </Composition>
    ));
    expect(() => (chain.__shots[1] as { fn: () => unknown }).fn()).toThrow(
      /has not placed a shot "02" yet.*Placed so far: 01/s,
    );
  });

  it("cannot be called from the chain's first shot", () => {
    const chain = vShot(twoShots()).shot("01", ({ shot }) => (
      <Composition>
        <Video src={(shot as unknown as (id: string) => ShotHandle)("01").video("motion")} />
      </Composition>
    ));
    expect(() => (chain.__shots[0] as { fn: () => unknown }).fn()).toThrow(
      /this is the video chain's first shot/,
    );
  });

  it("rejects a kind mismatch at compile time, not only at load", () => {
    // Type-only: never invoked (it would hit the runtime guard above).
    const _kindIsTypeError = () =>
      openWith(twoShots()).nextShot("02", ({ shot }) => (
        <Composition>
          {/* @ts-expect-error an image asset is not a valid <Video> src */}
          <Video src={shot("01").image("still")} />
        </Composition>
      ));
    void _kindIsTypeError;
  });

  it("discovers a shot once, however many assets are pulled from it", () => {
    let builds = 0;
    const direction = twoShots();
    const chain = vShot(direction)
      .shot("01", () => {
        builds++;
        const motion = asset("motion", videoComfy, { prompt: "a" });
        const still = asset("still", imageComfy, { prompt: "b" });
        return (
          <Composition>
            <Video src={motion} />
            <Image src={still} />
          </Composition>
        );
      })
      .nextShot("02", ({ shot }) => (
        <Composition>
          <Video src={shot("01").video("motion")} />
          <Image src={shot("01").image("still")} />
        </Composition>
      ));

    builds = 0;
    (chain.__shots[1] as { fn: () => unknown }).fn();
    expect(builds).toBe(1);
  });
});
