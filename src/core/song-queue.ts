import type { Direction } from "./dsl/direction.js";
import type { JobManager } from "./job-manager.js";
import { songAddressOf } from "./song-take.js";
import type { KonteState, SongAnalysis } from "./types/index.js";

// A reading taken against another declared tempo, meter or language: the tempo is searched near the
// declared one, the bar heads counted in its meter and the vocal track heard in its language, so it
// no longer holds.
export function readingOutdated(
  reading: SongAnalysis,
  basis: { bpm: number; beatsPerBar: number; lang: string },
): boolean {
  return (
    reading.clock?.bpm !== basis.bpm ||
    reading.clock?.beatsPerBar !== basis.beatsPerBar ||
    reading.lang !== basis.lang
  );
}

// What a reading of the song is taken against under `direction`, or null where it declares no clock.
export function readingBasis(
  direction: Direction | null,
): { bpm: number; beatsPerBar: number; lang: string } | null {
  const clock = direction?.policy?.clock;
  if (!clock) return null;
  return { bpm: clock.bpm, beatsPerBar: clock.beatsPerBar, lang: direction.policy.lang };
}

export type UnreadSongTake = { address: string; variantId: string; outputHash: string | null };

// Every take of the song that has landed and holds no reading of it under the declared clock.
export function unreadSongTakes(direction: Direction | null, state: KonteState): UnreadSongTake[] {
  const basis = readingBasis(direction);
  const address = songAddressOf(direction);
  if (!basis || !address) return [];
  return Object.entries(state.assets[address]?.variants ?? {})
    .filter(
      ([, v]) => v.file && v.status !== "dismissed" && (!v.song || readingOutdated(v.song, basis)),
    )
    .map(([variantId, v]) => ({ address, variantId, outputHash: v.outputHash ?? null }));
}

/**
 * Queue an analysis for every unread take of the song (see `unreadSongTakes`). A take is read once
 * under its bytes and the declared clock: one whose job failed stays unread until
 * `konte song analyze`.
 */
export async function queueSongAnalyses(opts: {
  direction: Direction | null;
  state: KonteState;
  jobManager: JobManager;
}): Promise<string[]> {
  const basis = readingBasis(opts.direction);
  if (!basis) return [];
  const queued: string[] = [];
  for (const take of unreadSongTakes(opts.direction, opts.state)) {
    const job = await opts.jobManager.ensureSongAnalysisJob({ ...take, ...basis });
    if (job.status === "pending") queued.push(job.id);
  }
  return queued;
}
