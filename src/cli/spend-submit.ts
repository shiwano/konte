import { constants } from "node:os";
import { resolveBackend } from "../backends/resolve-backend.js";
import { errorMessage } from "../core/errors.js";
import { printCapped } from "./format-list.js";
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

/** The last line's step after a spend: `konte job run` while any registered job is still to settle. */
export function nextAfterSpend(rows: readonly { status: string }[]): string {
  return rows.some((row) => !SETTLED.has(row.status))
    ? "run `konte job run`"
    : "run `konte status`";
}

/**
 * A spend command's report, the outcome and its step on the last line. The takes, the failures
 * and a list marked `full` print in full; `verbose` is set by a command that takes `-v`, and folds
 * every other list past the cap. A failure exits 1.
 */
export function printSpendReport(report: {
  rows?: readonly string[];
  failures: readonly string[];
  lists?: ReadonlyArray<{ heading: string; lines: readonly string[]; full?: boolean }>;
  parts: readonly (string | null)[];
  next: string;
  verbose?: boolean;
}): void {
  const { rows = [], failures, lists = [], parts, next, verbose } = report;
  const print = (lines: readonly string[], full = false) => {
    if (verbose === undefined || full) for (const line of lines) console.log(`  ${line}`);
    else printCapped(lines, (line) => line, { verbose });
  };
  if (rows.length > 0) console.log("");
  for (const row of rows) console.log(`  ${row}`);
  for (const { heading, lines, full } of [
    { heading: "Failed:", lines: failures, full: true },
    ...lists,
  ]) {
    if (lines.length === 0) continue;
    console.log(`\n${heading}`);
    print(lines, full);
  }
  console.log(`\n${parts.filter((part) => part !== null).join(", ")} — ${next}`);
  if (failures.length > 0) process.exitCode = 1;
}

/** What a spend prints for the board stems it re-mixed before its gate, and the ones it could not. */
export function printRemixedBoardStems(
  result: {
    accepted: ReadonlyArray<{ address: string }>;
    failed?: ReadonlyArray<{ address: string; reason: string }>;
  },
  opts: { plan?: boolean } = {},
): void {
  if (result.accepted.length > 0) {
    console.log(
      `${opts.plan ? "Would re-mix" : "Re-mixed"} ${result.accepted.length} board stem(s) the ` +
        `video develops past their review: ${result.accepted.map((s) => s.address).join(", ")}`,
    );
  }
  for (const { address, reason } of result.failed ?? []) {
    console.log(`Could not re-mix ${address}: ${reason}`);
  }
}

/**
 * Submits, before a spend command returns, the jobs it registered whose dependencies are already
 * met, and writes each row's status as it now stands. Everything after the submit — the
 * download, the dependents it unblocks — is the next `konte job run`'s, as is every `local`
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
      resolveBackend,
      () => loadStageDefinitions(roots.video),
      { only: remote },
    );
  } catch (err) {
    console.error(
      `Nothing more was submitted: ${errorMessage(err)} — the jobs stay registered for ` +
        "`konte job run`.",
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
