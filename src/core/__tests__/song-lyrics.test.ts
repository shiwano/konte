import { describe, expect, it } from "vitest";
import { placeLyricLines } from "../song-lyrics.js";

// 120 BPM in 4/4: a bar is 2s, and the first bar head is at 0.5s in the take.
const grid = { bpm: 120, beatsPerBar: 4, downbeatSec: 0.5, lang: "en" };

const lines = (texts: string[]) => texts.map((text) => ({ text }));
const spans = (pairs: [number, number][]) =>
  pairs.map(([startSec, endSec]) => ({ startSec, endSec }));

describe("placeLyricLines", () => {
  it("places each line on the stretches sung for it, a bar apart", () => {
    const placed = placeLyricLines({
      ...grid,
      lines: lines([
        "Hit the light, watch me move",
        "Snap on the beat, I'm in the groove",
        "One more time, I'm gonna prove",
      ]),
      phrases: spans([
        [0.5, 1.2],
        [1.35, 2.2],
        [4.5, 5.3],
        [5.4, 6.3],
        [8.5, 9.1],
        [9.3, 10.3],
      ]),
    });
    expect(placed.map((p) => p && [p.startSec, p.endSec])).toEqual([
      [0.5, 2.2],
      [4.5, 6.3],
      [8.5, 10.3],
    ]);
  });

  it("leaves lines unplaced where the stretches fit either of them", () => {
    // One sung stretch, two lines of one length: which of them was sung is not in the audio.
    const placed = placeLyricLines({
      ...grid,
      lines: lines(["Hit the light, watch me move", "Snap on the beat, I'm in the groove"]),
      phrases: spans([[0.5, 2.2]]),
    });
    expect(placed).toEqual([null, null]);
  });

  it("keeps a line a person placed where they placed it, and looks for the rest around it", () => {
    const placed = placeLyricLines({
      ...grid,
      lines: [
        { text: "Hit the light, watch me move" },
        { text: "Snap on the beat, I'm in the groove", set: { startSec: 4.5, endSec: 6 } },
        { text: "One more time, I'm gonna prove" },
      ],
      phrases: spans([
        [0.5, 2.2],
        [8.5, 10.3],
      ]),
    });
    expect(placed).toEqual([
      { startSec: 0.5, endSec: 2.2, set: false },
      { startSec: 4.5, endSec: 6, set: true },
      { startSec: 8.5, endSec: 10.3, set: false },
    ]);
  });

  it("leaves the stretches a line a person placed is sung on to it", () => {
    const placed = placeLyricLines({
      ...grid,
      lines: [
        { text: "Hit the light, watch me move", set: { startSec: 0.5, endSec: 3.5 } },
        { text: "Snap on the beat" },
      ],
      phrases: spans([
        [0.5, 3.5],
        [4.5, 5.5],
      ]),
    });
    expect(placed.map((p) => p && p.startSec)).toEqual([0.5, 4.5]);
  });

  it("places nothing without a vocal track, only what a person placed", () => {
    const placed = placeLyricLines({
      ...grid,
      lines: [
        { text: "Hit the light" },
        { text: "Watch me move", set: { startSec: 4.5, endSec: 6 } },
      ],
      phrases: null,
    });
    expect(placed).toEqual([null, { startSec: 4.5, endSec: 6, set: true }]);
  });
});
