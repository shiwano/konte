import { randomUUID } from "node:crypto";
import { type ComfyInstallOutcome, ComfyUIBackend } from "../comfyui/backend.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import type { ModelDownloadProgress } from "../comfyui/model-downloader.js";
import { KonteError } from "../core/errors.js";
import { isJobTerminal, type JobManager } from "../core/job-manager.js";
import { TransientPollError } from "../core/poll-until-terminal.js";
import type { ComfyModelDownloadJob, ComfyNodeInstallJob, JobRecord } from "../core/types/index.js";
import { resolveUrlTokens } from "../comfyui/token-resolver.js";
import { startProgressWriter } from "./progress-writer.js";
import { type LeasedJobResult, runLeasedJob } from "./run-leased-job.js";
import type { VideoRoots } from "../core/roots.js";

type ComfyInstallOpts = {
  // Only konte's own downloader can report this; a Manager-driven install reports whole models.
  onBytes?: (p: ModelDownloadProgress) => void;
  onLog?: (msg: string) => void;
  shouldCancel?: () => boolean | Promise<boolean>;
};

type ComfyInstallSpec<J extends JobRecord> = {
  kind: J["kind"] & ("comfy-model-download" | "comfy-node-install");
  // Human noun for log lines, e.g. "Model download" / "Node install".
  logNoun: string;
  // Verb for the "continues server-side" messages, e.g. "download" / "install".
  runNoun: string;
  getLabel: (job: J) => string;
  install: (
    backend: ComfyUIBackend,
    job: J,
    opts: ComfyInstallOpts,
  ) => Promise<ComfyInstallOutcome>;
};

/**
 * Run a ComfyUI install job (model download or custom-node install): atomically claim it
 * under a run lease and install via ComfyUI-Manager. The claim is the cross-worker mutual-
 * exclusion guarantee; a crashed owner's lease lapses and another worker reclaims and retries
 * (re-running is harmless — ComfyUI-Manager dedups an already-installed pack / cached model).
 *
 * Cancellation: the running install polls the job's own status and bails if it flipped to
 * "cancelled" (`konte job cancel`). The Manager has no abort API, so the server-side work may
 * still finish — harmless. We never overwrite a "cancelled" terminal state with ready/failed.
 */
async function runComfyInstallJob<J extends JobRecord>(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  spec: ComfyInstallSpec<J>,
): Promise<LeasedJobResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== spec.kind) {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not a ${spec.kind} job`);
  }
  const typedJob = job as J;
  const label = spec.getLabel(typedJob);

  if (isJobTerminal(job.status)) return {};

  return runLeasedJob(jobManager, id, {
    failureLabel: spec.logNoun,
    work: async ({ isCancelled, complete }) => {
      const progress = startProgressWriter(jobManager, id, typedJob.progress);

      try {
        jobManager.appendLog(id, `${spec.logNoun} started: ${label}`);

        const config = await resolveComfyUIConfig(roots.workspace);
        // Persist a ComfyUI client_id on the job (set-once, like a generation job's
        // comfyClientId) and reuse it across reclaims. The Manager's install queue is client_id
        // scoped, so a reclaimer that shares this id can observe the original owner's in-flight
        // download (see ComfyUIBackend.installModel) instead of blindly re-queueing it.
        const persisted =
          typeof typedJob.metadata.comfyClientId === "string"
            ? typedJob.metadata.comfyClientId
            : undefined;
        const clientId = persisted ?? randomUUID();
        if (!persisted) {
          await jobManager.updateJob(id, {
            metadata: { ...typedJob.metadata, comfyClientId: clientId },
          });
        }
        const backend = new ComfyUIBackend({ ...config, clientId }, roots);

        const outcome = await spec.install(backend, typedJob, {
          onLog: (line) => jobManager.appendLog(id, line),
          onBytes: (p) => {
            if (p.total !== null) progress.write(p.received, p.total);
          },
          shouldCancel: isCancelled,
        });
        await progress.settle();

        if (outcome.kind === "cancelled") return {};

        // The waiter's deadline elapsed — NOT a failure. The Manager has no abort API, so the
        // work keeps running server-side and is re-observable via its queue. Leave the job
        // non-terminal (status stays "running"; the lease lapses when the heartbeat stops) so a
        // later pass reclaims and re-attaches.
        if (outcome.kind === "timedOut") {
          jobManager.appendLog(
            id,
            `Stopped waiting for ${label}; the ${spec.runNoun} continues server-side and will be re-observed.`,
          );
          return {};
        }

        await complete(`${spec.logNoun} completed: ${label}`);
        return {};
      } catch (err) {
        await progress.settle();
        // A transient comms failure (Manager/ComfyUI briefly unreachable, 5xx) is NOT an install
        // failure — leave the job non-terminal (running; lease lapses) so a later pass re-observes
        // and retries, mirroring how generation waits never fail on transient.
        if (err instanceof TransientPollError && !(await isCancelled())) {
          jobManager.appendLog(
            id,
            `Stopped on a transient comms failure (${err.message}); ${label} is re-observable and will be retried.`,
          );
          return {};
        }
        throw err;
      }
    },
  });
}

// Run a comfy-model-download job.
export function runComfyModelDownloadJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
): Promise<LeasedJobResult> {
  return runComfyInstallJob<ComfyModelDownloadJob>(jobManager, roots, id, {
    kind: "comfy-model-download",
    logNoun: "Model download",
    runNoun: "download",
    getLabel: (job) => job.model.filename,
    install: (backend, job, opts) =>
      backend.installModel(job.model, resolveUrlTokens(job.model.url), opts),
  });
}

// Run a comfy-node-install job — installs the pack to disk only; loading it (a ComfyUI reboot)
// is the comfy-node-activate job's responsibility.
export function runComfyNodeInstallJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
): Promise<LeasedJobResult> {
  return runComfyInstallJob<ComfyNodeInstallJob>(jobManager, roots, id, {
    kind: "comfy-node-install",
    logNoun: "Node install",
    runNoun: "install",
    getLabel: (job) => job.node.id,
    install: (backend, job, opts) => backend.installNode(job.node, opts),
  });
}
