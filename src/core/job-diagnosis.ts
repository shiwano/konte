import { formatDuration } from "./format-duration.js";
import { isJobTerminal, isStrandedSubmit } from "./job-manager.js";
import type { JobStatBucket } from "./job-stats.js";
import type { JobRecord } from "./types/index.js";

// The three windows a job's clock splits into, kept separate because a single "elapsed"
// cannot tell "the backend has been working for 5h" apart from "the backend never started".
type JobTiming = {
  /** createdAt → completedAt (or now). */
  totalMs: number;
  /** startedAt → processingStartedAt: the backend's queue wait. Null until execution starts. */
  queuedMs: number | null;
  /** The window `jobElapsed` reports, and what it is measured from — see `elapsedFrom`. */
  elapsedMs: number | null;
  /**
   * "execution" once the backend reported work starting (processingStartedAt, comfy only),
   * "submit" when the job is running but only startedAt is known — for a cloud backend that
   * already is the real start, for comfy it means execution has not begun. Null while pending.
   */
  elapsedFrom: "execution" | "submit" | null;
};

export function computeJobTiming(job: JobRecord, now: number = Date.now()): JobTiming {
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  const started = job.startedAt ? Date.parse(job.startedAt) : null;
  const processing = job.processingStartedAt ? Date.parse(job.processingStartedAt) : null;
  const basis = processing ?? started;

  return {
    totalMs: Math.max(0, end - Date.parse(job.createdAt)),
    queuedMs: processing !== null && started !== null ? Math.max(0, processing - started) : null,
    elapsedMs: basis === null ? null : Math.max(0, end - basis),
    elapsedFrom: basis === null ? null : processing !== null ? "execution" : "submit",
  };
}

// How far past the adapter's p90 a still-running job must be to read as an outlier rather
// than a slow-but-normal run. Needs a few samples before a p90 means anything.
const OUTLIER_P90_MULTIPLE = 3;
const OUTLIER_MIN_SAMPLES = 3;

// A running comfy prompt the backend has not reported executing: submitted, and waiting its turn
// in ComfyUI's serial queue. Comfy stamps an execution start on its first "executing" event; the
// cloud backends never do, so their null is uninformative and only comfy is read here. Only a
// generation job runs as a prompt — a model download or a node install is konte's own work with
// no prompt to wait for, so its null processing start says nothing.
function isAwaitingExecution(job: JobRecord): boolean {
  return (
    job.status === "running" &&
    job.backendKind === "comfy" &&
    job.kind === "generation" &&
    job.processingStartedAt === null
  );
}

// When a prompt entered ComfyUI's queue. startedAt is the enqueue instant for comfy; createdAt
// covers a record that is running without one.
function enqueuedAt(job: JobRecord): number {
  return Date.parse(job.startedAt ?? job.createdAt);
}

// A strict total order over the queue, so a batch enqueued within the same millisecond still
// gives every prompt a distinct position instead of two rows claiming the same one.
function enqueuedBefore(a: JobRecord, b: JobRecord): boolean {
  const ta = enqueuedAt(a);
  const tb = enqueuedAt(b);
  return ta !== tb ? ta < tb : a.id < b.id;
}

/**
 * How many comfy prompts sit ahead of this one in ComfyUI's serial queue: the one executing, plus
 * every prompt enqueued earlier that has not started either. Null when the job is not waiting on
 * that queue — already executing, not running, or not a comfy generation job at all.
 *
 * Counts konte's own jobs, so a prompt submitted from ComfyUI's own UI is invisible and the real
 * wait can be longer. It is a fact about the queue, never a finding: a prompt ComfyUI lost is
 * caught by its waiter within a poll or two (COMFYUI_JOB_GONE / COMFYUI_JOB_ORPHANED), and a
 * prompt with no waiter to catch it is already called `unwatched`.
 */
export function comfyQueueAhead(job: JobRecord, peers: readonly JobRecord[]): number | null {
  if (!isAwaitingExecution(job)) return null;
  return peers.filter(
    (p) =>
      p.id !== job.id &&
      p.status === "running" &&
      p.kind === "generation" &&
      p.backendKind === "comfy" &&
      (p.processingStartedAt !== null || enqueuedBefore(p, job)),
  ).length;
}

// A running job no worker holds the run lease on: nothing is watching it or will commit its
// result. Says nothing about the backend — the job may well have finished there.
function isUnwatched(job: JobRecord, now: number): boolean {
  return job.status === "running" && (job.lease === null || Date.parse(job.lease.expiresAt) <= now);
}

function typicalSuffix(stats: JobStatBucket | null | undefined): string {
  if (!stats) return "";
  return ` (typical: p50 ${formatDuration(stats.p50Ms)}, p90 ${formatDuration(stats.p90Ms)} over ${stats.count})`;
}

type DiagnoseJobInput = {
  job: JobRecord;
  /**
   * The records `dependsOnJobs` resolved to (pruned ids simply absent). Lets a pending job say what
   * is holding it, and — since a missing id means a dependency that will never complete — flag a
   * dependency that no longer exists. Judged only when provided; omit it and neither check runs.
   */
  dependencies?: readonly JobRecord[];
  /** The job's own adapter bucket from `computeJobStats`, for the outlier threshold. */
  stats?: JobStatBucket | null;
  now?: number;
};

// What is wrong (or notable) about this job's current state, one human-readable line each, in the
// order a reader should act on them. Empty for a job that is simply doing its work — silence is
// the healthy signal. Plain strings, not coded findings: unlike a direction finding there is no
// waiver to key off a code, so the message is the whole product.
export function diagnoseJob(input: DiagnoseJobInput): string[] {
  const { job, stats } = input;
  const now = input.now ?? Date.now();
  const timing = computeJobTiming(job, now);
  const out: string[] = [];

  if (job.status === "failed" && job.error) {
    out.push(job.error);
  }

  if (isJobTerminal(job.status)) return out;

  if (job.unconfirmedSince) {
    const age = formatDuration(now - Date.parse(job.unconfirmedSince));
    out.push(
      `Status checks against the backend have been failing for ${age}. The job is still being ` +
        "polled and is never auto-failed, but the backend may be down or unreachable.",
    );
  }

  if (job.status === "pending") {
    const deps = input.dependencies;
    const blocking = (deps ?? []).filter((d) => !isJobTerminal(d.status));
    if (blocking.length > 0) {
      const named = blocking.map((d) => `${d.id} (${d.status})`).join(", ");
      out.push(`Not submitted yet — waiting on ${blocking.length} job(s): ${named}.`);
    }
    // A dependency id that resolved to no job record: the dependency was pruned or lost, so
    // nothing will ever complete it and the cascade will never submit this job. Only judged
    // when the caller actually resolved the dependency set (deps present), never from a bare
    // dependsOnJobs the caller didn't look up.
    if (deps) {
      const missing = job.dependsOnJobs.filter((id) => !deps.some((d) => d.id === id));
      if (missing.length > 0) {
        // No fix verb here (reroll/re-export/…): the remedy depends on the job kind, so the
        // diagnosis states the fact and leaves the action to the caller.
        out.push(
          `Not submitted yet, and ${missing.length} dependency job(s) no longer exist ` +
            `(${missing.join(", ")}) — pruned or lost, so this job will never submit on its own.`,
        );
      }
    }
    return out;
  }

  if (isStrandedSubmit(job, now)) {
    out.push(
      "Claimed running but never recorded a backend job id, and its submit lease has lapsed — " +
        (job.kind === "generation" && job.submissionStartedAt && job.backendKind !== "local"
          ? "Submission may have reached the backend. Automatic resubmission is refused; check the backend before rerolling."
          : "The next worker can retry submission."),
    );
  } else if (isUnwatched(job, now)) {
    const since = job.lease
      ? `expired ${formatDuration(now - Date.parse(job.lease.expiresAt))} ago`
      : "never claimed";
    out.push(
      `No worker holds this job's run lease (${since}), so nothing is currently watching it or ` +
        "committing its result. Start the MCP watcher, or wait on it from the CLI.",
    );
  }

  const elapsedMs = timing.elapsedMs;
  if (job.status !== "running" || elapsedMs === null) return out;

  // A prompt still waiting its turn has no execution window, so `elapsedMs` measures the queue
  // ahead of it rather than work — the outlier check below would read the whole queue as one slow
  // run. The wait itself is not a finding; see `comfyQueueAhead`.
  if (isAwaitingExecution(job)) return out;

  if (
    stats &&
    stats.count >= OUTLIER_MIN_SAMPLES &&
    stats.p90Ms > 0 &&
    elapsedMs > stats.p90Ms * OUTLIER_P90_MULTIPLE
  ) {
    out.push(
      `Running for ${formatDuration(elapsedMs)}${typicalSuffix(stats)} — far longer than this ` +
        "adapter's other runs.",
    );
  }

  return out;
}

// The short forms of the diagnoses above, for a listing that must fit them beside the status.
// Only the states where nothing is progressing — a job merely running long is still running, and
// `job show` is where that nuance belongs. Empty for a healthy job.
export function jobStatusFlags(input: DiagnoseJobInput): string[] {
  const { job } = input;
  const now = input.now ?? Date.now();
  if (isJobTerminal(job.status)) return [];

  const out: string[] = [];
  if (job.unconfirmedSince) out.push("unconfirmed");
  if (isStrandedSubmit(job, now)) {
    out.push("stranded");
  } else if (isUnwatched(job, now)) {
    out.push("unwatched");
  }
  return out;
}
