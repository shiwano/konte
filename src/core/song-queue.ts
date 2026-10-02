import type { Direction } from "./dsl/direction.js";
import type { JobManager } from "./job-manager.js";
import { songAddressOf } from "./song-take.js";
import type { KonteState, SongAnalysis } from "./types/index.js";

// A reading taken against another declared tempo or meter: the tempo is searched near the declared
// one and the bar heads counted in its meter, so it no longer holds.
export function readingOutdated(
  reading: SongAnalysis,
  clock: { bpm: number; beatsPerBar: number },
): boolean {
  return reading.clock?.bpm !== clock.bpm || reading.clock?.beatsPerBar !== clock.beatsPerBar;
}

export type UnreadSongTake = { address: string; variantId: string; outputHash: string | null };

// Every take of the song that has landed and holds no reading of it under the declared clock.
export function unreadSongTakes(direction: Direction | null, state: KonteState): UnreadSongTake[] {
  const clock = direction?.policy?.clock;
  const address = songAddressOf(direction);
  if (!clock || !address) return [];
  return Object.entries(state.assets[address]?.variants ?? {})
    .filter(
      ([, v]) => v.file && v.status !== "dismissed" && (!v.song || readingOutdated(v.song, clock)),
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
  const clock = opts.direction?.policy?.clock;
  if (!clock) return [];
  const queued: string[] = [];
  for (const take of unreadSongTakes(opts.direction, opts.state)) {
    const job = await opts.jobManager.ensureSongAnalysisJob({
      ...take,
      bpm: clock.bpm,
      beatsPerBar: clock.beatsPerBar,
    });
    if (job.status === "pending") queued.push(job.id);
  }
  return queued;
}
