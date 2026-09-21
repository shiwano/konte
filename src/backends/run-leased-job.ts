import * as crypto from "node:crypto";
import { type JobManager, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";

type LeasedJobContext = {
  // The lease owner id — pass to finishIfOwner so only the current owner commits terminal state.
  workerId: string;
  // Whether `konte job cancel` flipped the job to "cancelled" since the claim.
  isCancelled: () => Promise<boolean>;
};

// Atomically claim a job under a run lease, keep the lease alive with a heartbeat while `work`
// runs, and always stop the heartbeat when it settles. The claim is the cross-worker mutual-
// exclusion guarantee — if another live worker owns the job (or it already went terminal), the
// claim returns null and `onClaimFailed` decides the return value without running the work. A
// crashed worker stops renewing, its lease lapses, and a later pass reclaims and retries.
//
// This owns only the claim → heartbeat → release scaffold; `work` owns the job-specific commit
// (finishIfOwner) and error handling.
export async function runLeasedJob<T>(
  jobManager: JobManager,
  id: string,
  handlers: {
    onClaimFailed: () => Promise<T>;
    work: (ctx: LeasedJobContext) => Promise<T>;
  },
): Promise<T> {
  const workerId = `w-${crypto.randomBytes(8).toString("hex")}`;
  const claimed = await jobManager.claimJobForRun(id, workerId, RUN_LEASE_TTL_MS);
  if (!claimed) {
    return handlers.onClaimFailed();
  }

  // Renew the lease while working so a live job is never reclaimed mid-flight; a crashed worker
  // stops renewing and another worker reclaims after the lease lapses. Started before the try so
  // the finally below ALWAYS stops it — including if `work` throws before its own try.
  const stopHeartbeat = startLeaseHeartbeat(jobManager, id, workerId);

  const isCancelled = async (): Promise<boolean> => {
    const current = await jobManager.getJob(id).catch(() => null);
    return current?.status === "cancelled";
  };

  try {
    return await handlers.work({ workerId, isCancelled });
  } finally {
    stopHeartbeat();
  }
}
