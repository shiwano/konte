import { describe, expect, it } from "vitest";
import { BUILTIN_LENSES, findBuiltinLens } from "../lenses.js";
import {
  type ArcItem,
  type DirectionFindingCode,
  type LensSpec,
  checkArc,
} from "../direction-check.js";

const miniDrama = findBuiltinLens("mini-drama")!;
const comedy = findBuiltinLens("comedy")!;
const transformation = findBuiltinLens("transformation")!;
const productDemo = findBuiltinLens("product-demo")!;
const threeAct = findBuiltinLens("three-act")!;
const kishotenketsu = findBuiltinLens("kishotenketsu")!;

function shot(
  id: string,
  role: string,
  duration: number,
  synopsis = "act",
  framing?: string,
): ArcItem<string> {
  return { id, role, synopsis, duration, ...(framing ? { framing } : {}) };
}

function seq(id: string, role: string, duration: number, synopsis = "act"): ArcItem<string> {
  return { id, role, synopsis, duration };
}

function codes(items: ArcItem<string>[], realizedIds?: string[]): DirectionFindingCode[] {
  return checkArc(miniDrama, items, { realizedIds }).map((f) => f.code);
}

describe("checkArc", () => {
  it("passes a complete mini-drama (release is optional)", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
      shot("04", "hero", 4),
    ];
    expect(checkArc(miniDrama, items)).toEqual([]);
  });

  it("flags a missing required beat", () => {
    const items = [shot("01", "ordinary", 3), shot("03", "pressure", 3), shot("04", "hero", 4)];
    const finding = checkArc(miniDrama, items).find((f) => f.code === "missing-beat");
    expect(finding?.subject).toBe("disruption");
  });

  it("flags a missing payoff", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
    ];
    expect(codes(items)).toContain("no-payoff");
  });

  it("flags beats out of order", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "hero", 4),
      shot("04", "pressure", 3),
    ];
    const finding = checkArc(miniDrama, items).find((f) => f.code === "beat-out-of-order");
    expect(finding?.subject).toBe("hero");
  });

  it("flags a role outside the lens (membership)", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
      shot("04", "hero", 4),
      shot("08", "button", 2),
    ];
    const finding = checkArc(miniDrama, items).find((f) => f.code === "lens-role-mismatch");
    expect(finding?.subject).toBe("08");
  });

  it("flags too many consecutive of one role", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
      shot("04", "pressure", 3),
      shot("05", "pressure", 3),
      shot("06", "pressure", 3),
      shot("07", "hero", 4),
    ];
    const finding = checkArc(miniDrama, items).find((f) => f.code === "too-many-consecutive");
    expect(finding?.subject).toBe("pressure");
    expect(finding?.message).toContain("4 consecutive");
  });

  it("flags a building beat that lands only once (too-few-consecutive)", () => {
    // transformation's process must build across a run of ≥2; a single process shot is hollow.
    const items = [shot("01", "before", 3), shot("02", "process", 2), shot("03", "reveal", 4)];
    const finding = checkArc(transformation, items).find((f) => f.code === "too-few-consecutive");
    expect(finding?.subject).toBe("process");
  });

  it("clears too-few-consecutive once the beat repeats", () => {
    const items = [
      shot("01", "before", 3),
      shot("02", "process", 2),
      shot("03", "process", 2),
      shot("04", "reveal", 4),
    ];
    expect(checkArc(transformation, items).map((f) => f.code)).not.toContain("too-few-consecutive");
  });

  it("passes a comedy with no escalation (escalation is optional)", () => {
    const items = [shot("01", "setup", 2), shot("02", "violation", 1), shot("03", "button", 2)];
    expect(checkArc(comedy, items)).toEqual([]);
  });

  it("passes a complete transformation (after-glow is optional)", () => {
    const items = [
      shot("01", "before", 3),
      shot("02", "process", 2),
      shot("03", "process", 2),
      shot("04", "reveal", 4),
    ];
    expect(checkArc(transformation, items)).toEqual([]);
  });

  it("passes a complete product-demo (call-to-action is optional)", () => {
    const items = [
      shot("01", "problem", 2),
      shot("02", "solution", 3),
      shot("03", "demonstration", 4),
      shot("04", "result", 3),
    ];
    expect(checkArc(productDemo, items)).toEqual([]);
  });

  it("flags an empty synopsis", () => {
    const items = [
      shot("01", "ordinary", 3, ""),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
      shot("04", "hero", 4),
    ];
    const finding = checkArc(miniDrama, items).find((f) => f.code === "empty-synopsis");
    expect(finding?.subject).toBe("01");
  });

  // The space checks read the caller's framing vocabulary; these mirror what direction.ts passes.
  const space = { exposedFramings: ["wide", "medium"], establishingFraming: "wide" };

  it("flags an undeclared wide↔medium cut inside one location", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "disruption", 2, "shot", "medium"), location: "deck" },
      { ...shot("03", "pressure", 3, "shot", "close"), location: "deck" },
      { ...shot("04", "hero", 4, "shot", "insert"), location: "deck" },
    ];
    const finding = checkArc(miniDrama, items, space).find(
      (f) => f.code === "undeclared-continuity",
    );
    expect(finding?.subject).toBe("01-02");
  });

  it("does not flag a two-size jump or a cross-location cut", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "disruption", 2, "shot", "close"), location: "deck" },
      { ...shot("03", "pressure", 3, "shot", "wide"), location: "galley" },
      { ...shot("04", "hero", 4, "shot", "medium"), location: "deck" },
    ];
    expect(checkArc(miniDrama, items, space).map((f) => f.code)).not.toContain(
      "undeclared-continuity",
    );
  });

  it("flags a second wide of one location inside a role (re-established-wide)", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "ordinary", 2, "shot", "close"), location: "deck" },
      { ...shot("03", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("04", "disruption", 2, "shot", "close"), location: "deck" },
      { ...shot("05", "pressure", 3, "shot", "close"), location: "deck" },
      { ...shot("06", "hero", 4, "shot", "insert"), location: "deck" },
    ];
    const finding = checkArc(miniDrama, items, space).find((f) => f.code === "re-established-wide");
    expect(finding?.subject).toBe("03");
  });

  it("flags every repeat wide in one role, not just the second", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "ordinary", 2, "shot", "wide"), location: "deck" },
      { ...shot("03", "ordinary", 3, "shot", "close"), location: "deck" },
      { ...shot("04", "ordinary", 4, "shot", "wide"), location: "deck" },
      { ...shot("05", "disruption", 2, "shot", "close"), location: "deck" },
      { ...shot("06", "pressure", 3, "shot", "close"), location: "deck" },
      { ...shot("07", "hero", 4, "shot", "insert"), location: "deck" },
    ];
    const subjects = checkArc(miniDrama, items, space)
      .filter((f) => f.code === "re-established-wide")
      .map((f) => f.subject);
    expect(subjects).toEqual(["02", "04"]);
  });

  it("does not flag a wide that runs on continuously from the wide before it", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "ordinary", 2, "shot", "wide"), location: "deck", join: "continuous" },
      { ...shot("03", "disruption", 3, "shot", "close"), location: "deck" },
      { ...shot("04", "pressure", 3, "shot", "close"), location: "deck" },
      { ...shot("05", "hero", 4, "shot", "insert"), location: "deck" },
    ];
    expect(checkArc(miniDrama, items, space).map((f) => f.code)).not.toContain(
      "re-established-wide",
    );
  });

  it("does not flag a wide re-established after a role change (act break)", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "disruption", 2, "shot", "close"), location: "deck" },
      { ...shot("03", "pressure", 3, "shot", "close"), location: "deck" },
      { ...shot("04", "hero", 4, "shot", "wide"), location: "deck" },
    ];
    expect(checkArc(miniDrama, items, space).map((f) => f.code)).not.toContain(
      "re-established-wide",
    );
  });

  it("does not flag a first wide per location, and skips both checks without the vocabulary", () => {
    const items = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "disruption", 2, "shot", "wide"), location: "galley" },
      { ...shot("03", "pressure", 3, "shot", "medium"), location: "deck" },
      { ...shot("04", "hero", 4, "shot", "close"), location: "deck" },
    ];
    expect(checkArc(miniDrama, items, space).map((f) => f.code)).not.toContain(
      "re-established-wide",
    );
    const bare = [
      { ...shot("01", "ordinary", 3, "shot", "wide"), location: "deck" },
      { ...shot("02", "disruption", 2, "shot", "medium"), location: "deck" },
      { ...shot("03", "pressure", 3, "shot", "wide"), location: "deck" },
      { ...shot("04", "hero", 4, "shot", "close"), location: "deck" },
    ];
    const codes = checkArc(miniDrama, bare).map((f) => f.code);
    expect(codes).not.toContain("undeclared-continuity");
    expect(codes).not.toContain("re-established-wide");
  });

  it("flags unrealized direction ids against a stage's realized set", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
      shot("04", "hero", 4),
    ];
    const finding = checkArc(miniDrama, items, { realizedIds: ["01", "02", "04"] }).find(
      (f) => f.code === "unrealized",
    );
    expect(finding?.subject).toBe("03");
  });

  it("flags a stage order that differs from the direction order", () => {
    const items = [
      shot("01", "ordinary", 3),
      shot("02", "disruption", 2),
      shot("03", "pressure", 3),
      shot("04", "hero", 4),
    ];
    expect(
      checkArc(miniDrama, items, { realizedIds: ["02", "01", "03", "04"] }).map((f) => f.code),
    ).toContain("stage-order-mismatch");
  });
});

describe("checkArc at the sequence scale (meta arc)", () => {
  it("weaves the noun into messages so a sequence arc reads as one", () => {
    const items = [seq("act1", "setup-act", 10), seq("act3", "climax-act", 10)];
    const finding = checkArc(threeAct, items, { noun: "sequence" }).find(
      (f) => f.code === "missing-beat",
    );
    expect(finding?.message).toContain("confrontation-act sequence");
    expect(finding?.message).not.toContain("shot");
  });

  it("passes a balanced three-act", () => {
    const items = [
      seq("act1", "setup-act", 25),
      seq("act2", "confrontation-act", 50),
      seq("act3", "climax-act", 25),
    ];
    expect(checkArc(threeAct, items, { noun: "sequence" })).toEqual([]);
  });

  // The lens catalog claims the split is advisory: the checker runs the same rules at either scale.
  // A four-part shape authored over acts has to pass exactly as it does over shots.
  it("passes a kishotenketsu over acts, as it does over shots", () => {
    const parts: Array<[string, number]> = [
      ["ki", 4],
      ["sho", 6],
      ["ten", 3],
      ["ketsu", 5],
    ];
    const overActs = parts.map(([role, d], i) => seq(`act${i}`, role, d * 3));
    const overShots = parts.map(([role, d], i) => shot(`0${i}`, role, d));
    expect(checkArc(kishotenketsu, overActs, { noun: "sequence" })).toEqual([]);
    expect(checkArc(kishotenketsu, overShots)).toEqual([]);
  });
});

// The registry is only trustworthy if every lens in it obeys the rules the engine checks other
// people's lenses against — `validateDirectionStructure` raises `payoff-function-mismatch` on a
// custom lens whose declared climax is not a `fn: "payoff"` beat, so a built-in must never trip it.
describe("the built-in lens catalog", () => {
  it.each(BUILTIN_LENSES.map((l) => [l.name, l] as const))(
    "%s declares a payoff beat that performs the payoff function",
    (_name, lens) => {
      const payoffBeat = lens.beats.find((b) => b.role === lens.payoff);
      expect(payoffBeat).toBeDefined();
      expect(payoffBeat?.fn).toBe("payoff");
    },
  );

  it.each(BUILTIN_LENSES.map((l) => [l.name, l] as const))(
    "%s earns its payoff — something grounds, turns, or builds before it",
    (_name, lens) => {
      const before = lens.beats.slice(
        0,
        lens.beats.findIndex((b) => b.role === lens.payoff),
      );
      expect(before.some((b) => b.fn === "ground" || b.fn === "turn" || b.fn === "build")).toBe(
        true,
      );
    },
  );

  it.each(BUILTIN_LENSES.map((l) => [l.name, l] as const))(
    "%s declares a function on every beat — a lens of container beats is a lens with no rules",
    (_name, lens) => {
      expect(lens.beats.filter((b) => b.fn === undefined)).toEqual([]);
    },
  );
});

describe("checkArc act-ratio pacing (share)", () => {
  it("flags a payoff act below its minShare", () => {
    const items = [
      seq("act1", "setup-act", 10),
      seq("act2", "confrontation-act", 40),
      seq("act3", "climax-act", 6), // 6 / 56 ≈ 11% < 15%
    ];
    const finding = checkArc(threeAct, items, { noun: "sequence" }).find(
      (f) => f.code === "beat-underweight",
    );
    expect(finding?.subject).toBe("climax-act");
  });

  it("flags a setup act above its maxShare", () => {
    const items = [
      seq("act1", "setup-act", 50), // 50 / 100 = 50% > 40%
      seq("act2", "confrontation-act", 30),
      seq("act3", "climax-act", 20),
    ];
    const finding = checkArc(threeAct, items, { noun: "sequence" }).find(
      (f) => f.code === "beat-overweight",
    );
    expect(finding?.subject).toBe("setup-act");
  });

  it("sums a role's items before comparing its share", () => {
    // Two setup shots (2s + 2s) exceed a 40% budget together though neither does alone.
    const lens: LensSpec<string> = {
      name: "l",
      payoff: "hero",
      beats: [{ role: "setup", maxShare: 0.4 }],
    };
    const items = [shot("01", "setup", 2), shot("02", "setup", 2), shot("03", "hero", 1)];
    const finding = checkArc(lens, items).find((f) => f.code === "beat-overweight");
    expect(finding?.subject).toBe("setup");
  });
});

describe("checkArc function checks (per-lens beat fn)", () => {
  const soundItems = [
    shot("01", "ordinary", 3),
    shot("02", "disruption", 2),
    shot("03", "pressure", 3),
    shot("04", "hero", 4),
  ];

  it("passes a sound arc", () => {
    expect(checkArc(miniDrama, soundItems)).toEqual([]);
  });

  it("flags a payoff nothing grounded or built toward (one-beat lens)", () => {
    const hollow: LensSpec<string> = {
      name: "hollow",
      payoff: "peak",
      beats: [{ role: "peak", fn: "payoff" }],
    };
    const items = [shot("01", "peak", 3)];
    const finding = checkArc(hollow, items).find((f) => f.code === "unearned-payoff");
    expect(finding?.subject).toBe("peak");
  });

  it("accepts a payoff earned by any grounding, turning, or building item", () => {
    const twoBeat: LensSpec<string> = {
      name: "two-beat",
      payoff: "peak",
      beats: [
        { role: "atmosphere", fn: "ground" },
        { role: "peak", fn: "payoff" },
      ],
    };
    const items = [shot("01", "atmosphere", 3), shot("02", "peak", 4)];
    expect(checkArc(twoBeat, items).find((f) => f.code === "unearned-payoff")).toBeUndefined();
  });

  it("exempts a container beat with no fn", () => {
    const container: LensSpec<string> = {
      name: "one-act",
      payoff: "whole",
      beats: [{ role: "whole" }],
    };
    const items = [seq("act1", "whole", 20)];
    expect(checkArc(container, items, { noun: "sequence" })).toEqual([]);
  });

  it("runs no payoff check when the payoff beat declares no fn", () => {
    const hollow: LensSpec<string> = {
      name: "hollow",
      payoff: "peak",
      beats: [{ role: "peak" }],
    };
    expect(checkArc(hollow, [shot("01", "peak", 3)])).toEqual([]);
  });
});
