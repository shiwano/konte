import { describe, expect, it } from "vitest";
import {
  assertRetimeRate,
  atempoChain,
  MAX_RETIME_RATE,
  MIN_RETIME_RATE,
} from "../audio-retime.js";

describe("assertRetimeRate", () => {
  const where = "animatic:shot.01.line";

  it("holds speeding up and slowing down to the same distance from the take", () => {
    for (const rate of [MIN_RETIME_RATE, 1, MAX_RETIME_RATE]) {
      expect(() => assertRetimeRate({ rate, sourceDuration: 2, duration: 2, where })).not.toThrow();
    }
    for (const rate of [MIN_RETIME_RATE - 0.01, MAX_RETIME_RATE + 0.01]) {
      expect(() => assertRetimeRate({ rate, sourceDuration: 2, duration: 2, where })).toThrow(
        /RETIME|past the/,
      );
    }
  });

  it("passes any rate a waiver stands against", () => {
    expect(() =>
      assertRetimeRate({ rate: 3, sourceDuration: 6, duration: 2, waiver: "reason", where }),
    ).not.toThrow();
  });
});

describe("atempoChain", () => {
  it("splits a rate outside atempo's range into factors inside it", () => {
    for (const rate of [0.25, 0.5, 1, 1.1, 2, 3, 5]) {
      const factors = atempoChain(rate)
        .split(",")
        .map((filter) => Number(filter.replace("atempo=", "")));
      expect(factors.every((f) => f >= 0.5 && f <= 2)).toBe(true);
      expect(factors.reduce((a, b) => a * b, 1)).toBeCloseTo(rate, 6);
    }
  });
});
