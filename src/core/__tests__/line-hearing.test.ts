import { describe, expect, it } from "vitest";
import { lineMishearing } from "../line-hearing.js";

describe("lineMishearing", () => {
  it("names the opening words a take drops, with the punctuation closing them", () => {
    expect(
      lineMishearing("Bigger! She should fill the sky!", "she should fill the sky", "en"),
    ).toBe('drops the opening "Bigger!"');
  });

  it("names a short whole word a take drops at an end", () => {
    expect(lineMishearing("Oh! Not bad!", "not bad", "en")).toBe('drops the opening "Oh!"');
    expect(lineMishearing("Not bad, eh?", "not bad", "en")).toBe('drops the closing "eh?"');
  });

  it("passes a one-letter word or a word heard in another spelling at an end", () => {
    expect(lineMishearing("I did it!", "did it", "en")).toBeNull();
    expect(lineMishearing("Oh! Not bad!", "a not bad", "en")).toBeNull();
  });

  it("names the closing words a take drops", () => {
    expect(
      lineMishearing(
        "まずは保護者のアプリから、カードにおこづかいを送金します。",
        "まずは保護者のアプリから",
        "ja",
      ),
    ).toBe('drops the closing "カードにおこづかいを送金します。"');
  });

  it("quotes the whole lost stretch past a kana the alignment pairs by chance", () => {
    expect(lineMishearing("お子さまのアプリですぐに確認できます。", "お子様のアプリで", "ja")).toBe(
      'drops the closing "ですぐに確認できます。"',
    );
  });

  it("finds words dropped inside a clause", () => {
    expect(
      lineMishearing(
        "お店でもネットでも、カードで支払えます。",
        "ネットでもカードで支払えます",
        "ja",
      ),
    ).toBe('drops the opening "お店でも"');
  });

  it("passes a take heard with another spelling, case or punctuation", () => {
    expect(
      lineMishearing("No... her eyes are kinder.", "know her eyes are kinder", "en"),
    ).toBeNull();
    expect(
      lineMishearing("Claude Code... and kon-teh.", "clode code and content", "en"),
    ).toBeNull();
    expect(lineMishearing("Whoa...!", "wow", "en")).toBeNull();
  });

  it("passes kanji heard where the line has kana", () => {
    expect(
      lineMishearing(
        "おこづかいは、アプリからいつでも送れます。",
        "お小遣いはアプリからいつでも遅れます",
        "ja",
      ),
    ).toBeNull();
    expect(lineMishearing("使い方も、親子でいっしょに。", "使い方も親子で一緒に", "ja")).toBeNull();
    expect(lineMishearing("とうきょう駅で会いましょう。", "東京駅で会いましょう", "ja")).toBeNull();
    expect(lineMishearing("とうきょう", "東京", "ja")).toBeNull();
    expect(
      lineMishearing("きょうはとうきょうえきであいましょう。", "今日は東京駅で会いましょう", "ja"),
    ).toBeNull();
  });

  it("weighs a hanzi heard in a Chinese line's place as one letter", () => {
    expect(lineMishearing("我们明天早上在北京站门口见面。", "我们明天早上在北京吧好", "zh")).toBe(
      'drops the closing "站门口见面。"',
    );
  });

  it("reads digits heard where the line spells the number", () => {
    expect(
      lineMishearing("...A hundred and nineteen to go.", "1 hundred19 to go", "en"),
    ).toBeNull();
    expect(
      lineMishearing("4桁の暗証番号を入力します。", "四桁の暗証番号を入力します", "ja"),
    ).toBeNull();
  });

  it("says a reordered read says other words", () => {
    expect(lineMishearing("Done! One whole second!", "one second done", "en")).toBe(
      "says other words",
    );
  });

  it("says a take heard as nothing of the line says none of it", () => {
    expect(lineMishearing("That one!", "", "en")).toBe("says none of the line");
  });
});
