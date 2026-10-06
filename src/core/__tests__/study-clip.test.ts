import { describe, expect, it } from "vitest";
import { evenPicks, formatClock, heardLines, musicTempo, shotsBetween } from "../study-clip.js";

describe("shotsBetween", () => {
  it("splits the clip at each cut", () => {
    expect(shotsBetween([2, 5], 9)).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2, endSec: 5 },
      { startSec: 5, endSec: 9 },
    ]);
  });

  it("drops a cut too close to the last one or to the end", () => {
    expect(shotsBetween([0.1, 2, 2.1, 8.9], 9)).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 2, endSec: 9 },
    ]);
  });

  it("is one shot where nothing cuts", () => {
    expect(shotsBetween([], 4)).toEqual([{ startSec: 0, endSec: 4 }]);
  });
});

describe("evenPicks", () => {
  it("keeps every index when they fit", () => {
    expect(evenPicks(3, 5)).toEqual([0, 1, 2]);
  });

  it("spreads the picks evenly, first and last included", () => {
    expect(evenPicks(10, 4)).toEqual([0, 3, 6, 9]);
  });
});

describe("musicTempo", () => {
  const pulse = (count: number, every: number) =>
    Array.from({ length: count }, (_, i) => Math.round(i * every * 1000) / 1000);

  it("reads the tempo of a steady pulse", () => {
    expect(musicTempo(pulse(64, 0.5), 32)).toEqual({ bpm: 120 });
  });

  it("hears no music in a handful of beats", () => {
    expect(musicTempo(pulse(8, 0.5), 32)).toBeNull();
  });

  it("hears no music where the pulse covers too little of the clip", () => {
    expect(musicTempo(pulse(20, 0.5), 120)).toBeNull();
  });
});

describe("heardLines", () => {
  it("opens a line at each pause, stamped with its clock", () => {
    expect(
      heardLines([
        { text: "今日", startSec: 4 },
        { text: "は", startSec: 4.3 },
        { text: "晴れ", startSec: 64 },
      ]),
    ).toEqual(["[0:04] 今日は", "[1:04] 晴れ"]);
  });
});

describe("formatClock", () => {
  it("reads as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(92.7)).toBe("1:32");
    expect(formatClock(1800)).toBe("30:00");
  });
});
