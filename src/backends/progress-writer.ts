import type { JobManager } from "../core/job-manager.js";

type ProgressWriter = {
  write: (value: number, max: number) => void;
  // Stops further writes and waits out the one in flight; call before committing a terminal state.
  settle: () => Promise<void>;
};

// Persists progress onto the job record as an integer percent, so `job list` / `status` show it
// without a live waiter attached. Writes only on a percent change with at most one in flight; a
// dropped write self-heals on the next percent.
export function startProgressWriter(
  jobManager: JobManager,
  id: string,
  initialPct: number | null,
): ProgressWriter {
  let lastPct = initialPct;
  let inFlight = false;
  let settled = false;
  let lastWrite: Promise<unknown> = Promise.resolve();

  return {
    write: (value, max) => {
      if (settled || max <= 0 || inFlight) return;
      const pct = Math.min(100, Math.max(0, Math.round((value / max) * 100)));
      if (pct === lastPct) return;
      lastPct = pct;
      inFlight = true;
      lastWrite = jobManager
        .updateJob(id, { progress: pct })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    },
    settle: async () => {
      settled = true;
      await lastWrite;
    },
  };
}
