import { describe, expect, it } from "vitest";
import { recoverFocalShift, toPointMap } from "../moge.js";

// A pinhole camera's points over a floor tilting away, read back as MoGe hands them over: scaled and
// shifted along z.
function reading(fovX: number, shift: number, scale: number) {
  const width = 96;
  const height = 48;
  const fx = 0.5 / Math.tan(((fovX / 2) * Math.PI) / 180);
  const fy = fx * (width / height);
  const points = new Float32Array(width * height * 3);
  const mask = new Float32Array(width * height).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const z = 2 + (3 * x) / width + (2 * y) / height;
      const k = y * width + x;
      points[k * 3] = ((((x + 0.5) / width - 0.5) / fx) * z) / scale;
      points[k * 3 + 1] = ((((y + 0.5) / height - 0.5) / fy) * z) / scale;
      points[k * 3 + 2] = (z - shift) / scale;
    }
  }
  return { width, height, points, mask, metricScale: scale };
}

describe("recoverFocalShift", () => {
  it("recovers the shift and the field of view of a pinhole camera's points", () => {
    const r = reading(70, 1.2, 1);
    const map = toPointMap(r);
    expect(map.fovX).toBeCloseTo(70, 1);
    expect(recoverFocalShift(r).shift).toBeCloseTo(1.2, 2);
  });

  it("reads no point at all as a finite shift and focal", () => {
    const r = reading(60, 0.5, 1);
    r.mask.fill(0);
    const { shift, focal } = recoverFocalShift(r);
    expect([shift, focal].every(Number.isFinite)).toBe(true);
    expect(toPointMap(r).points.every((v) => v === Infinity)).toBe(true);
  });
});

describe("toPointMap", () => {
  it("back-projects every pixel at metric depth", () => {
    const map = toPointMap(reading(60, 0.5, 0.25));
    expect(map.points[2]).toBeCloseTo(2, 1);
    expect(map.points[(map.width * map.height - 1) * 3 + 2]).toBeCloseTo(
      2 + (3 * 95) / 96 + (2 * 47) / 48,
      1,
    );
  });

  it("leaves a masked-out pixel at infinity", () => {
    const r = reading(60, 0.5, 1);
    r.mask[0] = 0;
    const map = toPointMap(r);
    expect(map.points[0]).toBe(Infinity);
    expect(Number.isFinite(map.points[3]!)).toBe(true);
  });
});
