import { describe, expect, it } from "vitest";
import type { JapaneseReader } from "../japanese-reading.js";
import { englishHearing as en } from "../hearing/en.js";
import { hearingOf } from "../hearing/index.js";
import { japaneseHearing } from "../hearing/ja.js";
import { alignHeard, lineMishearing, markedGaps } from "../line-hearing.js";

// One line, heard as one token.
const misheard = (line: string, heard: string, lang: string) =>
  lineMishearing([{ text: line, number: 1 }], [{ text: heard, startSec: 0 }], hearingOf(lang));

describe("lineMishearing at the ends", () => {
  it("names the opening words a take drops, with the punctuation closing them", () => {
    expect(misheard("Bigger! She should fill the sky!", "she should fill the sky", "en")).toBe(
      'line 1: drops the opening "Bigger!"',
    );
  });

  it("names a short whole word a take drops at an end", () => {
    expect(misheard("Oh! Not bad!", "not bad", "en")).toBe('line 1: drops the opening "Oh!"');
    expect(misheard("Not bad, eh?", "not bad", "en")).toBe('line 1: drops the closing "eh?"');
  });

  it("passes a one-letter word or a word heard in another spelling at an end", () => {
    expect(misheard("I did it!", "did it", "en")).toBeNull();
    expect(misheard("Oh! Not bad!", "a not bad", "en")).toBeNull();
  });

  it("names the closing words a take drops", () => {
    expect(
      misheard(
        "まずは保護者のアプリから、カードにおこづかいを送金します。",
        "まずは保護者のアプリから",
        "ja",
      ),
    ).toBe('line 1: drops the closing "カードにおこづかいを送金します。"');
  });

  it("quotes the whole lost stretch past a kana the alignment pairs by chance", () => {
    expect(misheard("お子さまのアプリですぐに確認できます。", "お子様のアプリで", "ja")).toBe(
      'line 1: drops the closing "ですぐに確認できます。"',
    );
  });

  it("finds words dropped inside a clause", () => {
    expect(
      misheard("お店でもネットでも、カードで支払えます。", "ネットでもカードで支払えます", "ja"),
    ).toBe('line 1: drops the opening "お店でも"');
  });

  it("passes a take heard with another spelling, case or punctuation", () => {
    expect(misheard("No... her eyes are kinder.", "know her eyes are kinder", "en")).toBeNull();
    expect(misheard("Claude Code... and kon-teh.", "clode code and content", "en")).toBeNull();
    expect(misheard("Whoa...!", "wow", "en")).toBeNull();
  });

  it("passes kanji heard where the line has kana", () => {
    expect(
      misheard(
        "おこづかいは、アプリからいつでも送れます。",
        "お小遣いはアプリからいつでも遅れます",
        "ja",
      ),
    ).toBeNull();
    expect(misheard("使い方も、親子でいっしょに。", "使い方も親子で一緒に", "ja")).toBeNull();
    expect(misheard("とうきょう駅で会いましょう。", "東京駅で会いましょう", "ja")).toBeNull();
    expect(misheard("とうきょう", "東京", "ja")).toBeNull();
    expect(
      misheard("きょうはとうきょうえきであいましょう。", "今日は東京駅で会いましょう", "ja"),
    ).toBeNull();
  });

  it("weighs a hanzi heard in a Chinese line's place as one letter", () => {
    expect(misheard("我们明天早上在北京站门口见面。", "我们明天早上在北京吧好", "zh")).toBe(
      'line 1: drops the closing "站门口见面。"',
    );
  });

  it("reads digits heard where the line spells the number", () => {
    expect(misheard("...A hundred and nineteen to go.", "1 hundred19 to go", "en")).toBeNull();
    expect(misheard("4桁の暗証番号を入力します。", "四桁の暗証番号を入力します", "ja")).toBeNull();
  });

  it("says a reordered read says other words", () => {
    expect(misheard("Done! One whole second!", "one second done", "en")).toBe("says other words");
  });

  it("says a take heard as nothing of the line says none of it", () => {
    expect(misheard("That one!", "", "en")).toBe("says none of the line");
  });
});

// A reader knowing only the words the cases below say, longest first; anything else reads as itself.
const PRONUNCIATIONS: Record<string, string> = {
  靴下: "クツシタ",
  仕立て: "シタテ",
  下れ: "クダレ",
  博士: "ハカセ",
  任せ: "マカセ",
  ホームズ: "ホームズ",
  さん: "サン",
  見える: "ミエル",
  と: "ト",
  は: "ワ",
  ね: "ネ",
  なの: "ナノ",
  の: "ノ",
  です: "デス",
  三: "サン",
  名: "メイ",
  ページ: "ページ",
  木: "キ",
  を: "ヲ",
  めくる: "メクル",
};
const read: JapaneseReader = (text) => {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const word = Object.keys(PRONUNCIATIONS)
      .filter((w) => text.startsWith(w, i))
      .sort((x, y) => y.length - x.length)[0];
    const end = i + (word?.length ?? 1);
    out.push({ at: i, end, pronunciation: word ? PRONUNCIATIONS[word]! : text.slice(i, end) });
    i = end;
  }
  return out;
};
const ja = japaneseHearing(read);

// A heard text as one token a character (Japanese) or a word (English), 0.2s apart.
const tokens = (heard: string, lang: string) =>
  (lang === "en" ? heard.split(/(?= )/) : [...heard]).map((text, i) => ({
    text,
    startSec: (i * 2) / 10,
  }));

const said = (...lines: string[]) => lines.map((text, i) => ({ text, number: i + 1 }));

describe("lineMishearing inside the lines", () => {
  it("names a Japanese word heard as another, by its pronunciation", () => {
    expect(lineMishearing(said("靴下の仕立て"), tokens("靴下の下れ", "ja"), ja)).toBe(
      'line 1: heard "下れ" for "仕立て"',
    );
  });

  it("names a word dropped inside a line, on the line that says it", () => {
    expect(
      lineMishearing(said("はい。", "ホームズさんは博士です"), tokens("はいは博士です", "ja"), ja),
    ).toBe('line 2: drops "ホームズさん"');
  });

  it("names a voice heard where no line has one, after the words it follows", () => {
    expect(
      lineMishearing(
        said("見えるとはね、博士です"),
        tokens("見えるとはねなのよ博士です", "ja"),
        ja,
      ),
    ).toBe('line 1: adds "なのよ" after "見えるとはね"');
  });

  it("passes a slip of under three kana", () => {
    expect(lineMishearing(said("博士です"), tokens("任せです", "ja"), ja)).toBeNull();
  });

  it("passes digits heard for a kanji number", () => {
    expect(lineMishearing(said("三名の博士です"), tokens("3名の博士です", "ja"), ja)).toBeNull();
  });

  it("names an English word dropped or added inside the lines, not one heard as another", () => {
    expect(
      lineMishearing(said("Okay, make it sync."), tokens("okay make make it sink", "en"), en),
    ).toBe('line 1: adds "make" after "Okay"');
    expect(lineMishearing(said("Now it is your turn."), tokens("now is your turn", "en"), en)).toBe(
      'line 1: drops "it"',
    );
    expect(
      lineMishearing(said("Accept the konte take."), tokens("except the conte take", "en"), en),
    ).toBeNull();
  });

  it("matches English words heard joined, split or contracted", () => {
    expect(
      lineMishearing(
        said("Run the checkin, you're done, Konte-chan, add it."),
        tokens("run the check in you are done conte chahn at it", "en"),
        en,
      ),
    ).toBeNull();
  });
});

describe("alignHeard", () => {
  it("splits one take's gaps and seconds across the lines it says", () => {
    const [first, second] = alignHeard(
      ["靴下の仕立て", "ページをめくる"],
      tokens("くつかの仕立て木をめくる", "ja"),
      ja,
    );
    expect(first!.gaps.map((g) => [g.range, g.heard, g.by, g.kind, g.size])).toEqual([
      [[0, 2], "くつか", "sound", "subst", 2],
    ]);
    expect(first!.secAt.slice(2)).toEqual([0.6, 0.8, 1, 1.2]);
    expect(first!.heard).toBe("くつかの仕立て");
    expect(second!.gaps.map((g) => [g.range, g.heard, g.kind])).toEqual([[[0, 3], "木", "subst"]]);
    expect(second!.gaps[0]!.sec).toEqual([1.4, 1.6]);
    expect(second!.heard).toBe("木をめくる");
  });

  it("marks a line dropped whole inside a gap over several lines", () => {
    const lines = alignHeard(
      ["Hello friend", "Take this box", "Bring the red bag", "See you later"],
      tokens("hello friend see you later", "en"),
      en,
    );
    expect(lines.map((l) => l.gaps.map((g) => [g.kind, g.range]))).toEqual([
      [],
      [["drop", [0, 13]]],
      [["drop", [0, 17]]],
      [],
    ]);
  });

  it("cuts a drop across two lines into the words each loses", () => {
    const lines = alignHeard(
      ["Hello friend take this", "bring the red bag here"],
      tokens("hello friend bag here", "en"),
      en,
    );
    expect(lines.map((l) => l.gaps.map((g) => [g.kind, g.range]))).toEqual([
      [["drop", [13, 22]]],
      [["drop", [0, 13]]],
    ]);
    expect(
      lineMishearing(
        said("Hello friend take this", "bring the red bag here"),
        tokens("hello friend take the red bag here", "en"),
        en,
      ),
    ).toBe('line 1: drops "this"; line 2: drops "bring"');
  });

  it("puts a drop between the words heard either side of it", () => {
    const [line] = alignHeard(["now it is your turn"], tokens("now is your turn", "en"), en);
    expect(line!.gaps).toEqual([
      { range: [4, 6], heard: "", sec: [0, 0.2], kind: "drop", size: 1, by: "sound" },
    ]);
    expect(line!.secAt.slice(0, 8)).toEqual([0, 0, 0, null, null, null, null, 0.2]);
  });

  it("times the last token to the take's end", () => {
    const [line] = alignHeard(["that one"], tokens("that one more", "en"), en, 0.5);
    expect(line!.gaps.map((g) => [g.kind, g.heard, g.sec])).toEqual([
      ["insert", "more", [0.4, 0.5]],
    ]);
  });
});

describe("markedGaps", () => {
  it("keeps a Japanese gap of two units or more, once per range", () => {
    const [line] = alignHeard(["博士の差出人"], tokens("任せの差し出し任", "ja"), ja);
    expect(markedGaps(line!.gaps, ja).map((g) => [g.range, g.heard])).toEqual([
      [[0, 2], "任せ"],
      [[5, 6], "し任"],
    ]);
  });
});

describe("lineMishearing on what it passes", () => {
  it("passes a word written with a numeral's scale alone, heard in kana", () => {
    expect(lineMishearing(said("千葉に行こうよ"), tokens("ちばに行こうよ", "ja"), ja)).toBeNull();
  });

  it("passes a voice heard before or after the lines", () => {
    expect(
      lineMishearing(said("Hello there my friend"), tokens("uh hello there my friend", "en"), en),
    ).toBeNull();
    expect(lineMishearing(said("Go now"), tokens("go now okay", "en"), en)).toBeNull();
  });

  it("names an end lost once, not again as a word heard as another", () => {
    const wrong = lineMishearing(
      said("ホームズさんは博士です"),
      tokens("ホームズさんは", "ja"),
      ja,
    );
    expect(wrong).toBe('line 1: drops the closing "博士です"');
  });
});
