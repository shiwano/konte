import * as path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GenerationBackend } from "../core/backend.js";
import {
  JOBS_DB_FILE,
  JobManager,
  isJobTerminal,
  isStrandedSubmit,
  jobsDbPath,
} from "../core/job-manager.js";
import { type StaleJudgeRelease, submitReadyPendingJobs } from "../core/pending-jobs.js";
import { reloadLoadedDefinitions } from "../core/reload-definitions.js";
import type {
  BackendKind,
  ComfyModelDownloadJob,
  GenerationJob,
  JobRecord,
} from "../core/types/index.js";
import { resolveBackend } from "../backends/resolve-backend.js";
import {
  runComfyModelDownloadJob,
  runComfyNodeInstallJob,
} from "../backends/run-comfy-install-job.js";
import { runComfyNodeActivateJob } from "../backends/run-comfy-node-activate-job.js";
import { runExportJob } from "../backends/run-export-job.js";
import { waitForJob } from "../backends/wait-for-job.js";
import type { LoadedDefinitions } from "../core/select-definition.js";
import type { VideoRoots } from "../core/roots.js";
import { errorMessage } from "../core/errors.js";
import type { McpLog, McpLogLevel } from "./mcp-log.js";

// fs.watch is a fast path but not a guarantee: it can't attach until .konte exists (so jobs
// created in the gap before attach are missed), and event delivery is unreliable in some
// environments (e.g. WSL2). A periodic poll reconciles regardless — it lists the jobs on a
// timer and is correct even when the database only appears later.
const POLL_INTERVAL_MS = 5000;

// What a judge in this process found when it stepped aside: the job it handed back and, for a
// generation job, the two hashes that disagreed. The daemon's answer is to restart (mcp/index.ts).
export type StaleDefinitionsInfo =
  | ({ kind: "generation" } & StaleJudgeRelease)
  | { kind: "export"; jobId: string };

export class JobWatcher {
  private readonly server: McpServer;
  private readonly roots: VideoRoots;
  readonly videoRoot: string;
  private readonly videoName: string;
  private readonly jobManager: JobManager;
  private readonly watchingVariants = new Set<string>();
  private watcher: FSWatcher | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private backendCache = new Map<BackendKind, GenerationBackend>();
  private readonly handledJobs = new Set<string>();
  private readonly loggedSubmissions = new Set<string>();
  // The failure each job's watch last reported, for dedup — see reportWatchFailure.
  private readonly watchFailures = new Map<string, string>();
  // Ids of jobs already terminal when this watcher started — the pre-session backlog, which fires
  // no completion. A terminal job whose id is NOT here was first observed terminal DURING the
  // session (e.g. finished by a concurrent `konte job wait` before a waiter attached), so it still
  // fires. In-memory only; a fresh start re-seeds.
  private readonly startupTerminalIds = new Set<string>();
  private readonly modelJobsInFlight = new Set<string>();
  private readonly nodeInstallJobsInFlight = new Set<string>();
  private readonly nodeActivateJobsInFlight = new Set<string>();
  private readonly exportJobsInFlight = new Set<string>();
  private cascadeRunning = false;
  private cascadeRerunRequested = false;

  private readonly onStaleDefinitions: (info: StaleDefinitionsInfo) => void;
  private readonly log: McpLog | undefined;

  constructor(
    server: McpServer,
    roots: VideoRoots,
    videoName: string,
    hooks: { onStaleDefinitions?: (info: StaleDefinitionsInfo) => void; log?: McpLog } = {},
  ) {
    this.server = server;
    this.roots = roots;
    this.videoRoot = roots.video;
    this.videoName = videoName;
    this.jobManager = new JobManager(roots.video);
    this.onStaleDefinitions = hooks.onStaleDefinitions ?? (() => {});
    this.log = hooks.log;
  }

  async start(): Promise<void> {
    // Create .konte and the jobs database up front so fs.watch can attach immediately. Without
    // this, a freshly-init'd project has no .konte at startup, watch() throws, and jobs created
    // before the retry re-attaches are missed (the watcher sits idle).
    await this.jobManager.ensureDirs();

    await this.initialScan();
    this.startWatching();
    // Safety-net poll: reconcile even when fs.watch missed events or attached late.
    this.pollTimer = setInterval(() => {
      void this.scanForNewJobs();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Forget the backends built so far, so the next submit resolves them again. Called when the
   * workspace's credentials changed under the daemon: a cached backend closed over the key it was
   * built with, and would keep submitting on a rotated or deleted one.
   *
   * Replaced, not cleared. A submit already past its cache miss resolves the backend across an
   * `await` and then writes it into the map it was handed — clearing in place would let a backend
   * built on the old key land back in the live cache, and stay there until the next rotation.
   */
  dropBackendCache(): void {
    this.backendCache = new Map();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // A job already terminal before this session started is never recorded — nothing here watches a
  // terminal job (only running/queued are waited on below), so a completion that landed while the
  // daemon was down is left for the agent to read from `konte status` / `konte job list`.
  private async initialScan(): Promise<void> {
    try {
      const jobs = await this.jobManager.listJobs();
      // Baseline the pre-session backlog so scanForNewJobs can tell a terminal that predates this
      // watcher (skipped) from one that goes terminal during the session (recorded).
      for (const job of jobs) {
        if (isJobTerminal(job.status)) this.startupTerminalIds.add(job.id);
      }
      let hasPending = false;
      for (const job of jobs) {
        if (job.kind === "comfy-model-download") {
          if (job.status === "pending" || job.status === "running") {
            this.startComfyModelJob(job.id);
          }
          continue;
        }
        if (job.kind === "comfy-node-install") {
          if (job.status === "pending" || job.status === "running") {
            this.startComfyNodeInstallJob(job.id);
          }
          continue;
        }
        if (job.kind === "comfy-node-activate") {
          if (job.status === "pending" || job.status === "running") {
            this.startComfyNodeActivateJob(job.id);
          }
          continue;
        }
        if (job.kind === "export") {
          if (job.status === "pending" || job.status === "running") {
            this.startExportJob(job.id);
          }
          continue;
        }
        if (job.status === "running" || job.status === "queued") {
          this.startWaitingForJob(job.id);
        }
        // "queued" too: the eager path claims a fresh no-deps job before submitting, so one left
        // sitting "queued" is an orphan (its creator died in the createJob→claim gap) that only
        // the cascade can submit — waitForJob can't claim it. A stranded submit (crashed
        // mid-submit: "running", no backendJobId, lapsed lease) likewise needs the cascade to
        // reclaim and re-submit it — on its own it never leaves "running".
        if (job.status === "pending" || job.status === "queued" || isStrandedSubmit(job)) {
          hasPending = true;
        }
      }
      if (hasPending) {
        await this.runCascadeSubmit();
      }
    } catch {
      // jobs dir may not exist yet
    }
  }

  // Forget dedup entries a fresh terminal transition should be free to re-record: a job no
  // longer on disk (cleaned/pruned — its unique id can't recur), and a job reset back to a
  // non-terminal state. The latter matters for deterministic model/node ids
  // (`ensureComfyModelDownloadJob` resets a failed `cmd-…` in place), whose retried download
  // would otherwise be suppressed by the stale "already handled" mark. Also bounds growth.
  private pruneDedupState(jobs: JobRecord[]): void {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const stale = (id: string): boolean => {
      const job = byId.get(id);
      return job == null || !isJobTerminal(job.status);
    };
    for (const id of this.handledJobs) {
      if (stale(id)) this.handledJobs.delete(id);
    }
    for (const vid of this.loggedSubmissions) {
      if (stale(vid)) this.loggedSubmissions.delete(vid);
    }
    // NOT the same rule: a watch failure is recorded on a job that is still running, which
    // `stale` calls stale. Only a job gone from disk drops its entry.
    for (const vid of this.watchFailures.keys()) {
      if (!byId.has(vid)) this.watchFailures.delete(vid);
    }
  }

  private startWatching(): void {
    // The database is written through its WAL sidecar, so the watch is on the directory and
    // keyed by the file's name prefix (jobs.db, jobs.db-wal, jobs.db-shm).
    const konteDir = path.dirname(jobsDbPath(this.videoRoot));

    try {
      this.watcher = watch(konteDir, (_event, filename) => {
        if (filename != null && !String(filename).startsWith(JOBS_DB_FILE)) return;
        this.debouncedScan();
      });
      // Without an error handler a watcher failure (e.g. the OS handle goes bad) throws on
      // the emitter and takes the whole daemon down — a fault the 5s poll could otherwise
      // have ridden out. Close and re-attach on the same retry path as an initial failure.
      this.watcher.on("error", () => this.restartWatching());
    } catch {
      // directory may not exist yet; retry periodically
      this.scanTimer = setTimeout(() => this.startWatching(), 5000);
    }
  }

  private restartWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.startWatching(), 5000);
  }

  private debouncedScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scanForNewJobs(), 200);
  }

  private async scanForNewJobs(): Promise<void> {
    try {
      const jobs = await this.jobManager.listJobs();
      this.pruneDedupState(jobs);
      let hasPending = false;
      for (const job of jobs) {
        if (job.kind === "comfy-model-download") {
          if (job.status === "pending" || job.status === "running") {
            this.startComfyModelJob(job.id);
          }
          continue;
        }
        if (job.kind === "comfy-node-install") {
          if (job.status === "pending" || job.status === "running") {
            this.startComfyNodeInstallJob(job.id);
          }
          continue;
        }
        if (job.kind === "comfy-node-activate") {
          if (job.status === "pending" || job.status === "running") {
            this.startComfyNodeActivateJob(job.id);
          }
          continue;
        }
        if (job.kind === "export") {
          if (job.status === "pending" || job.status === "running") {
            this.startExportJob(job.id);
          }
          continue;
        }
        // A generation job first seen terminal here — never caught running/queued by this watcher
        // (e.g. finished by a concurrent `konte job wait` before a waiter attached) — is recorded
        // unless it predates the session (startupTerminalIds, skipped). handleJobCompleted dedups
        // via handledJobs, so this never double-fires with the normal waiter path.
        if (
          isJobTerminal(job.status) &&
          !this.startupTerminalIds.has(job.id) &&
          !this.handledJobs.has(job.id)
        ) {
          await this.handleJobCompleted(
            job.id,
            job.address,
            job.status as "completed" | "failed" | "cancelled",
            job.error,
          );
          continue;
        }
        if (
          (job.status === "running" || job.status === "queued") &&
          !this.watchingVariants.has(job.id)
        ) {
          this.startWaitingForJob(job.id);
        }
        // See initialScan: an orphaned "queued" job and a stranded submit both need the cascade
        // to submit them; neither ever leaves its state on its own.
        if (job.status === "pending" || job.status === "queued" || isStrandedSubmit(job)) {
          hasPending = true;
        }
      }
      if (hasPending) {
        await this.runCascadeSubmit();
      }
    } catch {
      // best-effort scan
    }
  }

  // Deliberately NOT capped by a semaphore: a slot held for a job's whole backend wait would
  // let 16 long-running jobs starve the finalization of later jobs that already completed on
  // their backends — and every dependent blocked behind them. Bounding this fan-out needs
  // slice-polling (short leases per waiter), not a gate around the whole wait.
  private startWaitingForJob(variantId: string): void {
    if (this.watchingVariants.has(variantId)) return;
    this.watchingVariants.add(variantId);
    this.processJob(variantId).catch(() => {});
  }

  // Run a comfy-model-download job concurrently. Unlike the serial cascade, this
  // does NOT block other jobs while a multi-GB model downloads — only the
  // generation jobs that depend on this model wait. The in-flight set dedups
  // re-spawns across scans/polls.
  private startComfyModelJob(id: string): void {
    if (this.modelJobsInFlight.has(id)) return;
    this.modelJobsInFlight.add(id);
    this.processComfyModelJob(id)
      .catch(() => {})
      .finally(() => this.modelJobsInFlight.delete(id));
  }

  // Run a comfy-node-install job concurrently (installs the pack to disk). Like a model
  // download, this doesn't block unrelated jobs; only the activate job that depends on it
  // waits. The in-flight set dedups re-spawns across scans/polls.
  private startComfyNodeInstallJob(id: string): void {
    if (this.nodeInstallJobsInFlight.has(id)) return;
    this.nodeInstallJobsInFlight.add(id);
    this.processComfyNodeInstallJob(id)
      .catch(() => {})
      .finally(() => this.nodeInstallJobsInFlight.delete(id));
  }

  // Run a comfy-node-activate job concurrently. It gates on its install deps internally
  // (returns "pending" without rebooting if they are not ready) and reboots ComfyUI once
  // under a server-wide lock when activation is needed. The in-flight set dedups re-spawns.
  private startComfyNodeActivateJob(id: string): void {
    if (this.nodeActivateJobsInFlight.has(id)) return;
    this.nodeActivateJobsInFlight.add(id);
    this.processComfyNodeActivateJob(id)
      .catch(() => {})
      .finally(() => this.nodeActivateJobsInFlight.delete(id));
  }

  private async processComfyNodeInstallJob(id: string): Promise<void> {
    await runComfyNodeInstallJob(this.jobManager, this.roots, id, {
      onProgress: ({ label, done, total }) =>
        this.sendLog("debug", {
          event: "job_progress",
          variantId: id,
          node: label,
          progress: done,
          progressMax: total,
        }),
    });
    // Let the cascade re-evaluate the activate job (and any dependents) once this settles.
    await this.runCascadeSubmit();
  }

  private async processComfyNodeActivateJob(id: string): Promise<void> {
    const result = await runComfyNodeActivateJob(this.jobManager, this.roots, id, {
      onLog: (line) => this.sendLog("debug", { event: "node_activate", variantId: id, line }),
      onDeferred: ({ reason }) =>
        this.sendLog("debug", { event: "node_activate_deferred", variantId: id, line: reason }),
    });
    if (
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      // Generation jobs depend on this; cascade so they submit (or fail) now that it settled.
      await this.runCascadeSubmit();
    }
    // "pending" (install deps not ready, or the ComfyUI server is not idle): drop the watch; a
    // later scan retries. A hold by a SIBLING video's comfy job changes no file this watcher
    // watches, so there it is the periodic poll — not fs.watch — that eventually re-triggers.
  }

  // Run an export (render) job concurrently, like a model download. runExportJob gates
  // on its dependencies internally: if they are not ready it returns "pending" without
  // rendering, and a later scan (after a dependency completes and rewrites its job file)
  // re-triggers. The in-flight set dedups re-spawns across scans/polls.
  private startExportJob(id: string): void {
    if (this.exportJobsInFlight.has(id)) return;
    this.exportJobsInFlight.add(id);
    this.processExportJob(id)
      .catch(() => {})
      .finally(() => this.exportJobsInFlight.delete(id));
  }

  private async processExportJob(id: string): Promise<void> {
    const result = await runExportJob(this.jobManager, this.videoRoot, id, {
      onStarted: ({ outputDir }) =>
        this.sendLog("debug", { event: "export_started", variantId: id, outputDir }),
    });
    if (result.released) {
      await this.jobManager.flushLogs();
      this.onStaleDefinitions({ kind: "export", jobId: id });
      return;
    }
    if (
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      await this.emitExportJobCompleted(id, result.status, result.outputFile);
    }
    // "pending" (deps not ready yet): drop silently; a later scan retries.
  }

  private async emitExportJobCompleted(
    id: string,
    status: "completed" | "failed" | "cancelled",
    outputFile: string | null,
  ): Promise<void> {
    if (this.handledJobs.has(id)) return;
    this.handledJobs.add(id);

    const job = await this.jobManager.getJob(id).catch(() => null);
    const error = job?.error ?? null;

    const remainingActiveJobs = await this.countActiveJobs();

    this.sendLog("info", {
      event: "job_completed",
      variantId: id,
      kind: "export",
      status,
      outputFile,
      error,
      remainingActiveJobs,
    });
  }

  private async processComfyModelJob(id: string): Promise<void> {
    // Model downloads are ordinary jobs — they ride the same generic job events as
    // generation jobs (job_progress while downloading, job_completed on terminal),
    // distinguished only by `kind`. No bespoke events.
    await runComfyModelDownloadJob(this.jobManager, this.roots, id, {
      onProgress: ({ label, done, total }) =>
        this.sendLog("debug", {
          event: "job_progress",
          variantId: id,
          model: label,
          progress: done,
          progressMax: total,
        }),
    });

    const job = await this.jobManager.getJob(id).catch(() => null);
    if (
      job?.kind === "comfy-model-download" &&
      (job.status === "completed" || job.status === "failed" || job.status === "cancelled")
    ) {
      await this.emitModelJobCompleted(job);
    } else {
      // Still running elsewhere — let the next cascade pass submit dependents.
      await this.runCascadeSubmit();
    }
  }

  // Log the generic job_completed event for a finished model-download job, and cascade so
  // dependents can submit.
  private async emitModelJobCompleted(job: ComfyModelDownloadJob): Promise<void> {
    if (this.handledJobs.has(job.id)) return;
    this.handledJobs.add(job.id);

    await this.runCascadeSubmit();
    const remainingActiveJobs = await this.countActiveJobs();

    this.sendLog("info", {
      event: "job_completed",
      variantId: job.id,
      kind: job.kind,
      model: job.model.filename,
      status: job.status,
      error: job.error,
      remainingActiveJobs,
    });
  }

  private loadDefinitions(): Promise<LoadedDefinitions> {
    // The watcher is long-lived: video.tsx / reference.tsx can be edited (e.g. between `konte
    // generate` reserving a pending job's definitionHash and this daemon submitting it). A plain
    // import() caches the module forever, so every read is a cache-busted reload. A read that
    // still comes back older than the files is caught by the fingerprint a job carries, and the
    // daemon restarts rather than judge or render from it (onStaleDefinitions).
    return reloadLoadedDefinitions(this.videoRoot);
  }

  // Returns true if the job was already terminal and we notified for it. A job can
  // complete out from under us — finished by another waiter (a separate `konte job
  // wait` or watcher session) while we were about to wait. We still must notify, and
  // an already-terminal job needs no definitions or backend.
  private async maybeNotifyTerminal(variantId: string): Promise<boolean> {
    let job;
    try {
      job = await this.jobManager.getJob(variantId);
    } catch {
      return false;
    }
    if (job.kind !== "generation") return false;
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
      return false;
    }
    await this.handleJobCompleted(variantId, job.address, job.status, job.error);
    return true;
  }

  private async processJob(variantId: string): Promise<void> {
    try {
      if (await this.maybeNotifyTerminal(variantId)) return;

      const definitions = await this.loadDefinitions();
      const result = await waitForJob(this.jobManager, variantId, this.roots, definitions, {
        onProgress: (p) =>
          this.sendLog("debug", {
            event: "job_progress",
            variantId: p.variantId,
            address: p.address,
            progress: p.value,
            progressMax: p.max,
            node: p.node,
          }),
        onStateUpdateError: ({ variantId: vid, address, error }) =>
          this.sendLog("warning", {
            event: "state_update_failed",
            variantId: vid,
            address,
            error,
          }),
        onThumbnailError: ({ variantId: vid, address, error }) =>
          this.sendLog("debug", {
            event: "thumbnail_extraction_failed",
            variantId: vid,
            address,
            error,
          }),
        onUnconfirmed: ({ variantId: vid, address, unconfirmed, lastError }) =>
          this.sendLog(unconfirmed ? "warning" : "info", {
            event: unconfirmed ? "job_status_unconfirmed" : "job_status_confirmed",
            variantId: vid,
            address,
            error: lastError,
          }),
      });

      // This job's watch attached, so a later failure on it is new news rather than a repeat.
      this.watchFailures.delete(variantId);

      // The job is still mid-submit (claimed "running" but no backendJobId yet). This
      // is not a completion — drop the watch without notifying so a later scan (the
      // backendJobId write triggers fs.watch, or the cascade's submitted loop, or the
      // safety-net poll) re-attempts once the id is committed. Notifying here would
      // emit a false job_completed and poison notifiedVariants against the real one.
      if (result.submitPending) return;

      // The waiter timed out but the job is still running (non-terminal). Drop the watch
      // without notifying; a later scan re-attaches and observes the real outcome. The
      // watcher itself sets no timeout, so this is defense-in-depth.
      if (result.waitTimedOut) return;

      // Notify regardless of alreadyTerminal: if the job completed during the slow
      // loadDefinitions window above, waitForJob returns alreadyTerminal but we still
      // owe a notification. handleJobCompleted dedups so this fires exactly once.
      await this.handleJobCompleted(
        result.variantId,
        result.address,
        result.status as "completed" | "failed" | "cancelled",
        result.error,
      );
    } catch (err) {
      this.reportWatchFailure(variantId, err);
    } finally {
      // Always release the watch slot, on every exit including a throw. loadDefinitions
      // (a transient video.tsx load failure) or waitForJob (backend construction on a
      // missing API key, outside its own try) can throw; without this the variant would
      // stay in watchingVariants and every later scan would skip it until the daemon
      // restarts. The entry is held for the whole await above, so a concurrent scan never
      // double-watches an in-flight job; a terminal job is not re-added because
      // scanForNewJobs only watches running/queued.
      this.watchingVariants.delete(variantId);
    }
  }

  // A throw out of processJob — loadDefinitions on a broken video.tsx, waitForJob building a
  // backend on a missing credential — drops the watch, and the poll re-attempts every 5s and
  // throws in the same place. Nothing reconciles the job and, until this, nothing said why.
  // Reported once per job per distinct error, so a persistent fault is one line each rather than
  // the whole queue every 5s. Kept per job, not as one last-error: watches run concurrently, so a
  // single slot would let one job's success clear another's still-standing failure and let two
  // alternating errors re-report each other forever.
  private reportWatchFailure(variantId: string, err: unknown): void {
    const error = errorMessage(err);
    if (this.watchFailures.get(variantId) === error) return;
    this.watchFailures.set(variantId, error);
    this.sendLog("warning", { event: "job_watch_failed", variantId, error });
  }

  private async handleJobCompleted(
    variantId: string,
    address: string,
    status: "completed" | "failed" | "cancelled",
    error: string | null,
  ): Promise<void> {
    if (this.handledJobs.has(variantId)) return;
    this.handledJobs.add(variantId);

    await this.runCascadeSubmit();

    const remainingActiveJobs = await this.countActiveJobs();

    this.sendLog("info", {
      event: "job_completed",
      variantId,
      address,
      status,
      kind: "generation",
      error,
      remainingActiveJobs,
    });
  }

  private async runCascadeSubmit(): Promise<void> {
    // Serialize cascade runs: runCascadeSubmit is triggered from both handleJobCompleted
    // and scanForNewJobs, which can fire concurrently. Overlapping runs would each read
    // the same pending jobs and double-submit. A request arriving mid-run schedules
    // exactly one follow-up pass so no dependency completion is dropped.
    if (this.cascadeRunning) {
      this.cascadeRerunRequested = true;
      return;
    }
    this.cascadeRunning = true;
    try {
      do {
        this.cascadeRerunRequested = false;
        await this.runCascadeSubmitOnce();
      } while (this.cascadeRerunRequested);
    } finally {
      this.cascadeRunning = false;
    }
  }

  // Whether any pending/stranded generation job is worth a cascade pass, decided from the
  // job list alone (no definitions). Mirrors evaluateJob's prerequisite-job loop exactly: it
  // returns on the FIRST non-completed dep — "doomed" (fail path) if that dep is missing or
  // failed/cancelled, "wait" if it is still in flight. So a job is actionable when it can
  // submit (all deps completed) OR must fail; only a "wait" verdict is skippable. The common
  // model/node-install case is a "wait", so the expensive reload is skipped for the whole
  // download. Errs toward proceeding: returns true unless every pending job is a "wait".
  private hasActionablePendingJob(jobs: JobRecord[]): boolean {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const pending = jobs.filter(
      (j): j is GenerationJob =>
        j.kind === "generation" &&
        (j.status === "pending" || j.status === "queued" || isStrandedSubmit(j)),
    );
    for (const job of pending) {
      if (this.dependsOnJobsVerdict(job, byId) !== "wait") return true;
    }
    return false;
  }

  private dependsOnJobsVerdict(
    job: GenerationJob,
    byId: Map<string, JobRecord>,
  ): "settled" | "wait" | "doomed" {
    for (const depId of job.dependsOnJobs) {
      const dep = byId.get(depId);
      if (dep == null) return "doomed";
      if (dep.status === "completed") continue;
      if (dep.status === "failed" || dep.status === "cancelled") return "doomed";
      return "wait";
    }
    return "settled";
  }

  private async runCascadeSubmitOnce(): Promise<void> {
    try {
      // Skip the expensive definition reload+transpile unless some pending job is actually
      // actionable — evaluated from the job list alone. While a multi-GB model (or a node
      // pack) installs, every dependent sits blocked on that in-flight job, so without this
      // gate the daemon reloads the whole project every 5s for the entire download.
      const jobs = await this.jobManager.listJobs();
      if (!this.hasActionablePendingJob(jobs)) return;

      // A submit that fails is stamped "failed" on the job itself by submitReadyPendingJobs, so
      // the CLI reads it off disk and the daemon needs no record of its own.
      const { submitted, released } = await submitReadyPendingJobs(
        this.jobManager,
        this.roots,
        this.backendCache,
        resolveBackend,
        () => this.loadDefinitions(),
      );
      if (released.length > 0) await this.jobManager.flushLogs();
      for (const release of released) {
        this.onStaleDefinitions({ kind: "generation", ...release });
      }

      for (const vid of submitted) {
        // Logged once per variant: overlapping cascade passes (see runCascadeSubmit) can report
        // the same submission twice. startWaitingForJob is idempotent on its own, so it stays
        // outside the guard.
        if (!this.loggedSubmissions.has(vid)) {
          this.loggedSubmissions.add(vid);
          this.sendLog("debug", {
            event: "pending_job_submitted",
            variantId: vid,
          });
        }
        this.startWaitingForJob(vid);
      }
    } catch (err) {
      const msg = errorMessage(err);
      this.sendLog("warning", {
        event: "cascade_submit_failed",
        error: msg,
      });
    }
  }

  private async countActiveJobs(): Promise<number> {
    try {
      const jobs = await this.jobManager.listJobs();
      return jobs.filter(
        (j) => j.status === "pending" || j.status === "queued" || j.status === "running",
      ).length;
    } catch {
      return 0;
    }
  }

  // One process serves every video in the workspace, so each log line names the video it came from.
  private sendLog(level: McpLogLevel, data: object): void {
    this.log?.write(level, { video: this.videoName, ...data });
    try {
      this.server.server.sendLoggingMessage({
        level,
        logger: "konte",
        data: { video: this.videoName, ...data },
      });
    } catch {
      // notification sending is best-effort
    }
  }
}
