import { describe, expect, it } from "vitest";
import { estimateSpeechSec } from "../speech-duration.js";
import { LANGUAGES } from "../typography.js";

describe("estimateSpeechSec", () => {
  // A language with no rate falls back to the shot-sized count, silently — the very default this
  // exists to replace. So every language the direction may declare owes a rate.
  it("rates every language policy.lang accepts", () => {
    const unrated = LANGUAGES.filter((lang) => estimateSpeechSec("test", lang) === null);
    expect(unrated).toEqual([]);
  });

  it("carries the rate through a script or region subtag", () => {
    expect(estimateSpeechSec("春の日", "ja")).toBe(estimateSpeechSec("春の日", "ja-JP"));
    expect(estimateSpeechSec("春天", "zh-Hant")).not.toBeNull();
  });

  it("falls back rather than guessing at a script it has no rate for", () => {
    expect(estimateSpeechSec("Καλημέρα", "en-Grek")).toBeNull();
    expect(estimateSpeechSec("anything", undefined)).toBeNull();
    expect(estimateSpeechSec("", "ja")).toBeNull();
  });

  it("grows with the words", () => {
    const short = estimateSpeechSec("飴玉を出せ。", "ja")!;
    const long = estimateSpeechSec(
      "春のあたたかい日のこと。渡し舟に、女の旅人が乗りました。",
      "ja",
    )!;
    expect(long).toBeGreaterThan(short);
  });

  // A small kana is the tail of the mora before it, and punctuation is already in the slope.
  it("counts a mora, not a character", () => {
    expect(estimateSpeechSec("きょう", "ja")).toBe(estimateSpeechSec("きう", "ja"));
    expect(estimateSpeechSec("はい。", "ja")).toBe(estimateSpeechSec("はい", "ja"));
  });
});
