import type { Direction } from "./dsl/direction.js";
import type { JobManager } from "./job-manager.js";
import { readSongReading } from "./song-reading.js";
import { songAddressOf } from "./song-take.js";
import type { KonteState, SongRecord } from "./types/index.js";

// A reading taken against another declared language: the vocal track is heard in it, so it no
// longer holds.
export function readingOutdated(record: SongRecord, basis: { lang: string }): boolean {
  return record.lang !== basis.lang;
}

// What a reading of the song is taken against under `direction`, or null where it names no song.
export function readingBasis(direction: Direction | null): { lang: string } | null {
  if (!direction?.policy?.song) return null;
  return { lang: direction.policy.lang };
}

export type UnreadSongTake = { address: string; variantId: string; outputHash: string | null };

// Every take of the song that has landed and holds no reading of it in the declared language.
export function unreadSongTakes(
  videoRoot: string,
  direction: Direction | null,
  state: KonteState,
): UnreadSongTake[] {
  const basis = readingBasis(direction);
  const address = songAddressOf(direction);
  if (!basis || !address) return [];
  return Object.entries(state.assets[address]?.variants ?? {})
    .filter(
      ([variantId, v]) =>
        v.file &&
        v.status !== "dismissed" &&
        (!v.song ||
          readingOutdated(v.song, basis) ||
          !readSongReading(videoRoot, address, variantId, v.song)),
    )
    .map(([variantId, v]) => ({ address, variantId, outputHash: v.outputHash ?? null }));
}

/**
 * Queue an analysis for every unread take of the song (see `unreadSongTakes`). A take is read once
 * under its bytes and the declared language: one whose job failed stays unread until
 * `konte song analyze`.
 */
export async function queueSongAnalyses(opts: {
  videoRoot: string;
  direction: Direction | null;
  state: KonteState;
  jobManager: JobManager;
}): Promise<string[]> {
  const basis = readingBasis(opts.direction);
  if (!basis) return [];
  const queued: string[] = [];
  for (const take of unreadSongTakes(opts.videoRoot, opts.direction, opts.state)) {
    const job = await opts.jobManager.ensureSongAnalysisJob({ ...take, ...basis });
    if (job.status === "pending") queued.push(job.id);
  }
  return queued;
}
