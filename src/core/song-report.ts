import type { SongAnalysis } from "./types/index.js";

// A song take's bar grid as the reader lays a take against it: where each bar head falls in the
// take, and how loud the bar is.
export type SongBar = { index: number; startSec: number; levelDb: number | null };

// The bar heads from the downbeat on, each with its mean level over `rms` (buckets of `rate` per
// second); a bar past the end of the envelope has no level.
export function songBars(
  analysis: SongAnalysis,
  beatsPerBar: number,
  durationSec: number,
  rms: readonly number[],
  rate: number,
): SongBar[] {
  const barSec = (60 / analysis.bpm) * beatsPerBar;
  const bars: SongBar[] = [];
  for (let i = 0; analysis.downbeatSec + i * barSec < durationSec - 1e-6; i++) {
    const startSec = analysis.downbeatSec + i * barSec;
    const from = Math.floor(startSec * rate);
    const to = Math.min(rms.length, Math.floor((startSec + barSec) * rate));
    let power = 0;
    for (let b = from; b < to; b++) power += rms[b]! ** 2;
    const levelDb = to > from ? 10 * Math.log10(power / (to - from) + 1e-12) : null;
    bars.push({ index: i + 1, startSec, levelDb });
  }
  return bars;
}

// The bar a take-second falls in, counted from 1 at the downbeat; 0 before it.
export function barAt(analysis: SongAnalysis, beatsPerBar: number, sec: number): number {
  const barSec = (60 / analysis.bpm) * beatsPerBar;
  return sec < analysis.downbeatSec - 1e-6
    ? 0
    : Math.floor((sec - analysis.downbeatSec) / barSec + 1e-6) + 1;
}

// How many beats the take drifts from the declared grid by the end of a timeline `beats` long: the
// take plays `beats × measured / declared` beats in the time the timeline counts `beats`.
export function songDriftBeats(measuredBpm: number, declaredBpm: number, beats: number): number {
  return Math.abs(beats * (measuredBpm / declaredBpm - 1));
}
