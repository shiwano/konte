// English, heard word by word as each word sounds (Double Metaphone).

import { doubleMetaphone } from "double-metaphone";
import { type HearingProfile, type Letter, type SoundUnit, writtenLetters } from "./units.js";

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
  [100, "hundred"],
];
const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), ...SCALES.map(([, w]) => w), "a"]);

function numberWords(n: number): string[] {
  for (const [scale, word] of SCALES) {
    if (n >= scale) {
      const rest = n % scale;
      return [...numberWords(Math.floor(n / scale)), word, ...(rest > 0 ? numberWords(rest) : [])];
    }
  }
  if (n < 20) return [ONES[n]!];
  return [TENS[Math.floor(n / 10)]!, ...(n % 10 > 0 ? [ONES[n % 10]!] : [])];
}

// A digit run in English, as the words it is read as.
function spellDigits(digits: string): string[] | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n < 1_000_000_000_000 ? numberWords(n) : null;
}

// The letters of an English text, a run of digits spelled out: a recognizer writes `19` where the
// line has `nineteen`.
function englishLetters(text: string): Letter[] {
  const out: Letter[] = [];
  let digits: Letter[] = [];
  const flush = () => {
    if (digits.length === 0) return;
    const spelled = spellDigits(digits.map((l) => l.ch).join(""));
    if (spelled) {
      const { at } = digits[0]!;
      const { end } = digits.at(-1)!;
      for (const ch of spelled.join("")) out.push({ ch, at, end });
    } else out.push(...digits);
    digits = [];
  };
  for (const l of writtenLetters(text)) {
    if (!/\d/.test(l.ch)) {
      flush();
      out.push(l);
      continue;
    }
    if (digits.length > 0 && digits.at(-1)!.end !== l.at) flush();
    digits.push(l);
  }
  flush();
  return out;
}

const CONTRACTIONS: Record<string, string[]> = {
  "won't": ["will", "not"],
  "can't": ["can", "not"],
  "shan't": ["shall", "not"],
  "let's": ["let", "us"],
  "i'm": ["i", "am"],
};
const SUFFIXES: [suffix: string, words: string[]][] = [
  ["n't", ["not"]],
  ["'re", ["are"]],
  ["'ve", ["have"]],
  ["'ll", ["will"]],
  ["'d", ["would"]],
];
const IS_CONTRACTED = new Set(["it", "that", "what", "there", "here", "he", "she", "who", "where"]);

function expandContraction(word: string): string[] {
  const whole = CONTRACTIONS[word];
  if (whole) return whole;
  for (const [suffix, words] of SUFFIXES) {
    if (word.endsWith(suffix) && word.length > suffix.length) {
      return [word.slice(0, -suffix.length), ...words];
    }
  }
  if (word.endsWith("'s") && IS_CONTRACTED.has(word.slice(0, -2))) return [word.slice(0, -2), "is"];
  return [word.replace(/'/g, "")];
}

function metaphoneKeys(word: string): string[] {
  const keys = doubleMetaphone(word).filter((k) => k !== "");
  return keys.length > 0 ? [...new Set(keys)] : [`=${word}`];
}

// The keys two English words heard as one are matched on.
function joinedWordKeys(a: SoundUnit, b: SoundUnit): string[] {
  return metaphoneKeys(`${a.word ?? ""}${b.word ?? ""}`);
}

// The words of an English text, contractions expanded and digits spelled, each word as its two
// Double Metaphone keys. An `and` inside a number (`a hundred and nineteen`) is not compared.
function englishWords(text: string): SoundUnit[] {
  const words: { word: string; at: number; end: number }[] = [];
  for (const m of text.matchAll(/\p{L}+(?:['’]\p{L}+)*|\p{N}+/gu)) {
    const at = m.index;
    const end = at + m[0].length;
    const raw = m[0].normalize("NFKC").toLowerCase().replace(/’/g, "'");
    const spelled = /^\d+$/.test(raw) ? spellDigits(raw) : null;
    for (const word of spelled ?? expandContraction(raw)) words.push({ word, at, end });
  }
  return words
    .filter(
      (w, i) =>
        !(
          w.word === "and" &&
          NUMBER_WORDS.has(words[i - 1]?.word ?? "") &&
          NUMBER_WORDS.has(words[i + 1]?.word ?? "")
        ),
    )
    .map((w) => ({ keys: metaphoneKeys(w.word), at: w.at, end: w.end, word: w.word }));
}

export const englishHearing: HearingProfile = {
  alignments: [{ by: "sound", units: englishWords, join: joinedWordKeys }],
  letters: englishLetters,
  standIn: () => 1,
  // A word heard as another is too often the recognizer's spelling (`sync` / `sink`).
  misheard: (gap) => gap.kind !== "subst",
  marked: () => true,
};
