import type { SongTake } from "../../song-take.js";
import type { SongAnalysis } from "../../types/index.js";

// A reading of a take that plays steadily at `bpm` from its start to `durationSec`, beat 0 at
// `beat0Sec`.
export function steadySong(
  opts: { bpm?: number; beat0Sec?: number; durationSec?: number; beatsPerBar?: number } & Partial<
    Omit<SongAnalysis, "beats" | "firstBeat" | "beatsPerBar">
  > = {},
): SongAnalysis {
  const { bpm = 120, beat0Sec = 0, durationSec = 120, beatsPerBar = 4, ...rest } = opts;
  const period = 60 / bpm;
  const before = Math.floor(beat0Sec / period + 1e-9);
  const beats: number[] = [];
  for (let i = -before; beat0Sec + i * period < durationSec; i++) beats.push(beat0Sec + i * period);
  return {
    beats,
    firstBeat: before,
    beatsPerBar,
    sectionSecs: [],
    phrases: null,
    heard: null,
    lang: "en",
    ...rest,
  };
}

export function songTake(analysis: SongAnalysis, variantId = "v-song"): SongTake {
  return { address: "reference:song", variantId, analysis };
}
