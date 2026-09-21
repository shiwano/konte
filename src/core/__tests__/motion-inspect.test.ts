import { describe, expect, it } from "vitest";
import {
  displacementEnergy,
  displacementStride,
  frameCoherence,
  resolveDecodeFps,
  summarizeMotion,
} from "../motion-inspect.js";

describe("resolveDecodeFps", () => {
  it("defaults to min(nativeFps, 30), rounded", () => {
    expect(resolveDecodeFps(23.976)).toBe(24);
    expect(resolveDecodeFps(60)).toBe(30);
    expect(resolveDecodeFps(12)).toBe(12);
  });

  it("'native' uses the source rate (rounded)", () => {
    expect(resolveDecodeFps(23.976, "native")).toBe(24);
    expect(resolveDecodeFps(60, "native")).toBe(60);
  });

  it("a numeric override wins, rounded", () => {
    expect(resolveDecodeFps(24, 60)).toBe(60);
    expect(resolveDecodeFps(24, 12)).toBe(12);
  });
});

describe("summarizeMotion", () => {
  it("returns an empty summary for no samples", () => {
    const s = summarizeMotion([], [], [], 24);
    expect(s.samples).toBe(0);
    expect(s.mean).toBe(0);
    expect(s.peak).toEqual({ time: 0, value: 0 });
    expect(s.magnitude).toEqual({ time: 0, value: 0 });
    expect(s.displacementWindowSec).toBe(0);
    expect(s.segments).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it("finds the coherent peak, mean, and active/still segments", () => {
    const fps = 10;
    const series = [...Array(10).fill(0.01), ...Array(10).fill(0.5), ...Array(10).fill(0.01)];
    const s = summarizeMotion(series, series, series, fps);

    expect(s.peak.value).toBeCloseTo(0.5, 5);
    expect(s.peak.time).toBeCloseTo(1.05, 5); // first sample of the burst, (10+0.5)/10
    expect(s.mean).toBeCloseTo(0.173, 2);

    const active = s.segments.filter((seg) => seg.type === "active");
    const still = s.segments.filter((seg) => seg.type === "still");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ start: 1.05, end: 1.95 });
    expect(still).toHaveLength(2);

    // raw === coherent → no dispersed energy. The peak (0.5) clears the noise floor, so the clip
    // draws no low_motion warning either.
    expect(s.flickerScore.every((v) => v === 0)).toBe(true);
    expect(s.warnings).toEqual([]);
  });

  // The low_motion levels below are measured, not invented, over the displacement window: motionless
  // clips read 0.0008 frozen, 0.0051 under heavy grain and 0.0036 through an exposure drift, while the
  // subtlest real motion — a 3%-over-5s push-in — reads 0.0185 and a small figure walking 0.0409.

  it("flags a clip where nothing moves, reporting the magnitude and its window", () => {
    const flat = Array(20).fill(0.0008); // a frozen frame
    const s = summarizeMotion(flat, flat, flat, 10);
    expect(s.magnitude.value).toBe(0.0008);
    expect(s.displacementWindowSec).toBe(1);
    const w = s.warnings.find((w) => w.type === "low_motion");
    expect(w?.message).toBe("motion magnitude 0.0008 over 1s — nothing in frame moves that far.");
  });

  it("still flags a static clip whose grain lifts every tile off zero", () => {
    const local = Array(20).fill(0.0051); // frozen + heavy grain
    const s = summarizeMotion(local, local, local, 10);
    expect(s.warnings.map((w) => w.type)).toContain("low_motion");
  });

  it("flags a magnitude resting exactly on the floor (boundary)", () => {
    const local = Array(20).fill(0.01);
    const s = summarizeMotion(local, local, local, 10);
    expect(s.magnitude.value).toBe(0.01);
    expect(s.warnings.map((w) => w.type)).toContain("low_motion");
  });

  it("does not flag a magnitude just above the floor", () => {
    const local = [...Array(18).fill(0.0008), ...Array(2).fill(0.0101)];
    const s = summarizeMotion(local, local, local, 10);
    expect(s.warnings.map((w) => w.type)).not.toContain("low_motion");
  });

  it("does not flag the slow moves a consecutive-frame reading called still", () => {
    // A 6%-over-5s push-in and a small figure walking read 0.016 and 0.0075 frame-to-frame — under any
    // floor — and 0.0330 / 0.0409 over a second.
    for (const measured of [0.033, 0.0409]) {
      const local = [...Array(18).fill(0.004), ...Array(2).fill(measured)];
      const s = summarizeMotion(local, local, local, 10);
      expect(s.warnings.map((w) => w.type)).not.toContain("low_motion");
    }
  });

  it("reports the window the magnitude's own sample spanned, not the nominal stride", () => {
    // The tail's windows shrink to the clip's end, and the magnitude can land there — a 1Hz oscillation
    // reads ~0 a second apart and shows itself only in the short tail comparisons.
    const local = [...Array(8).fill(0.001), 0.05];
    const s = summarizeMotion(local, local, local, 10);
    expect(s.magnitude.time).toBe(0.85);
    expect(s.displacementWindowSec).toBe(0.1);
    expect(s.warnings.map((w) => w.type)).not.toContain("low_motion");
  });

  it("reports the window a short clip actually managed", () => {
    // Fewer frames than a second holds: the window clamps to the clip instead of over-claiming.
    const local = Array(5).fill(0.0008);
    const s = summarizeMotion(local, local, local, 10);
    expect(s.displacementWindowSec).toBe(0.5);
    expect(s.warnings[0]?.message).toContain("over 0.5s");
  });

  it("does not flag subtle localized motion the frame-wide reading dilutes away", () => {
    // The real regression: a cat breathing in its sleep. The frame-wide peak lands on the old 0.008
    // floor, so this warned on a shot a human had already accepted; the busiest tile reads 0.0948.
    const frameWide = [...Array(18).fill(0.004), ...Array(2).fill(0.008)];
    const local = [...Array(18).fill(0.03), ...Array(2).fill(0.0948)];
    const s = summarizeMotion(frameWide, frameWide, local, 10);
    expect(s.peak.value).toBeLessThanOrEqual(0.008);
    expect(s.magnitude).toEqual({ time: 1.85, value: 0.0948 });
    expect(s.warnings.map((w) => w.type)).not.toContain("low_motion");
  });

  it("flags dispersed energy when raw is high but coherent is low", () => {
    const raw = Array(10).fill(0.4);
    const coherent = Array(10).fill(0.1);
    const s = summarizeMotion(raw, coherent, raw, 10);

    expect(s.flickerScore[0]).toBeCloseTo(0.75, 5);
    expect(s.warnings.map((w) => w.type)).toContain("dispersed_motion");
  });

  it("treats near-zero raw energy as no flicker", () => {
    const raw = Array(5).fill(0.001);
    const coherent = Array(5).fill(0);
    const s = summarizeMotion(raw, coherent, raw, 10);
    expect(s.flickerScore.every((v) => v === 0)).toBe(true);
  });
});

describe("displacementStride", () => {
  it("spans a second of samples", () => {
    expect(displacementStride(24, 120)).toBe(24);
    expect(displacementStride(10, 20)).toBe(10);
  });

  it("clamps to the frames the clip has, never below one", () => {
    expect(displacementStride(24, 12)).toBe(11);
    expect(displacementStride(24, 2)).toBe(1);
    expect(displacementStride(24, 1)).toBe(1);
  });
});

describe("displacementEnergy", () => {
  const W = 16;
  const H = 12;

  function ramp(shift: number): number[] {
    const f: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f.push(Math.max(0, Math.min(255, (x + shift) * 12)));
    }
    return f;
  }

  it("measures a localized subject in its own tile, not across the frame", () => {
    // The same motion, measured two ways: spread over the frame it reads 0.017, and in the tile it
    // actually happens in, 0.18. That gap is why the low_motion warning reads the tile.
    const flat = new Array(W * H).fill(128);
    const patch = flat.slice();
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) patch[y * W + x] = 220;
    expect(frameCoherence(flat, patch, W, H).rawEnergy).toBeCloseTo(0.017, 3);
    expect(displacementEnergy(flat, patch, W, H)).toBeCloseTo(0.18, 2);
  });

  it("reads zero through a brightness change, which displaces nothing", () => {
    const flat = new Array(W * H).fill(128);
    expect(displacementEnergy(flat, flat.map((v) => v + 30), W, H)).toBe(0); // prettier-ignore
    // Textured too: an exposure drift over a gradient-rich frame is still not motion.
    expect(displacementEnergy(ramp(0), ramp(0).map((v) => Math.min(255, v + 30)), W, H)).toBe(0); // prettier-ignore
  });

  it("reads zero for identical frames", () => {
    const flat = new Array(W * H).fill(100);
    expect(displacementEnergy(flat, flat, W, H)).toBe(0);
  });

  it("cannot separate a sliding linear ramp from a brightness step (documented limitation)", () => {
    // A perfect gradient shifted one pixel changes every pixel by the same amount, which is
    // arithmetically an exposure shift. Accepted: such content sits under the floor either way.
    expect(displacementEnergy(ramp(0), ramp(1), W, H)).toBe(0);
  });
});

describe("frameCoherence", () => {
  const W = 16;
  const H = 12;

  // A horizontal grayscale ramp: value rises with x. Spatial gradient is nonzero everywhere.
  function ramp(shift: number): number[] {
    const f: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        f.push(Math.max(0, Math.min(255, (x + shift) * 12)));
      }
    }
    return f;
  }

  it("rates a globally shifted frame (camera pan) as highly edge-coherent", () => {
    // The whole ramp slides by one pixel: every pixel changes (dispersed, low concentration) yet the
    // diff sits exactly on the ramp's gradient — the camera-motion case that used to false-flag.
    const { concentration, edgeCoherence, weight } = frameCoherence(ramp(0), ramp(1), W, H);
    expect(concentration).toBeLessThan(0.15); // energy spread across every tile
    expect(edgeCoherence).toBeGreaterThan(0.9); // but aligned with the edges it displaces
    expect(weight).toBeGreaterThan(0.9); // so it reads as real motion, not flicker
  });

  it("rates flat-background flicker as incoherent", () => {
    // Uniform background (zero gradient) with a frame-wide checkerboard flash: energy everywhere, on no
    // edge at all — the genuine flicker/morphing signature.
    const flat = new Array(W * H).fill(128);
    const flick = flat.map((v, i) => v + (i % 2 === 0 ? 1 : -1) * 40);
    const { concentration, edgeCoherence, weight } = frameCoherence(flat, flick, W, H);
    expect(edgeCoherence).toBe(0); // no gradient to align to
    expect(concentration).toBeLessThan(0.15);
    expect(weight).toBeLessThan(0.15);
  });

  it("rescues localized subject motion via concentration even with no edges", () => {
    // A small patch of a flat frame changes: concentration is high, edge-coherence is irrelevant
    // (flat background), and the max keeps the sample as real motion.
    const flat = new Array(W * H).fill(128);
    const patch = flat.slice();
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) patch[y * W + x] = 220;
    const { concentration, weight, rawEnergy } = frameCoherence(flat, patch, W, H);
    expect(concentration).toBeGreaterThan(0.6);
    expect(weight).toBeGreaterThan(0.6);
    expect(rawEnergy).toBeCloseTo(0.017, 3);
  });

  it("reports no energy and zero coherence for identical frames", () => {
    const flat = new Array(W * H).fill(100);
    const { rawEnergy, edgeCoherence, weight } = frameCoherence(flat, flat, W, H);
    expect(rawEnergy).toBe(0);
    expect(edgeCoherence).toBe(0);
    expect(weight).toBe(0);
  });

  // A sharp vertical step edge at column `edge` — the case that exposes gradient direction-bias. A
  // forward-difference gradient localizes the edge to one side, so panning it one way lands the diff on
  // the gradient and the other way lands it off (cosine → 0); the central difference must score both
  // pan directions the same.
  function step(edge: number): number[] {
    const f: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f.push(x < edge ? 0 : 200);
    }
    return f;
  }

  it("scores a step-edge pan the same in both directions (central gradient, no direction bias)", () => {
    const base = step(8);
    const right = frameCoherence(base, step(9), W, H).edgeCoherence; // edge slides +1
    const left = frameCoherence(base, step(7), W, H).edgeCoherence; // edge slides −1
    expect(right).toBeGreaterThan(0.6);
    expect(left).toBeGreaterThan(0.6);
    expect(right).toBeCloseTo(left, 5); // the fix: symmetric, not ~0.97 vs ~0
  });

  it("does not use cur's gradient — a checkerboard flash cannot self-align", () => {
    // If the gradient were read from cur, the flash's own high-frequency structure would align with its
    // diff and mask the flicker. Taken from prev (flat), it stays incoherent.
    const flat = new Array(W * H).fill(128);
    const checker = flat.map((_, i) => (((i % W) + Math.floor(i / W)) % 2 === 0 ? 60 : 196));
    expect(frameCoherence(flat, checker, W, H).edgeCoherence).toBe(0);
  });

  it("accepts a uniform luminance pulse over a textured frame as coherent (documented limitation)", () => {
    // A frame-wide brightness step on a gradient-rich frame aligns with that gradient, so max() keeps it
    // as motion. This is a knowingly-accepted false negative: distinguishing an exposure pulse from
    // edge-hugging morphing needs temporal/global-motion modeling beyond a single frame pair. The
    // priority here is killing the camera-motion false positive, not perfect flicker recall.
    const { edgeCoherence, weight } = frameCoherence(ramp(0), ramp(0).map((v) => Math.min(255, v + 30)), W, H); // prettier-ignore
    expect(edgeCoherence).toBeGreaterThan(0.9);
    expect(weight).toBeGreaterThan(0.9);
  });
});
