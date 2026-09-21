import { describe, expect, it } from "vitest";
import { DIRECTION_SECTIONS, directionSectionOf } from "../address.js";
import {
  applyDirectionPartDecisions,
  applyDirectionReferenceCascade,
  applyDirectionSectionDecisions,
  applyDirectionShotCascade,
  directionAcceptanceView,
  directionCascadeReferenceIds,
  directionCascadeShotIds,
  isDirectionSpendGateSatisfied,
  summarizeDirectionAcceptance,
} from "../direction-acceptance.js";
import { directionHash, directionPartHashes } from "../direction-hash.js";
import type { BeatFunction } from "../direction-check.js";
import type { Direction, NarrativeShot } from "../dsl/direction.js";

// The frames the shots are taken from. A fixture's shots name one by id; its `location`/`framing` are
// read through it, so nothing here is restated on a shot.
const setups = {
  "bedroom-medium": {
    name: "the bedroom, medium",
    description: "straight on, eye level",
    location: "bedroom",
    framing: "medium",
    holds: ["bedroomMark"],
  },
  "bedroom-close": {
    name: "the bedroom, close",
    description: "in on the face",
    location: "bedroom",
    framing: "close",
    holds: ["bedroomMark"],
  },
  "bedroom-wide": {
    name: "the bedroom, wide",
    description: "the whole room",
    location: "bedroom",
    framing: "wide",
    holds: ["bedroomMark"],
  },
} as const;

// A minimal, type-valid direction with something in every section: a brief, the policy fields, a
// character, a prop, a location, an arc with shots, and a waiver — so a test can accept one box and
// assert the others held.
function makeDirection(): Direction {
  return {
    brief: { logline: "a girl wakes and leaves", tone: "quiet" },
    characters: {
      alice: { name: "Alice", description: "a girl in red", promptDepiction: "alice" },
    },
    props: { lantern: { name: "the lantern", description: "a brass hand lantern" } },
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
      },
    },
    setups,
    policy: {
      format: { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
      lang: "en",
      speech: "free",
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
          setup: "bedroom-wide",
          duration: 6,
          lineup: [],
        },
      ],
      waivers: { "multi-sentence-action_02": "intentional — a quiet shot" },
    },
  } as Direction;
}

const ALL_SECTIONS = Object.fromEntries(DIRECTION_SECTIONS.map((s) => [s, true]));

// A direction signed off end to end — so `whole` stands, and the gate has narrowed to the sections
// no downstream review re-reads.
function acceptAll(direction: Direction) {
  return applyDirectionSectionDecisions(direction, null, ALL_SECTIONS);
}

// A review still in progress: every box but the waivers, so `parts` never covers the live set and
// `whole` never comes together. This is the state before the first spend, where the gate demands
// everything and no cascade may sign off a part on a human's behalf.
function acceptAllButWaivers(direction: Direction) {
  return applyDirectionSectionDecisions(direction, null, {
    brief: true,
    policy: true,
    characters: true,
    props: true,
    locations: true,
    shots: true,
  });
}

describe("directionSectionOf", () => {
  // Every part must land in a box the page renders, or it is a part with no Accept anywhere — the
  // gate would demand it and no reviewer could ever settle it.
  it("routes every part of a direction to a section", () => {
    for (const address of directionPartHashes(makeDirection()).keys()) {
      expect(DIRECTION_SECTIONS).toContain(directionSectionOf(address));
    }
  });

  it("routes the root arc, the acts and the shots to the one Flow & Shots box", () => {
    expect(directionSectionOf("direction:sequence")).toBe("shots");
    expect(directionSectionOf("direction:sequence.shots.01")).toBe("shots");
    expect(directionSectionOf("direction:sequence.sequences.act1")).toBe("shots");
    expect(directionSectionOf("direction:sequence.waivers.multi-sentence-action_02")).toBe(
      "waivers",
    );
    expect(directionSectionOf("direction:brief.logline")).toBe("brief");
    expect(directionSectionOf("direction:policy.format")).toBe("policy");
    expect(directionSectionOf("direction:characters.alice")).toBe("characters");
    expect(directionSectionOf("direction:props.lantern")).toBe("props");
  });
});

describe("directionAcceptanceView", () => {
  it("reads an unaccepted direction as every part blocking", () => {
    const direction = makeDirection();
    const view = directionAcceptanceView(direction, null);
    expect(view.complete).toBe(false);
    expect(view.blocking).toHaveLength(view.parts.size);
    expect(view.blocking.every((b) => b.status === "unaccepted")).toBe(true);
    expect([...view.sections.values()].every((s) => s === "unaccepted")).toBe(true);
  });

  it("reads a fully accepted direction as complete", () => {
    const direction = makeDirection();
    const view = directionAcceptanceView(direction, acceptAll(direction));
    expect(view.complete).toBe(true);
    expect(view.blocking).toEqual([]);
  });

  // The whole point of per-part state: a rewrite ages out what it changed, and nothing else.
  it("ages out only the parts an edit changed", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const edited = makeDirection();
    (edited.sequence.shots![1] as NarrativeShot).action = "she stays";

    const view = directionAcceptanceView(edited, acceptance);
    expect(view.blocking).toEqual([{ address: "direction:sequence.shots.02", status: "stale" }]);
    expect(view.sections.get("shots")).toBe("stale");
    expect(view.sections.get("brief")).toBe("accepted");
    expect(view.sections.get("characters")).toBe("accepted");
  });

  // A box with nothing in it is not rendered, so it can never be accepted — it must not be what
  // holds the gate shut forever.
  it("reads a section with no parts as accepted", () => {
    const direction = makeDirection();
    direction.characters = {};
    delete direction.sequence.waivers;
    const view = directionAcceptanceView(direction, acceptAll(direction));
    expect(view.sections.get("characters")).toBe("accepted");
    expect(view.sections.get("waivers")).toBe("accepted");
    expect(view.complete).toBe(true);
  });

  // A DELETED part removes a key rather than changing one, so comparing only live parts would wave
  // the edit through — the human accepted a direction that had it, and this one does not.
  it("blocks when an accepted part was deleted from the direction", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const cut = makeDirection();
    delete cut.brief.tone;

    const view = directionAcceptanceView(cut, acceptance);
    expect(view.complete).toBe(false);
    // Nothing LIVE is blocking — the block is the orphan alone.
    expect(view.blocking).toEqual([]);
    // And it is pinned on the box that owns it: only that box's Accept can drop it, so a box
    // reading "accepted" over its own orphan would tell the reviewer to re-accept and then show
    // them nothing to re-accept.
    expect(view.sections.get("brief")).toBe("stale");
    expect(view.sections.get("characters")).toBe("accepted");
  });

  // The dead end: a section that loses its LAST live part has no rows, so the page would render no
  // box for it — and only its own box can drop its orphan. If it read as "accepted", the gate would
  // stay shut with nothing on the page able to open it, forever.
  it("keeps a section that lost every live part reviewable", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const noCast = makeDirection();
    noCast.characters = {};

    const view = directionAcceptanceView(noCast, acceptance);
    expect(view.sections.get("characters")).toBe("stale");
    expect(view.complete).toBe(false);

    // ...and accepting that box clears the orphan, so the gate can open again.
    const reaccepted = applyDirectionSectionDecisions(noCast, acceptance, {
      characters: true,
      shots: true, // the cut also re-shaped the arc (its characters list), so the sequence part needs re-reading too
    });
    expect(reaccepted.parts["direction:characters.alice"]).toBeUndefined();
    expect(isDirectionSpendGateSatisfied(noCast, reaccepted)).toBe(true);
  });
});

describe("isDirectionSpendGateSatisfied", () => {
  it("is false with no acceptance at all", () => {
    expect(isDirectionSpendGateSatisfied(makeDirection(), null)).toBe(false);
  });

  // Before the piece has been signed off whole, the gate is the full comparison: nothing downstream
  // exists to have shown any of it, so a single unread part holds every spend.
  it("demands every part until the direction has been accepted whole", () => {
    const direction = makeDirection();
    const partial = acceptAllButWaivers(direction);
    expect(partial.whole).toBeNull();
    expect(isDirectionSpendGateSatisfied(direction, partial)).toBe(false);
  });

  it("is true once every section is accepted", () => {
    const direction = makeDirection();
    expect(isDirectionSpendGateSatisfied(direction, acceptAll(direction))).toBe(true);
  });

  // The whole point of the change: after the piece has been accepted whole, a shot rewritten while
  // reviewing the reel that plays it does not send anyone back to the direction page.
  it("does not re-block on a shot edited after the whole was accepted", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const edited = makeDirection();
    (edited.sequence.shots![1] as NarrativeShot).action = "she stays";
    expect(isDirectionSpendGateSatisfied(edited, acceptance)).toBe(true);
    // Still reported as changed — the gate stopped asking, the page did not.
    expect(directionAcceptanceView(edited, acceptance).complete).toBe(false);
  });

  // The piece-wide agreements have no downstream reading, so they re-block for the life of the piece.
  it("re-blocks on an edit to the brief, the policy or a waiver", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    for (const edit of [
      (d: Direction) => (d.brief.logline = "a girl wakes and stays"),
      (d: Direction) => (d.policy.format!.fps = 30),
      (d: Direction) => (d.sequence.waivers = { "multi-sentence-action_02": "reconsidered" }),
    ]) {
      const edited = makeDirection();
      edit(edited);
      expect(isDirectionSpendGateSatisfied(edited, acceptance)).toBe(false);
    }
  });

  // The short-circuit must never be more permissive than the walk it stands in for. A stamped
  // `whole.hash` that no longer matches proves nothing, so the answer has to come from the parts.
  it("agrees with the full comparison when the short-circuit misses", () => {
    const direction = makeDirection();
    const accepted = acceptAll(direction);
    const acceptance = { ...accepted, whole: { hash: "stale-or-forged", acceptedAt: "t" } };
    expect(isDirectionSpendGateSatisfied(direction, acceptance)).toBe(true);
  });

  it("does not accept a direction on a whole-hash with no parts behind it", () => {
    const direction = makeDirection();
    // No writer can produce this — emptying `parts` clears `whole` — but a hand-edited state can,
    // and there is no record of which parts a human read, so it cannot stand in for their verdict.
    const acceptance = { parts: {}, whole: { hash: directionHash(direction), acceptedAt: "t" } };
    expect(isDirectionSpendGateSatisfied(direction, acceptance)).toBe(false);
  });

  // `projectDirection` must subsume every part hash, or an edit it sees and the parts don't would
  // leave the short-circuit reporting a sign-off nobody gave. A custom lens is the case that nearly
  // escaped: rewriting its beats re-shapes the arc while every `node.lens` still names the same lens.
  it("ages out the arc when a custom lens it is placed on is rewritten", () => {
    const withLens = (fn: BeatFunction): Direction => ({
      ...makeDirection(),
      lenses: [{ name: "house-style", beats: [{ role: "hero", fn }], payoff: "hero" }],
    });

    const direction = withLens("build");
    const acceptance = acceptAll(direction);
    expect(directionAcceptanceView(direction, acceptance).complete).toBe(true);

    const view = directionAcceptanceView(withLens("payoff"), acceptance);
    expect(view.parts.get("direction:sequence")).toBe("stale");
  });
});

describe("applyDirectionSectionDecisions", () => {
  it("accepts only the parts the decided sections own", () => {
    const direction = makeDirection();
    const acceptance = applyDirectionSectionDecisions(direction, null, { brief: true });

    const view = directionAcceptanceView(direction, acceptance);
    expect(view.sections.get("brief")).toBe("accepted");
    expect(view.sections.get("shots")).toBe("unaccepted");
    expect(view.complete).toBe(false);
    expect(acceptance.whole).toBeNull();
  });

  it("stamps the short-circuit only once every part is covered", () => {
    const direction = makeDirection();
    expect(applyDirectionSectionDecisions(direction, null, { brief: true }).whole).toBeNull();
    expect(acceptAll(direction).whole?.hash).toBe(directionHash(direction));
  });

  // An untouched box keeps last session's verdict: a reviewer who only came back to sign off the
  // characters has not withdrawn anything.
  it("leaves an undecided section's acceptance standing", () => {
    const direction = makeDirection();
    const first = applyDirectionSectionDecisions(direction, null, { brief: true });
    const second = applyDirectionSectionDecisions(direction, first, { characters: true });

    const view = directionAcceptanceView(direction, second);
    expect(view.sections.get("brief")).toBe("accepted");
    expect(view.sections.get("characters")).toBe("accepted");
  });

  it("revokes a section's parts so the gate re-blocks on it", () => {
    const direction = makeDirection();
    const revoked = applyDirectionSectionDecisions(direction, acceptAll(direction), {
      shots: false,
    });

    const view = directionAcceptanceView(direction, revoked);
    expect(view.sections.get("shots")).toBe("unaccepted");
    expect(view.sections.get("brief")).toBe("accepted");
    expect(view.complete).toBe(false);
    expect(revoked.whole?.hash).toBeNull();
  });

  it("clears its own box's orphans when the section is re-accepted", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const cut = makeDirection();
    delete cut.brief.tone;
    expect(directionAcceptanceView(cut, acceptance).complete).toBe(false);

    const reaccepted = applyDirectionSectionDecisions(cut, acceptance, { brief: true });
    expect(reaccepted.parts["direction:brief.tone"]).toBeUndefined();
    expect(isDirectionSpendGateSatisfied(cut, reaccepted)).toBe(true);
  });

  // A deletion is something a human has yet to read. Clearing its block from a DIFFERENT box's
  // button would sign off on their behalf — the characters' Accept says nothing about a cut brief field.
  it("leaves another box's orphan blocking", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const cut = makeDirection();
    delete cut.brief.tone;

    const reaccepted = applyDirectionSectionDecisions(cut, acceptance, { characters: true });
    expect(reaccepted.parts["direction:brief.tone"]).toBeDefined();
    expect(isDirectionSpendGateSatisfied(cut, reaccepted)).toBe(false);
  });

  it("owes no review for a deleted waiver, and sweeps its sign-off on the next write", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const cut = makeDirection();
    delete cut.sequence.waivers;

    const view = directionAcceptanceView(cut, acceptance);
    expect(view.complete).toBe(true);
    expect(view.gateSatisfied).toBe(true);
    expect(view.sections.get("waivers")).toBe("accepted");
    expect(summarizeDirectionAcceptance(cut, acceptance).status).toBe("accepted");

    const written = applyDirectionSectionDecisions(cut, acceptance, { characters: true });
    expect(written.parts["direction:sequence.waivers.multi-sentence-action_02"]).toBeUndefined();
    expect(written.whole?.hash).toBe(directionHash(cut));
  });
});

describe("applyDirectionPartDecisions", () => {
  it("stamps only the parts it is given", () => {
    const direction = makeDirection();
    const { acceptance, accepted } = applyDirectionPartDecisions(
      direction,
      null,
      new Map([["direction:brief.tone", true]]),
    );

    expect(accepted).toEqual(["direction:brief.tone"]);
    const view = directionAcceptanceView(direction, acceptance);
    expect(view.parts.get("direction:brief.tone")).toBe("accepted");
    expect(view.parts.get("direction:brief.logline")).toBe("unaccepted");
    expect(acceptance.whole).toBeNull();
  });

  it("reports nothing when the part is already signed off at that hash", () => {
    const direction = makeDirection();
    const first = applyDirectionPartDecisions(
      direction,
      null,
      new Map([["direction:brief.tone", true]]),
    );
    const second = applyDirectionPartDecisions(
      direction,
      first.acceptance,
      new Map([["direction:brief.tone", true]]),
    );

    expect(second.accepted).toEqual([]);
    expect(second.acceptance.parts["direction:brief.tone"]).toEqual(
      first.acceptance.parts["direction:brief.tone"],
    );
  });

  // A cut shot's address is not resurrected by naming it — an accept signs off what is there.
  it("ignores an accept aimed at a part the direction no longer has", () => {
    const direction = makeDirection();
    const { acceptance, accepted } = applyDirectionPartDecisions(
      direction,
      null,
      new Map([["direction:props.gone", true]]),
    );

    expect(accepted).toEqual([]);
    expect(acceptance.parts["direction:props.gone"]).toBeUndefined();
  });

  it("drops a record whether it is live or an orphan", () => {
    const direction = makeDirection();
    const cut = makeDirection();
    delete cut.brief.tone;

    const { acceptance, revoked } = applyDirectionPartDecisions(
      cut,
      acceptAll(direction),
      new Map([
        ["direction:brief.tone", false],
        ["direction:brief.logline", false],
      ]),
    );

    expect(revoked.sort()).toEqual(["direction:brief.logline", "direction:brief.tone"]);
    expect(directionAcceptanceView(cut, acceptance).parts.get("direction:brief.logline")).toBe(
      "unaccepted",
    );
  });

  it("stamps the short-circuit once every live part is covered", () => {
    const direction = makeDirection();
    const decisions = new Map([...directionPartHashes(direction).keys()].map((a) => [a, true]));

    const { acceptance } = applyDirectionPartDecisions(direction, null, decisions);
    expect(acceptance.whole?.hash).toBe(directionHash(direction));
    expect(isDirectionSpendGateSatisfied(direction, acceptance)).toBe(true);
  });
});

describe("summarizeDirectionAcceptance", () => {
  it("counts what is left, and separates never-read from partly-settled", () => {
    const direction = makeDirection();
    const total = directionPartHashes(direction).size;

    expect(summarizeDirectionAcceptance(direction, null)).toEqual({
      status: "unaccepted",
      blocking: total,
      gateBlocking: total,
      total,
    });
    expect(summarizeDirectionAcceptance(direction, acceptAll(direction))).toEqual({
      status: "accepted",
      blocking: 0,
      gateBlocking: 0,
      total,
    });

    const partial = applyDirectionSectionDecisions(direction, null, { brief: true });
    const summary = summarizeDirectionAcceptance(direction, partial);
    expect(summary.status).toBe("partial");
    expect(summary.blocking).toBeGreaterThan(0);
    expect(summary.blocking).toBeLessThan(total);
  });

  // The two counts part company once the piece is accepted whole: a rewritten shot is still named,
  // but nothing is waiting on it, so a reader is not sent to go clear it.
  it("counts a shot edited after the whole was accepted as reported but not blocking", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const edited = makeDirection();
    (edited.sequence.shots![1] as NarrativeShot).action = "she stays";

    const summary = summarizeDirectionAcceptance(edited, acceptance);
    expect(summary.status).toBe("partial");
    expect(summary.blocking).toBe(1);
    expect(summary.gateBlocking).toBe(0);
  });

  // A deleted part is not a live part, so it cannot be counted out of `total` — but it is still
  // something the reviewer has to settle, and reporting "0 of 12" beside a blocked gate would read
  // as a bug in konte rather than a page to go re-read.
  it("reports a deletion-only block as work left to do", () => {
    const direction = makeDirection();
    const acceptance = acceptAll(direction);

    const cut = makeDirection();
    delete cut.brief.tone;

    const summary = summarizeDirectionAcceptance(cut, acceptance);
    expect(summary.status).toBe("partial");
    expect(summary.blocking).toBe(1);
  });
});

// A direction of two acts, so the ancestor chain a shot cascade walks is more than "the root".
function nestedDirection(): Direction {
  const base = makeDirection();
  return {
    ...base,
    sequence: {
      lens: "mini-drama",
      pleasure: "cute",
      sequences: [
        {
          id: "act1",
          role: "hero",
          synopsis: "she wakes",
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
              action: "she sits up",
              setup: "bedroom-close",
              duration: 3,
              lineup: [],
            },
          ],
        },
        {
          id: "act2",
          role: "hero",
          synopsis: "she leaves",
          lens: "mini-drama",
          pleasure: "cute",
          shots: [
            {
              id: "03",
              role: "hero",
              action: "she leaves",
              setup: "bedroom-wide",
              duration: 6,
              lineup: [],
            },
          ],
        },
      ],
    },
  } as Direction;
}

describe("directionCascadeShotIds", () => {
  it("takes the shots out of a stage's accepted addresses, and nothing else", () => {
    expect(
      directionCascadeShotIds([
        "video:shot.01.motion",
        "video:shot.01#composition",
        "animatic:shot.02.first",
        "video:timeline.bgm",
        "reference:alice",
        "not an address",
      ]),
    ).toEqual(new Set(["01", "02"]));
  });
});

// A shot appended after the last review — the shape both halves of R1 are asked about.
function withThirdShot(): Direction {
  const grown = makeDirection();
  grown.sequence.shots!.push({
    id: "03",
    role: "hero",
    action: "she pauses at the door",
    setup: "bedroom-close",
    duration: 2,
    lineup: [],
  });
  return grown;
}

describe("applyDirectionShotCascade", () => {
  // The loop this exists for: a shot retimed while reviewing the video, signed off by accepting the
  // take that plays it — without sending the reviewer back to re-read the same shot on the
  // direction page.
  it("re-signs an accepted shot whose own words changed", () => {
    const accepted = acceptAll(makeDirection());

    const retimed = makeDirection();
    retimed.sequence.shots![0]!.duration = 7;
    expect(directionAcceptanceView(retimed, accepted).complete).toBe(false);

    const { acceptance, restamped } = applyDirectionShotCascade(retimed, accepted, ["01"]);
    // The shot's own part and the root arc, which reads its duration off the direction.
    expect(restamped.sort()).toEqual(["direction:sequence", "direction:sequence.shots.01"]);
    expect(directionAcceptanceView(retimed, acceptance!).complete).toBe(true);
  });

  // A setup carries the shot's size and place, and it has no reference asset of its own to be accepted
  // through — so if the shot cascade did not reach it, an edited frame could never be re-signed
  // downstream and a finished piece would never read `complete` again.
  it("re-signs the setup a re-described frame belongs to", () => {
    const accepted = acceptAll(makeDirection());

    const reframed = makeDirection();
    (reframed.setups as Record<string, { description: string }>)["bedroom-medium"]!.description =
      "lower, and closer to the bed";
    expect(directionAcceptanceView(reframed, accepted).complete).toBe(false);

    const { acceptance, restamped } = applyDirectionShotCascade(reframed, accepted, ["01"]);
    expect(restamped).toContain("direction:setups.bedroom-medium");
    expect(directionAcceptanceView(reframed, acceptance!).complete).toBe(true);
  });

  // Only the frame the accepted shot is actually taken from.
  it("leaves the setups the accepted shot does not use alone", () => {
    const accepted = acceptAll(makeDirection());

    const reframed = makeDirection();
    (reframed.setups as Record<string, { description: string }>)["bedroom-wide"]!.description =
      "further back";
    const { restamped } = applyDirectionShotCascade(reframed, accepted, ["01"]);
    expect(restamped).not.toContain("direction:setups.bedroom-wide");
  });

  // The other half of the change: a shot written mid-production is judged as the panel and the shot
  // that realize it, so the accept of that media settles its words too. Without this the piece could
  // never reach "every part accepted" without a trip back to a page showing the same shot as prose.
  it("signs off a shot added after the whole was accepted", () => {
    const accepted = acceptAll(makeDirection());

    const grown = withThirdShot();
    const { acceptance, restamped } = applyDirectionShotCascade(grown, accepted, ["03"]);

    expect(restamped).toContain("direction:sequence.shots.03");
    expect(directionAcceptanceView(grown, acceptance!).complete).toBe(true);
  });

  // R1, and it holds until the piece has been signed off whole: before then nothing downstream has
  // been reviewed, so a first read is the human's alone and no accept can stand in for it.
  it("never signs off an unread shot before the whole was accepted", () => {
    const partial = acceptAllButWaivers(makeDirection());

    const grown = withThirdShot();
    const { acceptance, restamped } = applyDirectionShotCascade(grown, partial, ["01", "02", "03"]);
    expect(restamped).not.toContain("direction:sequence.shots.03");
    expect(
      directionAcceptanceView(grown, acceptance!).parts.get("direction:sequence.shots.03"),
    ).toBe("unaccepted");
  });

  // A cut shot's lingering sign-off answers no question anyone asks once the gate has stopped
  // reading its section — and leaving it would keep `complete` false forever, so a finished piece
  // could never show a clean direction page.
  it("sweeps a cut shot's orphaned acceptance", () => {
    const accepted = acceptAll(makeDirection());

    const cut = makeDirection();
    cut.sequence.shots!.pop();

    const { acceptance } = applyDirectionShotCascade(cut, accepted, ["01"]);
    expect(acceptance!.parts["direction:sequence.shots.02"]).toBeUndefined();
    expect(directionAcceptanceView(cut, acceptance!).complete).toBe(true);
  });

  // The sweep is scoped to what the gate has stopped reading. Losing a brief field is still a change
  // a human has to sign, so its orphan stays and keeps blocking.
  it("keeps a piece-wide section's orphan", () => {
    const accepted = acceptAll(makeDirection());

    const cut = makeDirection();
    delete cut.brief.tone;

    const { acceptance } = applyDirectionShotCascade(cut, accepted, ["01"]);
    expect(acceptance!.parts["direction:brief.tone"]).toBeDefined();
    expect(isDirectionSpendGateSatisfied(cut, acceptance!)).toBe(false);
  });

  // The piece-wide agreements are not a shot's to settle — no shot's media speaks for the brief.
  it("settles nothing outside the accepted shot's arc", () => {
    const accepted = acceptAll(makeDirection());

    const edited = makeDirection();
    (edited.sequence.shots![0] as NarrativeShot).action = "she wakes with a start";
    edited.brief.logline = "a girl wakes and stays";

    const { acceptance } = applyDirectionShotCascade(edited, accepted, ["01"]);
    const view = directionAcceptanceView(edited, acceptance);
    expect(view.parts.get("direction:sequence.shots.01")).toBe("accepted");
    expect(view.parts.get("direction:brief.logline")).toBe("stale");
    expect(view.complete).toBe(false);
  });

  // The chain is the shot's own arc: its act, its act's act, up to the root — never a sibling act,
  // which the accepted shot is not in.
  it("walks the accepted shot's ancestor acts and no other", () => {
    const nested = nestedDirection();
    const accepted = acceptAll(nested);

    // Reordering act1's shots re-shapes act1 (its children list) and the root sequence, but leaves
    // act2 untouched. The reviewer watched that order play, so accepting a shot of it settles both.
    const reordered = nestedDirection();
    reordered.sequence.sequences![0]!.shots!.reverse();

    const { acceptance, restamped } = applyDirectionShotCascade(reordered, accepted, ["01"]);
    expect(restamped.sort()).toEqual(["direction:sequence", "direction:sequence.sequences.act1"]);
    expect(directionAcceptanceView(reordered, acceptance).complete).toBe(true);
    expect(acceptance!.parts["direction:sequence.sequences.act2"]).toEqual(
      accepted.parts["direction:sequence.sequences.act2"],
    );
  });

  it("is a no-op on a direction nobody has accepted yet", () => {
    const direction = makeDirection();
    expect(applyDirectionShotCascade(direction, null, ["01"])).toEqual({
      acceptance: null,
      restamped: [],
    });
  });
});

describe("directionCascadeReferenceIds", () => {
  it("takes the reference assets out of a set of accepted addresses, and nothing else", () => {
    expect(
      directionCascadeReferenceIds([
        "reference:alice",
        "reference:lantern",
        "video:shot.01.motion",
        "animatic:shot.02.first",
        "video:timeline.bgm",
        "not an address",
      ]),
    ).toEqual(new Set(["alice", "lantern"]));
  });
});

describe("applyDirectionReferenceCascade", () => {
  // The loop this exists for: a roster entry's prose reworded to match the image that was just
  // generated, signed off by accepting that image — without a second trip to the direction page.
  it("re-accepts a roster entry whose prose changed, for each roster", () => {
    const cases = [
      {
        id: "alice",
        address: "direction:characters.alice",
        edit: (d: Direction) => (d.characters.alice!.description = "a girl in blue"),
      },
      {
        id: "lantern",
        address: "direction:props.lantern",
        edit: (d: Direction) => (d.props!.lantern!.description = "a brass lantern, handled"),
      },
      {
        id: "bedroom",
        address: "direction:locations.bedroom",
        edit: (d: Direction) => (d.locations.bedroom!.description = "a dim bedroom"),
      },
    ];

    for (const { id, address, edit } of cases) {
      const accepted = acceptAll(makeDirection());

      const reworded = makeDirection();
      edit(reworded);
      expect(directionAcceptanceView(reworded, accepted).complete).toBe(false);

      const { acceptance, restamped } = applyDirectionReferenceCascade(reworded, accepted, [id]);
      expect(restamped).toEqual([address]);
      expect(directionAcceptanceView(reworded, acceptance!).complete).toBe(true);
    }
  });

  // R1 matters most here: the reference stage is exempt from the direction gate, so a fresh project
  // can generate and accept a character image before anyone has opened `konte preview direction`.
  // Without the guard that first read would arrive already stamped.
  it("never signs off an unread roster entry before the whole was accepted", () => {
    const partial = acceptAllButWaivers(makeDirection());

    const grown = makeDirection();
    grown.props!.key = { name: "the key", description: "a small iron key" };

    const { acceptance, restamped } = applyDirectionReferenceCascade(grown, partial, [
      "alice",
      "key",
    ]);
    expect(restamped).not.toContain("direction:props.key");
    expect(directionAcceptanceView(grown, acceptance!).parts.get("direction:props.key")).toBe(
      "unaccepted",
    );
  });

  it("signs off a roster entry added after the whole was accepted", () => {
    const accepted = acceptAll(makeDirection());

    const grown = makeDirection();
    grown.props!.key = { name: "the key", description: "a small iron key" };

    const { acceptance, restamped } = applyDirectionReferenceCascade(grown, accepted, ["key"]);
    expect(restamped).toContain("direction:props.key");
    expect(directionAcceptanceView(grown, acceptance!).parts.get("direction:props.key")).toBe(
      "accepted",
    );
  });

  // An unchanged entry was not re-decided by this review, so its `acceptedAt` must not move.
  // The sweep can be the ONLY thing a cascade changes, and callers decide whether to persist by
  // identity — `restamped` is empty here, so keying the write on its length would drop the sweep and
  // leave the orphan in state forever. (The shot cascade cannot show this: cutting anything re-shapes
  // the root arc, which it restamps.)
  it("returns a new record when it only swept", () => {
    const accepted = acceptAll(makeDirection());

    const cut = makeDirection();
    delete cut.props!.lantern;

    // Alice's own entry is untouched, so nothing is restamped — the cut prop's orphan is the diff.
    const { acceptance, restamped } = applyDirectionReferenceCascade(cut, accepted, ["alice"]);
    expect(restamped).toEqual([]);
    expect(acceptance).not.toBe(accepted);
    expect(acceptance!.parts["direction:props.lantern"]).toBeUndefined();
  });

  it("is a no-op when the accepted image's roster entry is unchanged", () => {
    const direction = makeDirection();
    const accepted = acceptAll(direction);

    const { acceptance, restamped } = applyDirectionReferenceCascade(direction, accepted, [
      "alice",
    ]);
    expect(restamped).toEqual([]);
    expect(acceptance).toBe(accepted);
  });

  // A reference asset that anchors no roster entry (a BGM bed) speaks for no part of the direction.
  it("settles nothing for a reference asset outside the rosters", () => {
    const accepted = acceptAll(makeDirection());

    const edited = makeDirection();
    edited.characters.alice!.description = "a girl in blue";

    const { restamped } = applyDirectionReferenceCascade(edited, accepted, ["bgm"]);
    expect(restamped).toEqual([]);
  });

  // The rosters are piece-wide; accepting one image says nothing about the brief or another entry.
  it("settles nothing outside the accepted image's own roster entry", () => {
    const accepted = acceptAll(makeDirection());

    const edited = makeDirection();
    edited.characters.alice!.description = "a girl in blue";
    edited.brief.logline = "a girl wakes and stays";
    edited.props!.lantern!.description = "a tin lantern";

    const { acceptance } = applyDirectionReferenceCascade(edited, accepted, ["alice"]);
    const view = directionAcceptanceView(edited, acceptance);
    expect(view.parts.get("direction:characters.alice")).toBe("accepted");
    expect(view.parts.get("direction:brief.logline")).toBe("stale");
    expect(view.parts.get("direction:props.lantern")).toBe("stale");
    expect(view.complete).toBe(false);
  });

  it("is a no-op on a direction nobody has accepted yet", () => {
    const direction = makeDirection();
    expect(applyDirectionReferenceCascade(direction, null, ["alice"])).toEqual({
      acceptance: null,
      restamped: [],
    });
  });
});

describe("cast voices", () => {
  // Every voice part routes to the Characters box, so the reviewer signs off on who is in the piece
  // and how they sound in one act — and no voice part is left with no Accept anywhere.
  function withVoices(): Direction {
    const d = makeDirection();
    d.characters.alice!.voice = { id: "aliceVoice", description: "bright, quick" };
    (d as { narrator?: unknown }).narrator = { id: "narratorVoice", description: "warm" };
    return d;
  }

  it("reviews every voice part in the characters section", () => {
    expect(directionSectionOf("direction:characters.alice.voice")).toBe("characters");
    expect(directionSectionOf("direction:narrator")).toBe("characters");
    for (const address of directionPartHashes(withVoices()).keys()) {
      expect(DIRECTION_SECTIONS).toContain(directionSectionOf(address));
    }
  });

  // Accepting a voice sample says nothing about the image, and vice versa: the two anchors restamp
  // two different parts.
  it("cascades a voice sample's accept onto its own part only", () => {
    const accepted = acceptAll(withVoices());

    const reworded = withVoices();
    reworded.characters.alice!.voice!.description = "gravelly";
    expect(directionAcceptanceView(reworded, accepted).complete).toBe(false);

    const noop = applyDirectionReferenceCascade(reworded, accepted, ["alice"]);
    expect(noop.restamped).toEqual([]);

    const { acceptance, restamped } = applyDirectionReferenceCascade(reworded, accepted, [
      "aliceVoice",
    ]);
    expect(restamped).toEqual(["direction:characters.alice.voice"]);
    expect(directionAcceptanceView(reworded, acceptance!).complete).toBe(true);
  });

  // One sample cast twice is one accept that settles both briefs — the whole point of letting the id
  // be shared instead of copying the audio to a second address.
  it("cascades a shared sample onto every part cast on it", () => {
    const shared = (): Direction => {
      const d = makeDirection();
      d.characters.alice!.voice = { id: "castVoice", description: "bright" };
      (d as { narrator?: unknown }).narrator = { id: "castVoice", description: "bright, older" };
      return d;
    };
    const accepted = acceptAll(shared());

    const reworded = shared();
    reworded.characters.alice!.voice!.description = "gravelly";
    (reworded as { narrator: { description: string } }).narrator.description = "gravelly, older";
    expect(directionAcceptanceView(reworded, accepted).complete).toBe(false);

    const { acceptance, restamped } = applyDirectionReferenceCascade(reworded, accepted, [
      "castVoice",
    ]);
    expect(restamped.sort()).toEqual(["direction:characters.alice.voice", "direction:narrator"]);
    expect(directionAcceptanceView(reworded, acceptance!).complete).toBe(true);
  });

  it("cascades the narrator's sample onto the narrator part", () => {
    const accepted = acceptAll(withVoices());
    const reworded = withVoices();
    (reworded as { narrator: { description: string } }).narrator.description = "clipped";

    const { restamped } = applyDirectionReferenceCascade(reworded, accepted, ["narratorVoice"]);
    expect(restamped).toEqual(["direction:narrator"]);
  });

  // Dropping a voice removes a key rather than changing one, so it re-blocks as an orphan — and only
  // the Characters box's own Accept can clear it.
  it("leaves a dropped voice as an orphan on the characters box", () => {
    const accepted = acceptAll(withVoices());
    const dropped = withVoices();
    dropped.characters.alice!.voice = undefined;

    const view = directionAcceptanceView(dropped, accepted);
    expect(view.complete).toBe(false);
    expect(view.sections.get("characters")).not.toBe("accepted");
    expect(view.sections.get("shots")).toBe("accepted");
  });
});
