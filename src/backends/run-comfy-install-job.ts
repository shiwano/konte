import * as crypto from "node:crypto";
import { type ComfyInstallOutcome, ComfyUIBackend } from "../comfyui/backend.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import type { ManagerQueueStatus } from "../comfyui/manager-client.js";
import type { ModelDownloadProgress } from "../comfyui/model-downloader.js";
import { KonteError, errorMessage } from "../core/errors.js";
import type { JobManager } from "../core/job-manager.js";
import { TransientPollError } from "../core/poll-until-terminal.js";
import type { ComfyModelDownloadJob, ComfyNodeInstallJob, JobRecord } from "../core/types/index.js";
import { resolveUrlTokens } from "../comfyui/token-resolver.js";
import { runLeasedJob } from "./run-leased-job.js";
import type { VideoRoots } from "../core/roots.js";

type ComfyInstallOpts = {
  onProgress?: (status: ManagerQueueStatus) => void;
  // Only konte's own downloader can report this; a Manager-driven install reports whole models.
  onBytes?: (p: ModelDownloadProgress) => void;
  onLog?: (msg: string) => void;
  shouldCancel?: () => boolean | Promise<boolean>;
};

// Hooks shared by the two install job kinds — `label` is the filename for a model download, the
// node id for a node install.
type ComfyInstallHooks = {
  onStarted?: (info: { id: string; label: string }) => void;
  onProgress?: (info: {
    id: string;
    label: string;
    done: number;
    total: number;
    inProgress: number;
  }) => void;
  onSettled?: (info: {
    id: string;
    label: string;
    status: "completed" | "failed" | "cancelled";
    error: string | null;
  }) => void;
  onLog?: (line: string) => void;
};

type RunComfyInstallResult = {
  id: string;
  status: JobRecord["status"];
  // True only when THIS caller claimed the job and performed the install.
  ranInstall: boolean;
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
  hooks: ComfyInstallHooks = {},
): Promise<RunComfyInstallResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== spec.kind) {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not a ${spec.kind} job`);
  }
  const typedJob = job as J;
  const label = spec.getLabel(typedJob);

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return { id, status: job.status, ranInstall: false };
  }

  return runLeasedJob<RunComfyInstallResult>(jobManager, id, {
    onClaimFailed: async () => {
      // Owned by a live worker (lease valid) or just went terminal. Don't re-run; the owner
      // drives completion and the cascade. If the owner crashed, a later pass reclaims this job.
      const current = await jobManager.getJob(id).catch(() => null);
      return { id, status: current?.status ?? "running", ranInstall: false };
    },
    work: async ({ workerId, isCancelled }) => {
      // Persist byte progress (as an integer percent) onto the job record, so `job list` /
      // `status` show a large download advancing without a live waiter attached. Throttled to
      // actual percent changes with at most one write in flight; a dropped write self-heals on
      // the next percent.
      let lastPersistedPct = typedJob.progress;
      let persisting = false;
      let settled = false;
      let lastPersistWrite: Promise<unknown> = Promise.resolve();
      const persistBytes = ({ received, total }: ModelDownloadProgress): void => {
        if (settled || total === null || total <= 0 || persisting) return;
        const pct = Math.min(100, Math.max(0, Math.round((received / total) * 100)));
        if (pct === lastPersistedPct) return;
        lastPersistedPct = pct;
        persisting = true;
        lastPersistWrite = jobManager
          .updateJob(id, { progress: pct })
          .catch(() => {})
          .finally(() => {
            persisting = false;
          });
      };
      // Before any terminal state is committed: a stray sub-100 update landing afterwards would
      // walk a completed job's progress backwards, or touch a record this worker no longer owns.
      const settleProgress = async (): Promise<void> => {
        settled = true;
        await lastPersistWrite;
      };

      try {
        hooks.onStarted?.({ id, label });
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
        const clientId = persisted ?? crypto.randomUUID();
        if (!persisted) {
          await jobManager.updateJob(id, {
            metadata: { ...typedJob.metadata, comfyClientId: clientId },
          });
        }
        const backend = new ComfyUIBackend({ ...config, clientId }, roots);

        const outcome = await spec.install(backend, typedJob, {
          onLog: (line) => {
            jobManager.appendLog(id, line);
            hooks.onLog?.(line);
          },
          onProgress: (status) =>
            hooks.onProgress?.({
              id,
              label,
              done: status.done_count,
              total: 1,
              inProgress: status.in_progress_count,
            }),
          onBytes: (p) => {
            persistBytes(p);
            if (p.total !== null && p.total > 0) {
              hooks.onProgress?.({
                id,
                label,
                done: p.received,
                total: p.total,
                inProgress: 1,
              });
            }
          },
          shouldCancel: isCancelled,
        });
        await settleProgress();

        if (outcome.kind === "cancelled" || (await isCancelled())) {
          hooks.onSettled?.({ id, label, status: "cancelled", error: null });
          return { id, status: "cancelled", ranInstall: true };
        }

        // The waiter's deadline elapsed — NOT a failure. The Manager has no abort API, so the
        // work keeps running server-side and is re-observable via its queue. Leave the job
        // non-terminal (status stays "running"; the lease lapses when the heartbeat stops) so a
        // later pass reclaims and re-attaches. Crucially a returned value — not a thrown error
        // the catch below could mark failed.
        if (outcome.kind === "timedOut") {
          jobManager.appendLog(
            id,
            `Stopped waiting for ${label}; the ${spec.runNoun} continues server-side and will be re-observed.`,
          );
          return { id, status: "running", ranInstall: true };
        }

        // finishIfOwner guards against a stalled-but-alive worker overwriting a reclaimer's
        // result — only the current lease owner commits the terminal state.
        await jobManager.finishIfOwner(id, workerId, {
          status: "completed",
          progress: 100,
          completedAt: new Date().toISOString(),
        });
        jobManager.appendLog(id, `${spec.logNoun} completed: ${label}`);
        hooks.onSettled?.({ id, label, status: "completed", error: null });
        return { id, status: "completed", ranInstall: true };
      } catch (err) {
        await settleProgress();
        // A cancel that raced with the error wins — leave the cancelled state.
        if (await isCancelled()) {
          hooks.onSettled?.({ id, label, status: "cancelled", error: null });
          return { id, status: "cancelled", ranInstall: true };
        }
        // A transient comms failure (Manager/ComfyUI briefly unreachable, 5xx) is NOT an install
        // failure — leave the job non-terminal (running; lease lapses) so a later pass re-observes
        // and retries, mirroring how generation waits never fail on transient.
        if (err instanceof TransientPollError) {
          jobManager.appendLog(
            id,
            `Stopped on a transient comms failure (${err.message}); ${label} is re-observable and will be retried.`,
          );
          return { id, status: "running", ranInstall: true };
        }
        const msg = errorMessage(err);
        await jobManager.finishIfOwner(id, workerId, {
          status: "failed",
          error: msg,
          completedAt: new Date().toISOString(),
        });
        jobManager.appendLog(id, `${spec.logNoun} failed: ${msg}`);
        hooks.onSettled?.({ id, label, status: "failed", error: msg });
        return { id, status: "failed", ranInstall: true };
      }
    },
  });
}

// Run a comfy-model-download job. `onProgress`'s `done`/`total` count bytes when konte downloads
// the model itself and whole models when ComfyUI-Manager does; one job only ever takes one path.
export function runComfyModelDownloadJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  hooks: ComfyInstallHooks = {},
): Promise<RunComfyInstallResult> {
  return runComfyInstallJob<ComfyModelDownloadJob>(
    jobManager,
    roots,
    id,
    {
      kind: "comfy-model-download",
      logNoun: "Model download",
      runNoun: "download",
      getLabel: (job) => job.model.filename,
      install: (backend, job, opts) =>
        backend.installModel(job.model, resolveUrlTokens(job.model.url), opts),
    },
    hooks,
  );
}

// Run a comfy-node-install job — installs the pack to disk only; loading it (a ComfyUI reboot)
// is the comfy-node-activate job's responsibility.
export function runComfyNodeInstallJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  hooks: ComfyInstallHooks = {},
): Promise<RunComfyInstallResult> {
  return runComfyInstallJob<ComfyNodeInstallJob>(
    jobManager,
    roots,
    id,
    {
      kind: "comfy-node-install",
      logNoun: "Node install",
      runNoun: "install",
      getLabel: (job) => job.node.id,
      install: (backend, job, opts) => backend.installNode(job.node, opts),
    },
    hooks,
  );
}
