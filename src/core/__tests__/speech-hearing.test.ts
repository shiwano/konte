import { describe, expect, it } from "vitest";
import { hearingWindows, joinHeardWindows } from "../speech-hearing.js";

describe("hearingWindows", () => {
  it("starts a window every 15s until one reaches the end", () => {
    expect(hearingWindows(12)).toEqual([0]);
    expect(hearingWindows(40)).toEqual([0, 15, 30]);
  });
});

describe("joinHeardWindows", () => {
  it("puts each token on the take's clock, a token heard twice kept from one window", () => {
    const joined = joinHeardWindows([
      { startSec: 0, heard: { tokens: ["A", "B", "C"], timestamps: [1, 16, 18] } },
      { startSec: 15, heard: { tokens: ["B", "C", "D"], timestamps: [1, 3, 10] } },
    ]);
    expect(joined).toEqual([
      { text: "A", startSec: 1 },
      { text: "B", startSec: 16 },
      { text: "C", startSec: 18 },
      { text: "D", startSec: 25 },
    ]);
  });
});
