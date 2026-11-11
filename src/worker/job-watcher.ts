import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import type { GenerationBackend } from "../core/backend.js";
import {
  JOBS_DB_FILE,
  JobManager,
  isJobTerminal,
  isStrandedSubmit,
  jobsDbPath,
} from "../core/job-manager.js";
import { prerequisiteVerdict } from "../core/job-index.js";
import { type StaleJudgeRelease, submitReadyPendingJobs } from "../core/pending-jobs.js";
import { applyResolutionDefinitions } from "../core/definition-hashes.js";
import { loadStageDefinitions } from "../core/stage-definitions.js";
import type { BackendKind, GenerationJob, JobRecord } from "../core/types/index.js";
import { resolveBackend } from "../backends/resolve-backend.js";
import {
  runComfyModelDownloadJob,
  runComfyNodeInstallJob,
} from "../backends/run-comfy-install-job.js";
import { runComfyNodeActivateJob } from "../backends/run-comfy-node-activate-job.js";
import { runExportJob } from "../backends/run-export-job.js";
import { runSongAnalysisJob } from "../backends/run-song-analysis-job.js";
import { loadDirectionDefinition, loadIfPresent } from "../core/loader.js";
import { stageEntryPath } from "../core/roots.js";
import { queueSongAnalyses } from "../core/song-queue.js";
import { StateManager } from "../core/state/index.js";
import { waitForJob } from "../backends/wait-for-job.js";
import type { LoadedDefinitions } from "../core/select-definition.js";
import type { VideoRoots } from "../core/roots.js";
import { errorMessage } from "../core/errors.js";
import type { WorkerLog, WorkerLogLevel } from "./worker-log.js";

// fs.watch is a fast path but not a guarantee: it can't attach until .konte exists (so jobs
// created in the gap before attach are missed), and event delivery is unreliable in some
// environments (e.g. WSL2). A periodic poll reconciles regardless — it lists the jobs on a
// timer and is correct even when the database only appears later.
const POLL_INTERVAL_MS = 5000;

// What a judge in this process found when it stepped aside: the job it handed back and, for a
// generation job, the two hashes that disagreed. The worker's answer is to restart (worker.ts).
export type StaleDefinitionsInfo =
  | ({ kind: "generation" } & StaleJudgeRelease)
  | { kind: "export"; jobId: string };

type StandaloneKind = Exclude<JobRecord["kind"], "generation">;

type JobCompletion = {
  variantId: string;
  kind: JobRecord["kind"];
  status: string;
  error: string | null;
} & Record<string, unknown>;

function completionOf(job: JobRecord): JobCompletion {
  const base = { variantId: job.id, kind: job.kind, status: job.status, error: job.error };
  switch (job.kind) {
    case "generation":
    case "song-analysis":
      return { ...base, address: job.address };
    case "comfy-model-download":
      return { ...base, model: job.model.filename };
    case "comfy-node-install":
      return { ...base, node: job.node.id };
    case "export":
      return { ...base, outputFile: job.outputFile };
    case "comfy-node-activate":
      return base;
  }
}

export class JobWatcher {
  private readonly roots: VideoRoots;
  readonly videoRoot: string;
  private readonly videoName: string;
  private readonly jobManager: JobManager;
  private readonly workerId = `w-${randomBytes(8).toString("hex")}`;
  // Every job this watcher is driving — a generation job's wait or a standalone job's run — so a
  // later scan never drives one twice.
  private readonly running = new Map<string, Promise<void>>();
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
  // session (e.g. finished by a concurrent `konte job run` before a waiter attached), so it still
  // fires. In-memory only; a fresh start re-seeds.
  private readonly startupTerminalIds = new Set<string>();
  private cascadeRunning = false;
  private cascadeRerunRequested = false;

  private readonly onStaleDefinitions: (info: StaleDefinitionsInfo) => void;
  private readonly log: Pick<WorkerLog, "write"> | undefined;

  constructor(
    roots: VideoRoots,
    videoName: string,
    hooks: {
      onStaleDefinitions?: (info: StaleDefinitionsInfo) => void;
      log?: Pick<WorkerLog, "write">;
    } = {},
  ) {
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
   * workspace's credentials changed under the worker: a cached backend closed over the key it was
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

  /** Hands the jobs this watcher still holds to the next worker; for a process about to exit. */
  releaseLeases(): Promise<void> {
    return this.jobManager.releaseClaimedLeases();
  }

  /** Settles once no job this watcher started is still running, including ones they start. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  // The entry is released on every exit, a throw included, so a job whose drive failed is driven
  // again by the next scan rather than skipped until the worker restarts.
  private drive(id: string, work: () => Promise<void>): void {
    if (this.running.has(id)) return;
    this.running.set(
      id,
      work()
        .catch(() => {})
        .finally(() => this.running.delete(id)),
    );
  }

  // A job already terminal before this session started is never recorded — nothing here watches a
  // terminal job (only running/queued are waited on below), so a completion that landed while the
  // worker was down is left for the agent to read from `konte status` / `konte job list`.
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
        if (job.kind !== "generation") {
          if (job.status === "pending" || job.status === "running") {
            this.startStandaloneJob(job.id, job.kind);
          }
          continue;
        }
        if (job.status === "running" || job.status === "queued") {
          this.startWaitingForJob(job.id);
        }
        // "queued" too: a job registered with nothing to wait on is the cascade's to submit —
        // waitForJob can't claim it. A stranded submit (crashed
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
      // the emitter and takes the whole worker down — a fault the 5s poll could otherwise
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
      await this.queueSongAnalyses();
      const jobs = await this.jobManager.listJobs();
      this.pruneDedupState(jobs);
      let hasPending = false;
      for (const job of jobs) {
        if (job.kind !== "generation") {
          if (job.status === "pending" || job.status === "running") {
            this.startStandaloneJob(job.id, job.kind);
          }
          continue;
        }
        // A generation job first seen terminal here — never caught running/queued by this watcher
        // (e.g. finished by a concurrent `konte job run` before a waiter attached) — is recorded
        // unless it predates the session (startupTerminalIds, skipped). emitCompleted dedups
        // via handledJobs, so this never double-fires with the normal waiter path.
        if (
          isJobTerminal(job.status) &&
          !this.startupTerminalIds.has(job.id) &&
          !this.handledJobs.has(job.id)
        ) {
          await this.emitCompleted(completionOf(job));
          continue;
        }
        if (job.status === "running" || job.status === "queued") {
          this.startWaitingForJob(job.id);
        }
        // See initialScan: a "queued" job and a stranded submit both need the cascade
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
    this.drive(variantId, () => this.processJob(variantId));
  }

  // A standalone job runs concurrently with everything else: only the jobs that depend on it wait
  // on it. A runner whose job is not ready yet returns it non-terminal, and a later scan retries.
  private startStandaloneJob(id: string, kind: StandaloneKind): void {
    this.drive(id, () => this.runStandaloneJob(id, kind));
  }

  private readonly runners: Record<
    StandaloneKind,
    (id: string) => Promise<{ status: JobRecord["status"]; released?: boolean }>
  > = {
    "comfy-model-download": (id) =>
      runComfyModelDownloadJob(this.jobManager, this.roots, id, {
        onProgress: ({ label, done, total }) =>
          this.sendLog("debug", {
            event: "job_progress",
            variantId: id,
            model: label,
            progress: done,
            progressMax: total,
          }),
      }),
    "comfy-node-install": (id) =>
      runComfyNodeInstallJob(this.jobManager, this.roots, id, {
        onProgress: ({ label, done, total }) =>
          this.sendLog("debug", {
            event: "job_progress",
            variantId: id,
            node: label,
            progress: done,
            progressMax: total,
          }),
      }),
    // A hold by a SIBLING video's comfy job changes no file this watcher watches, so a deferred
    // activation is retried by the periodic poll, not fs.watch.
    "comfy-node-activate": (id) =>
      runComfyNodeActivateJob(this.jobManager, this.roots, id, {
        onLog: (line) => this.sendLog("debug", { event: "node_activate", variantId: id, line }),
        onDeferred: ({ reason }) =>
          this.sendLog("debug", { event: "node_activate_deferred", variantId: id, line: reason }),
      }),
    export: (id) =>
      runExportJob(this.jobManager, this.videoRoot, id, {
        onStarted: ({ outputDir }) =>
          this.sendLog("debug", { event: "export_started", variantId: id, outputDir }),
      }),
    "song-analysis": (id) =>
      runSongAnalysisJob(this.jobManager, this.videoRoot, id, {
        onStarted: ({ address }) =>
          this.sendLog("debug", { event: "song_analysis_started", variantId: id, address }),
      }),
  };

  private async runStandaloneJob(id: string, kind: StandaloneKind): Promise<void> {
    const result = await this.runners[kind](id);
    if (result.released) {
      await this.jobManager.flushLogs();
      this.onStaleDefinitions({ kind: "export", jobId: id });
      return;
    }
    const job = await this.jobManager.getJob(id).catch(() => null);
    if (job && isJobTerminal(job.status)) {
      await this.emitCompleted(completionOf(job));
    } else {
      await this.runCascadeSubmit();
    }
  }

  // A take of the song that landed since the last scan is queued for reading; the queued job
  // rewrites the jobs database, which brings the next scan round to run it.
  private async queueSongAnalyses(): Promise<void> {
    const direction = await loadIfPresent(
      stageEntryPath(this.videoRoot, "direction"),
      loadDirectionDefinition,
    ).catch(() => null);
    if (!direction?.policy?.song) return;
    const state = (await StateManager.load(this.videoRoot)).getState();
    await queueSongAnalyses({
      videoRoot: this.videoRoot,
      direction,
      state,
      jobManager: this.jobManager,
    });
  }

  private async loadDefinitions(): Promise<LoadedDefinitions> {
    // The watcher is long-lived: video.tsx / reference.tsx can be edited (e.g. between `konte
    // generate` reserving a pending job's definitionHash and this worker submitting it). A plain
    // import() caches the module forever, so every read is a cache-busted reload. A read that
    // still comes back older than the files is caught by the fingerprint a job carries, and the
    // worker restarts rather than judge or render from it (onStaleDefinitions).
    // Registered for resolution, so a submit resolves the job's inputs against the same
    // definitions it judges the job by.
    const definitions = await loadStageDefinitions(this.videoRoot, { reload: true });
    await applyResolutionDefinitions({ videoRoot: this.videoRoot, definitions });
    return definitions;
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
    if (!isJobTerminal(job.status)) return false;
    await this.emitCompleted(completionOf(job));
    return true;
  }

  private async processJob(variantId: string): Promise<void> {
    try {
      if (await this.maybeNotifyTerminal(variantId)) return;

      const definitions = await this.loadDefinitions();
      const result = await waitForJob(this.jobManager, variantId, this.roots, definitions, {
        workerId: this.workerId,
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
      // owe a notification. emitCompleted dedups so this fires exactly once.
      await this.emitCompleted({
        variantId: result.variantId,
        kind: "generation",
        status: result.status,
        error: result.error,
        address: result.address,
      });
    } catch (err) {
      this.reportWatchFailure(variantId, err);
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

  // Every kind's terminal outcome is the one job_completed event, after a cascade pass so its
  // dependents submit (or fail) first.
  private async emitCompleted(completion: JobCompletion): Promise<void> {
    if (this.handledJobs.has(completion.variantId)) return;
    this.handledJobs.add(completion.variantId);

    await this.runCascadeSubmit();

    this.sendLog("info", {
      event: "job_completed",
      ...completion,
      remainingActiveJobs: await this.countActiveJobs(),
    });
  }

  private async runCascadeSubmit(): Promise<void> {
    // Serialize cascade runs: runCascadeSubmit is triggered from both emitCompleted
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
  // job list alone (no definitions), by the prerequisite verdict evaluateJob gates on: a job is
  // actionable when it can submit OR must fail; only a "wait" verdict is skippable. The common
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
      if (prerequisiteVerdict(job.dependsOnJobs, (id) => byId.get(id)).verdict !== "wait") {
        return true;
      }
    }
    return false;
  }

  private async runCascadeSubmitOnce(): Promise<void> {
    try {
      // Skip the expensive definition reload+transpile unless some pending job is actually
      // actionable — evaluated from the job list alone. While a multi-GB model (or a node
      // pack) installs, every dependent sits blocked on that in-flight job, so without this
      // gate the worker reloads the whole project every 5s for the entire download.
      const jobs = await this.jobManager.listJobs();
      if (!this.hasActionablePendingJob(jobs)) return;

      // A submit that fails is stamped "failed" on the job itself by submitReadyPendingJobs, so
      // the CLI reads it off disk and the worker needs no record of its own.
      // Submitting under the watcher's own worker id lets its waiter take over the submit lease;
      // each job is waited on as it commits, not after the whole pass.
      const { released } = await submitReadyPendingJobs(
        this.jobManager,
        this.roots,
        this.backendCache,
        resolveBackend,
        () => this.loadDefinitions(),
        {
          workerId: this.workerId,
          onSubmitted: (vid) => {
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
          },
        },
      );
      if (released.length > 0) await this.jobManager.flushLogs();
      for (const release of released) {
        this.onStaleDefinitions({ kind: "generation", ...release });
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
  private sendLog(level: WorkerLogLevel, data: object): void {
    this.log?.write(level, { video: this.videoName, ...data });
  }
}
