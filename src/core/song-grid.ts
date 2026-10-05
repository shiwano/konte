// A take of the song's beat grid: beats to take-seconds and back. Pure arithmetic, read by the
// preview page as well as the CLI.

// The beats a take is counted on: the read beats, numbered from beat 0 — the read beat a person made
// beat 0, else the reading's `firstBeat`.
type GridPoint = { beat: number; sec: number };

// What a take's beat grid is counted from: its reading (`SongReading`), and the beat 0 a person set
// on it (`SongRecord.firstBeatSet`).
export type SongGridSource = {
  beats: readonly number[];
  firstBeat: number;
  beatsPerBar: number;
  firstBeatSet?: number;
};

const grids = new WeakMap<SongGridSource, GridPoint[]>();

export function nearestBeatIndex(beats: readonly number[], sec: number): number {
  let best = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i]! - sec) < Math.abs(beats[best]! - sec)) best = i;
  }
  return best;
}

// The index in `beats` of beat 0.
export function songFirstBeat(analysis: SongGridSource): number {
  return analysis.firstBeatSet !== undefined && analysis.beats.length > 0
    ? nearestBeatIndex(analysis.beats, analysis.firstBeatSet)
    : analysis.firstBeat;
}

function songGrid(analysis: SongGridSource): GridPoint[] {
  const cached = grids.get(analysis);
  if (cached) return cached;
  const first = songFirstBeat(analysis);
  const grid = analysis.beats.map((sec, i) => ({ beat: i - first, sec }));
  grids.set(analysis, grid);
  return grid;
}

// A take with fewer than two beats to measure a span between keeps this one.
const FALLBACK_BEAT_SEC = 0.5;

function spanOf(grid: readonly GridPoint[], at: "first" | "last"): number {
  if (grid.length < 2) return FALLBACK_BEAT_SEC;
  return at === "first" ? grid[1]!.sec - grid[0]!.sec : grid.at(-1)!.sec - grid.at(-2)!.sec;
}

// The take-second of beat `beat` (fractional allowed), counted from beat 0.
export function songBeatSec(analysis: SongGridSource, beat: number): number {
  const grid = songGrid(analysis);
  if (grid.length === 0) return beat * FALLBACK_BEAT_SEC;
  const lo = grid[0]!.beat;
  const i = beat - lo;
  if (i <= 0) return grid[0]!.sec + i * spanOf(grid, "first");
  if (i >= grid.length - 1) {
    return grid.at(-1)!.sec + (i - (grid.length - 1)) * spanOf(grid, "last");
  }
  const k = Math.floor(i);
  const a = grid[k]!.sec;
  return a + (i - k) * (grid[k + 1]!.sec - a);
}

// The beat a take-second falls on, fractional.
export function songBeatAt(analysis: SongGridSource, sec: number): number {
  const grid = songGrid(analysis);
  if (grid.length === 0) return sec / FALLBACK_BEAT_SEC;
  const first = grid[0]!;
  const last = grid.at(-1)!;
  if (sec <= first.sec) return first.beat + (sec - first.sec) / spanOf(grid, "first");
  if (sec >= last.sec) return last.beat + (sec - last.sec) / spanOf(grid, "last");
  let lo = 0;
  let hi = grid.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid]!.sec <= sec) lo = mid;
    else hi = mid;
  }
  const a = grid[lo]!;
  return a.beat + (sec - a.sec) / (grid[hi]!.sec - a.sec);
}

// Every beat of the take's grid inside [0, durationSec), numbered from beat 0.
export function songGridBeats(analysis: SongGridSource, durationSec: number): GridPoint[] {
  const from = Math.ceil(songBeatAt(analysis, 0) - 1e-6);
  const out: GridPoint[] = [];
  for (let beat = from; ; beat++) {
    const sec = songBeatSec(analysis, beat);
    if (sec >= durationSec - 1e-6) break;
    if (sec >= 0) out.push({ beat, sec });
  }
  return out;
}

// The tempo the take plays at from beat 0 to its last beat, each bar's own read off its beats: one
// figure where the bars hold within 2% of each other, else the range they span (the 10th to the 90th
// percentile, so one misheard bar does not widen it).
export type SongTempo = { bpm: number } | { minBpm: number; maxBpm: number };

export function songTempo(analysis: SongGridSource): SongTempo | null {
  const grid = songGrid(analysis).filter((p) => p.beat >= 0);
  if (grid.length < 2) return null;
  const per = analysis.beatsPerBar;
  const bars: number[] = [];
  for (let i = 0; i + per < grid.length; i += per) {
    bars.push((60 * per) / (grid[i + per]!.sec - grid[i]!.sec));
  }
  const mean = (60 * (grid.length - 1)) / (grid.at(-1)!.sec - grid[0]!.sec);
  if (bars.length < 2) return { bpm: Math.round(mean) };
  bars.sort((a, b) => a - b);
  const min = bars[Math.floor((bars.length - 1) * 0.1)]!;
  const max = bars[Math.ceil((bars.length - 1) * 0.9)]!;
  if (max - min <= mean * 0.02) return { bpm: Math.round(mean) };
  return { minBpm: Math.round(min), maxBpm: Math.round(max) };
}

export function formatSongTempo(tempo: SongTempo | null): string {
  if (!tempo) return "no tempo";
  return "bpm" in tempo ? `${tempo.bpm} BPM` : `${tempo.minBpm}–${tempo.maxBpm} BPM`;
}
