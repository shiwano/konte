import type { SoundtrackEntry } from "./dsl/builders.js";
import { makeAddressPlaceholder } from "./dsl/shot-context.js";

export const SONG_BED_ID = "#song";

// What a stage mixes under its timeline: the author's soundtracks, then the song `policy.clock`
// counts on, from its first sample to the timeline's end, never looped or ducked.
export function mixedSoundtracks(
  stage: { song?: string },
  soundtracks: readonly SoundtrackEntry[] | null | undefined,
): SoundtrackEntry[] {
  const authored = [...(soundtracks ?? [])];
  if (!stage.song) return authored;
  return [
    ...authored,
    {
      __soundtrackEntry: true,
      id: SONG_BED_ID,
      src: { src: makeAddressPlaceholder(stage.song) },
      options: { loop: false, duck: false },
      song: true,
    },
  ];
}
