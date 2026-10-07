import * as crypto from "node:crypto";
import { ensureDeploymentReady } from "../comfy-api/deployment.js";
import { comfyApiKey, COMFY_API_KEY_ENV } from "../comfy-api/routing.js";
import { loadKonteConfig } from "../core/config.js";
import { missingCredentialMessage } from "../core/credentials.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { type JobManager, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import type { VideoRoots } from "../core/roots.js";
import type { JobRecord } from "../core/types/index.js";
import { sleep } from "../core/sleep.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";

const DEFER_RETRY_MS = 30_000;

type ComfyApiDeployJobHooks = {
  onStarted?: (info: { id: string; deployment: string }) => void;
  onSettled?: (info: {
    id: string;
    status: "completed" | "failed" | "cancelled";
    error: string | null;
  }) => void;
  onLog?: (line: string) => void;
};

type RunComfyApiDeployJobResult = {
  id: string;
  status: JobRecord["status"];
  // True only when THIS caller claimed the job and ran the bring-up.
  ran: boolean;
};

/**
 * Run a comfy-api-deploy job: bring its deployment up (see `ensureDeploymentReady`) so the
 * generation jobs routed to it can submit. The job's claim lease makes one worker per video run
 * it; the deployment's own lock makes one process across the workspace do the work.
 */
export async function runComfyApiDeployJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  hooks: ComfyApiDeployJobHooks = {},
): Promise<RunComfyApiDeployJobResult> {
  const job = await jobManager.getJob(id);
  if (job.kind !== "comfy-api-deploy") {
    throw new KonteError("VALIDATION_FAILED", `Job "${id}" is not a Comfy API deploy job`);
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return { id, status: job.status, ran: false };
  }

  const workerId = `w-${crypto.randomBytes(8).toString("hex")}`;
  const claimed = await jobManager.claimJobForRun(id, workerId, RUN_LEASE_TTL_MS);
  if (!claimed) {
    const current = await jobManager.getJob(id).catch(() => null);
    return { id, status: current?.status ?? "running", ran: false };
  }

  const stopHeartbeat = startLeaseHeartbeat(jobManager, id, workerId);
  const log = (line: string): void => {
    jobManager.appendLog(id, line);
    hooks.onLog?.(line);
  };
  try {
    hooks.onStarted?.({ id, deployment: job.deployment });
    log(`Bringing up Comfy API deployment ${job.deployment}`);
    const apiKey = comfyApiKey();
    if (apiKey === null) {
      throw new KonteError("BACKEND_NOT_CONFIGURED", missingCredentialMessage(COMFY_API_KEY_ENV));
    }
    const config = await loadKonteConfig(roots.workspace);
    // A `job cancel` only marks the record; the bring-up reads it between steps.
    const shouldCancel = async (): Promise<boolean> =>
      (await jobManager.getJob(id).catch(() => null))?.status === "cancelled";
    await ensureDeploymentReady(
      { workspaceRoot: roots.workspace, config, apiKey, log, shouldCancel },
      job.deployment,
    );
    const committed = await jobManager.finishIfOwner(id, workerId, {
      status: "completed",
      progress: 100,
      completedAt: new Date().toISOString(),
    });
    if (!committed) return settledElsewhere(jobManager, id);
    hooks.onSettled?.({ id, status: "completed", error: null });
    return { id, status: "completed", ran: true };
  } catch (err) {
    const msg = errorMessage(err);
    if (err instanceof KonteError && err.code === "COMFY_API_DEPLOY_DEFERRED") {
      // Back to the queue; a later pass tries again once the jobs on the old deployment end.
      await jobManager.updateIfNotTerminal(id, { status: "pending", lease: null });
      log(`Deployment bring-up deferred: ${msg}`);
      // Held here so the daemon's scan and `job wait`'s loop do not re-run the bring-up every pass.
      await sleep(DEFER_RETRY_MS);
      return { id, status: "pending", ran: false };
    }
    if (err instanceof KonteError && err.code === "COMFY_API_DEPLOY_CANCELLED") {
      log(msg);
      return settledElsewhere(jobManager, id);
    }
    const committed = await jobManager.finishIfOwner(id, workerId, {
      status: "failed",
      error: msg,
      completedAt: new Date().toISOString(),
    });
    if (!committed) return settledElsewhere(jobManager, id);
    log(`Deployment bring-up failed: ${msg}`);
    hooks.onSettled?.({ id, status: "failed", error: msg });
    return { id, status: "failed", ran: true };
  } finally {
    stopHeartbeat();
  }
}

// The job reached a terminal state through someone else — a `job cancel` above all — while this
// worker held it; report what the record says.
async function settledElsewhere(
  jobManager: JobManager,
  id: string,
): Promise<RunComfyApiDeployJobResult> {
  const current = await jobManager.getJob(id).catch(() => null);
  return { id, status: current?.status ?? "cancelled", ran: true };
}

/** Run every pending or stranded deploy job of the video (a bare `konte job wait`). */
export async function runRunnableComfyApiDeployJobs(
  jobManager: JobManager,
  roots: VideoRoots,
  hooks: ComfyApiDeployJobHooks = {},
): Promise<RunComfyApiDeployJobResult[]> {
  const jobs = (await jobManager.listJobs()).filter(
    (j) => j.kind === "comfy-api-deploy" && (j.status === "pending" || j.status === "running"),
  );
  return Promise.all(jobs.map((j) => runComfyApiDeployJob(jobManager, roots, j.id, hooks)));
}
