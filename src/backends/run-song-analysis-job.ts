import * as path from "node:path";
import { KonteError, errorMessage } from "../core/errors.js";
import type { JobManager } from "../core/job-manager.js";
import { analyzeSongTake } from "../core/song-analysis.js";
import { readingOutdated } from "../core/song-queue.js";
import { StateManager } from "../core/state/index.js";
import { readSongReading, writeSongReading } from "../core/song-reading.js";
import { SongReadingSchema, type JobRecord, type SongAnalysisJob } from "../core/types/index.js";
import { runLeasedJob } from "./run-leased-job.js";

type SongAnalysisHooks = {
  onStarted?: (info: { id: string; address: string }) => void;
  onSettled?: (info: { id: string; status: "completed" | "failed"; error: string | null }) => void;
};

type RunSongAnalysisResult = {
  id: string;
  status: JobRecord["status"];
  // True only when THIS caller claimed the job and read the take.
  ranAnalysis: boolean;
};

// Read one take of the song under a run lease and record what it says on the variant. The record
// is written only onto the bytes it was read from: a take whose file moved on meanwhile is left for
// a later job.
export async function runSongAnalysisJob(
  jobManager: JobManager,
  videoRoot: string,
  id: string,
  hooks: SongAnalysisHooks = {},
): Promise<RunSongAnalysisResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== "song-analysis") {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not a song analysis job`);
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return { id, status: job.status, ranAnalysis: false };
  }

  return runLeasedJob<RunSongAnalysisResult>(jobManager, id, {
    onClaimFailed: async () => {
      const current = await jobManager.getJob(id).catch(() => null);
      return { id, status: current?.status ?? "running", ranAnalysis: false };
    },
    work: async ({ workerId }) => {
      const settle = async (status: "completed" | "failed", error: string | null) => {
        const committed = await jobManager.finishIfOwner(id, workerId, {
          status,
          error,
          progress: status === "completed" ? 100 : null,
          completedAt: new Date().toISOString(),
        });
        if (committed) hooks.onSettled?.({ id, status, error });
        return { id, status, ranAnalysis: true };
      };
      try {
        hooks.onStarted?.({ id, address: job.address });
        const take = (await StateManager.load(videoRoot)).getState().assets[job.address]
          ?.variants?.[job.variantId];
        if (!take?.file) {
          const msg = `${job.address} ${job.variantId} has no file to read.`;
          jobManager.appendLog(id, msg);
          return await settle("failed", msg);
        }
        const outputHash = take.outputHash;
        const reading = SongReadingSchema.parse(
          await analyzeSongTake({
            file: path.resolve(videoRoot, take.file),
            outputHash,
            videoRoot,
            bpm: job.bpm,
            beatsPerBar: job.beatsPerBar,
            lang: job.lang,
            // One directory per run: a run superseded by `song analyze` may still be reading.
            workDir: path.join(videoRoot, ".konte", "cache", "song", id, workerId),
            log: (line) => jobManager.appendLog(id, line),
          }),
        );
        // Under the state lock: the reading is saved first, then the job completes, so a job seen
        // completed has its reading on disk. A job cancelled or reclaimed meanwhile (`job cancel`,
        // `song analyze` queueing it again) keeps nothing.
        const committed = await StateManager.withLock(videoRoot, async (manager) => {
          const current = await jobManager.getJob(id).catch(() => null);
          if (current?.status !== "running" || current.lease?.owner !== workerId) return false;
          const variant = manager.getState().assets[job.address]?.variants?.[job.variantId];
          const lands =
            !!variant &&
            variant.outputHash === outputHash &&
            (!variant.song ||
              readingOutdated(variant.song, job) ||
              !readSongReading(videoRoot, job.address, job.variantId, variant.song));
          if (lands) {
            variant.song = {
              reading: await writeSongReading(videoRoot, job.address, job.variantId, reading),
              clock: { bpm: job.bpm, beatsPerBar: job.beatsPerBar },
              lang: job.lang,
            };
            await manager.save();
          }
          const won = await jobManager.finishIfOwner(id, workerId, {
            status: "completed",
            error: null,
            progress: 100,
            completedAt: new Date().toISOString(),
          });
          if (!won && lands) delete variant.song;
          return won;
        });
        if (!committed) {
          const current = await jobManager.getJob(id).catch(() => null);
          return { id, status: current?.status ?? "running", ranAnalysis: true };
        }
        hooks.onSettled?.({ id, status: "completed", error: null });
        return { id, status: "completed", ranAnalysis: true };
      } catch (err) {
        const msg = errorMessage(err);
        jobManager.appendLog(id, `Song analysis failed: ${msg}`);
        return settle("failed", msg);
      }
    },
  });
}

// Run every pending song analysis to completion (used by `konte job wait` and the MCP watcher).
export async function runPendingSongAnalyses(
  jobManager: JobManager,
  videoRoot: string,
  hooks: SongAnalysisHooks = {},
): Promise<RunSongAnalysisResult[]> {
  const jobs = (await jobManager.listJobs()).filter(
    (j): j is SongAnalysisJob =>
      j.kind === "song-analysis" && (j.status === "pending" || j.status === "running"),
  );
  const results: RunSongAnalysisResult[] = [];
  for (const j of jobs) results.push(await runSongAnalysisJob(jobManager, videoRoot, j.id, hooks));
  return results;
}
