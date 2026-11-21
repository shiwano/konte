import { randomBytes } from "node:crypto";
import { errorMessage } from "../core/errors.js";
import { type JobManager, type JobUpdate, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import { startLeaseHeartbeat } from "../core/lease-heartbeat.js";

// `released`: the job was claimed and handed back unrun because this process's loaded definitions
// proved older than the files on disk; a fresh process runs it.
export type LeasedJobResult = { released?: boolean };

type LeasedJobContext = {
  workerId: string;
  // Whether `konte job cancel` flipped the job to "cancelled" since the claim.
  isCancelled: () => Promise<boolean>;
  // Commits "completed" while this worker still owns the job; `line` is logged only on a commit.
  complete: (line: string, update?: JobUpdate) => Promise<boolean>;
};

// Atomically claim a job under a run lease, keep the lease alive with a heartbeat while `work`
// runs, and always stop the heartbeat when it settles. The claim is the cross-worker mutual-
// exclusion guarantee — if another live worker owns the job (or it already went terminal), the
// claim returns null and the work does not run. A crashed worker stops renewing, its lease lapses,
// and a later pass reclaims and retries.
//
// A throw from `work` fails the job. Every terminal commit goes through finishIfOwner, and its log
// line is written only when the commit lands: a worker that lost the lease, or a job cancelled
// meanwhile, leaves both untouched.
export async function runLeasedJob(
  jobManager: JobManager,
  id: string,
  handlers: {
    // The job log's noun for a failure line, e.g. "Export" → "Export failed: …".
    failureLabel: string;
    work: (ctx: LeasedJobContext) => Promise<LeasedJobResult>;
  },
): Promise<LeasedJobResult> {
  const workerId = `w-${randomBytes(8).toString("hex")}`;
  const claimed = await jobManager.claimJobForRun(id, workerId, RUN_LEASE_TTL_MS);
  if (!claimed) return {};

  // Started before the try so the finally below ALWAYS stops it — including if `work` throws
  // before its own try.
  const stopHeartbeat = startLeaseHeartbeat(jobManager, id, workerId);

  const isCancelled = async (): Promise<boolean> => {
    const current = await jobManager.getJob(id).catch(() => null);
    return current?.status === "cancelled";
  };

  const complete = async (line: string, update: JobUpdate = {}): Promise<boolean> => {
    const committed = await jobManager.finishIfOwner(id, workerId, {
      ...update,
      status: "completed",
      error: null,
      progress: 100,
      completedAt: new Date().toISOString(),
    });
    if (committed) jobManager.appendLog(id, line);
    return committed;
  };

  try {
    return await handlers.work({ workerId, isCancelled, complete });
  } catch (err) {
    const msg = errorMessage(err);
    const committed = await jobManager.finishIfOwner(id, workerId, {
      status: "failed",
      error: msg,
      completedAt: new Date().toISOString(),
    });
    if (committed) jobManager.appendLog(id, `${handlers.failureLabel} failed: ${msg}`);
    return {};
  } finally {
    stopHeartbeat();
  }
}
