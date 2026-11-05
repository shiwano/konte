import { describe, expect, it } from "vitest";
import { englishHearing } from "../hearing/en.js";
import { alignHeard } from "../line-hearing.js";
import { clipWindow, reelLineMarks } from "../line-marks.js";

const tokens = (heard: string) =>
  heard.split(/(?= )/).map((text, i) => ({ text, startSec: (i * 5) / 10 }));

describe("reelLineMarks", () => {
  it("places a line's marks and characters on the reel the clip plays it at", () => {
    const lines = [{ text: "now it is your turn", number: 2 }];
    const aligned = alignHeard(["now it is your turn"], tokens("now is your turn"), englishHearing);
    // A clip at reel 10s playing the take from 0.5s at double speed.
    const reelAt = (t: number) => 10 + (t - 0.5) / 2;
    const [marks] = reelLineMarks(lines, aligned, englishHearing, reelAt, [10, 20]);
    expect(marks!.line).toBe(2);
    // `now`, heard before the clip's media starts, is cut.
    expect(marks!.marks).toEqual([
      { range: [0, 7], time: [9.75, 9.75] },
      { range: [4, 6], time: [9.75, 10] },
    ]);
    expect(marks!.timeAt[0]).toBeNull();
    expect(marks!.timeAt[7]).toBe(10);
    expect(marks!.timeAt.at(-1)).toBe(10.5);
  });

  it("marks what the clip's window cuts of the heard line", () => {
    const lines = [{ text: "that one more", number: 1 }];
    const aligned = alignHeard(["that one more"], tokens("that one more"), englishHearing);
    const [marks] = reelLineMarks(lines, aligned, englishHearing, (t) => t, [0, 0.8]);
    expect(marks!.marks).toEqual([{ range: [9, 13], time: [1, 1] }]);
    expect(marks!.timeAt.slice(9)).toEqual([null, null, null, null]);
  });
});

describe("clipWindow", () => {
  const clip = {
    assetName: null,
    address: "animatic:shot.01.vo",
    mediaType: "audio" as const,
    start: 1,
    end: 3,
    bounded: false,
    mediaStart: 0.5,
    playbackRate: 2,
    variantId: null,
    volume: null,
    hasAudio: true,
    cueId: null,
  };

  it("plays an <Audio> declaring no duration out, past the shot's end", () => {
    expect(clipWindow(clip, 10, 8.5)).toEqual([11, 15]);
  });

  it("ends a clip that declares its duration where it says", () => {
    expect(clipWindow({ ...clip, bounded: true }, 10, 8.5)).toEqual([11, 13]);
    expect(clipWindow(clip, 10, undefined)).toEqual([11, 13]);
  });
});
