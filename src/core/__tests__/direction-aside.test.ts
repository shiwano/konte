import { describe, expect, it } from "vitest";
import { checkDirection, validateDirectionStructure } from "../direction.js";
import { directionPartHashes } from "../direction-hash.js";
import { directionPartContents } from "../direction-parts.js";
import type { AsideShot, Direction, NarrativeShot, Setup } from "../dsl/direction.js";

// A four-shot mini-drama with a title card between the first and second shots: the shape every case
// below varies. The arc must read as if the card were not there, and the coverage must not.
// Every shot is on one setup, so each boundary inside the run has to say what it is; the opening
// shot has no boundary before it, and a jump is legal at any of them (the card's included).
const shot = (id: string, role: string, duration = 3): NarrativeShot => ({
  id,
  role,
  action: `shot ${id}`,
  setup: "front",
  duration,
  lineup: [],
  ...(id === "01" ? {} : { join: "jump-forward" as const }),
});

const aside = (id: string, label: string, duration: number): AsideShot => ({
  kind: "aside",
  id,
  label,
  duration,
});

const setups: Record<string, Setup> = {
  front: {
    name: "the front",
    description: "head on",
    location: "here",
    framing: "medium",
    holds: ["hereMark"],
  },
};

function direction(shots: Array<NarrativeShot | AsideShot>): Direction {
  return {
    brief: { logline: "a cat wakes" },
    characters: {},
    locations: {
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
    },
    setups,
    policy: {
      format: { fps: 24, size: { megapixels: 0.52224, delivery: { width: 960, height: 544 } } },
      lang: "en",
      speech: "free",
    },
    sequence: { lens: "mini-drama", pleasure: "cute", shots },
  };
}

const narrative = [
  shot("01", "ordinary", 4),
  shot("02", "disruption", 3),
  shot("03", "pressure", 2),
  shot("04", "hero", 5),
];
const withCard = [narrative[0]!, aside("card", "title card", 60), ...narrative.slice(1)];

describe("an aside shot", () => {
  it("raises no arc finding of its own", () => {
    const { active } = checkDirection(direction(withCard));
    // `lens-role-mismatch` is what a role-less shot would earn if the arc engine saw it at all.
    expect(active.map((f) => f.code)).not.toContain("lens-role-mismatch");
    expect(active.map((f) => f.code)).not.toContain("empty-synopsis");
  });

  it("stays out of the pacing denominator", () => {
    // "ordinary" holds 4 of the 14 narrative seconds (29%), under its 40% budget. Counted with the
    // 60-second card it would be 4 of 74 — a different number, from a runtime the story never uses.
    const withoutCard = checkDirection(direction(narrative)).active.map((f) => f.code);
    const withIt = checkDirection(direction(withCard)).active.map((f) => f.code);
    expect(withIt).toEqual(withoutCard);
  });

  it("is still a shot the stage must realize", () => {
    const { active } = checkDirection(direction(withCard), {
      realizedIds: ["01", "02", "03", "04"],
      stage: "video",
    });
    const unrealized = active.filter((f) => f.code === "unrealized");
    expect(unrealized.map((f) => f.subject)).toEqual(["card"]);
  });

  it("keeps its place in the realized order", () => {
    const { active } = checkDirection(direction(withCard), {
      realizedIds: ["01", "card", "02", "03", "04"],
      stage: "video",
    });
    expect(active.map((f) => f.code)).not.toContain("unrealized");
    expect(active.map((f) => f.code)).not.toContain("stage-order-mismatch");
  });

  it("is rejected with an empty label", () => {
    const codes = validateDirectionStructure(
      direction([narrative[0]!, aside("card", "  ", 5), ...narrative.slice(1)]),
    ).map((e) => e.code);
    expect(codes).toContain("aside-empty-label");
  });

  it("has its telop checked like any other shot's", () => {
    const codes = validateDirectionStructure(
      direction([
        narrative[0]!,
        { ...aside("card", "title card", 5), telop: ["  "] },
        ...narrative.slice(1),
      ]),
    ).map((e) => e.code);
    expect(codes).toContain("telop-empty-text");
  });

  it("shares the id namespace with the shots", () => {
    const codes = validateDirectionStructure(
      direction([narrative[0]!, aside("01", "title card", 5), ...narrative.slice(1)]),
    ).map((e) => e.code);
    expect(codes).toContain("duplicate-id");
  });

  it("owes a review part of its own", () => {
    const hashes = directionPartHashes(direction(withCard));
    expect(hashes.has("direction:sequence.shots.card")).toBe(true);
    const contents = directionPartContents(direction(withCard));
    expect(contents.get("direction:sequence.shots.card")).toMatchObject({
      kind: "aside",
      label: "title card",
      duration: 60,
    });
  });

  it("re-blocks the shot and the arc's own part when a boundary is rewritten", () => {
    // `join` rides in the SHAPE, so it moves the root `sequence` hash as well as the shot's own.
    const before = directionPartHashes(direction(withCard));
    const after = directionPartHashes(
      direction(
        withCard.map((s) =>
          s.id === "03" ? { ...(s as NarrativeShot), join: "jump-back" as const } : s,
        ),
      ),
    );
    expect(after.get("direction:sequence.shots.03")).not.toBe(
      before.get("direction:sequence.shots.03"),
    );
    expect(after.get("direction:sequence")).not.toBe(before.get("direction:sequence"));
    expect(after.get("direction:sequence.shots.04")).toBe(
      before.get("direction:sequence.shots.04"),
    );
  });

  it("ages out when its label is rewritten", () => {
    const before = directionPartHashes(direction(withCard));
    const after = directionPartHashes(
      direction([narrative[0]!, aside("card", "end card", 60), ...narrative.slice(1)]),
    );
    expect(after.get("direction:sequence.shots.card")).not.toBe(
      before.get("direction:sequence.shots.card"),
    );
    // …and nothing else moves with it.
    expect(after.get("direction:sequence.shots.01")).toBe(
      before.get("direction:sequence.shots.01"),
    );
  });
});
