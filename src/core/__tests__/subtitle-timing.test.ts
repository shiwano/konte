import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { type LineTiming, lineTimingKey, timeSubtitleLine } from "../subtitle-timing.js";

const TEXT = "ワトスン、金儲けの機会だよ。ガリデブを知っているかね？";

// One character heard every 0.1s from 10s, the punctuation unheard.
function heardTiming(over: Partial<LineTiming> = {}): LineTiming {
  let t = 10;
  const charAt = [...TEXT].map((c) => {
    if (/[、。？]/.test(c)) return null;
    const at = Math.round(t * 10) / 10;
    t += 0.1;
    return at;
  });
  return {
    shotId: "03",
    line: 1,
    text: TEXT,
    take: { address: "animatic:shot.03.holmes", variantId: "v-a" },
    charAt,
    clipped: null,
    onsets: charAt.filter((x): x is number => x !== null),
    sound: [9.9, 12.8],
    pauses: [[11.15, 11.4]],
    takeLines: [{ line: 1, text: TEXT }],
    ...over,
  };
}

const timings = (timing: LineTiming) =>
  new Map([[lineTimingKey(timing.shotId, timing.line), timing]]);

describe("timeSubtitleLine", () => {
  it("shows a whole line from its first heard character to the take's sound end", () => {
    expect(
      timeSubtitleLine({ shot: "03", line: 1, text: "All of it" }, timings(heardTiming())),
    ).toEqual([{ start: 10, end: 12.8, text: "All of it" }]);
  });

  it("times each part from the heard characters of the words it names", () => {
    const [first, second] = timeSubtitleLine(
      {
        shot: "03",
        line: 1,
        parts: [
          ["ワトスン、金儲けの機会だよ。", "There's money in this, Watson."],
          ["ガリデブを知っているかね？", "Do you know Garrideb?"],
        ],
      },
      timings(heardTiming()),
    );
    expect(first!.start).toBe(10);
    // `よ` ends where `ガ` is heard next.
    expect(first!.end).toBeCloseTo(11.2);
    expect(second).toEqual({ start: 11.2, end: 12.8, text: "Do you know Garrideb?" });
  });

  it("splits an unheard line by each part's share of its letters over the take's sound", () => {
    const [first, second] = timeSubtitleLine(
      {
        shot: "03",
        line: 1,
        parts: [
          ["ワトスン、", "Watson,"],
          ["金儲けの機会だよ。ガリデブを知っているかね？", "the rest"],
        ],
      },
      timings(heardTiming({ charAt: null, onsets: [] })),
    );
    expect(first!.start).toBe(9.9);
    expect(first!.end).toBeCloseTo(9.9 + (2.9 * 4) / 24);
    expect(second!.end).toBe(12.8);
  });

  it("splits at the pauses of the take they were read off", () => {
    const spec = { shot: "03", line: 1, take: "v-a", pauses: [1], text: ["a", "b"] } as const;
    expect(timeSubtitleLine(spec, timings(heardTiming()))).toEqual([
      { start: 9.9, end: 11.15, text: "a" },
      { start: 11.4, end: 12.8, text: "b" },
    ]);
  });

  it("splits by share of the texts where the take its pauses were read off no longer plays", () => {
    const spec = { shot: "03", line: 1, take: "v-old", pauses: [1], text: ["aa", "bb"] } as const;
    const [first, second] = timeSubtitleLine(spec, timings(heardTiming()));
    expect(first!.start).toBe(10);
    expect(first!.end).toBeCloseTo(11.4);
    expect(second!.end).toBeCloseTo(12.8);
  });

  it("refuses words the line does not say, a line the direction does not give, and a pause the take lacks", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof KonteError ? err.code : "other";
      }
      return null;
    };
    const t = timings(heardTiming());
    expect(
      code(() => timeSubtitleLine({ shot: "03", line: 1, parts: [["ホームズ", "x"]] }, t)),
    ).toBe("SUBTITLE_LINE_INVALID");
    expect(code(() => timeSubtitleLine({ shot: "03", line: 2, text: "x" }, t))).toBe(
      "SUBTITLE_LINE_INVALID",
    );
    expect(
      code(() =>
        timeSubtitleLine({ shot: "03", line: 1, take: "v-a", pauses: [2], text: ["a", "b"] }, t),
      ),
    ).toBe("SUBTITLE_LINE_INVALID");
  });

  it("shows nothing of what the clip cuts of a heard line", () => {
    const clipped = [...TEXT].map(() => true);
    const timing = heardTiming({ charAt: [...TEXT].map(() => null), clipped });
    expect(timeSubtitleLine({ shot: "03", line: 1, text: "x" }, timings(timing))).toEqual([]);
    const half = heardTiming();
    half.clipped = half.charAt!.map((_, i) => i >= 14);
    half.charAt = half.charAt!.map((t, i) => (i >= 14 ? null : t));
    const parts = timeSubtitleLine(
      {
        shot: "03",
        line: 1,
        parts: [
          ["ワトスン、金儲けの機会だよ。", "a"],
          ["ガリデブを知っているかね？", "b"],
        ],
      },
      timings(half),
    );
    expect(parts.map((p) => p.text)).toEqual(["a"]);
  });

  it("shows nothing for a line no take on the reel says", () => {
    const timing = heardTiming({
      take: null,
      charAt: null,
      onsets: [],
      sound: null,
      takeLines: [],
    });
    expect(timeSubtitleLine({ shot: "03", line: 1, text: "x" }, timings(timing))).toEqual([]);
  });
});
