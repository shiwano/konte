import * as path from "node:path";
import { KonteError, errorMessage } from "../core/errors.js";
import { computeDefinitionSourceFingerprint } from "../core/definition-source.js";
import { computeExportPlanDigest, computeExportSignature } from "../core/export-signature.js";
import { JobIndex } from "../core/job-index.js";
import type { JobManager } from "../core/job-manager.js";
import { loadAnimatic, reloadVideoDefinition } from "../core/loader.js";
import { assertNarrationStemsPlaced } from "../core/narration-stem.js";
import { renderVideoToFile } from "../core/render-video.js";
import { runLeasedJob } from "./run-leased-job.js";
import { buildTimestamp } from "../core/review-record.js";
import { StateManager } from "../core/state/index.js";
import type { ExportJob, JobRecord, KonteState } from "../core/types/index.js";
import { stageEntryPath } from "../core/roots.js";

type ExportJobHooks = {
  onStarted?: (info: { id: string; outputDir: string }) => void;
  onSettled?: (info: {
    id: string;
    status: "completed" | "failed";
    outputFile: string | null;
    error: string | null;
  }) => void;
};

type RunExportJobResult = {
  id: string;
  status: JobRecord["status"];
  outputFile: string | null;
  // True only when THIS caller claimed the job and performed the render.
  ranRender: boolean;
  // True when this caller claimed the job and handed it back unrendered because its own loaded
  // definitions proved older than the files on disk (see decideExportRender).
  released?: boolean;
  // Why a "pending" result is pending when the job itself is runnable — surfaced by `job wait`.
  pendingReason?: string;
};

export type ExportRenderDecision = "render" | "release";

// Whether the worker's reloaded definition is the one to render. The digest the registering CLI
// stamped is what the definition said then; a different one now means either the definition
// changed since (render it — an edit between submit and render is the definition winning) or
// the worker's reload returned something older than the files (step aside: rendering would cut
// the video to a definition nobody has on disk). The files decide which: unchanged files put the
// disagreement in the worker. One release per job; a second worker that still disagrees renders,
// because a difference no fingerprinted file explains is not one a fresh process can fix.
export function decideExportRender(
  job: Pick<ExportJob, "planDigest" | "sourceFingerprint" | "staleReleases">,
  digestNow: string,
  sourceFingerprintNow: string,
): ExportRenderDecision {
  if (job.planDigest == null || job.planDigest === digestNow) return "render";
  if (job.sourceFingerprint == null || job.sourceFingerprint !== sourceFingerprintNow) {
    return "render";
  }
  return job.staleReleases === 0 ? "release" : "render";
}

function assetHasFile(state: KonteState, address: string): boolean {
  const assetState = state.assets[address];
  return assetState?.variants ? Object.values(assetState.variants).some((v) => v.file) : false;
}

type ExportJobEvaluation = { action: "run" | "wait" } | { action: "fail"; reason: string };

// Whether an export job can run now: every prerequisite job must be "completed" and every
// dependency address (full addresses, including #delivery upscales) must have a file. A
// failed/cancelled/missing prerequisite, or a dependency with no file and no active job,
// dooms the export.
export function evaluateExportJob(
  job: ExportJob,
  state: KonteState,
  jobs: JobIndex,
): ExportJobEvaluation {
  for (const depJobId of job.dependsOnJobs) {
    const depJob = jobs.get(depJobId);
    if (!depJob) {
      return { action: "fail", reason: `Prerequisite job ${depJobId} is gone (it was cleaned).` };
    }
    if (depJob.status === "completed") continue;
    if (depJob.status === "failed" || depJob.status === "cancelled") {
      const detail = depJob.error ? `: ${depJob.error}` : "";
      return {
        action: "fail",
        reason: `Prerequisite job ${depJobId} ${depJob.status}${detail}, so the export cannot run.`,
      };
    }
    return { action: "wait" };
  }

  for (const depAddress of job.dependsOnAssets) {
    if (assetHasFile(state, depAddress)) continue;
    if (jobs.hasActiveJobFor(depAddress)) return { action: "wait" };
    return {
      action: "fail",
      reason: `Dependency ${depAddress} has no ready variant and no active job — re-run "konte export".`,
    };
  }

  return { action: "run" };
}

// Run an export job: verify its dependencies are ready, atomically claim it under a lease
// (so exactly one worker renders even across concurrent watchers and crash-recovery), then
// render the delivered MP4 via renderVideoToFile. A live render renews the lease via heartbeat
// so it is never reclaimed; a crashed render's lease lapses and another worker reclaims it.
// Each attempt renders into its own timestamped dir and only commits the result if it still
// owns the lease — so a stalled-but-alive owner cannot collide with or clobber a reclaimer.
// A not-yet-ready job returns status "pending" (ranRender: false); a later pass retries.
export async function runExportJob(
  jobManager: JobManager,
  videoRoot: string,
  id: string,
  hooks: ExportJobHooks = {},
): Promise<RunExportJobResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== "export") {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not an export job`);
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return { id, status: job.status, outputFile: job.outputFile, ranRender: false };
  }

  const manager = await StateManager.load(videoRoot);
  const allJobs = await jobManager.listJobs();
  const evaluation = evaluateExportJob(job, manager.getState(), new JobIndex(allJobs));
  if (evaluation.action === "wait") {
    return { id, status: "pending", outputFile: null, ranRender: false };
  }
  if (evaluation.action === "fail") {
    // Compare-and-set so a concurrent worker/cancel that already finished this job isn't
    // clobbered — honor its terminal state instead.
    const committed = await jobManager.updateIfNotTerminal(id, {
      status: "failed",
      error: evaluation.reason,
      completedAt: new Date().toISOString(),
    });
    if (!committed) {
      const current = await jobManager.getJob(id).catch(() => null);
      return {
        id,
        status: current?.status ?? "failed",
        outputFile: current?.kind === "export" ? current.outputFile : null,
        ranRender: false,
      };
    }
    hooks.onSettled?.({ id, status: "failed", outputFile: null, error: evaluation.reason });
    return { id, status: "failed", outputFile: null, ranRender: true };
  }

  return runLeasedJob<RunExportJobResult>(jobManager, id, {
    onClaimFailed: async () => {
      // Owned by a live worker (lease valid) or already terminal — don't re-render.
      const current = await jobManager.getJob(id).catch(() => null);
      return {
        id,
        status: current?.status ?? "running",
        outputFile: current?.kind === "export" ? current.outputFile : null,
        ranRender: false,
      };
    },
    work: async ({ workerId }) => {
      try {
        hooks.onStarted?.({ id, outputDir: job.outputDir });
        jobManager.appendLog(id, `Export render started (worker ${workerId})`);

        const videoPath = stageEntryPath(videoRoot, "video");
        const [video, animatic] = await Promise.all([
          reloadVideoDefinition(videoPath),
          loadAnimatic(videoRoot, { reload: true }),
        ]);
        assertNarrationStemsPlaced(video, animatic);
        const decision = decideExportRender(
          job,
          computeExportPlanDigest(video),
          await computeDefinitionSourceFingerprint(videoRoot),
        );
        if (decision === "release") {
          const released = await jobManager.releaseIfOwner(id, workerId);
          jobManager.appendLog(
            id,
            `Released without rendering: this process (pid ${process.pid}) reloaded a definition ` +
              `that disagrees with the one this export was registered from although no ` +
              `definition file changed since — its loaded definitions are stale. A fresh process ` +
              `renders it.`,
          );
          const current = await jobManager.getJob(id).catch(() => null);
          return {
            id,
            status: released ? "pending" : (current?.status ?? "running"),
            outputFile: null,
            ranRender: false,
            released,
            pendingReason:
              "this process loaded a stale definition and stepped aside; a fresh process renders it",
          };
        }
        // Render into a fresh per-attempt dir under the job's base output dir, so a reclaimer
        // never writes the same files as a stalled prior owner.
        const outputDir = path.resolve(
          videoRoot,
          job.outputDir,
          job.noDelivery ? `${buildTimestamp()}_no_delivery` : buildTimestamp(),
        );
        // Stamped from the definition we ACTUALLY rendered (reloaded above), not the submit-time
        // one — so an edit between submit and render can't leave this export wearing a stale
        // signature. A no-delivery run is a working-size check, not a real deliverable, so it
        // carries no signature (and is excluded from `Last export`).
        const exportSignature = job.noDelivery ? null : computeExportSignature(video);
        const result = await renderVideoToFile({
          onLog: (line) => jobManager.appendLog(id, line),
          videoRoot,
          video,
          animatic,
          allowUnaccepted: job.allowUnaccepted,
          outputDir,
          exportSignature,
          noDelivery: job.noDelivery,
        });
        const outputFileRel = path.relative(videoRoot, result.outputFile);
        const committed = await jobManager.finishIfOwner(id, workerId, {
          status: "completed",
          progress: 100,
          outputFile: outputFileRel,
          completedAt: new Date().toISOString(),
          exportSignature,
        });
        if (!committed) {
          // Lost the lease mid-render (we stalled past the TTL and were reclaimed) — discard.
          jobManager.appendLog(
            id,
            `Export render superseded by another worker; discarding result.`,
          );
          const current = await jobManager.getJob(id).catch(() => null);
          return {
            id,
            status: current?.status ?? "running",
            outputFile: current?.kind === "export" ? current.outputFile : null,
            ranRender: true,
          };
        }
        jobManager.appendLog(id, `Export rendered: ${outputFileRel}`);
        for (const w of result.warnings) jobManager.appendLog(id, `Warning: ${w}`);
        hooks.onSettled?.({ id, status: "completed", outputFile: outputFileRel, error: null });
        return { id, status: "completed", outputFile: outputFileRel, ranRender: true };
      } catch (err) {
        const msg = errorMessage(err);
        const committed = await jobManager.finishIfOwner(id, workerId, {
          status: "failed",
          error: msg,
          completedAt: new Date().toISOString(),
        });
        if (committed) {
          jobManager.appendLog(id, `Export failed: ${msg}`);
          hooks.onSettled?.({ id, status: "failed", outputFile: null, error: msg });
        }
        return { id, status: "failed", outputFile: null, ranRender: true };
      }
    },
  });
}

// Run every runnable export job to completion (used by `konte job wait`). Skips export
// jobs still waiting on dependencies; fails those whose dependencies died.
export async function runRunnableExportJobs(
  jobManager: JobManager,
  videoRoot: string,
  hooks: ExportJobHooks = {},
): Promise<RunExportJobResult[]> {
  const allJobs = await jobManager.listJobs();
  const exportJobs = allJobs.filter(
    (j): j is ExportJob =>
      j.kind === "export" && (j.status === "pending" || j.status === "running"),
  );
  const results: RunExportJobResult[] = [];
  for (const j of exportJobs) {
    results.push(await runExportJob(jobManager, videoRoot, j.id, hooks));
  }
  return results;
}
