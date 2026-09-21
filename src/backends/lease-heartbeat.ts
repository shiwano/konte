import { type JobManager, RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS } from "../core/job-manager.js";

// Start renewing a job's run lease on an interval, returning an idempotent stop().
//
// Three safety nets ensure the timer never leaks, since a runaway heartbeat would keep
// renewing a lease forever (blocking reclaim) and could keep a CLI process alive:
//   1. The caller MUST call stop() in a finally — covers every normal/throw path.
//   2. The timer self-terminates the moment renewLease returns false (the job is no longer
//      "running", or this worker lost ownership) — so even a missed stop() can't run on.
//   3. The timer is unref()'d, so a leaked one never holds the event loop open / hangs exit.
export function startLeaseHeartbeat(
  jobManager: JobManager,
  id: string,
  workerId: string,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval>;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  timer = setInterval(() => {
    void jobManager
      .renewLease(id, workerId, RUN_LEASE_TTL_MS)
      .then((ok) => {
        if (!ok) stop();
      })
      .catch(() => {});
  }, RUN_LEASE_HEARTBEAT_MS);

  // Node/Bun timers expose unref(); guard in case of an exotic timer impl.
  (timer as { unref?: () => void }).unref?.();

  return stop;
}
