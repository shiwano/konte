import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ComfyUIBackend } from "../comfyui/backend.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import type { ComfyUIHttpClient } from "../comfyui/http-client.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { withFileLock } from "../core/file-lock.js";
import { JobManager, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import type { JobRecord } from "../core/types/index.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";
import { listVideos, type VideoRoots, VIDEOS_DIR } from "../core/roots.js";

// Acquiring the server-wide reboot lock may have to wait out another run's whole
// reboot-and-verify cycle (waitUntilReachable can take minutes), so allow well over that.
const REBOOT_LOCK_TIMEOUT_MS = 7 * 60 * 1000;
const REBOOT_LOCK_STALE_MS = 8 * 60 * 1000;

// Directory for the machine-global reboot lock. Shared across users (two people driving the same
// ComfyUI server must not reboot it at once), so it is created sticky + world-writable like /tmp
// itself — a plain 0755 dir would EACCES the second user's lock file and hard-fail their job.
// A pre-existing dir we can't chmod (an older konte made it 0755, owned by someone else) falls
// back to a per-user dir: reboots then serialize per user rather than machine-wide, which is a
// degradation, not a failure.
async function resolveRebootLockDir(): Promise<string> {
  const shared = path.join(os.tmpdir(), "konte");
  try {
    await fs.mkdir(shared, { recursive: true });
    // mkdir's mode is masked by umask, so set the bits explicitly. Fails when we don't own the
    // dir — the access check below then decides whether it is still usable.
    await fs.chmod(shared, 0o1777).catch(() => {});
    await fs.access(shared, fsConstants.W_OK | fsConstants.X_OK);
    return shared;
  } catch {
    const own = path.join(os.tmpdir(), `konte-${process.getuid?.() ?? "user"}`);
    await fs.mkdir(own, { recursive: true });
    return own;
  }
}

type ComfyNodeActivateJobHooks = {
  onStarted?: (info: { id: string }) => void;
  onSettled?: (info: {
    id: string;
    status: "completed" | "failed" | "cancelled";
    error: string | null;
  }) => void;
  // The activation was held back because the ComfyUI server is not idle. Fired on every pass a
  // caller polls, so a caller that surfaces it should de-duplicate.
  onDeferred?: (info: { id: string; reason: string }) => void;
  onLog?: (line: string) => void;
};

type RunComfyNodeActivateJobResult = {
  id: string;
  status: JobRecord["status"];
  // True only when THIS caller claimed the job and ran the activation.
  ranActivate: boolean;
  // Why a "pending" result is pending, when it is the idle gate rather than an unready
  // install dependency. Absent on every other outcome.
  pendingReason?: string;
};

/**
 * A konte job whose work is ABOUT to reach the server but is not in its queue yet: claimed for
 * submission, no prompt id committed. The server cannot report it, so only the job record can.
 *
 * A job that HAS a prompt id is deliberately not counted here — the server's own queue is the
 * authority on whether that prompt is still alive. Reading it from the record instead is what let
 * a sibling video's stale "running" row (its waiter died; the prompt finished long ago) block
 * activation forever.
 */
function isAboutToSubmit(job: JobRecord): boolean {
  if (job.kind === "generation") {
    return (
      job.backendKind === "comfy" &&
      (job.status === "running" || job.status === "queued") &&
      job.backendJobId == null
    );
  }
  // Manager work has no prompt id and no queue konte can read per-project, so the record is all
  // there is. A reboot mid-install abandons it.
  if (job.kind === "comfy-model-download" || job.kind === "comfy-node-install") {
    return job.status === "running";
  }
  return false;
}

/**
 * Everything the reboot below would destroy, or null when that cannot be determined.
 *
 * Two sources, because neither alone is complete:
 *
 * - **The server's own queue** is the authority on what it is holding, and the only thing that can
 *   see work konte did not create — another workspace on the same server, or a prompt someone
 *   queued in the ComfyUI UI. The reboot lock is machine-global for exactly that reason, so the
 *   idleness question has to be asked at the same scope.
 * - **Job records across this workspace**, for the gap the queue cannot cover: a job claimed for
 *   submission whose prompt id is not committed yet. It is about to land, and a reboot in that
 *   window loses it just the same.
 *
 * A queue that cannot be read contributes nothing rather than blocking. Deferring on it would be
 * the safer-looking choice and the wrong one: a server that answers nothing is holding nothing
 * this reboot could destroy, and waiting for it to prove itself idle means waiting forever — a
 * `job wait` with no ComfyUI running would never settle. Refusing to reboot an uninspectable
 * server is `activateNodes`' job, and it fails with a reason instead of spinning.
 */
async function findComfyServerWork(
  workspaceRoot: string,
  httpClient: ComfyUIHttpClient,
): Promise<string[]> {
  const queue = await httpClient.getQueue().catch(() => null);
  const queued = queue ? queue.queue_running.length + queue.queue_pending.length : 0;
  const busy = queued > 0 ? [`${queued} prompt(s) in ComfyUI's queue`] : [];
  busy.push(...(await findPendingComfySubmits(workspaceRoot)));
  return busy;
}

/**
 * The job-record half of the survey on its own — no network.
 *
 * Callers poll the gate about once a second, and an absent ComfyUI answers a queue probe only
 * after a connection timeout. Paying that on every pass made a single-id `job wait` on an
 * activation crawl. So the cheap half screens the common cases (work of ours about to land),
 * and the authoritative half runs once, under the reboot lock, where it decides.
 */
async function findPendingComfySubmits(workspaceRoot: string): Promise<string[]> {
  const busy: string[] = [];
  for (const video of await listVideos(workspaceRoot)) {
    const manager = new JobManager(path.join(workspaceRoot, VIDEOS_DIR, video));
    for (const job of await manager.listJobs()) {
      if (!isAboutToSubmit(job)) continue;
      busy.push(`${video}/${job.kind === "generation" ? job.address : job.id}`);
    }
  }
  return busy;
}

// Names at most this many busy jobs before collapsing the rest into a count.
const BUSY_NAMED_LIMIT = 3;

function describeBusy(busy: string[]): string {
  const named = busy.slice(0, BUSY_NAMED_LIMIT).join(", ");
  const rest = busy.length > BUSY_NAMED_LIMIT ? `, +${busy.length - BUSY_NAMED_LIMIT} more` : "";
  return `${busy.length} ComfyUI job(s) still in flight (${named}${rest})`;
}

/**
 * Run a comfy-node-activate job: once all its comfy-node-install dependencies are ready, make
 * the newly-installed packs live. Custom nodes register only after a ComfyUI restart, so this
 * reboots ComfyUI once (when needed) under a SERVER-WIDE reboot lock — keyed by the ComfyUI
 * baseUrl — so concurrent runs never reboot the server simultaneously. comfy generation jobs
 * depend on this job, so nothing generates until the nodes are loaded (or this fails).
 *
 * The reboot only happens while the ComfyUI server is IDLE workspace-wide (see
 * findComfyServerWork): rebooting under a live prompt orphans it, which is konte destroying its
 * own run. A busy server leaves the job "pending" with a `pendingReason`, same as an unready
 * dependency — a later pass retries, and the comfy generation jobs that depend on this one simply
 * wait their turn.
 *
 * A not-yet-ready dependency leaves the job "pending" (a later pass retries); a failed/missing
 * dependency fails it. The job's own claim lease (like exports) serializes workers per job.
 */
export async function runComfyNodeActivateJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  hooks: ComfyNodeActivateJobHooks = {},
): Promise<RunComfyNodeActivateJobResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== "comfy-node-activate") {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not a comfy node activate job`);
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return { id, status: job.status, ranActivate: false };
  }

  // Compare-and-set so a concurrent `job cancel` (or another worker) that already moved this job
  // to a terminal state isn't clobbered back to "failed" — honor its terminal state instead.
  const failActivation = async (reason: string): Promise<RunComfyNodeActivateJobResult> => {
    const committed = await jobManager.updateIfNotTerminal(id, {
      status: "failed",
      error: reason,
      completedAt: new Date().toISOString(),
    });
    if (!committed) {
      const current = await jobManager.getJob(id).catch(() => null);
      return { id, status: current?.status ?? "failed", ranActivate: false };
    }
    hooks.onSettled?.({ id, status: "failed", error: reason });
    return { id, status: "failed", ranActivate: true };
  };

  // Hand an already-claimed job back to the queue. A deferral is neither a failure nor a
  // completion, so the record must return to "pending" and drop its lease — left "running" with
  // no worker it would only be picked up again after the lease lapsed, as a stale reclaim.
  const deferActivation = async (reason: string): Promise<RunComfyNodeActivateJobResult> => {
    await jobManager.updateIfNotTerminal(id, { status: "pending", lease: null });
    jobManager.appendLog(id, `Node activation deferred: ${reason}`);
    hooks.onDeferred?.({ id, reason });
    return { id, status: "pending", ranActivate: false, pendingReason: reason };
  };

  // Gate on the install jobs this activation depends on.
  const allJobs = await jobManager.listJobs();
  for (const depJobId of job.dependsOnJobs) {
    const depJob = allJobs.find((j) => j.id === depJobId);
    if (!depJob) {
      return failActivation(`Prerequisite node install ${depJobId} is gone (it was cleaned).`);
    }
    if (depJob.status === "completed") continue;
    if (depJob.status === "failed" || depJob.status === "cancelled") {
      const detail = depJob.error ? `: ${depJob.error}` : "";
      return failActivation(`Prerequisite node install ${depJobId} ${depJob.status}${detail}.`);
    }
    return { id, status: "pending", ranActivate: false };
  }

  // Gate on the ComfyUI server being idle: the reboot below kills whatever it is running. The
  // cheap half runs here, before the claim, so a pass that is not this worker's turn costs neither
  // a state change nor a network round trip; the authoritative half runs under the reboot lock.
  const busy = await findPendingComfySubmits(roots.workspace);
  if (busy.length > 0) {
    const reason = describeBusy(busy);
    hooks.onDeferred?.({ id, reason });
    return { id, status: "pending", ranActivate: false, pendingReason: reason };
  }

  const workerId = `w-${crypto.randomBytes(8).toString("hex")}`;
  const claimed = await jobManager.claimJobForRun(id, workerId, RUN_LEASE_TTL_MS);
  if (!claimed) {
    const current = await jobManager.getJob(id).catch(() => null);
    return { id, status: current?.status ?? "running", ranActivate: false };
  }

  const stopHeartbeat = startLeaseHeartbeat(jobManager, id, workerId);

  try {
    hooks.onStarted?.({ id });
    jobManager.appendLog(id, `Node activation started (${job.cnrIds.length} pack(s))`);

    const config = await resolveComfyUIConfig(roots.workspace);
    const backend = new ComfyUIBackend(config, roots);

    // One reboot at a time across the whole machine for this ComfyUI server. The lock is keyed
    // by baseUrl and lives in a machine-global dir (NOT the video's .konte) so two DIFFERENT
    // projects targeting the same server also serialize their reboots; each re-checks what is
    // still unloaded and only reboots if needed. (Processes with a different TMPDIR don't share
    // the dir, so they don't serialize against each other — a limit of keying the lock to tmp.)
    const lockDir = await resolveRebootLockDir();
    const lockPath = path.join(
      lockDir,
      `comfy-reboot-${crypto.createHash("sha256").update(config.baseUrl).digest("hex").slice(0, 12)}.lock`,
    );
    // Mutated inside the lock rather than returned from it, so the deferral is handled after the
    // lock is released — the retry belongs to a later pass, not to this critical section.
    const deferral: { reason: string | null } = { reason: null };
    await withFileLock(
      lockPath,
      async () => {
        // Acquiring the lock can wait out another run's whole reboot-and-verify cycle (minutes),
        // and the pre-claim gate above is that stale by now. A prompt submitted in that window is
        // exactly what this gate exists to protect.
        const stillBusy = await findComfyServerWork(roots.workspace, backend.httpClient);
        if (stillBusy.length > 0) {
          deferral.reason = describeBusy(stillBusy);
          return;
        }
        await backend.activateNodes(job.cnrIds, {
          onLog: (line) => {
            jobManager.appendLog(id, line);
            hooks.onLog?.(line);
          },
        });
      },
      { timeoutMs: REBOOT_LOCK_TIMEOUT_MS, staleMs: REBOOT_LOCK_STALE_MS },
    );

    if (deferral.reason !== null) return deferActivation(deferral.reason);

    await jobManager.finishIfOwner(id, workerId, {
      status: "completed",
      progress: 100,
      completedAt: new Date().toISOString(),
    });
    jobManager.appendLog(id, `Node activation completed`);
    hooks.onSettled?.({ id, status: "completed", error: null });
    return { id, status: "completed", ranActivate: true };
  } catch (err) {
    const msg = errorMessage(err);
    await jobManager.finishIfOwner(id, workerId, {
      status: "failed",
      error: msg,
      completedAt: new Date().toISOString(),
    });
    jobManager.appendLog(id, `Node activation failed: ${msg}`);
    hooks.onSettled?.({ id, status: "failed", error: msg });
    return { id, status: "failed", ranActivate: true };
  } finally {
    stopHeartbeat();
  }
}

// Run every runnable comfy-node-activate job (used by a bare `konte job wait`). Skips jobs still
// waiting on their install dependencies; fails those whose dependencies died; holds all of them
// while the ComfyUI server is busy.
export async function runRunnableComfyNodeActivateJobs(
  jobManager: JobManager,
  roots: VideoRoots,
  hooks: ComfyNodeActivateJobHooks = {},
): Promise<RunComfyNodeActivateJobResult[]> {
  const allJobs = await jobManager.listJobs();
  const jobs = allJobs.filter(
    (j) => j.kind === "comfy-node-activate" && (j.status === "pending" || j.status === "running"),
  );
  if (jobs.length === 0) return [];

  // The idle gate, answered ONCE for the batch. It is the same question for every job here, and
  // the cascade re-runs this every second — asking per job would poll the server and re-read every
  // job file of every video N times a second. The per-job gate still runs below and stays
  // authoritative; this only skips the calls that are certain to defer.
  const busy = await findPendingComfySubmits(roots.workspace);
  if (busy.length > 0) {
    const reason = describeBusy(busy);
    return jobs.map((j) => {
      hooks.onDeferred?.({ id: j.id, reason });
      return { id: j.id, status: "pending" as const, ranActivate: false, pendingReason: reason };
    });
  }

  const results: RunComfyNodeActivateJobResult[] = [];
  for (const j of jobs) {
    results.push(await runComfyNodeActivateJob(jobManager, roots, j.id, hooks));
  }
  return results;
}
