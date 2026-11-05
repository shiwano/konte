// What every language's hearing shares: the units a line and what a take is heard to say are made,
// each keeping the [at, end) of the text it is read off, and what a language decides about them.

import { lettersAt } from "../song-lyrics.js";

export type SoundUnit = {
  // The unit matches another sharing any key.
  keys: readonly string[];
  at: number;
  end: number;
  // The word a unit is, where the language joins two words to match one.
  word?: string;
};

// `letters`: the written letters. `sound`: what they sound as (a pronunciation, a word's sound).
type UnitAlignment = "letters" | "sound";

export type Letter = { ch: string; at: number; end: number };

export interface HeardGap {
  // The line's [start, end) the gap covers; an insert is zero-width.
  range: [start: number, end: number];
  // What is heard there.
  heard: string;
  // Where on the take.
  sec: [start: number, end: number];
  kind: "drop" | "insert" | "subst";
  // Units of the alignment that found it: kana of a Japanese pronunciation, English words, letters.
  size: number;
  by: UnitAlignment;
}

/** One way a language aligns a line with what is heard. */
export interface Alignment {
  by: UnitAlignment;
  units: (text: string) => SoundUnit[];
  // The keys two units sound as joined, where two may match one (`check in` / `checkin`).
  join?: (a: SoundUnit, b: SoundUnit) => readonly string[];
  // Whether each unit spans its whole word, so what is heard of a gap takes in the units matched
  // inside the words it covers (`靴下` heard as `くつか` matches its `くつ`).
  wordSpans?: boolean;
  // A gap this alignment leaves to another of the language's.
  defers?: (line: readonly SoundUnit[], heard: readonly SoundUnit[]) => boolean;
}

/** How a take is heard in one language. */
export interface HearingProfile {
  // In order; the first places each character of a line on the take.
  alignments: readonly Alignment[];
  // The letters an end of a line is read off.
  letters: (text: string) => Letter[];
  // How many of a line's letters a heard one stands in for at an end (a kanji for kana).
  standIn: (ch: string) => number;
  // Whether a gap inside the lines makes the take misheard.
  misheard: (gap: HeardGap) => boolean;
  // Whether the review marks a gap.
  marked: (gap: HeardGap) => boolean;
}

export function primaryLang(lang: string): string {
  return lang.split("-")[0]!.toLowerCase();
}

export function letterUnits(letters: Letter[]): SoundUnit[] {
  return letters.map((l) => ({ keys: [l.ch], at: l.at, end: l.end }));
}

// The fewest units of a gap the review marks, where a language marks by size.
export const MARKED_UNITS = 2;

const HAN_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const HAN_SCALES: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const HAN_MYRIADS: Record<string, number> = { 万: 1e4, 億: 1e8, 兆: 1e12 };

const isHanNumeral = (ch: string) => ch in HAN_DIGITS || ch in HAN_SCALES || ch in HAN_MYRIADS;
const isNumeral = (ch: string) => isHanNumeral(ch) || /^[0-9]$/.test(ch);

// The value of a run of Han numerals and digits: `百三十六`, `一三六` and `1百36` are all 136.
export function hanNumberValue(run: string): number {
  let total = 0;
  let section = 0;
  let digits: number | null = null;
  for (const ch of run) {
    const digit = /^[0-9]$/.test(ch) ? Number(ch) : HAN_DIGITS[ch];
    if (digit !== undefined) digits = (digits ?? 0) * 10 + digit;
    else if (ch in HAN_SCALES) {
      section += (digits ?? 1) * HAN_SCALES[ch]!;
      digits = null;
    } else {
      total += (section + (digits ?? (section === 0 ? 1 : 0))) * HAN_MYRIADS[ch]!;
      section = 0;
      digits = null;
    }
  }
  return total + section + (digits ?? 0);
}

// Each run of numerals holding a Han one and a digit as the digits of its value, every digit keeping
// the run's [at, end).
function foldHanNumerals(letters: Letter[]): Letter[] {
  const out: Letter[] = [];
  for (let i = 0; i < letters.length; ) {
    let j = i;
    while (
      j < letters.length &&
      isNumeral(letters[j]!.ch) &&
      (j === i || letters[j - 1]!.end === letters[j]!.at)
    )
      j++;
    const run = letters.slice(i, Math.max(j, i + 1));
    // A word written with a scale alone (`千葉`, `十分`) is no number.
    const digit = (ch: string) => ch in HAN_DIGITS || /^[0-9]$/.test(ch);
    if (!run.some((l) => isHanNumeral(l.ch)) || !run.some((l) => digit(l.ch))) {
      out.push(...run);
      i += run.length;
      continue;
    }
    const at = run[0]!.at;
    const end = run.at(-1)!.end;
    const value = hanNumberValue(run.map((l) => l.ch).join(""));
    for (const ch of String(value)) out.push({ ch, at, end });
    i = j;
  }
  return out;
}

/** The compared letters of `text`, a run of Han numerals read as the digits of its value. */
export function writtenLetters(text: string): Letter[] {
  return foldHanNumerals(lettersAt(text));
}
