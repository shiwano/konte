import { describe, expect, it } from "vitest";
import { quotedSpans, speechLangOf, spokenSecOf } from "../source-speech.js";

describe("quotedSpans", () => {
  it("finds every quotation of a paragraph, marks included", () => {
    expect(quotedSpans("「切符を」と駅長が言い、「早く」と続けた")).toEqual([
      "「切符を」",
      "「早く」",
    ]);
    expect(quotedSpans('"Go," he said, "now."')).toEqual(['"Go,"', '"now."']);
    expect(quotedSpans("I don’t, ‘never’")).toEqual([]);
  });

  it("runs one left open to the paragraph's end", () => {
    expect(quotedSpans("He said: “It was late, and")).toEqual(["“It was late, and"]);
  });
});

describe("speechLangOf", () => {
  it("reads the most frequent script's language, Japanese where kana show", () => {
    expect(speechLangOf("君はアフガニスタン帰りだね")).toBe("ja");
    expect(speechLangOf("你好世界")).toBe("zh");
    expect(speechLangOf("안녕하세요 여러분 오늘은")).toBe("ko");
    expect(speechLangOf("Привет, как дела")).toBe("ru");
    expect(speechLangOf("You have been in Afghanistan, ワトスン")).toBe("en");
    expect(speechLangOf("")).toBe("en");
  });
});

describe("spokenSecOf", () => {
  it("adds every line's estimate, a mark-only line adding nothing", () => {
    const one = spokenSecOf(["“You have been in Afghanistan, I perceive.”"], "en");
    expect(one).toBeGreaterThan(2);
    expect(spokenSecOf(["“You have been in Afghanistan, I perceive.”", "“”"], "en")).toBe(one);
    expect(spokenSecOf([], "en")).toBe(0);
  });
});
