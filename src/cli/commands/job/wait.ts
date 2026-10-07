import * as path from "node:path";
import type { Command } from "commander";
import { formatDuration } from "../../../core/format-duration.js";
import { isJobTerminal, JobManager } from "../../../core/job-manager.js";
import { sleep } from "../../../core/sleep.js";
import { queueSongAnalyses } from "../../../core/song-queue.js";
import { StateManager } from "../../../core/state/index.js";
import type { JobRecord } from "../../../core/types/index.js";
import { mcpLogEnd, readMcpLogSince } from "../../../mcp/mcp-log.js";
import { parsePositiveInt } from "../../parse-option.js";
import { requireVideoRoots } from "../../context.js";
import { JobRunnerGuard } from "../../job-runner.js";
import { loadDirectionIfPresent } from "../../load-definition.js";

const POLL_INTERVAL_MS = 1000;

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

The workspace's konte daemon (\`konte mcp serve\`) runs the jobs. With none running, this wait
starts one and stops it when the wait ends. With no arguments it waits on every active job of
the video; naming ids waits on exactly those.

--timeout is a deadline on the whole command, not a budget per job. On expiry it stops
waiting, names everything still in flight and exits 1; nothing is cancelled, and work a daemon
this wait started had in hand resumes on the next wait.

Examples:
  konte job wait                    Wait for every active job, then summarize the batch
  konte job wait v-a1b2c3d4         Wait for one job and report its outcome
  konte job wait --timeout 600      Give up after 10 minutes, naming what is still running
`,
    )
    .action(async (jobIds: string[], opts: { timeout?: string }) => {
      const roots = requireVideoRoots();
      const jobManager = new JobManager(roots.video);
      const deadline = new Deadline(
        opts.timeout ? parsePositiveInt(opts.timeout, "--timeout") * 1000 : undefined,
      );
      // An unknown id fails here, before anything is started for it.
      for (const id of jobIds) await jobManager.getJob(id);

      const live = new LiveProgress({ renderRegion: Boolean(process.stderr.isTTY) });
      const runner = new JobRunnerGuard(roots.workspace, () =>
        live.log("No konte daemon is running in the workspace — this wait runs one until it ends."),
      );
      const warnings = new DaemonWarnings(roots.workspace, path.basename(roots.video), live);
      await warnings.start();
      const startedAt = Date.now();
      let observed: Observed;
      try {
        observed = await observe(
          jobManager,
          jobIds.length > 0 ? jobIds : null,
          deadline,
          live,
          runner,
          warnings,
        );
      } finally {
        live.stop();
        await runner.stop();
      }
      const elapsedMs = Date.now() - startedAt;
      const { results, priorFailedCount, settledBefore } = observed;

      if (jobIds.length > 0) {
        // Named ids get a line each: the caller asked about exactly these jobs.
        for (const r of results) printResultLine(r);
        console.log("");
        console.log(formatWaitSummary(results, elapsedMs, 0));
      } else if (results.length === 0) {
        const prior = priorFailedCount > 0 ? `, ${priorFailedCount} failed before this wait` : "";
        console.log(`No running, queued, or pending jobs${prior} — run \`konte status\``);
      } else {
        // Problems first, outcome last: the outcome line is the one a piped caller keeps.
        if (printProblemLines(results)) console.log("");
        for (const r of results) printExportOutput(r);
        console.log(formatWaitSummary(results, elapsedMs, settledBefore));
      }
      await jobManager.markReported(results.filter((r) => !r.timedOut).map((r) => r.id));
      if (results.some((r) => r.timedOut || r.status === "failed")) process.exitCode = 1;
    });
}

interface Outcome {
  id: string;
  kind: JobRecord["kind"];
  address: string;
  status: JobRecord["status"];
  outputFiles: string[];
  error: string | null;
  // Still in flight when the deadline passed — not a failure.
  timedOut: boolean;
}

interface Observed {
  results: Outcome[];
  priorFailedCount: number;
  settledBefore: number;
}

async function observe(
  jobManager: JobManager,
  ids: readonly string[] | null,
  deadline: Deadline,
  live: LiveProgress,
  runner: JobRunnerGuard,
  warnings: DaemonWarnings,
): Promise<Observed> {
  // An outcome already reported is history; the caller notes the reported failures' count when
  // there was otherwise nothing to do. One terminal but unreported is this wait's to report,
  // counted as settled before it.
  const jobsAtStart = await jobManager.listJobs();
  const priorFailedCount = jobsAtStart.filter(
    (j) => j.status === "failed" && j.reportedAt != null,
  ).length;
  const terminalAtStart = new Set(
    jobsAtStart.filter((j) => isJobTerminal(j.status)).map((j) => j.id),
  );
  // Another wait may report a job this one watched in flight; it is still this wait's outcome.
  const observedActive = new Set<string>();
  const timedOut = new Set<string>();
  const named = ids ? new Set(ids) : null;

  let jobs = jobsAtStart;
  while (true) {
    // A take of the song is read by a job the daemon queues once the take lands; a wait that ended
    // in between would leave the song unread with nothing active to start a daemon for.
    if (!named && (await queueSongReadings(jobManager)).length > 0) {
      jobs = await jobManager.listJobs();
    }
    const active = jobs.filter((j) => (named ? named.has(j.id) : true) && !isJobTerminal(j.status));
    for (const j of active) observedActive.add(j.id);
    await warnings.drain();
    if (active.length === 0) break;
    // Checked after the drain test, so a queue that emptied exactly on the deadline reports its
    // results rather than a spurious "still running".
    if (deadline.expired) {
      for (const j of active) timedOut.add(j.id);
      break;
    }
    await runner.ensure();
    live.setHeader(formatWaitHeader(active));
    live.setJobs(
      active
        .filter((j) => j.kind === "generation" && j.backendJobId != null)
        .map((j) => [j.id, formatJobLine(j)]),
    );
    await sleep(Math.min(POLL_INTERVAL_MS, deadline.remainingMs() ?? POLL_INTERVAL_MS));
    jobs = await jobManager.listJobs();
  }

  const results: Outcome[] = [];
  if (named) {
    for (const id of ids!) {
      const job = jobs.find((j) => j.id === id);
      if (job) results.push(outcomeOf(job, timedOut.has(id)));
    }
  } else {
    for (const job of jobs) {
      if (timedOut.has(job.id)) {
        results.push(outcomeOf(job, true));
        continue;
      }
      if (!isJobTerminal(job.status)) continue;
      if (job.reportedAt != null && !observedActive.has(job.id)) continue;
      results.push(outcomeOf(job, false));
    }
  }
  const settledBefore = results.filter((r) => terminalAtStart.has(r.id)).length;
  return { results, priorFailedCount, settledBefore };
}

async function queueSongReadings(jobManager: JobManager): Promise<string[]> {
  const videoRoot = jobManager.videoRoot;
  return queueSongAnalyses({
    videoRoot,
    direction: await loadDirectionIfPresent(videoRoot).catch(() => null),
    state: (await StateManager.load(videoRoot)).getState(),
    jobManager,
  });
}

function outcomeOf(job: JobRecord, timedOut: boolean): Outcome {
  return {
    id: job.id,
    kind: job.kind,
    address: job.kind === "generation" ? job.address : standaloneLabel(job),
    status: job.status,
    outputFiles:
      timedOut || job.status !== "completed"
        ? []
        : job.kind === "generation"
          ? job.outputFiles
          : job.kind === "export" && job.outputFile
            ? [job.outputFile]
            : [],
    error: timedOut ? null : job.error,
    timedOut,
  };
}

// What a standalone job is called in the results: the thing it installs, since it has no address.
function standaloneLabel(job: JobRecord): string {
  if (job.kind === "comfy-model-download") return job.model.filename;
  if (job.kind === "comfy-node-install") return job.node.id;
  if (job.kind === "song-analysis") return job.address;
  return "";
}

// `--timeout` is a deadline on the whole command, not a per-job budget.
class Deadline {
  private readonly at: number | null;

  constructor(timeoutMs: number | undefined) {
    this.at = timeoutMs == null ? null : Date.now() + timeoutMs;
  }

  get expired(): boolean {
    return this.at !== null && Date.now() >= this.at;
  }

  // undefined means "no deadline set".
  remainingMs(): number | undefined {
    return this.at === null ? undefined : Math.max(1, this.at - Date.now());
  }
}

// The daemon's warnings about this video since the wait began — a status check failing, a job it
// cannot watch — printed where the agent reads them: in the wait's own output.
class DaemonWarnings {
  private offset = 0;
  private readonly printed = new Set<string>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly video: string,
    private readonly live: LiveProgress,
  ) {}

  async start(): Promise<void> {
    this.offset = await mcpLogEnd(this.workspaceRoot);
  }

  async drain(): Promise<void> {
    const { entries, offset } = await readMcpLogSince(this.workspaceRoot, this.offset);
    this.offset = offset;
    for (const { level, data } of entries) {
      if (level !== "warning" && level !== "error") continue;
      if (data.video !== this.video) continue;
      const line = formatDaemonWarning(data);
      if (this.printed.has(line)) continue;
      this.printed.add(line);
      this.live.log(line);
    }
  }
}

const DAEMON_WARNINGS: Record<string, string> = {
  job_watch_failed: "the daemon cannot watch it; it retries every few seconds",
  job_status_unconfirmed: "no successful status check for a while; still waiting",
  state_update_failed: "it settled, but its state may be stale — run `konte status`",
  cascade_submit_failed: "pending jobs could not be submitted; retrying",
};

function formatDaemonWarning(data: Record<string, unknown>): string {
  const event = String(data.event ?? "");
  const subject = [data.address, data.variantId ? `(${String(data.variantId)})` : null]
    .filter((p) => p != null && p !== "")
    .join(" ");
  const what = DAEMON_WARNINGS[event] ?? event;
  const error = data.error ? `\n  ${String(data.error)}` : "";
  return `Warning: ${subject ? `${subject} — ` : ""}${what}${error}`;
}

interface WaitSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  stillRunning: number;
}

function summarize(results: Outcome[]): WaitSummary {
  return {
    total: results.length,
    completed: results.filter((r) => !r.timedOut && r.status === "completed").length,
    failed: results.filter((r) => !r.timedOut && r.status === "failed").length,
    cancelled: results.filter((r) => !r.timedOut && r.status === "cancelled").length,
    stillRunning: results.filter((r) => r.timedOut).length,
  };
}

function formatWaitSummary(results: Outcome[], elapsedMs: number, settledBefore: number): string {
  const s = summarize(results);
  const parts = [
    `${s.completed} completed`,
    s.failed > 0 ? `${s.failed} failed` : null,
    s.cancelled > 0 ? `${s.cancelled} cancelled` : null,
    s.stillRunning > 0 ? `${s.stillRunning} still running` : null,
  ].filter((p) => p !== null);
  // The outcome and the one command that answers it share a line, so a caller piping through
  // `tail -1` keeps both.
  const before = settledBefore > 0 ? `, ${settledBefore} of them before this wait` : "";
  return `${s.total} job(s) settled: ${parts.join(", ")} (${formatDuration(elapsedMs)}${before}) — run \`konte status\``;
}

// Only what the caller may have to act on — naming all 60 completions buries the two that broke.
function printProblemLines(results: Outcome[]): boolean {
  let printed = false;
  for (const r of results) {
    if (!r.timedOut && r.status === "completed") continue;
    printResultLine(r);
    printed = true;
  }
  return printed;
}

function printResultLine(r: Outcome): void {
  if (r.timedOut) {
    console.log(`Job ${r.id}: still running (stopped waiting — timeout reached)`);
    console.log(
      `  Re-run "konte job wait ${r.id}" to keep waiting, or "konte job cancel ${r.id}" to stop it.`,
    );
    return;
  }
  const label = r.address ? `${r.address} (${r.id})` : r.id;
  console.log(`Job ${label}: ${r.status}`);
  printExportOutput(r);
  if (r.error) {
    console.log(`  Error: ${r.error}`);
  }
}

function printExportOutput(r: Outcome): void {
  if (r.kind !== "export" || r.status !== "completed" || r.timedOut) return;
  for (const file of r.outputFiles) console.log(`Export ${r.id}: ${file}`);
}

// One live line per job: the address leads (what is being generated), the trailing variant id
// disambiguates rerolls that share an address. Elapsed is live-only, per formatDuration.
function formatJobLine(job: JobRecord): string {
  const address = job.kind === "generation" ? job.address : job.id;
  const progress = job.progress != null ? `  ${Math.round(job.progress)}%` : "";
  const elapsed = job.startedAt
    ? ` ${formatDuration(Date.now() - new Date(job.startedAt).getTime())}`
    : "";
  return `  ${address}${progress}${elapsed}  ${job.id}`;
}

// The live region's header: the total still in flight and its breakdown.
function formatWaitHeader(active: readonly JobRecord[]): string {
  let running = 0;
  let pending = 0;
  let installing = 0;
  let exporting = 0;
  for (const j of active) {
    if (j.kind === "generation") {
      if (j.backendJobId != null) running++;
      else pending++;
    } else if (j.kind === "export") exporting++;
    else installing++;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (installing > 0) parts.push(`${installing} installing`);
  if (exporting > 0) parts.push(`${exporting} exporting`);
  const total = active.length;
  const breakdown = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `Waiting on ${total} job${total === 1 ? "" : "s"}${breakdown}`;
}

// A bottom-anchored live status region on stderr: an optional header plus one line per active
// job, repainted in place each pass. Permanent output goes through `log()`, which prints above the
// region so the live lines stay pinned to the bottom. TTY-only — a piped stderr (`renderRegion`
// false) gets `log()` lines and no region at all. Each rendered line is clipped to the terminal
// width so none wraps, which would desync the cursor-up math.
class LiveProgress {
  private header = "";
  private jobs = new Map<string, string>();
  private renderedRows = 0;
  private readonly renderRegion: boolean;
  private readonly out: NodeJS.WriteStream = process.stderr;

  constructor(opts: { renderRegion?: boolean } = {}) {
    this.renderRegion = opts.renderRegion ?? Boolean(process.stderr.isTTY);
  }

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

  setJobs(lines: Iterable<[string, string]>): void {
    if (!this.renderRegion) return;
    this.jobs = new Map(lines);
    this.repaint();
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
