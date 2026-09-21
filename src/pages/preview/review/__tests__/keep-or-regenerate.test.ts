import { describe, expect, it } from "vitest";
import type { KeepGraphInfo } from "../../types.js";
import {
  keepDecisions,
  keepPrompt,
  keepPromptFor,
  keepingUnit,
  regenerateByUnit,
  regenerateDecisions,
  regenerateSummary,
  withoutUnits,
  type KeepChoice,
  type KeepContext,
  type KeepDecision,
  type KeepTarget,
} from "../keep-or-regenerate.js";

// Board shots 12 → 13 → 14 chained by the previous panel, a video shot built on 13, and a video shot built on
// a deterministic resize of 12. A background sheet under 13 and the video shot built on it, and a
// video shot built on that one and the sheet. Every take accepted; each consumer made from its
// upstream's `a` take.
const P12 = "animatic:shot.12.first";
const SMALL12 = "animatic:shot.12.small";
const P13 = "animatic:shot.13.first";
const P14 = "animatic:shot.14.first";
const M12 = "video:shot.12.motion";
const M13 = "video:shot.13.motion";
const M14 = "video:shot.14.motion";
const BG = "reference:bg";

function graph(): KeepGraphInfo {
  const take = (outputHash: string, inputs: Record<string, string[]> = {}) => ({
    outputHash,
    inputs,
  });
  const at = (
    unit: string,
    acceptedVariantId: string,
    takes: KeepGraphInfo["addresses"][string]["takes"],
    consumers: KeepGraphInfo["addresses"][string]["consumers"] = [],
  ) => ({ unit, rerollable: true, acceptedVariantId, takes, consumers });
  return {
    units: {
      "animatic:shot.12": { stage: "animatic", label: "Shot 12" },
      "animatic:shot.13": { stage: "animatic", label: "Shot 13" },
      "animatic:shot.14": { stage: "animatic", label: "Shot 14" },
      "video:shot.12": { stage: "video", label: "Shot 12" },
      "video:shot.13": { stage: "video", label: "Shot 13" },
      "video:shot.14": { stage: "video", label: "Shot 14" },
      [BG]: { stage: "reference", label: "bg" },
    },
    addresses: {
      [P12]: at("animatic:shot.12", "v12a", { v12a: take("h12a"), v12b: take("h12b") }, [
        { address: P13, via: P12 },
        { address: M12, via: SMALL12 },
      ]),
      [P13]: at(
        "animatic:shot.13",
        "v13a",
        { v13a: take("h13a", { [P12]: ["h12a"], [BG]: ["hbga"] }) },
        [
          { address: P14, via: P13 },
          { address: M13, via: P13 },
        ],
      ),
      [P14]: at("animatic:shot.14", "v14a", { v14a: take("h14a", { [P13]: ["h13a"] }) }),
      [M12]: at("video:shot.12", "vm12", { vm12: take("hm12", { [SMALL12]: ["hs12a"] }) }),
      [M13]: at(
        "video:shot.13",
        "vm13",
        { vm13: take("hm13", { [P13]: ["h13a"], [BG]: ["hbga"] }) },
        [{ address: M14, via: M13 }],
      ),
      [M14]: at("video:shot.14", "vm14", {
        vm14: take("hm14", { [M13]: ["hm13"], [BG]: ["hbga"] }),
      }),
      [BG]: at(BG, "bga", { bga: take("hbga"), bgb: take("hbgb") }, [
        { address: P13, via: BG },
        { address: M13, via: BG },
        { address: M14, via: BG },
      ]),
    },
  };
}

function ctx(overrides: Partial<KeepContext> = {}): KeepContext {
  const g = overrides.graph ?? graph();
  return {
    graph: g,
    takeAccepted: (address) => g.addresses[address]?.acceptedVariantId != null,
    takeOf: (address) => g.addresses[address]?.acceptedVariantId ?? null,
    choices: [],
    ...overrides,
  };
}

const moveP12 = [{ unit: "animatic:shot.12", chosen: { [P12]: "v12b" } }];
const moveBg = [{ unit: BG, chosen: { [BG]: "bgb" } }];
const via12 = `via:${P12}=h12b`;

const row = (
  unit: string,
  takes: KeepTarget["takes"],
  o: Partial<Omit<KeepTarget, "unit" | "takes">> = {},
): KeepTarget => ({ unit, takes, decision: "keep", follows: [], madeFrom: [], ...o });

const choice = (o: Partial<KeepChoice> & Pick<KeepChoice, "origin">): KeepChoice => ({
  seq: 1,
  targets: [],
  keep: {},
  ...o,
});

// The prompt's entries answered per row, as the modal answers them.
const answered = (
  entries: ReturnType<typeof keepPromptFor>,
  decisions: Record<string, KeepDecision>,
  seq = 1,
): KeepChoice[] =>
  entries.map((entry) => ({
    ...entry,
    seq,
    targets: entry.targets.map((t) => ({ ...t, decision: decisions[t.unit] ?? "keep" })),
  }));

const T13 = { address: P13, variantId: "v13a" };
const T14 = { address: P14, variantId: "v14a" };

describe("keepPromptFor", () => {
  it("asks one row per accepted unit made straight from what the accept changes, with what follows it", () => {
    const [entry] = keepPromptFor(ctx(), moveP12);
    expect(entry?.targets).toEqual([
      row("animatic:shot.13", [T13], { follows: [{ unit: "animatic:shot.14", takes: [T14] }] }),
      row("video:shot.12", [{ address: M12, variantId: "vm12" }]),
    ]);
    expect(entry?.keep[P13]).toEqual({
      address: P13,
      variantId: "v13a",
      inputs: { [P12]: "h12b" },
    });
  });

  it("makes a unit in another stage its own row, made from the row upstream of it, not a follow", () => {
    const [entry] = keepPromptFor(ctx(), moveBg);
    expect(entry?.targets).toEqual([
      row("animatic:shot.13", [T13], { follows: [{ unit: "animatic:shot.14", takes: [T14] }] }),
      row("video:shot.13", [{ address: M13, variantId: "vm13" }], {
        madeFrom: ["animatic:shot.13"],
      }),
      row("video:shot.14", [{ address: M14, variantId: "vm14" }], { madeFrom: ["video:shot.13"] }),
    ]);
  });

  it("regenerates a row with its follows and keeps the rest, each row on its own answer", () => {
    const entries = keepPromptFor(ctx(), moveBg);
    const one = answered(entries, { "animatic:shot.13": "regenerate" });
    expect(regenerateDecisions(one).map((t) => t.address)).toEqual([P13, P14]);
    expect(keepDecisions(one)).toEqual([
      { address: M13, variantId: "vm13", inputs: { [BG]: "hbgb" } },
      { address: M14, variantId: "vm14", inputs: { [BG]: "hbgb" } },
    ]);
    const two = answered(entries, {
      "animatic:shot.13": "regenerate",
      "video:shot.13": "regenerate",
    });
    expect(regenerateDecisions(two).map((t) => t.address)).toEqual([P13, P14, M13]);
    expect(keepDecisions(two).map((e) => e.address)).toEqual([M14]);
  });

  it("asks about a stale unit whose upstream is not accepted, with no row to hang it on", () => {
    const [entry] = keepPromptFor(ctx({ takeAccepted: (a) => a !== P13 && a !== P14 }), moveBg);
    expect(entry?.targets.map((t) => [t.unit, t.madeFrom])).toEqual([
      ["video:shot.13", []],
      ["video:shot.14", ["video:shot.13"]],
    ]);
  });

  it("sees through a take konte re-makes, keeping against the upstream it is re-made from", () => {
    const [entry] = keepPromptFor(ctx(), moveP12);
    expect(entry?.keep[M12]).toEqual({
      address: M12,
      variantId: "vm12",
      inputs: { [SMALL12]: via12 },
    });
  });

  it("asks nothing for a re-accept of the same take", () => {
    expect(keepPromptFor(ctx(), [{ unit: "animatic:shot.12", chosen: { [P12]: "v12a" } }])).toEqual(
      [],
    );
  });

  it("names no follow that is not accepted, and asks nothing when no row is", () => {
    const [entry] = keepPromptFor(ctx({ takeAccepted: (a) => a !== P14 }), moveP12);
    expect(entry?.targets[0]?.follows).toEqual([]);
    expect(keepPromptFor(ctx({ takeAccepted: (a) => a !== P13 && a !== M12 }), moveP12)).toEqual(
      [],
    );
  });

  it("asks about a change to a take no reroll makes, like a file", () => {
    const g = graph();
    g.addresses[P12]!.rerollable = false;
    expect(keepPromptFor(ctx({ graph: g }), moveP12)).toHaveLength(1);
  });

  it("does not ask again about a row a Keep already settled against the same take", () => {
    const kept = answered(keepPromptFor(ctx(), moveP12), {});
    expect(keepPromptFor(ctx({ choices: kept }), moveP12)).toEqual([]);
  });

  it("does not ask about a take already kept against that upstream", () => {
    const g = graph();
    g.addresses[P13]!.takes.v13a!.inputs[P12] = ["h12a", "h12b"];
    g.addresses[M12]!.takes.vm12!.inputs[SMALL12] = ["hs12a", via12];
    expect(keepPromptFor(ctx({ graph: g }), moveP12)).toEqual([]);
  });
});

describe("standing answers", () => {
  const follow14 = { unit: "animatic:shot.14", takes: [T14] };
  const keepP13 = (inputs: Record<string, string>) => ({
    [P13]: { address: P13, variantId: "v13a", inputs },
  });

  it("marks a follow as regenerating with its row, and keeps it when the row is kept after all", () => {
    const choices = [
      choice({
        origin: "animatic:shot.12",
        targets: [row("animatic:shot.13", [T13], { decision: "regenerate", follows: [follow14] })],
      }),
    ];
    expect(regenerateByUnit(choices)).toEqual(
      new Map([
        ["animatic:shot.13", { takes: [T13], origin: "animatic:shot.12", follows: null }],
        [
          "animatic:shot.14",
          { takes: [T14], origin: "animatic:shot.12", follows: "animatic:shot.13" },
        ],
      ]),
    );
    expect(regenerateByUnit(keepingUnit(choices, "animatic:shot.13")).size).toBe(0);
  });

  it("takes the last answer given for a unit asked about twice", () => {
    const regenerate = choice({
      seq: 1,
      origin: "animatic:shot.12",
      targets: [row("animatic:shot.13", [T13], { decision: "regenerate" })],
    });
    const keep = choice({
      seq: 2,
      origin: "reference:bg",
      targets: [row("animatic:shot.13", [T13])],
      keep: keepP13({ "reference:bg": "hbg" }),
    });
    expect(regenerateDecisions([regenerate, keep])).toEqual([]);
    expect(keepDecisions([regenerate, keep])).toEqual([
      { address: P13, variantId: "v13a", inputs: { "reference:bg": "hbg" } },
    ]);
    expect(regenerateDecisions([keep, { ...regenerate, seq: 3 }])).toEqual([T13]);
  });

  it("merges the upstreams of every Keep standing for a take", () => {
    const choices = [
      choice({
        seq: 1,
        origin: "animatic:shot.12",
        targets: [row("animatic:shot.13", [T13])],
        keep: keepP13({ [P12]: "h12b", x: "via:a=1" }),
      }),
      choice({
        seq: 2,
        origin: "reference:bg",
        targets: [row("animatic:shot.13", [T13])],
        keep: keepP13({ "reference:bg": "hbg", x: "via:b=2" }),
      }),
    ];
    expect(keepDecisions(choices)[0]?.inputs).toEqual({
      [P12]: "h12b",
      "reference:bg": "hbg",
      x: "via:a=1,b=2",
    });
  });

  it("drops every answer about a unit decided again directly, whoever asked it", () => {
    const choices = [
      choice({
        origin: "animatic:shot.12",
        targets: [row("animatic:shot.13", [T13], { decision: "regenerate", follows: [follow14] })],
      }),
    ];
    const left = withoutUnits(choices, ["animatic:shot.14"]);
    expect(regenerateDecisions(left).map((t) => t.address)).toEqual([P13]);
    expect(withoutUnits(choices, ["animatic:shot.13"])).toEqual([]);
    expect(withoutUnits(choices, ["animatic:shot.12"])).toEqual([]);
  });
});

describe("what the prompt and the submit dialog show", () => {
  it("lists the rows per stage in pipeline order, naming another stage's unit by its stage", () => {
    expect(keepPrompt(graph(), keepPromptFor(ctx(), moveP12), "animatic")).toEqual({
      origins: ["Shot 12"],
      stages: [
        {
          stage: "animatic",
          rows: [
            {
              unit: "animatic:shot.13",
              label: "Shot 13",
              takes: ["first"],
              follows: ["Shot 14"],
              madeFrom: [],
            },
          ],
        },
        {
          stage: "video",
          rows: [
            {
              unit: "video:shot.12",
              label: "Shot 12",
              takes: ["motion"],
              follows: [],
              madeFrom: [],
            },
          ],
        },
      ],
    });
    const { origins, stages } = keepPrompt(graph(), keepPromptFor(ctx(), moveBg), "reference");
    expect(origins).toEqual(["bg"]);
    expect(stages[1]?.rows[0]?.madeFrom).toEqual([
      { unit: "animatic:shot.13", label: "Shot 13 (animatic)", stage: "animatic" },
    ]);
  });

  it("summarizes a Regenerate as its row with its follows under it", () => {
    const choices = answered(keepPromptFor(ctx(), moveP12), { "animatic:shot.13": "regenerate" });
    expect(regenerateSummary(graph(), choices, "animatic")).toEqual([
      { label: "Shot 13", takes: ["first"], with: [{ label: "Shot 14", takes: ["first"] }] },
    ]);
  });
});
