import * as path from "node:path";
import { KonteError } from "../core/errors.js";
import { computeDefinitionSourceFingerprint } from "../core/definition-source.js";
import { computeExportPlanDigest, computeExportSignature } from "../core/export-signature.js";
import { JobIndex, prerequisiteVerdict } from "../core/job-index.js";
import { isJobTerminal, type JobManager } from "../core/job-manager.js";
import { loadVideoAndAnimatic } from "../core/stage-definitions.js";
import { renderVideoToFile } from "../core/render-video.js";
import { LocalBackend } from "../local/backend.js";
import { type LeasedJobResult, runLeasedJob } from "./run-leased-job.js";
import { buildTimestamp } from "../core/review-record.js";
import { StateManager } from "../core/state/index.js";
import type { ExportJob, KonteState } from "../core/types/index.js";

type ExportRenderDecision = "render" | "release";

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
  const prerequisites = prerequisiteVerdict(job.dependsOnJobs, (id) => jobs.get(id));
  if (prerequisites.verdict === "wait") return { action: "wait" };
  if (prerequisites.verdict === "doomed") {
    const { depId, dep } = prerequisites;
    if (!dep) {
      return { action: "fail", reason: `Prerequisite job ${depId} is gone (it was cleaned).` };
    }
    const detail = dep.error ? `: ${dep.error}` : "";
    return {
      action: "fail",
      reason: `Prerequisite job ${depId} ${dep.status}${detail}, so the export cannot run.`,
    };
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
// A not-yet-ready job stays "pending"; a later pass retries.
export async function runExportJob(
  jobManager: JobManager,
  videoRoot: string,
  id: string,
): Promise<LeasedJobResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== "export") {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not an export job`);
  }
  if (isJobTerminal(job.status)) return {};

  // Jobs before state, as the generation pass reads them: an upscale finishing in between is then
  // a job still running over a state that already has its take, never the reverse.
  const allJobs = await jobManager.listJobs();
  const manager = await StateManager.load(videoRoot);
  const evaluation = evaluateExportJob(job, manager.getState(), new JobIndex(allJobs));
  if (evaluation.action === "wait") return {};
  if (evaluation.action === "fail") {
    // Compare-and-set so a concurrent worker/cancel that already finished this job isn't
    // clobbered — honor its terminal state instead.
    await jobManager.updateIfNotTerminal(id, {
      status: "failed",
      error: evaluation.reason,
      completedAt: new Date().toISOString(),
    });
    return {};
  }

  return runLeasedJob(jobManager, id, {
    failureLabel: "Export",
    work: async ({ workerId, complete }) => {
      jobManager.appendLog(id, `Export render started (worker ${workerId})`);

      const { video, animatic } = await loadVideoAndAnimatic(videoRoot, { reload: true });
      const decision = decideExportRender(
        job,
        computeExportPlanDigest(video),
        await computeDefinitionSourceFingerprint(videoRoot),
      );
      if (decision === "release") {
        const released = await jobManager.releaseIfOwner(id, workerId, "stale");
        if (released) {
          jobManager.appendLog(
            id,
            `Released without rendering: this process (pid ${process.pid}) reloaded a definition ` +
              `that disagrees with the one this export was registered from although no ` +
              `definition file changed since — its loaded definitions are stale. A fresh process ` +
              `renders it.`,
          );
        }
        return { released };
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
        rederiveLocal: async (address, definition, resolvedDependencies, outputDir) => {
          const backend = new LocalBackend(videoRoot);
          await backend.submit({
            address,
            assetDefinition: definition,
            variantId: `thumbnail-${id}`,
            outputDir,
            resolvedDependencies,
          });
          const done = await backend.waitForCompletion("", outputDir);
          if (done.kind !== "done" || !done.result.files[0]) {
            throw new KonteError("GENERATION_FAILED", `${address} made no file`);
          }
          return done.result.files[0];
        },
      });
      const outputFileRel = path.relative(videoRoot, result.outputFile);
      const committed = await complete(`Export rendered: ${outputFileRel}`, {
        outputFile: outputFileRel,
        exportSignature,
      });
      if (committed) {
        for (const w of result.warnings) jobManager.appendLog(id, `Warning: ${w}`);
      }
      return {};
    },
  });
}
