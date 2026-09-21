import type { Command } from "commander";
import { resolveBackend } from "../../../backends/resolve-backend.js";
import {
  runComfyModelDownloadJob,
  runComfyNodeInstallJob,
} from "../../../backends/run-comfy-install-job.js";
import { runComfyNodeActivateJob } from "../../../backends/run-comfy-node-activate-job.js";
import { runRunnableComfyNodeActivateJobs } from "../../../backends/run-comfy-node-activate-job.js";
import { runExportJob, runRunnableExportJobs } from "../../../backends/run-export-job.js";
import { type WaitForJobResult, waitForJob } from "../../../backends/wait-for-job.js";
import type { GenerationBackend } from "../../../core/backend.js";
import { formatDuration } from "../../../core/format-duration.js";
import { isJobTerminal, JobManager } from "../../../core/job-manager.js";
import { submitReadyPendingJobs } from "../../../core/pending-jobs.js";
import { reloadLoadedDefinitions } from "../../../core/reload-definitions.js";
import { Semaphore } from "../../../core/semaphore.js";
import { sleep } from "../../../core/sleep.js";

// Cap on concurrently-awaited jobs — see the semaphore note at the wait loop.
const WAIT_CONCURRENCY = 16;
import type { BackendKind, JobRecord } from "../../../core/types/index.js";
import type { LoadedDefinitions } from "../../../core/select-definition.js";
import { loadStageDefinitions } from "../../load-definition.js";
import { parsePositiveInt } from "../../parse-option.js";
import { TURBO_TAKE_NOTE, turboTakes } from "../../turbo-takes.js";
import { requireVideoRoots } from "../../context.js";
import type { VideoRoots } from "../../../core/roots.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

export function registerJobWaitCommand(program: Command): void {
  program
    .command("wait [jobIds...]")
    .description("Wait for jobs to complete — every active one, or the ids given")
    .option("--timeout <seconds>", "Timeout in seconds")
    .addHelpText(
      "after",
      `
Blocks until the jobs settle, then prints what broke and, on the last line, the outcome
and the command that answers it. Generation and export are async, so this is how a run ends.

With no arguments it waits on the whole queue and cascades: a pending job submits as its
dependencies land, a stranded submit is reclaimed, and model/node installs and export
renders are driven too. Naming ids waits on exactly those and cascades nothing — a pending
one is reported, not resolved.

--timeout is a deadline on the whole command, not a budget per job. On expiry it stops
waiting, names everything still in flight and exits 1; nothing is cancelled. It bounds
waiting only — a download or render this process already started has no abort path and
runs to completion.

Examples:
  konte job wait                    Wait for every active job, then summarize the batch
  konte job wait v-a1b2c3d4         Wait for one job and report its outcome
  konte job wait --timeout 600      Give up after 10 minutes, naming what is still running
`,
    )
    .action(async (jobIds: string[], opts: { timeout?: string }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const jobManager = new JobManager(videoRoot);

      const deadline = new Deadline(
        opts.timeout ? parsePositiveInt(opts.timeout, "--timeout") * 1000 : undefined,
      );

      const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
      // This command cascades pending submissions — it resolves dependencies for a spend.
      await applyResolutionDefinitions({
        videoRoot,
        definitions: { video, animatic, reference },
      });

      if (jobIds.length === 0) {
        const live = new LiveProgress({
          renderRegion: Boolean(process.stderr.isTTY),
        });
        const startedAt = Date.now();
        const { results, priorFailedCount } = await waitAllCascade(
          jobManager,
          roots,
          live,
          { video, animatic, reference },
          deadline,
        );
        live.stop();
        const elapsedMs = Date.now() - startedAt;
        if (results.length === 0) {
          const prior = priorFailedCount > 0 ? `, ${priorFailedCount} failed before this wait` : "";
          console.log(`No running, queued, or pending jobs${prior} — run \`konte status\``);
        } else {
          // Problems first, outcome last: the outcome line is the one a piped caller keeps.
          if (printProblemLines(results)) console.log("");
          for (const r of results) printExportOutput(r);
          await printTurboLine(videoRoot, results);
          console.log(formatWaitSummary(results, elapsedMs));
        }
        if (results.some((r) => r.waitTimedOut || r.status === "failed")) process.exitCode = 1;
      } else {
        const live = new LiveProgress({
          renderRegion: Boolean(process.stderr.isTTY),
        });
        const startedAt = Date.now();
        const results: WaitForJobResult[] = [];
        for (const id of jobIds) {
          const job = await jobManager.getJob(id);
          if (job.kind === "comfy-model-download") {
            // Model downloads have no dependencies, so a single `job wait` can run
            // the download itself (or follow another worker's) to completion.
            results.push(await waitForModelJob(jobManager, roots, id, deadline));
            continue;
          }
          if (job.kind === "comfy-node-install") {
            results.push(await waitForNodeInstallJob(jobManager, roots, id, deadline));
            continue;
          }
          if (job.kind === "comfy-node-activate") {
            results.push(await waitForNodeActivateJob(jobManager, roots, id, deadline));
            continue;
          }
          if (job.kind === "export") {
            results.push(await waitForExportJob(jobManager, videoRoot, id, deadline));
            continue;
          }
          if (job.status === "pending") {
            console.log(
              `Job ${id}: pending (depends on: ${job.dependsOnAssets.join(", ")}). Run "konte job wait" with no ids to cascade.`,
            );
            results.push({
              variantId: job.id,
              kind: job.kind,
              address: job.address,
              status: "pending",
              outputFiles: [],
              thumbnails: [],
              error: `Pending: depends on ${job.dependsOnAssets.join(", ")}. Run "konte job wait" with no ids to cascade.`,
              alreadyTerminal: false,
              submitPending: false,
            });
            continue;
          }
          results.push(
            await runWait(jobManager, id, roots, { video, animatic, reference }, deadline, live),
          );
        }
        live.stop();
        const elapsedMs = Date.now() - startedAt;
        // Named ids get a line each: the caller asked about exactly these jobs.
        for (const r of results) {
          if (r.status === "pending") continue;
          printResultLine(r);
        }
        console.log("");
        await printTurboLine(videoRoot, results);
        console.log(formatWaitSummary(results, elapsedMs));
        if (results.some((r) => r.waitTimedOut || r.status === "failed")) process.exitCode = 1;
      }
    });
}

// `generate` already listed each address.
async function printTurboLine(videoRoot: string, results: WaitForJobResult[]): Promise<void> {
  const landed = results.flatMap((r) =>
    r.kind === "generation" && r.status === "completed" && !r.waitTimedOut && r.address
      ? [{ address: r.address, variantId: r.variantId }]
      : [],
  );
  const onTurbo = await turboTakes(videoRoot, landed);
  if (onTurbo.length > 0) console.log(`${onTurbo.length} on turbo — ${TURBO_TAKE_NOTE}`);
}

// `--timeout` is a deadline on the whole command, not a per-waiter budget: every waiter below is
// fed what is LEFT of it. Handing each one the full value is what made a cascade of N dependency
// waves wait N × --timeout, and a sequential list of N ids wait N × --timeout.
class Deadline {
  private readonly at: number | null;

  constructor(timeoutMs: number | undefined) {
    this.at = timeoutMs == null ? null : Date.now() + timeoutMs;
  }

  get expired(): boolean {
    return this.at !== null && Date.now() >= this.at;
  }

  // undefined means "no deadline set" — wait indefinitely, which is what every caller does
  // without --timeout. Never returns 0: waitForJob treats a falsy timeout as "no deadline".
  remainingMs(): number | undefined {
    return this.at === null ? undefined : Math.max(1, this.at - Date.now());
  }
}

interface WaitSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  stillRunning: number;
  // Named ids only: a pending job is reported, not waited on, and it must still add up to `total`.
  pending: number;
}

function summarize(results: WaitForJobResult[]): WaitSummary {
  return {
    total: results.length,
    completed: results.filter((r) => !r.waitTimedOut && r.status === "completed").length,
    failed: results.filter((r) => !r.waitTimedOut && r.status === "failed").length,
    cancelled: results.filter((r) => !r.waitTimedOut && r.status === "cancelled").length,
    stillRunning: results.filter((r) => r.waitTimedOut).length,
    pending: results.filter((r) => !r.waitTimedOut && r.status === "pending").length,
  };
}

function formatWaitSummary(results: WaitForJobResult[], elapsedMs: number): string {
  const s = summarize(results);
  const parts = [
    `${s.completed} completed`,
    s.failed > 0 ? `${s.failed} failed` : null,
    s.cancelled > 0 ? `${s.cancelled} cancelled` : null,
    s.stillRunning > 0 ? `${s.stillRunning} still running` : null,
    s.pending > 0 ? `${s.pending} still pending` : null,
  ].filter((p) => p !== null);
  // The outcome and the one command that answers it share a line, so a caller piping through
  // `tail -1` keeps both.
  return `${s.total} job(s) settled: ${parts.join(", ")} (${formatDuration(elapsedMs)}) — run \`konte status\``;
}

// Only what the caller may have to act on — naming all 60 completions buries the two that broke.
function printProblemLines(results: WaitForJobResult[]): boolean {
  let printed = false;
  for (const r of results) {
    if (!r.waitTimedOut && r.status === "completed") continue;
    printResultLine(r);
    printed = true;
  }
  return printed;
}

// A timed-out wait is not a job failure: the backend job is still running and was
// left re-observable. Report that plainly rather than as a status line that reads
// like a terminal outcome.
function printResultLine(r: WaitForJobResult): void {
  if (r.waitTimedOut) {
    console.log(`Job ${r.variantId}: still running (stopped waiting — timeout reached)`);
    console.log(
      `  Re-run "konte job wait ${r.variantId}" to keep waiting, or "konte job cancel ${r.variantId}" to stop it.`,
    );
    return;
  }
  // No backendJobId yet: still being submitted, or stranded by a crashed submitter.
  // A wait on named ids does not resubmit — point at the cascade, which reclaims it.
  if (r.submitPending) {
    console.log(`Job ${r.variantId}: not submitted yet (submit in progress or interrupted)`);
    console.log(
      `  Run "konte job wait" with no ids to resubmit a stranded job or cascade pending ones.`,
    );
    return;
  }
  const label = r.address ? `${r.address} (${r.variantId})` : r.variantId;
  console.log(`Job ${label}: ${r.status}`);
  printExportOutput(r);
  if (r.error) {
    console.log(`  Error: ${r.error}`);
  }
}

function printExportOutput(result: WaitForJobResult): void {
  if (result.kind !== "export" || result.status !== "completed" || result.waitTimedOut) return;
  for (const file of result.outputFiles) console.log(`Export ${result.variantId}: ${file}`);
}

// Drive a locally-run job (comfy model download, node install/activate, export) to a terminal
// state from a single `konte job wait <id>`. Each `run` attempt either runs the job itself or —
// when a live worker (e.g. the MCP watcher) owns the lease — reports the current status without
// re-running, so we poll until it settles (the same monitor the bare-`job wait` cascade applies in bulk).
// A job whose dependency jobs aren't ready reports "pending": we stop and surface pendingMessage,
// pointing at a bare `job wait` to cascade those deps. Model/node-install jobs have no deps and never do.
// A runner that knows WHY it is pending (a node activation held off a busy ComfyUI) returns its own
// `pendingReason`, which wins over the generic message.
async function waitForLocalRunJob(
  jobManager: JobManager,
  id: string,
  deadline: Deadline,
  run: () => Promise<{ status: JobRecord["status"]; pendingReason?: string }>,
  resolve: (job: JobRecord) => { address: string; outputFiles: string[] },
  pendingMessage?: string,
): Promise<WaitForJobResult> {
  const isTerminal = (s: JobRecord["status"]) =>
    s === "completed" || s === "failed" || s === "cancelled";
  let outcome = await run();
  while (!isTerminal(outcome.status) && outcome.status !== "pending") {
    // Bounds the polling, not the work: a download or render this process already claimed has no
    // abort path, so `run()` above can overshoot the deadline before we get to check it.
    if (deadline.expired) return stillRunningResult(await jobManager.getJob(id));
    await new Promise((r) => setTimeout(r, 1000));
    outcome = await run();
  }
  const status = outcome.status;
  if (status === "pending") {
    const pendingJob = await jobManager.getJob(id);
    return {
      variantId: id,
      kind: pendingJob.kind,
      address: "",
      status: "pending",
      outputFiles: [],
      thumbnails: [],
      error: outcome.pendingReason
        ? `Pending: ${outcome.pendingReason}. Run "konte job wait" with no ids to cascade.`
        : (pendingMessage ?? null),
      alreadyTerminal: false,
      submitPending: false,
    };
  }
  const job = await jobManager.getJob(id);
  const { address, outputFiles } = resolve(job);
  return {
    variantId: id,
    kind: job.kind,
    address,
    status,
    outputFiles,
    thumbnails: [],
    error: job.error,
    alreadyTerminal: true,
    submitPending: false,
  };
}

function waitForModelJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  deadline: Deadline,
): Promise<WaitForJobResult> {
  return waitForLocalRunJob(
    jobManager,
    id,
    deadline,
    () =>
      runComfyModelDownloadJob(jobManager, roots, id, {
        onStarted: ({ label }) => {
          process.stderr.write(`Downloading comfy model: ${label}\n`);
        },
      }),
    (job) => ({
      address: job.kind === "comfy-model-download" ? job.model.filename : id,
      outputFiles: [],
    }),
  );
}

function waitForNodeInstallJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  deadline: Deadline,
): Promise<WaitForJobResult> {
  return waitForLocalRunJob(
    jobManager,
    id,
    deadline,
    () =>
      runComfyNodeInstallJob(jobManager, roots, id, {
        onStarted: ({ label }) => {
          process.stderr.write(`Installing custom node pack: ${label}\n`);
        },
      }),
    (job) => ({ address: job.kind === "comfy-node-install" ? job.node.id : id, outputFiles: [] }),
  );
}

function waitForNodeActivateJob(
  jobManager: JobManager,
  roots: VideoRoots,
  id: string,
  deadline: Deadline,
): Promise<WaitForJobResult> {
  return waitForLocalRunJob(
    jobManager,
    id,
    deadline,
    () =>
      runComfyNodeActivateJob(jobManager, roots, id, {
        onStarted: () => {
          process.stderr.write(`Activating custom nodes (${id})...\n`);
        },
      }),
    () => ({ address: "", outputFiles: [] }),
    `Pending: node install dependencies not ready. Run "konte job wait" with no ids to cascade.`,
  );
}

function waitForExportJob(
  jobManager: JobManager,
  videoRoot: string,
  id: string,
  deadline: Deadline,
): Promise<WaitForJobResult> {
  return waitForLocalRunJob(
    jobManager,
    id,
    deadline,
    () =>
      runExportJob(jobManager, videoRoot, id, {
        onStarted: () => {
          process.stderr.write(`Rendering export ${id}...\n`);
        },
      }),
    (job) => ({
      address: "",
      outputFiles: job.kind === "export" && job.outputFile ? [job.outputFile] : [],
    }),
    `Pending: export dependencies not ready. Run "konte job wait" with no ids to cascade.`,
  );
}

async function runWait(
  jobManager: JobManager,
  variantId: string,
  roots: VideoRoots,
  definitions: LoadedDefinitions,
  deadline: Deadline,
  live: LiveProgress,
): Promise<WaitForJobResult> {
  // Elapsed is shown only on the live line (not streamed); on-disk elapsed is queried
  // via `konte job list`. Read startedAt once up front.
  const startedAtMs = await jobManager
    .getJob(variantId)
    .then((j) => (j.startedAt ? new Date(j.startedAt).getTime() : null))
    .catch(() => null);

  // waitForJob returns submitPending when the job has no committed backendJobId: it
  // is either being submitted right now by another worker, or its submitter crashed
  // mid-transaction (a stranded submit). Either way this single-job wait does NOT
  // re-drive it — recovery (reclaim + resubmit) belongs to the orchestration loop
  // (a bare `job wait` or the MCP watcher), which owns submitReadyPendingJobs. Surface
  // submitPending to the caller (reported like a `pending` job) rather than looping
  // forever on an id that no one in this process will ever commit.
  const result = await waitForJob(jobManager, variantId, roots, definitions, {
    timeoutMs: deadline.remainingMs(),
    onProgress: (p) => {
      live.setJob(p.variantId, formatJobLine(p, startedAtMs));
    },
    onStateUpdateError: ({ variantId: vid, phase, error }) => {
      live.log(
        `Warning: Failed to update state for ${vid}: ${error}\n` +
          `  Job ${phase === "completed" ? "completed" : "failed"} but state may be stale. Run "konte status" to check.`,
      );
    },
    // Without this the terminal shows a progress line that simply stops moving, with nothing to
    // say the backend has gone silent — the wait looks healthy while it is anything but. The job
    // itself is never failed by this; it is the human who needs telling.
    onUnconfirmed: ({ address, unconfirmed, lastError }) => {
      const what = address || variantId;
      live.log(
        unconfirmed
          ? `Warning: ${what} — no successful status check for a while; still waiting.\n` +
              `  Last error: ${lastError ?? "unknown"}`
          : `${what} — status checks recovered.`,
      );
    },
  });
  // Drop the live line; the authoritative outcome is printed by printResultLine after the
  // whole batch settles. The last progress value is meaningless on completion anyway — a
  // non-sampler final node (e.g. SaveImage) reports 0/100.
  live.removeJob(variantId);
  return result;
}

// One live line per job: the address leads (what is being generated), the trailing variant id
// disambiguates rerolls that share an address. Elapsed is live-only, per formatDuration.
function formatJobLine(
  p: { variantId: string; address: string; value: number; max: number; node: string | null },
  startedAtMs: number | null,
): string {
  const elapsed = startedAtMs != null ? ` ${formatDuration(Date.now() - startedAtMs)}` : "";
  const node = p.node ? ` [${p.node}]` : "";
  return `  ${p.address || p.variantId}  ${p.value}/${p.max}${node}${elapsed}  ${p.variantId}`;
}

// The live region's header: the total still in flight and its breakdown, so the whole batch's
// shape is visible while the per-job lines below cover only the ones actively being waited on.
function formatWaitHeader(counts: {
  running: number;
  pending: number;
  installing: number;
  exporting: number;
}): string {
  const total = counts.running + counts.pending + counts.installing + counts.exporting;
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.installing > 0) parts.push(`${counts.installing} installing`);
  if (counts.exporting > 0) parts.push(`${counts.exporting} exporting`);
  const breakdown = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `Waiting on ${total} job${total === 1 ? "" : "s"}${breakdown}`;
}

// A bottom-anchored live status region on stderr: an optional header plus one line per active
// job, repainted in place as jobs report progress. Permanent output goes through `log()`, which
// prints above the region so the live lines stay pinned to the bottom. TTY-only — a piped stderr
// (`renderRegion` false) gets `log()` lines and no region at all. Each rendered line is clipped to
// the terminal width so none wraps, which would desync the cursor-up math.
class LiveProgress {
  private header = "";
  private readonly jobs = new Map<string, string>();
  private renderedRows = 0;
  private readonly renderRegion: boolean;
  private readonly out: NodeJS.WriteStream = process.stderr;

  constructor(opts: { renderRegion?: boolean } = {}) {
    this.renderRegion = opts.renderRegion ?? Boolean(process.stderr.isTTY);
  }

  // Print a permanent line above the live region. Always writes, region or not — this is how
  // download/install/export notices and warnings surface regardless of TTY.
  log(message: string): void {
    if (!this.renderRegion) {
      this.out.write(`${message}\n`);
      return;
    }
    this.clear();
    this.out.write(`${message}\n`);
    this.paint();
  }

  setHeader(text: string): void {
    if (!this.renderRegion || text === this.header) return;
    this.header = text;
    this.repaint();
  }

  setJob(id: string, text: string): void {
    if (!this.renderRegion) return;
    this.jobs.set(id, text);
    this.repaint();
  }

  removeJob(id: string): void {
    if (!this.renderRegion) return;
    if (this.jobs.delete(id)) this.repaint();
  }

  // Erase the region for good; the caller prints the authoritative summary afterwards.
  stop(): void {
    if (!this.renderRegion) return;
    this.clear();
    this.header = "";
    this.jobs.clear();
  }

  private repaint(): void {
    this.clear();
    this.paint();
  }

  private clear(): void {
    if (this.renderedRows === 0) return;
    this.out.write(`\x1b[${this.renderedRows}A\x1b[0J`);
    this.renderedRows = 0;
  }

  private paint(): void {
    const rows: string[] = [];
    if (this.header) rows.push(this.header);
    for (const line of this.jobs.values()) rows.push(line);
    if (rows.length === 0) return;
    const width = (this.out.columns ?? 80) - 1;
    this.out.write(rows.map((r) => `${clip(r, width)}\n`).join(""));
    this.renderedRows = rows.length;
  }
}

function clip(text: string, width: number): string {
  if (width < 1) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

async function waitAllCascade(
  jobManager: JobManager,
  roots: VideoRoots,
  live: LiveProgress,
  initialDefinitions: LoadedDefinitions,
  deadline: Deadline,
): Promise<{ results: WaitForJobResult[]; priorFailedCount: number }> {
  const videoRoot = roots.video;
  // This wait outlives the definitions it started with: an agent edits and rerolls while it
  // blocks on a long generation, and the pending job that lands must be judged by the files as
  // they are then, not as they were at startup. Each cascade pass re-reads them (after listing
  // the jobs, so no job is older than what judges it) and the waits use the latest read.
  let definitions = initialDefinitions;
  const allResults: WaitForJobResult[] = [];
  // Failures already terminal when this wait began are prior history — reported by the wait
  // (or generate) that observed them, and re-printing them on every later wait reads as
  // "still broken". Snapshot them so the final sweep surfaces only what failed during this
  // wait; the caller notes their count when there was otherwise nothing to do.
  const priorFailed = await jobManager.listJobs({ status: "failed" });
  const priorFailedIds = new Set(priorFailed.map((j) => j.id));
  const backendCache = new Map<BackendKind, GenerationBackend>();
  // A node activation waits for the ComfyUI server to go idle, and reports that on every pass —
  // roughly once a second. Keyed by the reason so the hold is stated once, and again only when
  // what it is waiting for actually changes.
  const reportedActivateHolds = new Set<string>();
  // Export jobs we observed active during this wait. An export owned by a live worker
  // (e.g. the MCP watcher) can't be claimed here, so we poll until it settles; once it
  // does, the top-of-loop filter drops it, so we surface its terminal status after the
  // loop rather than letting a wait we deliberately blocked on report "nothing to do".
  const monitoredExportIds = new Set<string>();

  // Model downloads and node installs/activations carry no variant of their own, so they are the
  // one class of work this wait drives without producing a result. Fold each settled one in, or a
  // run whose only failure was a multi-GB download reports "no running, queued, or pending jobs"
  // and exits 0. Keyed by id: the runners are re-entered every pass until they settle.
  const recordedStandaloneIds = new Set<string>();
  const recordStandalone = async (id: string, status: JobRecord["status"]): Promise<void> => {
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
    if (recordedStandaloneIds.has(id)) return;
    recordedStandaloneIds.add(id);
    const job = await jobManager.getJob(id).catch(() => null);
    if (!job) return;
    allResults.push({
      variantId: id,
      kind: job.kind,
      address: standaloneLabel(job),
      status,
      outputFiles: [],
      thumbnails: [],
      error: job.error,
      alreadyTerminal: true,
      submitPending: false,
    });
  };

  while (true) {
    const allJobs = await jobManager.listJobs();
    // Model downloads run concurrently with generation waits — a multi-GB model
    // install must not block unrelated jobs (no watcher needed for standalone use).
    const activeModelJobs = allJobs.filter(
      (j) =>
        j.kind === "comfy-model-download" && (j.status === "pending" || j.status === "running"),
    );
    const activeNodeInstallJobs = allJobs.filter(
      (j) => j.kind === "comfy-node-install" && (j.status === "pending" || j.status === "running"),
    );
    const activeNodeActivateJobs = allJobs.filter(
      (j) => j.kind === "comfy-node-activate" && (j.status === "pending" || j.status === "running"),
    );
    // Only jobs with a committed backendJobId are waitable — there is a backend job to
    // observe. A "running" job WITHOUT one is still mid-submit (being submitted now, or
    // stranded by a crashed submitter); it goes to submittingJobs and is advanced by
    // submitReadyPendingJobs below (which reclaims stranded submits), never fed to
    // runWait — which would otherwise block on a submitPending that never resolves.
    const runningJobs = allJobs.filter(
      (j) =>
        j.kind === "generation" &&
        (j.status === "running" || j.status === "queued") &&
        j.backendJobId != null,
    );
    const submittingJobs = allJobs.filter(
      (j) => j.kind === "generation" && j.status === "running" && j.backendJobId == null,
    );
    const pendingJobs = allJobs.filter((j) => j.kind === "generation" && j.status === "pending");
    const exportJobs = allJobs.filter(
      (j) => j.kind === "export" && (j.status === "pending" || j.status === "running"),
    );
    for (const j of exportJobs) monitoredExportIds.add(j.id);

    if (
      activeModelJobs.length === 0 &&
      activeNodeInstallJobs.length === 0 &&
      activeNodeActivateJobs.length === 0 &&
      runningJobs.length === 0 &&
      submittingJobs.length === 0 &&
      pendingJobs.length === 0 &&
      exportJobs.length === 0
    )
      break;

    // Checked after the drain test, so a queue that emptied exactly on the deadline reports its
    // results rather than a spurious "still running". Everything left in flight is named: a wait
    // that gives up must say what it gave up on.
    if (deadline.expired) {
      for (const job of allJobs) {
        if (isJobTerminal(job.status)) continue;
        if (allResults.some((r) => r.variantId === job.id)) continue;
        allResults.push(stillRunningResult(job));
      }
      break;
    }

    live.setHeader(
      formatWaitHeader({
        running: runningJobs.length,
        pending: pendingJobs.length + submittingJobs.length,
        installing:
          activeModelJobs.length + activeNodeInstallJobs.length + activeNodeActivateJobs.length,
        exporting: exportJobs.length,
      }),
    );

    const modelTask = Promise.all(
      activeModelJobs.map((mj) =>
        runComfyModelDownloadJob(jobManager, roots, mj.id, {
          onStarted: ({ label }) => live.log(`Downloading comfy model: ${label}`),
          onSettled: ({ label, status }) => live.log(`Comfy model ${label}: ${status}`),
        }).catch(() => ({ id: mj.id, status: "failed" as const, ranInstall: false })),
      ),
    );
    const nodeInstallTask = Promise.all(
      activeNodeInstallJobs.map((nj) =>
        runComfyNodeInstallJob(jobManager, roots, nj.id, {
          onStarted: ({ label }) => live.log(`Installing custom node pack: ${label}`),
          onSettled: ({ label, status }) => live.log(`Custom node ${label}: ${status}`),
        }).catch(() => ({ id: nj.id, status: "failed" as const, ranInstall: false })),
      ),
    );
    // At most WAIT_CONCURRENCY jobs are awaited at once; the rest queue for a slot. Each
    // waiter holds a backend client/poller (and, for comfy, a websocket) and runs the
    // completion-side ffmpeg/hashing work, so an unbounded fan-out over a 1000-job run
    // opens that many sockets and processes. A queued job keeps running on its backend —
    // its waiter just picks the result up later — and the deadline still bounds the wait.
    const waitGate = new Semaphore(WAIT_CONCURRENCY);
    const waitTask =
      runningJobs.length > 0
        ? Promise.all(
            runningJobs.map((j) =>
              waitGate.run(async () => {
                // A task whose slot frees only after the command deadline must not start a
                // backend wait — with hundreds queued, each would still pay backend setup on
                // a ~1ms budget, overrunning the deadline in waves. Report it still running.
                // The job may meanwhile have settled or been cleaned: a terminal record goes
                // through runWait (waitForJob short-circuits an already-terminal job) so its
                // real outcome is reported, and a cleaned one falls back to the listing
                // snapshot rather than rejecting the whole batch.
                if (deadline.expired) {
                  let rec = j;
                  try {
                    rec = await jobManager.getJob(j.id);
                  } catch {
                    // cleaned mid-wait — the snapshot is the best remaining description
                  }
                  if (!isJobTerminal(rec.status)) return stillRunningResult(rec);
                }
                return runWait(jobManager, j.id, roots, definitions, deadline, live);
              }),
            ),
          )
        : Promise.resolve([] as WaitForJobResult[]);

    const [modelResults, nodeInstallResults, waitResults] = await Promise.all([
      modelTask,
      nodeInstallTask,
      waitTask,
    ]);
    // A submitPending result is not an outcome (the job has no backendJobId yet) — drop
    // it; the cascade reclaims/resubmits it and a later pass waits on the real job.
    allResults.push(...waitResults.filter((r) => !r.submitPending));

    for (const r of [...modelResults, ...nodeInstallResults]) {
      await recordStandalone(r.id, r.status);
    }

    const { submitted, failed, released } = await submitReadyPendingJobs(
      jobManager,
      roots,
      backendCache,
      resolveBackend,
      async () => (definitions = await reloadLoadedDefinitions(videoRoot)),
    );
    // Handed back unjudged: this process read a definition older than the files. The next pass
    // reads again; a second disagreement fails the job with the reason on it.
    for (const r of released) {
      live.log(
        `Warning: ${r.address} (${r.variantId}) was not submitted — this process loaded a stale definition (queued ${r.queuedHash}, read ${r.currentHash}); retrying on the next pass.`,
      );
    }

    for (const vid of failed) {
      const job = await jobManager.getJob(vid);
      if (job.kind !== "generation") continue;
      allResults.push({
        variantId: vid,
        kind: job.kind,
        address: job.address,
        status: "failed",
        outputFiles: [],
        thumbnails: [],
        error: job.error,
        alreadyTerminal: false,
        submitPending: false,
      });
    }

    // Render any export jobs whose dependencies are now ready (skips ones still waiting).
    const exportResults = await runRunnableExportJobs(jobManager, videoRoot, {
      onStarted: ({ id }) => live.log(`Rendering export ${id}...`),
    });
    let ranAnyExport = false;
    // An export owned by a live worker (the MCP watcher) returns running/pending without
    // our having run it — keep the cascade polling instead of declaring nothing to do.
    const unsettledExports = exportResults.some(
      (r) => r.status === "running" || r.status === "pending",
    );
    for (const r of exportResults) {
      if (r.ranRender) ranAnyExport = true;
      if (r.status === "completed" || r.status === "failed") {
        allResults.push({
          variantId: r.id,
          kind: "export",
          address: "",
          status: r.status,
          outputFiles: r.outputFile ? [r.outputFile] : [],
          thumbnails: [],
          error: null,
          alreadyTerminal: false,
          submitPending: false,
        });
      }
    }

    // Activate jobs reboot ComfyUI once their install deps are ready; runnable ones run here,
    // pending ones (deps not ready) are skipped and retried next pass.
    const nodeActivateResults = await runRunnableComfyNodeActivateJobs(jobManager, roots, {
      onStarted: ({ id }) => live.log(`Activating custom nodes (${id})...`),
      onDeferred: ({ reason }) => {
        if (reportedActivateHolds.has(reason)) return;
        reportedActivateHolds.add(reason);
        live.log(`Node activation waiting for ComfyUI to go idle: ${reason}`);
      },
    });
    const ranAnyNodeActivate = nodeActivateResults.some((r) => r.ranActivate);
    for (const r of nodeActivateResults) {
      await recordStandalone(r.id, r.status);
    }

    const ranAnyModel = modelResults.some((r) => r.ranInstall);
    const ranAnyNodeInstall = nodeInstallResults.some((r) => r.ranInstall);
    if (
      submitted.length === 0 &&
      failed.length === 0 &&
      runningJobs.length === 0 &&
      !ranAnyModel &&
      !ranAnyNodeInstall &&
      !ranAnyNodeActivate &&
      !ranAnyExport
    ) {
      // Nothing advanced this pass. If model/node installs, an in-flight activate, or an
      // in-flight submit (a job being submitted by another process — a stranded one would have
      // been reclaimed above and counted as progress) are still active, wait briefly and
      // re-check rather than spin or exit early; otherwise we're done.
      // An activate deferred by the idle gate lands here too, and may be held by a SIBLING
      // video's comfy job that this wait drives nothing of — so the re-check is what eventually
      // lets it through, and `--timeout` is what bounds it.
      if (
        activeModelJobs.length > 0 ||
        activeNodeInstallJobs.length > 0 ||
        activeNodeActivateJobs.length > 0 ||
        submittingJobs.length > 0 ||
        unsettledExports
      ) {
        if (deadline.expired) continue;
        await sleep(1000);
        continue;
      }
      break;
    }
  }

  const seen = new Set(allResults.map((r) => r.variantId));

  // An export we polled while a live worker rendered it leaves the loop once it settles
  // (the top-of-loop filter drops the now-terminal job before runRunnableExportJobs sees
  // it). Report its terminal status here so a successful wait isn't summarized as empty.
  for (const id of monitoredExportIds) {
    if (seen.has(id)) continue;
    const job = await jobManager.getJob(id).catch(() => null);
    if (!job || job.kind !== "export") continue;
    if (job.status !== "completed" && job.status !== "failed") continue;
    seen.add(id);
    allResults.push({
      variantId: id,
      kind: job.kind,
      address: "",
      status: job.status,
      outputFiles: job.outputFile ? [job.outputFile] : [],
      thumbnails: [],
      error: job.error,
      alreadyTerminal: true,
      submitPending: false,
    });
  }

  // Surface failures that became terminal during this wait without being waited on directly
  // (e.g. failed between submission and the next pass's listing), so a batch that failed
  // right after submission isn't reported as "nothing to do". Jobs in priorFailedIds are
  // excluded per the snapshot above.
  const failedJobs = await jobManager.listJobs({ status: "failed" });
  for (const job of failedJobs) {
    if (seen.has(job.id) || priorFailedIds.has(job.id)) continue;
    if (job.kind !== "generation") continue;
    allResults.push({
      variantId: job.id,
      kind: job.kind,
      address: job.address,
      status: "failed",
      outputFiles: [],
      thumbnails: [],
      error: job.error,
      alreadyTerminal: true,
      submitPending: false,
    });
  }

  return { results: allResults, priorFailedCount: priorFailed.length };
}

// A job the wait stopped waiting on. NOT a failure — it is still running and re-observable, so
// `printResultLine` reports it as such and the summary counts it under `stillRunning`.
function stillRunningResult(job: JobRecord): WaitForJobResult {
  return {
    variantId: job.id,
    kind: job.kind,
    address: job.kind === "generation" ? job.address : standaloneLabel(job),
    status: job.status,
    outputFiles: [],
    thumbnails: [],
    error: null,
    alreadyTerminal: false,
    submitPending: false,
    waitTimedOut: true,
  };
}

// What a standalone job is called in the results: the thing it installs, since it has no address.
function standaloneLabel(job: JobRecord): string {
  if (job.kind === "comfy-model-download") return job.model.filename;
  if (job.kind === "comfy-node-install") return job.node.id;
  return "";
}
