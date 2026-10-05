import { type SongGridSource, songBeatAt, songBeatSec } from "./song-take.js";

// A song take's bar grid as the reader lays a take against it: where each bar head falls in the
// take, and how loud the bar is.
export type SongBar = { index: number; startSec: number; levelDb: number | null };

// The bar heads from beat 0 on, every `beatsPerBar` beats of the take's grid, each with its mean
// level over `rms` (buckets of `rate` per second); a bar past the end of the envelope has no level.
export function songBars(
  analysis: SongGridSource,
  durationSec: number,
  rms: readonly number[],
  rate: number,
): SongBar[] {
  const per = analysis.beatsPerBar;
  const bars: SongBar[] = [];
  for (let i = 0; songBeatSec(analysis, i * per) < durationSec - 1e-6; i++) {
    const startSec = songBeatSec(analysis, i * per);
    const endSec = songBeatSec(analysis, (i + 1) * per);
    const from = Math.floor(startSec * rate);
    const to = Math.min(rms.length, Math.floor(endSec * rate));
    let power = 0;
    for (let b = from; b < to; b++) power += rms[b]! ** 2;
    const levelDb = to > from ? 10 * Math.log10(power / (to - from) + 1e-12) : null;
    bars.push({ index: i + 1, startSec, levelDb });
  }
  return bars;
}

// The bar a take-second falls in, counted from 1 at beat 0; 0 before it.
export function barAt(analysis: SongGridSource, sec: number): number {
  const beat = songBeatAt(analysis, sec);
  return beat < -1e-6 ? 0 : Math.floor(beat / analysis.beatsPerBar + 1e-6) + 1;
}
