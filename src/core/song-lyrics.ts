// Where each declared lyric line is sung, read off what the take's vocal track is heard to sing. The
// words are the direction's; the recognizer's are only matched against them, letter by letter in
// singing order, so a misheard word leaves the letters around it in place. A line opens where the
// first of its opening letters is heard, set back by the letters before it at the median pace
// between its heard letters (a held note does not slow it), and closes where the sung stretch its
// last heard letter falls in ends.
//
// A line is placed only where its opening is heard: one with fewer than `MIN_OPENING_HEARD` of its
// first `OPENING_LETTERS` letters heard (all of a shorter line's) is left for a person to place.

export type LyricPlacementInput = {
  // In declaration order. `set` is where a person placed the line on the take's own clock; such a
  // line is not looked for, and a line looked for is placed only between the set lines either side.
  lines: readonly { text: string; set?: { startSec: number; endSec: number } }[];
  heard: readonly { text: string; startSec: number }[] | null;
  phrases: readonly { startSec: number; endSec: number }[] | null;
};

// A line's place on the take's clock, or null where it is not heard. `set` is a line a person placed.
export type LyricPlacement = { startSec: number; endSec: number; set: boolean } | null;

const OPENING_LETTERS = 10;
const MIN_OPENING_HEARD = 2;
// The most a token's letters are spread apart, and the pace a line with one letter heard is sung at.
const LETTER_SEC = 0.08;
const MIN_LETTER_SEC = 0.03;
const MAX_LETTER_SEC = 0.4;
// How long a line holds its last heard letter where no sung stretch says.
const TAIL_SEC = 0.5;
// The cost of a lyric letter heard as nothing, and of a heard letter in no lyric.
const UNHEARD = 1;
const UNSUNG = 0.6;
const VOWELS = new Set([..."aeiouy"]);

// What is compared of a text: its letters and digits, case and kana folded.
function letters(text: string): string[] {
  return [
    ...text
      .replace(/<\|[^|]*\|>/g, "")
      .normalize("NFKC")
      .toLowerCase(),
  ]
    .filter((ch) => /[\p{L}\p{N}]/u.test(ch))
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
    });
}

// Every heard letter and the second it is sung at, a token's letters spread over the time to the
// next token, at most `LETTER_SEC` apart.
function heardLetters(
  heard: readonly { text: string; startSec: number }[],
): { ch: string; sec: number }[] {
  return heard.flatMap((token, i) => {
    const chars = letters(token.text);
    const next = heard[i + 1]?.startSec ?? Infinity;
    const span = Math.min(next - token.startSec, chars.length * LETTER_SEC);
    return chars.map((ch, k) => ({ ch, sec: token.startSec + (span * k) / chars.length }));
  });
}

function mismatch(a: string, b: string): number {
  if (a === b) return 0;
  return VOWELS.has(a) === VOWELS.has(b) ? 0.7 : 1;
}

// For each sung letter, the heard letter it is matched to exactly, or -1: the cheapest alignment of
// the two in order.
function matchLetters(sung: readonly string[], heard: readonly string[]): Int32Array {
  const n = sung.length;
  const m = heard.length;
  const cost = new Float32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) cost[at(i, 0)] = i * UNHEARD;
  for (let j = 1; j <= m; j++) cost[at(0, j)] = j * UNSUNG;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[at(i, j)] = Math.min(
        cost[at(i - 1, j - 1)]! + mismatch(sung[i - 1]!, heard[j - 1]!),
        cost[at(i - 1, j)]! + UNHEARD,
        cost[at(i, j - 1)]! + UNSUNG,
      );
    }
  }
  const matched = new Int32Array(n).fill(-1);
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const here = cost[at(i, j)]!;
    const step = mismatch(sung[i - 1]!, heard[j - 1]!);
    if (same(here, cost[at(i - 1, j - 1)]! + step)) {
      if (step === 0) matched[i - 1] = j - 1;
      i--;
      j--;
    } else if (same(here, cost[at(i - 1, j)]! + UNHEARD)) i--;
    else j--;
  }
  return matched;
}

export function placeLyricLines(input: LyricPlacementInput): LyricPlacement[] {
  const placements: LyricPlacement[] = input.lines.map((line) =>
    line.set ? { ...line.set, set: true } : null,
  );
  // The lines between two set ones are matched against what is heard between them, the set line
  // before them leading so that its own words are not taken for theirs.
  const n = input.lines.length;
  let lead = -1;
  for (let i = 0; input.heard && i <= n; i++) {
    const ceiling = i < n ? input.lines[i]!.set?.startSec : Infinity;
    if (ceiling === undefined) continue;
    const ids = Array.from({ length: i - lead - 1 }, (_, k) => lead + 1 + k);
    const leading = input.lines[lead];
    const floor = leading?.set?.startSec ?? -Infinity;
    const found = findLines(
      [...(leading ? [leading.text] : []), ...ids.map((id) => input.lines[id]!.text)],
      input.heard.filter((t) => t.startSec >= floor && t.startSec < ceiling),
      input.phrases ?? [],
    ).slice(leading ? 1 : 0);
    ids.forEach((id, k) => {
      placements[id] = found[k] ?? null;
    });
    lead = i;
  }

  // A line found out of order with the lines before it, or past the next set line, is not placed.
  let floor = -Infinity;
  placements.forEach((p, i) => {
    if (!p) return;
    const ceiling = placements.slice(i + 1).find((q) => q?.set)?.startSec ?? Infinity;
    if (!p.set && (p.startSec <= floor || p.startSec >= ceiling)) placements[i] = null;
    else floor = p.startSec;
  });
  // A found line closes no later than the next placed line opens.
  placements.forEach((p, i) => {
    if (!p || p.set) return;
    const next = placements.slice(i + 1).find((q) => q !== null)?.startSec ?? Infinity;
    p.endSec = Math.max(p.startSec, Math.min(p.endSec, next));
  });
  return placements;
}

function findLines(
  lines: readonly string[],
  heard: NonNullable<LyricPlacementInput["heard"]>,
  phrases: NonNullable<LyricPlacementInput["phrases"]>,
): LyricPlacement[] {
  const sung: string[] = [];
  const lineOf: number[] = [];
  lines.forEach((line, l) => {
    for (const ch of letters(line)) {
      sung.push(ch);
      lineOf.push(l);
    }
  });
  const heardAt = heardLetters(heard);
  const matched = matchLetters(
    sung,
    heardAt.map((h) => h.ch),
  );
  const secOf = (k: number) => heardAt[matched[k]!]!.sec;

  return lines.map((_, l): LyricPlacement => {
    const own = lineOf.flatMap((owner, k) => (owner === l ? [k] : []));
    const opening = own.slice(0, OPENING_LETTERS).filter((k) => matched[k]! >= 0);
    if (opening.length === 0 || opening.length < Math.min(MIN_OPENING_HEARD, own.length)) {
      return null;
    }
    const heardOwn = own.filter((k) => matched[k]! >= 0);
    const first = heardOwn[0]!;
    const last = heardOwn.at(-1)!;
    const gaps = heardOwn
      .slice(1)
      .map((k, i) => (secOf(k) - secOf(heardOwn[i]!)) / (k - heardOwn[i]!))
      .sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] ?? LETTER_SEC;
    const pace = Math.min(MAX_LETTER_SEC, Math.max(MIN_LETTER_SEC, median));
    const startSec = Math.max(0, secOf(first) - pace * (first - own[0]!));
    const lastSec = secOf(last);
    const stretch = phrases.find((p) => p.startSec <= lastSec && lastSec < p.endSec);
    return {
      startSec: round(startSec),
      endSec: round(Math.max(startSec, stretch?.endSec ?? lastSec + TAIL_SEC)),
      set: false,
    };
  });
}

function round(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}
