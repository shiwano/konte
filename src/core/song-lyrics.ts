import { estimateSpeechSec, BASE_SEC } from "./speech-duration.js";

// Where each declared lyric line is sung, read off the stretches a separated vocal track sings. The
// words are the direction's; only their place is looked for. A line is a run of consecutive
// stretches, lines keep their order, and a stretch may be left to no line (an ad-lib, bleed the
// separation left). The cues are the line order; how long each line takes to sing relative to the
// others, from its syllables as `estimateSpeechSec` counts them; the breath a line opens after; and
// the bar grid, which a song's lines open on at a whole number of bars from one another.
//
// A line is placed only where its place is clear: where the best reading with that line opening
// somewhere else costs nearly as little, it is left for a person to place.

export type LyricPlacementInput = {
  // In declaration order. `set` is where a person placed the line on the take's own clock; such a
  // line is not looked for, and the lines either side of it are looked for only on their side of it.
  lines: readonly { text: string; set?: { startSec: number; endSec: number } }[];
  phrases: readonly { startSec: number; endSec: number }[] | null;
  bpm: number;
  beatsPerBar: number;
  downbeatSec: number;
  lang: string | undefined;
};

// A line's place on the take's clock, or null where it is not clear. `set` is a line a person placed.
export type LyricPlacement = { startSec: number; endSec: number; set: boolean } | null;

const MAX_STRETCHES_PER_LINE = 10;
// What leaving a line unplaced costs: a line is placed only where its fit costs less than this.
const UNPLACED_LINE = 3;
// What leaving a stretch to no line costs, per second of it: short bleed is cheap to skip, a long
// sung passage is not.
const SKIPPED_PER_SEC = 1.5;
// A line whose best reading with it opening elsewhere costs less than this more is ambiguous.
const AMBIGUITY_MARGIN = 1;

function singingWeight(text: string, lang: string | undefined): number {
  const sec = estimateSpeechSec(text, lang);
  if (sec !== null) return Math.max(0.1, sec - BASE_SEC);
  return Math.max(1, text.trim().split(/\s+/).length);
}

type Stretch = { startSec: number; endSec: number };

export function placeLyricLines(input: LyricPlacementInput): LyricPlacement[] {
  const placements: LyricPlacement[] = input.lines.map((line) =>
    line.set === undefined ? null : { ...line.set, set: true },
  );
  const stretches = input.phrases ?? [];
  if (stretches.length === 0) return placements;

  // The lines between two set ones are looked for among the stretches between those places. A set
  // line opening on a stretch holds it and whatever of the stretches after it the reading gives it,
  // so the line after cannot open there.
  const beat = 60 / input.bpm;
  const anchorAt = (sec: number): number =>
    stretches.findIndex((s) => Math.abs(s.startSec - sec) <= beat / 2);
  let segmentStart = 0;
  let lead: { text: string; from: number } | null = null;
  let floorSec = -Infinity;
  for (let i = 0; i <= input.lines.length; i++) {
    const setAt = i < input.lines.length ? input.lines[i]!.set?.startSec : Infinity;
    if (setAt === undefined) continue;
    const ids: number[] = [];
    for (let id = segmentStart; id < i; id++) ids.push(id);
    const anchor = Number.isFinite(setAt) ? anchorAt(setAt) : -1;
    const ceilingSec = anchor >= 0 ? stretches[anchor]!.startSec : setAt;
    const pool = stretches.filter((s, k) =>
      lead
        ? k >= lead.from && s.startSec < ceilingSec
        : s.startSec >= floorSec && s.startSec < ceilingSec,
    );
    const found = placeBetween(
      ids.map((id) => input.lines[id]!.text),
      pool,
      input,
      lead?.text,
    );
    ids.forEach((id, k) => {
      placements[id] = found[k] ?? null;
    });
    segmentStart = i + 1;
    lead = anchor >= 0 ? { text: input.lines[i]!.text, from: anchor } : null;
    floorSec = setAt;
  }
  return placements;
}

// `lead` is a set line opening on the first stretch: it takes a run from there, and is not
// reported.
function placeBetween(
  found: readonly string[],
  stretches: readonly Stretch[],
  input: LyricPlacementInput,
  lead?: string,
): LyricPlacement[] {
  if (found.length === 0) return [];
  if (stretches.length === 0) return found.map(() => null);
  const lines = lead === undefined ? found : [lead, ...found];
  const leading = lead === undefined ? 0 : 1;
  const n = lines.length;
  const m = stretches.length;

  const beat = 60 / input.bpm;
  const weights = lines.map((l) => singingWeight(l, input.lang));
  const sung = stretches.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
  const perWeight = sung / weights.reduce((a, b) => a + b, 0);

  const fit = (line: number, from: number, to: number): number => {
    let singing = 0;
    let breaks = 0;
    for (let s = from; s < to; s++) {
      singing += stretches[s]!.endSec - stretches[s]!.startSec;
      if (s > from) {
        const gap = stretches[s]!.startSec - stretches[s - 1]!.endSec;
        breaks += Math.max(0, gap - beat / 2) / beat;
      }
    }
    const length = Math.abs(Math.log(singing / (weights[line]! * perWeight)));
    // A line opens after a breath; one that opens straight on the stretch before is mid-phrase.
    const lead = from > 0 ? stretches[from]!.startSec - stretches[from - 1]!.endSec : beat;
    const midPhrase = Math.max(0, beat / 2 - lead) / (beat / 2);
    const halfBeats = (stretches[from]!.startSec - input.downbeatSec) / (beat / 2);
    const offGrid = Math.abs(halfBeats - Math.round(halfBeats));
    return 2 * length + breaks + midPhrase + 0.5 * offGrid;
  };
  // How far the gap between two line openings is from a whole number of bars, in beats.
  const span = (fromStretch: number, toStretch: number): number => {
    const beats = (stretches[toStretch]!.startSec - stretches[fromStretch]!.startSec) / beat;
    const bars = Math.max(1, Math.round(beats / input.beatsPerBar));
    return Math.min(2, Math.abs(beats - bars * input.beatsPerBar));
  };
  const skip = (s: number): number =>
    SKIPPED_PER_SEC * (stretches[s]!.endSec - stretches[s]!.startSec);

  // A reading is a walk over states (lines placed, stretches passed, the stretch the last placed line
  // opened on, -1 before any). `forward` is the least cost of reaching a state, `backward` the least
  // cost of finishing from it; their sum over a choice is the best reading that makes it.
  const lastSlots = m + 1;
  const at = (l: number, s: number, last: number) => (l * (m + 1) + s) * lastSlots + last + 1;
  const forward = new Float64Array((n + 1) * (m + 1) * lastSlots).fill(Infinity);
  const backward = new Float64Array(forward.length).fill(Infinity);
  const fits = new Float64Array(n * m * MAX_STRETCHES_PER_LINE);
  for (let l = 0; l < n; l++)
    for (let s = 0; s < m; s++)
      for (let to = s + 1; to <= Math.min(m, s + MAX_STRETCHES_PER_LINE); to++)
        fits[(l * m + s) * MAX_STRETCHES_PER_LINE + to - s - 1] = fit(l, s, to);
  const fitOf = (l: number, s: number, to: number) =>
    fits[(l * m + s) * MAX_STRETCHES_PER_LINE + to - s - 1]!;
  const place = (l: number, last: number, s: number, to: number) =>
    fitOf(l, s, to) + (last >= 0 ? span(last, s) : 0);

  // Every step out of a state: its cost and where it lands. A set line leading the pool opens on
  // the first stretch, so it is neither skipped past nor left unplaced.
  const steps = (
    l: number,
    s: number,
    last: number,
    visit: (cost: number, l2: number, s2: number, last2: number) => void,
  ) => {
    const opensLead = l < leading;
    if (s < m && !opensLead) visit(skip(s), l, s + 1, last);
    if (l === n) return;
    if (!opensLead) visit(UNPLACED_LINE, l + 1, s, last);
    for (let to = s + 1; to <= Math.min(m, s + MAX_STRETCHES_PER_LINE); to++) {
      visit(place(l, last, s, to), l + 1, to, s);
    }
  };

  forward[at(0, 0, -1)] = 0;
  for (let l = 0; l <= n; l++)
    for (let s = 0; s <= m; s++)
      for (let last = -1; last < m; last++) {
        const f = forward[at(l, s, last)]!;
        if (f === Infinity) continue;
        steps(l, s, last, (cost, l2, s2, last2) => {
          const i = at(l2, s2, last2);
          if (f + cost < forward[i]!) forward[i] = f + cost;
        });
      }
  for (let last = -1; last < m; last++) backward[at(n, m, last)] = 0;
  for (let l = n; l >= 0; l--)
    for (let s = m; s >= 0; s--)
      for (let last = -1; last < m; last++) {
        if (l === n && s === m) continue;
        let b = Infinity;
        steps(l, s, last, (cost, l2, s2, last2) => {
          b = Math.min(b, cost + backward[at(l2, s2, last2)]!);
        });
        backward[at(l, s, last)] = b;
      }
  const best = backward[at(0, 0, -1)]!;
  if (best === Infinity) return found.map(() => null);

  // The best reading, walked from the start along the steps that keep its cost.
  const groups: ({ from: number; to: number } | null)[] = [];
  for (let l = 0, s = 0, last = -1; l < n || s < m; ) {
    const here = backward[at(l, s, last)]!;
    let next: [number, number, number] | null = null;
    steps(l, s, last, (cost, l2, s2, last2) => {
      if (next || Math.abs(cost + backward[at(l2, s2, last2)]! - here) > 1e-9) return;
      next = [l2, s2, last2];
      if (l2 === l + 1) groups.push(last2 === last && s2 === s ? null : { from: s, to: s2 });
    });
    [l, s, last] = next!;
  }

  // The best reading with line `l` not opening on stretch `from`: left unplaced, or opening
  // anywhere else.
  const bestWithout = (l: number, from: number): number => {
    let cost = Infinity;
    for (let s = 0; s <= m; s++)
      for (let last = -1; last < m; last++) {
        const f = forward[at(l, s, last)]!;
        if (f === Infinity) continue;
        cost = Math.min(cost, f + UNPLACED_LINE + backward[at(l + 1, s, last)]!);
        if (s === from || s === m) continue;
        for (let to = s + 1; to <= Math.min(m, s + MAX_STRETCHES_PER_LINE); to++) {
          cost = Math.min(cost, f + place(l, last, s, to) + backward[at(l + 1, to, s)]!);
        }
      }
    return cost;
  };

  return groups.slice(leading).map((group, k): LyricPlacement => {
    if (!group) return null;
    if (bestWithout(k + leading, group.from) - best < AMBIGUITY_MARGIN) return null;
    return {
      startSec: stretches[group.from]!.startSec,
      endSec: stretches[group.to - 1]!.endSec,
      set: false,
    };
  });
}
