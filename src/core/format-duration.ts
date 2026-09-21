// Compact elapsed-time formatter for CLI display: "M:SS" under an hour, else
// "H:MM:SS". Negative inputs clamp to zero.
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Elapsed time for a job, measured from actual processing start: live (now − start)
// while running, final (completedAt − start) once terminal, or "-" if it never started.
// The basis is processingStartedAt when set (comfy, after its serial-queue wait) and
// startedAt otherwise (cloud/local, whose startedAt already is the real start) — so the
// value is queue-independent per-job runtime across every backend, not inflated by jobs
// queued ahead of it. Total submit-to-now is read from createdAt instead.
export function jobElapsed(
  job: {
    startedAt: string | null;
    processingStartedAt: string | null;
    completedAt: string | null;
  },
  now: number = Date.now(),
): string {
  const startAt = job.processingStartedAt ?? job.startedAt;
  if (!startAt) return "-";
  const start = new Date(startAt).getTime();
  const end = job.completedAt ? new Date(job.completedAt).getTime() : now;
  return formatDuration(end - start);
}
