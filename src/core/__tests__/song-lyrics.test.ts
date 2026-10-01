import { describe, expect, it } from "vitest";
import { placeLyricLines } from "../song-lyrics.js";

const lines = (texts: string[]) => texts.map((text) => ({ text }));
const heard = (tokens: [string, number][]) =>
  tokens.map(([text, startSec]) => ({ text, startSec }));
const spans = (pairs: [number, number][]) =>
  pairs.map(([startSec, endSec]) => ({ startSec, endSec }));

describe("placeLyricLines", () => {
  it("places each line where its words are heard, to the end of the stretch it is sung on", () => {
    const placed = placeLyricLines({
      lines: lines(["Hit the light", "Watch me move"]),
      heard: heard([
        [" HIT", 0.5],
        [" THE", 0.9],
        [" LIGHT", 1.2],
        [" WATCH", 4.5],
        [" ME", 5],
        [" MOVE", 5.3],
      ]),
      phrases: spans([
        [0.5, 2.2],
        [4.5, 6.3],
      ]),
    });
    expect(placed).toEqual([
      { startSec: 0.5, endSec: 2.2, set: false },
      { startSec: 4.5, endSec: 6.3, set: false },
    ]);
  });

  it("places a line whose words are misheard by the letters heard right", () => {
    const placed = placeLyricLines({
      lines: lines(["Carry your fire, become the light"]),
      heard: heard([
        [" CARRIY", 2],
        [" YUR", 2.6],
        [" FIEE", 3],
        [" BECOME", 3.4],
        [" AIE", 4],
      ]),
      phrases: null,
    });
    expect(placed.map((p) => p?.startSec)).toEqual([2]);
  });

  it("sets a line back to its first letter where its first word goes unheard", () => {
    // "Rise" is not heard; "into" is, five letters in, at the pace the rest is heard at.
    const placed = placeLyricLines({
      lines: lines(["Rise into the night"]),
      heard: heard([
        [" IN", 10],
        ["TO", 10.2],
        [" THE", 10.4],
        [" NIGHT", 10.7],
      ]),
      phrases: null,
    });
    expect(placed[0]!.startSec).toBeGreaterThan(9.5);
    expect(placed[0]!.startSec).toBeLessThan(10);
  });

  it("leaves a line unplaced where its opening is not heard", () => {
    const placed = placeLyricLines({
      lines: lines(["Hit the light", "Snap on the beat tonight", "Watch me move"]),
      heard: heard([
        [" HIT", 0.5],
        [" THE", 0.9],
        [" LIGHT", 1.2],
        [" WATCH", 8.5],
        [" ME", 9],
        [" MOVE", 9.3],
      ]),
      phrases: null,
    });
    expect(placed.map((p) => p?.startSec ?? null)).toEqual([0.5, null, 8.5]);
  });

  it("closes a line no later than the next one opens", () => {
    const placed = placeLyricLines({
      lines: lines(["Hit the light", "Watch me move"]),
      heard: heard([
        [" HIT", 0.5],
        [" THE", 0.9],
        [" LIGHT", 1.2],
        [" WATCH", 1.8],
        [" ME", 2.1],
        [" MOVE", 2.4],
      ]),
      phrases: spans([[0.5, 3]]),
    });
    expect(placed.map((p) => p && [p.startSec, p.endSec])).toEqual([
      [0.5, 1.8],
      [1.8, 3],
    ]);
  });

  it("keeps a line a person placed, and places no line found past the next one they placed", () => {
    const placed = placeLyricLines({
      lines: [
        { text: "Hit the light" },
        { text: "Snap on the beat" },
        { text: "Watch me move", set: { startSec: 3, endSec: 4 } },
      ],
      heard: heard([
        [" HIT", 0.5],
        [" THE", 0.9],
        [" LIGHT", 1.2],
        [" SNAP", 5],
        [" ON", 5.3],
        [" THE", 5.5],
        [" BEAT", 5.8],
      ]),
      phrases: null,
    });
    expect(placed.map((p) => p && [p.startSec, p.set])).toEqual([[0.5, false], null, [3, true]]);
  });

  it("matches the lines either side of a set line only against what is heard on their side", () => {
    const placed = placeLyricLines({
      lines: [
        { text: "Hello" },
        { text: "Hello", set: { startSec: 10, endSec: 11 } },
        { text: "Hello" },
      ],
      heard: heard([
        [" HELLO", 1],
        [" HELLO", 20],
      ]),
      phrases: null,
    });
    expect(placed.map((p) => p?.startSec ?? null)).toEqual([1, 10, 20]);
  });

  it("places a one-letter line heard as that letter", () => {
    const placed = placeLyricLines({
      lines: lines(["夢", "ゆめ"]),
      heard: heard([
        ["夢", 1],
        ["ユメ", 3],
      ]),
      phrases: null,
    });
    expect(placed.map((p) => p?.startSec ?? null)).toEqual([1, 3]);
  });

  it("matches kana whichever script it is heard in", () => {
    const placed = placeLyricLines({
      lines: lines(["きらきら ひかる"]),
      heard: heard([
        ["キラ", 1],
        ["キラ", 1.4],
        ["ヒカル", 1.8],
      ]),
      phrases: null,
    });
    expect(placed.map((p) => p?.startSec)).toEqual([1]);
  });

  it("places nothing unheard, only what a person placed", () => {
    const placed = placeLyricLines({
      lines: [
        { text: "Hit the light" },
        { text: "Watch me move", set: { startSec: 4.5, endSec: 6 } },
      ],
      heard: null,
      phrases: null,
    });
    expect(placed).toEqual([null, { startSec: 4.5, endSec: 6, set: true }]);
  });
});
