import { describe, expect, it } from "vitest";
import {
  assertDuck,
  buildDuckEnvelope,
  bedVolumeLane,
  duckSettings,
  duckVolumeExpr,
  voiceTriggerSpan,
} from "../audio-duck.js";

const settings = duckSettings({ depth: 0.3, attack: 0.1, release: 0.5, hold: 0.2 })!;
const bed = { start: 10, end: 40 };

const envelope = (triggers: { start: number; end: number }[]) =>
  buildDuckEnvelope({ bed, triggers, settings });

describe("buildDuckEnvelope", () => {
  it("puts the dip in the bed's own time, not the timeline's", () => {
    expect(envelope([{ start: 15, end: 17 }])).toEqual([{ a: 4.9, b: 5, c: 7.2, d: 7.7 }]);
  });

  it("reads only the lines the bed actually plays under", () => {
    expect(
      envelope([
        { start: 2, end: 4 },
        { start: 45, end: 47 },
      ]),
    ).toEqual([]);
  });

  it("merges lines whose dips would meet — the bed never gets back up between them", () => {
    // 15–17 and 17.5–19: the gap is under release + attack, so it is one dip across both.
    expect(
      envelope([
        { start: 15, end: 17 },
        { start: 17.5, end: 19 },
      ]),
    ).toEqual([{ a: 4.9, b: 5, c: 9.2, d: 9.7 }]);
  });

  it("keeps two dips apart when the bed has time to come back", () => {
    expect(
      envelope([
        { start: 15, end: 17 },
        { start: 30, end: 31 },
      ]),
    ).toHaveLength(2);
  });

  // The property the hash rests on: a line moved inside a run changes no boundary, so nothing
  // downstream ages out over an edit nobody can hear.
  it("is unchanged by a line moving inside a run", () => {
    const before = envelope([
      { start: 15, end: 17 },
      { start: 17.2, end: 19 },
    ]);
    const after = envelope([
      { start: 15, end: 17 },
      { start: 17.4, end: 19 },
    ]);
    expect(after).toEqual(before);
  });
});

describe("voiceTriggerSpan", () => {
  it("ducks from where the take's sound starts, not from where the clip does", () => {
    expect(voiceTriggerSpan({ start: 10, end: 13, mediaStart: 0, leadInSec: 0.3 })).toEqual({
      start: 10.3,
      end: 13,
    });
  });

  it("leaves the placement alone when the take opens on sound", () => {
    expect(voiceTriggerSpan({ start: 10, end: 13, mediaStart: 0, leadInSec: 0 })).toEqual({
      start: 10,
      end: 13,
    });
  });

  it("spans the whole placement when the take was never measured", () => {
    expect(voiceTriggerSpan({ start: 10, end: 13, mediaStart: 0, leadInSec: undefined })).toEqual({
      start: 10,
      end: 13,
    });
  });

  it("trims only the lead-in the cue does not already skip", () => {
    expect(voiceTriggerSpan({ start: 10, end: 13, mediaStart: 0.2, leadInSec: 0.3 })).toEqual({
      start: 10.1,
      end: 13,
    });
  });

  it("never pushes the span back when mediaStart clears the whole lead-in", () => {
    expect(voiceTriggerSpan({ start: 10, end: 13, mediaStart: 0.5, leadInSec: 0.3 })).toEqual({
      start: 10,
      end: 13,
    });
  });

  it("ducks nothing for a take that never rises out of silence", () => {
    expect(voiceTriggerSpan({ start: 10, end: 13, mediaStart: 0, leadInSec: 3 })).toBeNull();
  });
});

describe("duckSettings", () => {
  it("takes the defaults for `true` and yields to nothing for `false`", () => {
    expect(duckSettings(true)).toEqual({ depth: 0.35, attack: 0.15, release: 0.4, hold: 0.2 });
    expect(duckSettings(false)).toBeNull();
  });

  it("refuses a zero-length ramp, which is a divide by zero in the filter", () => {
    expect(duckSettings({ attack: 0 })!.attack).toBeGreaterThan(0);
  });

  it("resolves an unauthored depth so the bed lands on the duck target, whatever its gain", () => {
    const loudness = { integratedLufs: -24, truePeakDb: -3 };
    const loud = duckSettings(true, { volume: 1, loudness })!;
    const quiet = duckSettings(true, { volume: 0.5, loudness })!;
    expect(-24 + 20 * Math.log10(loud.depth)).toBeCloseTo(-33, 6);
    expect(-24 + 20 * Math.log10(0.5 * quiet.depth)).toBeCloseTo(-33, 6);
  });

  it("does not duck a bed already at or under the target, rather than burying it twice", () => {
    expect(
      duckSettings(true, { volume: 0.1, loudness: { integratedLufs: -24, truePeakDb: -3 } }),
    ).toBeNull();
  });

  it("keeps an authored depth, and falls back to the ratio for an unmeasured take", () => {
    const loudness = { integratedLufs: -24, truePeakDb: -3 };
    expect(duckSettings({ depth: 0.8 }, { volume: 1, loudness })!.depth).toBe(0.8);
    expect(duckSettings(true, { volume: 1, loudness: undefined })!.depth).toBe(0.35);
  });
});

describe("duckVolumeExpr", () => {
  it("scales the bed's own volume and bottoms out at the depth", () => {
    const expr = duckVolumeExpr(0.4, [{ a: 1, b: 2, c: 4, d: 5 }], 0.25);
    expect(expr).toBe("0.4*(1-0.75*clip(min((t-1)/1,(5-t)/1),0,1))");
  });

  it("takes the deepest dip where two overlap", () => {
    const expr = duckVolumeExpr(
      1,
      [
        { a: 0, b: 1, c: 2, d: 3 },
        { a: 5, b: 6, c: 7, d: 8 },
      ],
      0.5,
    );
    expect(expr).toContain("max(");
  });
});

describe("bedVolumeLane", () => {
  const steps = buildDuckEnvelope({
    bed: { start: 0, end: 20 },
    triggers: [{ start: 5, end: 7 }],
    settings,
  });
  const lane = bedVolumeLane({ span: 20, volume: 0.4, steps, depth: settings.depth })!;
  const points = lane.lanes[0].points;

  it("draws the dip as breakpoints a player interpolates, in the bed's own time", () => {
    expect(lane.version).toBe(1);
    expect(lane.lanes[0].target).toBe("volume");
    expect(points).toEqual([
      { t: 0, v: 0.4 },
      { t: 4.9, v: 0.4 },
      { t: 5, v: 0.12 },
      { t: 7.2, v: 0.12 },
      { t: 7.7, v: 0.4 },
      { t: 20, v: 0.4 },
    ]);
  });

  it("stays inside the bed's span and never runs backwards", () => {
    expect(points[0]!.t).toBe(0);
    expect(points[points.length - 1]!.t).toBe(20);
    for (let i = 1; i < points.length; i++) expect(points[i]!.t).toBeGreaterThan(points[i - 1]!.t);
  });

  // ffmpeg evaluates its expression at t=0 like any other moment, so a bed whose first moments are
  // already part-way down must start there rather than at full.
  it("starts part-way down when a line opens over the bed's first moments", () => {
    const clipped = buildDuckEnvelope({
      bed: { start: 0, end: 20 },
      triggers: [{ start: 0.05, end: 2 }],
      settings,
    });
    const edge = bedVolumeLane({ span: 20, volume: 1, steps: clipped, depth: 0.3 })!;
    const first = edge.lanes[0].points[0]!;
    expect(first.t).toBe(0);
    expect(first.v).toBeLessThan(1);
    expect(first.v).toBeGreaterThan(0.3);
  });

  it("carries the declared fades, which the preview has no other reader for", () => {
    const faded = bedVolumeLane({
      span: 10,
      volume: 1,
      steps: [],
      depth: 1,
      fadeIn: 2,
      fadeOut: 4,
    })!;
    expect(faded.lanes[0].points).toEqual([
      { t: 0, v: 0 },
      { t: 2, v: 1 },
      { t: 6, v: 1 },
      { t: 10, v: 0 },
    ]);
  });

  it("is nothing at all for a bed with neither a duck nor a fade", () => {
    expect(bedVolumeLane({ span: 20, volume: 1, steps: [], depth: 1 })).toBeNull();
  });

  // A lane holds 512 points and a dip costs four, so a very talkative reel has to merge until it
  // fits — in the envelope, so the mux coarsens with it rather than the two parting.
  it("keeps a talkative reel inside the lane's ceiling", () => {
    const triggers = Array.from({ length: 400 }, (_, i) => ({ start: i * 3, end: i * 3 + 1 }));
    const many = buildDuckEnvelope({ bed: { start: 0, end: 1200 }, triggers, settings });
    expect(many.length).toBeLessThanOrEqual(120);
    // Only as far as the ceiling asks: widening the gap by doubling used to collapse a talkative
    // reel to a single dip, ducking it end to end.
    expect(many.length).toBeGreaterThan(100);
    const big = bedVolumeLane({ span: 1200, volume: 1, steps: many, depth: 0.3 })!;
    expect(big.lanes[0].points.length).toBeLessThanOrEqual(512);
  });
});

describe("assertDuck", () => {
  it("takes the shapes an author can mean", () => {
    expect(() => assertDuck(true, "bed")).not.toThrow();
    expect(() => assertDuck(false, "bed")).not.toThrow();
    expect(() => assertDuck({ depth: 0, attack: 0, hold: 0 }, "bed")).not.toThrow();
  });

  it("refuses a depth that would raise the bed under the line, or invert it", () => {
    expect(() => assertDuck({ depth: 1.5 }, "bed")).toThrow(/depth/);
    expect(() => assertDuck({ depth: -0.1 }, "bed")).toThrow(/depth/);
  });

  it("refuses a time that cannot be drawn", () => {
    expect(() => assertDuck({ attack: -1 }, "bed")).toThrow(/attack/);
    expect(() => assertDuck({ release: Number.NaN }, "bed")).toThrow(/release/);
    expect(() => assertDuck({ hold: Number.POSITIVE_INFINITY }, "bed")).toThrow(/hold/);
  });
});
