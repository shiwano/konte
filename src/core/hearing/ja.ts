// Japanese, heard by its letters and by its pronunciation as IPADIC reads it.

import type { JapaneseReader } from "../japanese-reading.js";
import { japaneseReader } from "../japanese-reading.js";
import { lettersAt } from "../song-lyrics.js";
import {
  type HearingProfile,
  hanNumberValue,
  type Letter,
  letterUnits,
  MARKED_UNITS,
  type SoundUnit,
  writtenLetters,
} from "./units.js";

// The kana a kanji heard in a line's place stands for, near the 1.8 morae `estimateSpeechSec` reads
// it as.
const KANA_PER_KANJI = 2;
// The kana of a gap in the pronunciation that make a take misheard.
const MISHEARD_KANA = 3;

const HAN = /\p{Script=Han}/u;
const isHanUnit = (unit: SoundUnit) => unit.keys.some((k) => HAN.test(k));

const KANJI_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

// A number as Japanese writes it in kanji: 136 is `百三十六`, 1902 `千九百二`.
function kanjiNumber(n: number): string {
  if (n === 0) return "零";
  const under10k = (m: number) =>
    [
      [1000, "千"],
      [100, "百"],
      [10, "十"],
      [1, ""],
    ]
      .map(([scale, mark]) => {
        const d = Math.floor(m / (scale as number)) % 10;
        if (d === 0) return "";
        return `${d === 1 && mark !== "" ? "" : KANJI_DIGITS[d]}${mark}`;
      })
      .join("");
  let out = "";
  for (const [scale, mark] of [
    [1e12, "兆"],
    [1e8, "億"],
    [1e4, "万"],
    [1, ""],
  ] as const) {
    const part = Math.floor(n / scale) % 1e4;
    if (part > 0) out += `${under10k(part)}${mark}`;
  }
  return out;
}

const SMALL_VOWELS: Record<string, string> = { ぁ: "ば", ぃ: "び", ぅ: "ぶ", ぇ: "べ", ぉ: "ぼ" };

// `ゔ` and the small vowel after it as the `ば` row they are said as.
function foldVu(letters: Letter[]): Letter[] {
  const out: Letter[] = [];
  for (let i = 0; i < letters.length; i++) {
    const l = letters[i]!;
    if (l.ch !== "ゔ") {
      out.push(l);
      continue;
    }
    const small = letters[i + 1];
    const row = small && SMALL_VOWELS[small.ch];
    if (row) {
      out.push({ ch: row, at: l.at, end: small.end });
      i++;
    } else out.push({ ...l, ch: "ぶ" });
  }
  return out;
}

const VOWEL_ROWS: [vowel: string, kana: string][] = [
  ["あ", "あかさたなはまやらわがざだばぱぁゃゎ"],
  ["い", "いきしちにひみりぎじぢびぴぃ"],
  ["う", "うくすつぬふむゆるぐずづぶぷぅゅ"],
  ["え", "えけせてねへめれげぜでべぺぇ"],
  ["お", "おこそとのほもよろをごぞどぼぽぉょ"],
];
const VOWEL_OF = new Map(VOWEL_ROWS.flatMap(([v, kana]) => [...kana].map((k) => [k, v] as const)));

// A vowel that lengthens the one before it as `ー`: IPADIC writes `とう` and `ええ` as `トー` and `エー`
// where it knows the word, and as they are spelled where it does not.
function foldLongVowels(letters: Letter[]): Letter[] {
  return letters.map((l, i) => {
    const before = VOWEL_OF.get(letters[i - 1]?.ch ?? "");
    if (!before || !"あいうえお".includes(l.ch)) return l;
    const lengthens =
      l.ch === before || (l.ch === "う" && before === "お") || (l.ch === "い" && before === "え");
    return lengthens ? { ...l, ch: "ー" } : l;
  });
}

// `text` with each run of numerals holding a digit written in kanji, and the [at, end) of `text`
// each of its characters was written from.
function digitsAsKanji(text: string): { text: string; at: number[]; end: number[] } {
  let out = "";
  const at: number[] = [];
  const end: number[] = [];
  const put = (written: string, from: number, to: number) => {
    out += written;
    for (let c = 0; c < written.length; c++) {
      at.push(from);
      end.push(to);
    }
  };
  for (const m of text.matchAll(
    /[0-9０-９〇零一二三四五六七八九十百千万億兆]+|[^0-9０-９〇零一二三四五六七八九十百千万億兆]+/gu,
  )) {
    const run = m[0];
    const n = hanNumberValue(run.normalize("NFKC"));
    if (/[0-9０-９]/u.test(run) && Number.isSafeInteger(n))
      put(kanjiNumber(n), m.index, m.index + run.length);
    else for (let c = 0; c < run.length; c++) put(run[c]!, m.index + c, m.index + c + 1);
  }
  return { text: out, at, end };
}

// The kana a Japanese text is pronounced as, each kana keeping the [at, end) of its token.
function japaneseSounds(text: string, read: JapaneseReader): SoundUnit[] {
  const written = digitsAsKanji(text);
  return read(written.text).flatMap((token) => {
    const at = written.at[token.at]!;
    const end = written.end[token.end - 1]!;
    const kana = foldLongVowels(foldVu(lettersAt(token.pronunciation)));
    return kana.map((l) => ({ keys: [l.ch], at, end }));
  });
}

/** Japanese, its pronunciation read by `read` where given; without it, its letters alone. */
export function japaneseHearing(read?: JapaneseReader): HearingProfile {
  return {
    alignments: [
      {
        by: "letters",
        units: (text) => letterUnits(foldVu(writtenLetters(text))),
        // A kanji heard for kana, or kana for a kanji, is the pronunciation's to judge.
        defers: (line, heard) =>
          line.length > 0 && heard.length > 0 && line.some(isHanUnit) !== heard.some(isHanUnit),
      },
      ...(read
        ? [
            {
              by: "sound" as const,
              units: (text: string) => japaneseSounds(text, read),
              wordSpans: true,
            },
          ]
        : []),
    ],
    letters: writtenLetters,
    standIn: (ch) => (HAN.test(ch) ? KANA_PER_KANJI : 1),
    misheard: (gap) => gap.by === "sound" && gap.size >= MISHEARD_KANA,
    marked: (gap) => gap.size >= MARKED_UNITS,
  };
}

export async function loadJapaneseHearing(): Promise<HearingProfile> {
  return japaneseHearing(await japaneseReader());
}
