// Whether a take says the line it owes, read off what it is heard to say. The line and the heard
// words are aligned letter by letter (`matchLetters`). What a take loses to a clip cut too short is
// a run at either end of the line with nothing heard against it.

import { lettersAt, matchLetters } from "./song-lyrics.js";

// The shortest run at an end of the line that counts as dropped: a recognizer's slip at a word
// boundary (`a` heard as `1`, `whoa` as `wow`) leaves one letter unmatched, a lost word several.
const MIN_DROPPED_LETTERS = 3;
// The kana a kanji heard in a Japanese line's place stands for, near the 1.8 morae
// `estimateSpeechSec` reads it as.
const KANA_PER_KANJI = 2;
// A line this long or longer with under this share of its letters heard says other words: a
// reordered or rewritten read keeps its ends but not its middle.
const MIN_LINE_LETTERS = 12;
const MIN_HEARD_SHARE = 0.5;

const HAN_DIGITS: Record<string, string> = {
  〇: "0",
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
};

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

function spellNumber(n: number): string {
  for (const [scale, word] of SCALES) {
    if (n >= scale) {
      const rest = n % scale;
      return `${spellNumber(Math.floor(n / scale))}${word}${rest > 0 ? spellNumber(rest) : ""}`;
    }
  }
  if (n < 20) return ONES[n]!;
  return `${TENS[Math.floor(n / 10)]}${n % 10 > 0 ? ONES[n % 10] : ""}`;
}

type Letter = { ch: string; at: number; end: number };

function primaryLang(lang: string): string {
  return lang.split("-")[0]!.toLowerCase();
}

// The compared letters of `text`. A Han numeral is read as its digit, on both sides alike; in English
// a run of digits is spelled out, since a recognizer writes `19` where the line has `nineteen`.
function comparedLetters(text: string, lang: string): Letter[] {
  const letters = lettersAt(text).map((l) => ({ ...l, ch: HAN_DIGITS[l.ch] ?? l.ch }));
  if (primaryLang(lang) !== "en") return letters;
  const out: Letter[] = [];
  let digits: Letter[] = [];
  const flush = () => {
    if (digits.length === 0) return;
    const n = Number(digits.map((l) => l.ch).join(""));
    if (Number.isSafeInteger(n) && n < 1_000_000_000_000) {
      const { at } = digits[0]!;
      const { end } = digits.at(-1)!;
      for (const ch of spellNumber(n)) out.push({ ch, at, end });
    } else out.push(...digits);
    digits = [];
  };
  for (const l of letters) {
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

/**
 * What a take heard as `heard` gets wrong of `line`, as a clause (`drops the opening "Bigger!"`), or
 * null where it says the line. `lang` is the BCP 47 tag the line is written in.
 */
export function lineMishearing(line: string, heard: string, lang: string): string | null {
  const said = comparedLetters(line, lang);
  if (said.length === 0) return null;
  const heardLetters = comparedLetters(heard, lang);
  const matched = matchLetters(
    said.map((l) => l.ch),
    heardLetters.map((l) => l.ch),
  );
  const heardCount = matched.filter((m) => m >= 0).length;
  const ja = primaryLang(lang) === "ja";
  // A kanji heard where a Japanese line spells the word in kana matches none of its letters, so the
  // kanji nothing matched stand in for that many of the line's unmatched ones.
  const matchedHeard = new Set(matched);
  const kanjiStandIns = ja
    ? heardLetters.filter((l, j) => !matchedHeard.has(j) && /\p{Script=Han}/u.test(l.ch)).length *
      KANA_PER_KANJI
    : 0;
  const covered = heardCount + Math.min(said.length - heardCount, kanjiStandIns);
  if (heardCount === 0) {
    return said.length - covered >= MIN_DROPPED_LETTERS ? "says none of the line" : null;
  }

  const heardAt = (i: number) => matched[i]! >= 0;
  // What is quoted as dropped is read off the letters heard in runs, where the line has any: a lone
  // letter matched inside a lost stretch is the alignment pairing a common kana or letter by chance.
  // Whether anything is dropped is not — a kanji heard as kana leaves its lone kana matched too.
  const inRun = (i: number) => heardAt(i) && (heardAt(i - 1) || heardAt(i + 1));
  const anchored = said.some((_, i) => inRun(i)) ? inRun : heardAt;
  const unheardRun = (from: number, step: number, heard: (i: number) => boolean) => {
    let n = 0;
    while (!heard(from + n * step)) n++;
    return n;
  };
  // An end's lost letters count less those the take is heard to say in their place: the same words
  // in another spelling (`とうきょう` heard as `東京`) are not dropped ones.
  const standIns = (from: number, to: number) =>
    heardLetters
      .slice(from, to)
      .reduce((n, l) => n + (ja && /\p{Script=Han}/u.test(l.ch) ? KANA_PER_KANJI : 1), 0);
  const opening = unheardRun(0, 1, heardAt);
  if (opening - standIns(0, matched[opening]!) >= MIN_DROPPED_LETTERS) {
    const head = unheardRun(0, 1, anchored);
    return `drops the opening "${extendToWordEnd(line, said[head - 1]!.end)}"`;
  }
  const last = said.length - 1;
  const closing = unheardRun(last, -1, heardAt);
  if (
    closing - standIns(matched[last - closing]! + 1, heardLetters.length) >=
    MIN_DROPPED_LETTERS
  ) {
    const tail = unheardRun(last, -1, anchored);
    return `drops the closing "${line.slice(said[said.length - tail]!.at).trim()}"`;
  }
  if (said.length >= MIN_LINE_LETTERS && covered / said.length < MIN_HEARD_SHARE) {
    return "says other words";
  }
  return null;
}

// The line up to `end`, with the punctuation that closes the word there.
function extendToWordEnd(line: string, end: number): string {
  const rest = line.slice(end).match(/^[^\p{L}\p{N}\s]*/u)![0];
  return line.slice(0, end + rest.length).trim();
}
