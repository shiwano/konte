import * as path from "node:path";
import { KonteError } from "../core/errors.js";
import { isJobTerminal, type JobManager } from "../core/job-manager.js";
import { analyzeSongVariant } from "../core/song-analysis.js";
import { readingOutdated } from "../core/song-queue.js";
import { StateManager } from "../core/state/index.js";
import { readSongReading, writeSongReading } from "../core/song-reading.js";
import { SongReadingSchema } from "../core/types/index.js";
import { type LeasedJobResult, runLeasedJob } from "./run-leased-job.js";

// Read one take of the song under a run lease and record what it says on the variant. The record
// is written only onto the bytes it was read from: a take whose file moved on meanwhile is left for
// a later job.
export async function runSongAnalysisJob(
  jobManager: JobManager,
  videoRoot: string,
  id: string,
): Promise<LeasedJobResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== "song-analysis") {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not a song analysis job`);
  }
  if (isJobTerminal(job.status)) return {};

  return runLeasedJob(jobManager, id, {
    failureLabel: "Song analysis",
    work: async ({ workerId, complete }) => {
      const variant = (await StateManager.load(videoRoot)).getState().assets[job.address]
        ?.variants?.[job.variantId];
      if (!variant?.file) {
        throw new KonteError(
          "VALIDATION_FAILED",
          `${job.address} ${job.variantId} has no file to read.`,
        );
      }
      const outputHash = variant.outputHash;
      const reading = SongReadingSchema.parse(
        await analyzeSongVariant({
          variantId: job.variantId,
          file: path.resolve(videoRoot, variant.file),
          outputHash,
          videoRoot,
          lang: job.lang,
          // One directory per run: a run superseded by `song analyze` may still be reading.
          workDir: path.join(videoRoot, ".konte", "cache", "song", `${id}-${workerId}`),
          log: (line) => jobManager.appendLog(id, line),
        }),
      );
      // Under the state lock: the reading is saved first, then the job completes, so a job seen
      // completed has its reading on disk. A job cancelled or reclaimed meanwhile (`job cancel`,
      // `song analyze` queueing it again) keeps nothing.
      await StateManager.withLock(videoRoot, async (manager) => {
        const current = await jobManager.getJob(id).catch(() => null);
        if (current?.status !== "running" || current.lease?.owner !== workerId) return;
        const variant = manager.getState().assets[job.address]?.variants?.[job.variantId];
        const previous = variant?.song;
        const lands =
          !!variant &&
          variant.outputHash === outputHash &&
          (job.again ||
            !previous ||
            readingOutdated(previous, job) ||
            !readSongReading(videoRoot, job.address, job.variantId, previous));
        if (lands) {
          variant.song = {
            reading: await writeSongReading(videoRoot, job.address, job.variantId, reading),
            lang: job.lang,
            ...(previous?.firstBeatSet !== undefined
              ? { firstBeatSet: previous.firstBeatSet }
              : {}),
            ...(previous?.lines ? { lines: previous.lines } : {}),
          };
          await manager.save();
        }
        const won = await complete("Song analysis completed");
        if (!won && lands) {
          if (previous) variant.song = previous;
          else delete variant.song;
        }
      });
      return {};
    },
  });
}
