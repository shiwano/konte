// Whether a take says the lines it owes, read off what it is heard to say. The lines and the heard
// words are each made the units their language hears them as (`HearingProfile`) and aligned unit by
// unit; what lies between two matched units is a gap. What a take loses to a clip cut too short is a run at either
// end of the lines with nothing heard against it, read letter by letter.

import type { Alignment, HearingProfile, HeardGap, SoundUnit } from "./hearing/units.js";
import { matchLetters } from "./song-lyrics.js";
import type { HeardSpeech } from "./types/index.js";

export type { HeardGap } from "./hearing/units.js";

// The shortest run at an end of the line that counts as dropped: a recognizer's slip at a word
// boundary (`a` heard as `1`, `whoa` as `wow`) leaves one letter unmatched, a lost word several.
const MIN_DROPPED_LETTERS = 3;
// A whole word lost at an end, with nothing heard in its place, is dropped however short (`Oh!`): a
// slip leaves part of a word matched, or a word of one letter unheard.
const MIN_DROPPED_WORD_LETTERS = 2;
// A line this long or longer with under this share of its letters heard says other words: a
// reordered or rewritten read keeps its ends but not its middle.
const MIN_LINE_LETTERS = 12;
const MIN_HEARD_SHARE = 0.5;
// How long the last heard token is taken to last.
const LAST_TOKEN_SEC = 0.3;
// The cost of a line's unit heard as nothing, and of a heard unit in no line.
const UNHEARD = 1;
const UNSAID = 0.6;

export interface HeardLine {
  // The take-second each of the line's characters is heard at; null where nothing is heard of it.
  secAt: (number | null)[];
  gaps: HeardGap[];
  // What is heard of the line.
  heard: string;
}

// A take's tokens as one text, and where each character of it is on the take.
type HeardClock = { text: string; startAt: number[]; endAt: number[] };

function heardClock(heard: HeardSpeech["heard"], durationSec?: number): HeardClock {
  let text = "";
  const startAt: number[] = [];
  const endAt: number[] = [];
  heard.forEach((token, k) => {
    const end =
      heard[k + 1]?.startSec ??
      Math.min(token.startSec + LAST_TOKEN_SEC, durationSec ?? Number.POSITIVE_INFINITY);
    text += token.text;
    for (let c = 0; c < token.text.length; c++) {
      startAt.push(token.startSec);
      endAt.push(Math.max(end, token.startSec));
    }
  });
  return { text, startAt, endAt };
}

// Units matched, as the line's [a0, a1) against the heard [b0, b1).
type Span = { a: [number, number]; b: [number, number] };

const sameUnit = (x: SoundUnit, y: SoundUnit) => x.keys.some((k) => y.keys.includes(k));
const sameKeys = (keys: readonly string[], y: SoundUnit) => keys.some((k) => y.keys.includes(k));

// The cheapest alignment of units in order, two matching one where they sound alike `join`ed.
function alignJoined(
  a: readonly SoundUnit[],
  b: readonly SoundUnit[],
  join: NonNullable<Alignment["join"]>,
): Span[] {
  const n = a.length;
  const m = b.length;
  const cost = new Float64Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  const joinedA = a.map((u, i) => (i > 0 ? join(a[i - 1]!, u) : []));
  const joinedB = b.map((u, j) => (j > 0 ? join(b[j - 1]!, u) : []));
  for (let i = 1; i <= n; i++) cost[at(i, 0)] = i * UNHEARD;
  for (let j = 1; j <= m; j++) cost[at(0, j)] = j * UNSAID;
  const steps = (i: number, j: number) => {
    const out: { cost: number; di: number; dj: number; match: boolean }[] = [];
    if (i > 0 && j > 0) {
      const match = sameUnit(a[i - 1]!, b[j - 1]!);
      out.push({ cost: cost[at(i - 1, j - 1)]! + (match ? 0 : 1), di: 1, dj: 1, match });
    }
    if (i > 1 && j > 0 && sameKeys(joinedA[i - 1]!, b[j - 1]!)) {
      out.push({ cost: cost[at(i - 2, j - 1)]!, di: 2, dj: 1, match: true });
    }
    if (i > 0 && j > 1 && sameKeys(joinedB[j - 1]!, a[i - 1]!)) {
      out.push({ cost: cost[at(i - 1, j - 2)]!, di: 1, dj: 2, match: true });
    }
    if (i > 0) out.push({ cost: cost[at(i - 1, j)]! + UNHEARD, di: 1, dj: 0, match: false });
    if (j > 0) out.push({ cost: cost[at(i, j - 1)]! + UNSAID, di: 0, dj: 1, match: false });
    return out;
  };
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[at(i, j)] = Math.min(...steps(i, j).map((s) => s.cost));
    }
  }
  const spans: Span[] = [];
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const here = cost[at(i, j)]!;
    const options = steps(i, j);
    const step =
      options.find((s) => s.match && Math.abs(s.cost - here) < 1e-9) ??
      options.find((s) => Math.abs(s.cost - here) < 1e-9)!;
    if (step.match) spans.push({ a: [i - step.di, i], b: [j - step.dj, j] });
    i -= step.di;
    j -= step.dj;
  }
  return spans.reverse();
}

function alignUnits(
  a: readonly SoundUnit[],
  b: readonly SoundUnit[],
  join: Alignment["join"],
): Span[] {
  if (join) return alignJoined(a, b, join);
  const matched = matchLetters(
    a.map((u) => u.keys[0]!),
    b.map((u) => u.keys[0]!),
  );
  const spans: Span[] = [];
  matched.forEach((j, i) => {
    if (j >= 0) spans.push({ a: [i, i + 1], b: [j, j + 1] });
  });
  return spans;
}

// A gap on the joined lines, and the end of them it is at where nothing is matched before or after
// it.
type TakeGap = HeardGap & { end: "opening" | "closing" | null };

type TakeAlignment = {
  joined: string;
  lineStarts: number[];
  clock: HeardClock;
  gaps: TakeGap[];
  // The take-second each character of `joined` is heard at.
  secAt: (number | null)[];
  // The heard [at, end) given to each line.
  heardAt: ([number, number] | null)[];
};

function lineIndexOf(lineStarts: readonly number[], at: number): number {
  for (let k = lineStarts.length - 1; k >= 0; k--) if (lineStarts[k]! <= at) return k;
  return 0;
}

// The line a joined [s, e) belongs to: the one it covers most of, or for a zero-width one the line
// it sits in or ends.
function lineOfRange(starts: readonly number[], lines: readonly string[], s: number, e: number) {
  if (s === e) {
    for (let k = 0; k < lines.length; k++) {
      if (s <= starts[k]! + lines[k]!.length) return k;
    }
    return lines.length - 1;
  }
  let best = 0;
  let bestOverlap = -1;
  for (let k = 0; k < lines.length; k++) {
    const overlap = Math.min(e, starts[k]! + lines[k]!.length) - Math.max(s, starts[k]!);
    if (overlap > bestOverlap) {
      best = k;
      bestOverlap = overlap;
    }
  }
  return best;
}

function alignTake(
  lines: readonly string[],
  heard: HeardSpeech["heard"],
  hearing: HearingProfile,
  durationSec: number | undefined,
): TakeAlignment {
  const joined = lines.join(" ");
  const lineStarts: number[] = [];
  lines.reduce((at, line) => {
    lineStarts.push(at);
    return at + line.length + 1;
  }, 0);
  const clock = heardClock(heard, durationSec);
  const secAt: (number | null)[] = Array.from({ length: joined.length }, () => null);
  const heardAt: ([number, number] | null)[] = lines.map(() => null);
  const own = (k: number, at: number, end: number) => {
    const cur = heardAt[k];
    heardAt[k] = cur ? [Math.min(cur[0], at), Math.max(cur[1], end)] : [at, end];
  };
  const gaps: TakeGap[] = [];

  hearing.alignments.forEach((seq, s) => {
    const a = seq.units(joined);
    const b = seq.units(clock.text);
    const spans = alignUnits(a, b, seq.join);
    const primary = s === 0;
    for (const span of spans) {
      const first = b[span.b[0]]!;
      const last = b[span.b[1] - 1]!;
      const sec = clock.startAt[first.at] ?? null;
      for (let i = span.a[0]; i < span.a[1]; i++) {
        for (let c = a[i]!.at; c < a[i]!.end; c++) secAt[c] ??= sec;
      }
      if (primary) own(lineIndexOf(lineStarts, a[span.a[0]]!.at), first.at, last.end);
    }
    const anchors: Span[] = [
      { a: [0, 0], b: [0, 0] },
      ...spans,
      { a: [a.length, a.length], b: [b.length, b.length] },
    ];
    for (let k = 1; k < anchors.length; k++) {
      const [a0, a1] = [anchors[k - 1]!.a[1], anchors[k]!.a[0]];
      const [b0, b1] = [anchors[k - 1]!.b[1], anchors[k]!.b[0]];
      if (a0 === a1 && b0 === b1) continue;
      const lineSide = a.slice(a0, a1);
      const heardSide = b.slice(b0, b1);
      const range: [number, number] =
        lineSide.length > 0
          ? [lineSide[0]!.at, lineSide.at(-1)!.end]
          : a0 > 0
            ? [a[a0 - 1]!.end, a[a0 - 1]!.end]
            : [a[0]?.at ?? 0, a[0]?.at ?? 0];
      // What is heard of the words the gap covers, the units matched inside them included: `靴下`
      // heard as `くつか` matches its `くつ`.
      const covering = (seq.wordSpans ? spans : []).filter((sp) => {
        const u = a[sp.a[0]]!;
        return u.at >= range[0] && u.end <= range[1];
      });
      const heardEnds = [
        ...heardSide.flatMap((u) => [u.at, u.end]),
        ...covering.flatMap((sp) => [b[sp.b[0]]!.at, b[sp.b[1] - 1]!.end]),
      ];
      const heardRange: [number, number] | null =
        heardEnds.length > 0 ? [Math.min(...heardEnds), Math.max(...heardEnds)] : null;
      if (primary && heardRange) {
        own(lineOfRange(lineStarts, lines, range[0], range[1]), heardRange[0], heardRange[1]);
      }
      if (seq.defers?.(lineSide, heardSide)) continue;
      const before = b0 > 0 ? b[b0 - 1] : undefined;
      const after = b1 < b.length ? b[b1] : undefined;
      const lastEnd = clock.endAt.at(-1) ?? 0;
      const sec: [number, number] = heardRange
        ? [clock.startAt[heardRange[0]]!, clock.endAt[heardRange[1] - 1]!]
        : [
            before ? clock.startAt[before.at]! : 0,
            after ? clock.startAt[after.at]! : before ? clock.endAt[before.end - 1]! : lastEnd,
          ];
      gaps.push({
        range,
        heard: heardRange ? clock.text.slice(heardRange[0], heardRange[1]).trim() : "",
        sec,
        kind: lineSide.length === 0 ? "insert" : heardRange === null ? "drop" : "subst",
        size: Math.max(lineSide.length, heardSide.length),
        by: seq.by,
        end: k === 1 ? "opening" : k === anchors.length - 1 ? "closing" : null,
      });
    }
  });
  gaps.sort((x, y) => x.range[0] - y.range[0] || x.range[1] - y.range[1]);
  return { joined, lineStarts, clock, gaps, secAt, heardAt };
}

// Each gap of a take on the lines it lies over, its range each line's own. A drop is cut at the
// lines' bounds, each line losing its own words. What is heard in a line's place stays with the line
// it covers most of, and any other line it covers whole is that line dropped.
function gapsByLine(take: TakeAlignment, lines: readonly string[]): TakeGap[][] {
  const out: TakeGap[][] = lines.map(() => []);
  for (const gap of take.gaps) {
    const [s, e] = gap.range;
    const owner = lineOfRange(take.lineStarts, lines, s, e);
    lines.forEach((line, k) => {
      const start = take.lineStarts[k]!;
      const end = start + line.length;
      const clip = (x: number) => Math.min(Math.max(x - start, 0), line.length);
      if (k === owner) {
        out[k]!.push({ ...gap, range: [clip(s), clip(e)] });
        return;
      }
      const crosses = gap.kind === "drop" ? s < end && start < e : s <= start && end <= e;
      if (!crosses || line.length === 0) return;
      out[k]!.push({ ...gap, kind: "drop", heard: "", range: [clip(s), clip(e)] });
    });
  }
  return out;
}

/**
 * What a take heard as `heard` says of each of `lines` — the lines it owes, in the order it says
 * them, heard as `hearing` hears their language. `durationSec` is the take's length.
 */
export function alignHeard(
  lines: readonly string[],
  heard: HeardSpeech["heard"],
  hearing: HearingProfile,
  durationSec?: number,
): HeardLine[] {
  const take = alignTake(lines, heard, hearing, durationSec);
  const gaps = gapsByLine(take, lines);
  return lines.map((line, k) => {
    const at = take.heardAt[k];
    return {
      secAt: take.secAt.slice(take.lineStarts[k], take.lineStarts[k]! + line.length),
      gaps: gaps[k]!.map(({ end: _end, ...gap }) => gap),
      heard: at ? take.clock.text.slice(at[0], at[1]).trim() : "",
    };
  });
}

/**
 * The gaps a review marks on a line, as `hearing` marks them. Where two of its alignments find one
 * place, the wider gap is kept.
 */
export function markedGaps(gaps: readonly HeardGap[], hearing: HearingProfile): HeardGap[] {
  const width = (g: HeardGap) => g.range[1] - g.range[0];
  const overlaps = (x: HeardGap, y: HeardGap) =>
    x.range[0] <= y.range[1] && y.range[0] <= x.range[1] && width(x) > 0 === width(y) > 0;
  const kept: HeardGap[] = [];
  for (const g of [...gaps].filter(hearing.marked).sort((x, y) => width(y) - width(x))) {
    if (!kept.some((k) => overlaps(k, g))) kept.push(g);
  }
  return kept.sort((x, y) => x.range[0] - y.range[0]);
}

/** A line a take owes, and its number in the shot's script (1-based). */
export type SaidLine = { text: string; number: number };

// The clause of the line before `at`, back to the last punctuation or space.
function clauseBefore(line: string, at: number): string {
  const head = line.slice(0, at).replace(/[^\p{L}\p{N}]+$/u, "");
  const m = /[\p{L}\p{N}]+(?:[^\p{L}\p{N}\s、。，．,.!?！？「」『』]+[\p{L}\p{N}]+)*$/u.exec(head);
  return m ? m[0] : head;
}

function clauseAfter(line: string, at: number): string {
  const m = /^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u.exec(line.slice(at));
  return m ? m[1]! : "";
}

function gapClause(gap: HeardGap, line: SaidLine): string {
  const said = line.text.slice(gap.range[0], gap.range[1]).trim();
  const where = `line ${line.number}`;
  if (gap.kind === "subst") return `${where}: heard "${gap.heard}" for "${said}"`;
  if (gap.kind === "drop") return `${where}: drops "${said}"`;
  const before = clauseBefore(line.text, gap.range[0]);
  return before
    ? `${where}: adds "${gap.heard}" after "${before}"`
    : `${where}: adds "${gap.heard}" before "${clauseAfter(line.text, gap.range[0])}"`;
}

/**
 * What a take heard as `heard` gets wrong of `lines`, as clauses (`line 2: heard "下れ" for "仕立て"`),
 * or null where it says them, heard as `hearing` hears their language.
 */
export function lineMishearing(
  lines: readonly SaidLine[],
  heard: HeardSpeech["heard"],
  hearing: HearingProfile,
): string | null {
  if (lines.length === 0) return null;
  const texts = lines.map((l) => l.text);
  const words = heard
    .map((t) => t.text)
    .join("")
    .trim();
  const end = endMishearing(texts.join(" "), words, hearing);
  if (end?.at === "whole") return end.clause;
  const clauses: string[] = [];
  if (end)
    clauses.push(
      `line ${lines[end.at === "opening" ? 0 : lines.length - 1]!.number}: ${end.clause}`,
    );
  const take = alignTake(texts, heard, hearing, undefined);
  gapsByLine(take, texts).forEach((gaps, k) => {
    for (const gap of gaps) {
      // At an end, only a word heard as another: a drop there is read letter by letter above, and
      // a voice before or after the lines is no word of them.
      if (gap.end && (gap.kind !== "subst" || gap.end === end?.at)) continue;
      if (hearing.misheard(gap)) clauses.push(gapClause(gap, lines[k]!));
    }
  });
  return clauses.length > 0 ? clauses.join("; ") : null;
}

// What a take heard as `heard` loses at an end of `line`, or whether it says other words.
function endMishearing(
  line: string,
  heard: string,
  hearing: HearingProfile,
): { clause: string; at: "opening" | "closing" | "whole" } | null {
  const said = hearing.letters(line);
  if (said.length === 0) return null;
  const heardLetters = hearing.letters(heard);
  const matched = matchLetters(
    said.map((l) => l.ch),
    heardLetters.map((l) => l.ch),
  );
  const heardCount = matched.filter((m) => m >= 0).length;
  // A letter standing in for several (a kanji heard where a Japanese line spells the word in kana)
  // matches none of them, so the ones nothing matched stand in for that many of the line's
  // unmatched letters.
  const matchedHeard = new Set(matched);
  const kanjiStandIns = heardLetters
    .filter((l, j) => !matchedHeard.has(j) && hearing.standIn(l.ch) > 1)
    .reduce((n, l) => n + hearing.standIn(l.ch), 0);
  const covered = heardCount + Math.min(said.length - heardCount, kanjiStandIns);
  if (heardCount === 0) {
    return said.length - covered >= MIN_DROPPED_LETTERS
      ? { clause: "says none of the line", at: "whole" }
      : null;
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
    heardLetters.slice(from, to).reduce((n, l) => n + hearing.standIn(l.ch), 0);
  // Whether the letters at `i` and `i + 1` belong to two words of the line.
  const wordBreak = (i: number) => /\s/u.test(line.slice(said[i]!.end, said[i + 1]!.at));
  const dropped = (run: number, standingIn: number, breakAt: number) =>
    run - standingIn >= MIN_DROPPED_LETTERS ||
    (standingIn === 0 && run >= MIN_DROPPED_WORD_LETTERS && wordBreak(breakAt));
  const opening = unheardRun(0, 1, heardAt);
  if (dropped(opening, standIns(0, matched[opening]!), opening - 1)) {
    const head = unheardRun(0, 1, anchored);
    return {
      clause: `drops the opening "${extendToWordEnd(line, said[head - 1]!.end)}"`,
      at: "opening",
    };
  }
  const last = said.length - 1;
  const closing = unheardRun(last, -1, heardAt);
  if (
    dropped(closing, standIns(matched[last - closing]! + 1, heardLetters.length), last - closing)
  ) {
    const tail = unheardRun(last, -1, anchored);
    return {
      clause: `drops the closing "${line.slice(said[said.length - tail]!.at).trim()}"`,
      at: "closing",
    };
  }
  if (said.length >= MIN_LINE_LETTERS && covered / said.length < MIN_HEARD_SHARE) {
    return { clause: "says other words", at: "whole" };
  }
  return null;
}

// The line up to `end`, with the punctuation that closes the word there.
function extendToWordEnd(line: string, end: number): string {
  const rest = line.slice(end).match(/^[^\p{L}\p{N}\s]*/u)![0];
  return line.slice(0, end + rest.length).trim();
}
