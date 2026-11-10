import { constants } from "node:os";
import { resolveBackend } from "../backends/resolve-backend.js";
import { errorMessage } from "../core/errors.js";
import type { JobManager } from "../core/job-manager.js";
import { submitReadyPendingJobs } from "../core/pending-jobs.js";
import type { VideoRoots } from "../core/roots.js";
import { loadStageDefinitions } from "../core/stage-definitions.js";
import { drainSubmissions } from "../core/submission-drain.js";
import { SUBMIT_DRAIN_MS } from "../worker/worker-protocol.js";

interface SubmitFailure {
  variantId: string;
  address: string;
  error: string;
}

export function formatSubmitFailure(failure: SubmitFailure): string {
  return `${failure.address} (${failure.variantId})  ${failure.error}`;
}

const SETTLED = new Set(["completed", "failed", "cancelled"]);

/** The last line's step after a spend: a wait while any registered job is still to settle. */
export function nextAfterSpend(rows: readonly { status: string }[]): string {
  return rows.some((row) => !SETTLED.has(row.status))
    ? "run `konte job wait`"
    : "run `konte status`";
}

/**
 * Submits, before a spend command returns, the jobs it registered whose dependencies are already
 * met, and writes each row's status as it now stands. Everything after the submit — the
 * download, the dependents it unblocks — is the next `konte job wait`'s, as is every `local`
 * job, whose submit is the whole operation. Returns the jobs that failed here, marked reported.
 */
export async function submitRegisteredJobs(
  roots: VideoRoots,
  jobManager: JobManager,
  rows: readonly { variantId: string; status: string }[],
  // Registered jobs with no row of their own: a patch chain's steps before the returned one.
  unlisted: readonly string[] = [],
): Promise<SubmitFailure[]> {
  const registered = new Set([...rows.map((row) => row.variantId), ...unlisted]);
  const remote = new Set<string>();
  for (const job of await jobManager.listJobs()) {
    if (registered.has(job.id) && job.kind === "generation" && job.backendKind !== "local") {
      remote.add(job.id);
    }
  }
  if (remote.size === 0) return [];

  // A first SIGINT/SIGTERM sends nothing new and lets a submit already sent commit its backend
  // job id, after which the command reports as usual; a second leaves at once.
  let interrupted = false;
  let passed = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = 128 + (constants.signals[signal] ?? 0);
    if (interrupted) process.exit(code);
    interrupted = true;
    process.exitCode = code;
    console.error("Stopping: letting a submit already sent record its backend job id.");
    void drainSubmissions(SUBMIT_DRAIN_MS).finally(() => {
      if (!passed) process.exit(code);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await submitReadyPendingJobs(
      jobManager,
      roots,
      new Map(),
      resolveBackend,
      () => loadStageDefinitions(roots.video),
      { only: remote },
    );
  } catch (err) {
    console.error(
      `Nothing more was submitted: ${errorMessage(err)} — the jobs stay registered for ` +
        "`konte job wait`.",
    );
  } finally {
    passed = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const failures: SubmitFailure[] = [];
  const rowOf = new Map(rows.map((row) => [row.variantId, row]));
  for (const id of remote) {
    const job = await jobManager.getJob(id).catch(() => null);
    if (job?.kind !== "generation") continue;
    const row = rowOf.get(id);
    if (row && job.status !== "pending" && job.status !== "queued") row.status = job.status;
    if (job.status === "failed") {
      failures.push({
        variantId: job.id,
        address: job.address,
        error: job.error ?? "submit failed",
      });
    }
  }
  await jobManager.markReported(failures.map((failure) => failure.variantId));
  return failures;
}
