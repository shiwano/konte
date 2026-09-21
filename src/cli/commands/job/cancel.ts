import type { Command } from "commander";
import { KonteError, errorMessage } from "../../../core/errors.js";
import { isJobTerminal, JobManager } from "../../../core/job-manager.js";
import { StateManager } from "../../../core/state/index.js";
import { getBackendKindFromJob, resolveBackend } from "../../../backends/resolve-backend.js";
import { confirmAction, printAborted } from "../../confirm.js";
import { requireVideoRoots } from "../../context.js";
import type { VideoRoots } from "../../../core/roots.js";

type CancelResult = {
  jobId: string;
  outcome: "cancelled" | "skipped" | "failed";
  reason?: string;
  job?: unknown;
  message: string;
};

// A compare-and-set cancel found the job already terminal: an owner committed its result
// between our initial terminal check and the write, so report it skipped rather than
// clobbering that state (and, for generation jobs, wiping its output file from state).
async function skippedTerminal(jobManager: JobManager, jobId: string): Promise<CancelResult> {
  const current = await jobManager.getJob(jobId).catch(() => null);
  const reason = `already in terminal state "${current?.status ?? "unknown"}"`;
  return {
    jobId,
    outcome: "skipped",
    reason,
    message: `Skipped ${jobId}: ${reason}`,
  };
}

async function cancelOne(
  jobManager: JobManager,
  roots: VideoRoots,
  jobId: string,
): Promise<CancelResult> {
  const videoRoot = roots.video;
  let job;
  try {
    job = await jobManager.getJob(jobId);
  } catch (err) {
    const reason = err instanceof KonteError ? err.message : String(err);
    return {
      jobId,
      outcome: "failed",
      reason,
      message: `Skipped ${jobId}: ${reason}`,
    };
  }

  if (isJobTerminal(job.status)) {
    const reason = `already in terminal state "${job.status}"`;
    return {
      jobId,
      outcome: "skipped",
      reason,
      message: `Skipped ${jobId}: ${reason}`,
    };
  }

  // Comfy model download jobs aren't tied to an asset/variant and have no
  // backend prompt to interrupt. Mark cancelled (a running worker observes
  // this and stops waiting); the install may still finish server-side —
  // ComfyUI-Manager has no abort API — which is harmless (the model is
  // cached). Generation jobs depending on this model will fail on cascade.
  if (job.kind === "comfy-model-download") {
    const cancelledJob = await jobManager.updateIfNotTerminal(jobId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    if (!cancelledJob) return skippedTerminal(jobManager, jobId);
    const filename = job.model.filename;
    console.warn(
      `Cancelled comfy model download "${filename}". ` +
        "If the download already started, ComfyUI-Manager may finish it in the background " +
        "(harmless — the model is cached). Generation jobs needing this model will fail.",
    );
    return {
      jobId,
      outcome: "cancelled",
      job: cancelledJob,
      message: `Comfy model download ${jobId} cancelled.`,
    };
  }

  // Custom node install/activate jobs aren't tied to an asset/variant and have no backend
  // prompt to interrupt. Mark cancelled (a running install worker stops on the next status
  // check); an install already started may finish server-side (harmless). Generation jobs
  // depending on this will fail on cascade.
  if (job.kind === "comfy-node-install" || job.kind === "comfy-node-activate") {
    const cancelledJob = await jobManager.updateIfNotTerminal(jobId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    if (!cancelledJob) return skippedTerminal(jobManager, jobId);
    const what =
      job.kind === "comfy-node-install" ? `node install "${job.node.id}"` : `node activation`;
    return {
      jobId,
      outcome: "cancelled",
      job: cancelledJob,
      message: `Comfy ${what} ${jobId} cancelled.`,
    };
  }

  // Export jobs aren't tied to an asset/variant and have no backend prompt. Mark
  // cancelled (a running worker stops on the next status check); a render already in
  // flight may still finish writing its file — harmless, just re-export to refresh.
  if (job.kind === "export") {
    const cancelledJob = await jobManager.updateIfNotTerminal(jobId, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    if (!cancelledJob) return skippedTerminal(jobManager, jobId);
    return {
      jobId,
      outcome: "cancelled",
      job: cancelledJob,
      message: `Export job ${jobId} cancelled.`,
    };
  }

  if (job.backendJobId) {
    try {
      const backendKind = getBackendKindFromJob(job);
      const backend = await resolveBackend(backendKind, roots);
      await backend.cancel(job.backendJobId);
    } catch (err) {
      // Cancellation on the backend is best-effort, but surface the failure so the
      // user knows the backend job may still be running even though konte records it
      // as cancelled. Warn on stderr to keep the outcome lines on stdout clean.
      const msg = errorMessage(err);
      console.warn(
        `Warning: failed to cancel backend job "${job.backendJobId}": ${msg}\n` +
          "The backend may still be running it; verify and stop it manually if needed.",
      );
    }
  }

  // Compare-and-set: if the owner committed "completed" between our initial terminal check and
  // now, don't overwrite it with "cancelled" — and, crucially, don't fall through to the state
  // wipe below, which would erase the real output file from state.
  const cancelledJob = await jobManager.updateIfNotTerminal(jobId, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
  });
  if (!cancelledJob) return skippedTerminal(jobManager, jobId);

  try {
    await StateManager.withLock(videoRoot, async (manager) => {
      // Use tryGetAssetState, not ensureAssetState: a job whose asset was already pruned
      // must not be resurrected into state just to mark its (gone) variant cancelled.
      const variant = manager.tryGetAssetState(job.address)?.variants?.[job.variantId];
      if (variant) {
        variant.status = "none";
        variant.file = null;
        variant.readyAt = null;
        delete variant.media;
        variant.metadata = { cancelledAt: new Date().toISOString() };
      }
    });
  } catch {
    // state update is best-effort
  }

  return {
    jobId,
    outcome: "cancelled",
    job: cancelledJob,
    message: `Generation job ${jobId} cancelled.`,
  };
}

export function registerJobCancelCommand(program: Command): void {
  program
    .command("cancel <jobId...>")
    .description("Cancel one or more running jobs")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .action(async (jobIds: string[], opts: { yes?: boolean; no?: boolean }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const jobManager = new JobManager(videoRoot);
      const ids = [...new Set(jobIds)];

      const confirmed = await confirmAction(
        ids.length === 1
          ? `Job "${ids[0]}" will be cancelled. Continue?`
          : `${ids.length} jobs will be cancelled: ${ids.join(", ")}. Continue?`,
        { yes: opts.yes, no: opts.no },
      );
      if (!confirmed) {
        printAborted();
        return;
      }

      const results: CancelResult[] = [];
      for (const id of ids) {
        results.push(await cancelOne(jobManager, roots, id));
      }

      for (const r of results) {
        console.log(r.message);
      }

      if (results.some((r) => r.outcome === "failed")) process.exitCode = 1;
    });
}
