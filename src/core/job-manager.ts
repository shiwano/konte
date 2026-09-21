import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeDefinitionSourceFingerprint } from "./definition-source.js";
import { KonteError, errorMessage } from "./errors.js";
import { hashToShortId, shortId } from "./short-id.js";
import { stableStringify } from "./stable-stringify.js";
import {
  type BackendKind,
  type ComfyModelDeclaration,
  type ComfyModelDownloadJob,
  type ComfyNodeActivateJob,
  type ComfyNodeDeclaration,
  type ComfyNodeInstallJob,
  type ExportJob,
  type GenerationJob,
  type JobRecord,
  type JobRecordInput,
  JobRecordSchema,
} from "./types/index.js";

// Fields an update may set: any field of any job kind except the immutable id.
// (Omit over the union would keep only fields common to every kind, so we union
// the per-variant field sets instead.)
type JobUpdate = Partial<Omit<GenerationJob, "id" | "variantId">> &
  Partial<Omit<ComfyModelDownloadJob, "id">> &
  Partial<Omit<ComfyNodeInstallJob, "id">> &
  Partial<Omit<ComfyNodeActivateJob, "id">> &
  Partial<Omit<ExportJob, "id">>;

const KONTE_DIR = ".konte";
const LOGS_DIR = "logs";
export const JOBS_DB_FILE = "jobs.db";

export function jobsDbPath(videoRoot: string): string {
  return path.join(videoRoot, KONTE_DIR, JOBS_DB_FILE);
}

// Run-lease policy for locally-executed jobs (export renders, comfy model downloads): the
// running worker renews its lease every RUN_LEASE_HEARTBEAT_MS, and the lease is valid for
// RUN_LEASE_TTL_MS — so a crashed worker's job becomes reclaimable after at most one TTL,
// while a live worker's job is never reclaimed.
export const RUN_LEASE_TTL_MS = 60_000;
export const RUN_LEASE_HEARTBEAT_MS = 20_000;

// Deterministic id for the shared download job of a comfy model, keyed by its
// install target — (type, savePath, filename) — so every asset that declares the
// same model maps to one job, while a same-named model of a different type or
// save path gets its own (no collision). The id is the cross-process dedup key.
export function comfyModelJobId(model: ComfyModelDeclaration): string {
  const key = JSON.stringify([model.type, model.savePath ?? "default", model.filename]);
  return `cmd-${hashToShortId(key)}`;
}

// Deterministic id for the shared install job of a custom node pack, keyed by its
// cnr_id, so every asset declaring the same pack maps to one job.
function comfyNodeJobId(node: ComfyNodeDeclaration): string {
  return `cni-${hashToShortId(JSON.stringify([node.id]))}`;
}

// Deterministic id for the activate job of a set of node packs, keyed by the packs it makes live
// and the install jobs it waits on. Every asset in a run declares the same missing packs, so a
// random id gave one activate job PER ASSET — and each ran the full reboot-and-verify cycle in
// turn, rebooting a ComfyUI the previous one had just brought back. Sorted so declaration order
// cannot split one activation into two.
export function comfyNodeActivateJobId(
  cnrIds: readonly string[],
  dependsOnJobs: readonly string[],
): string {
  const key = JSON.stringify([[...cnrIds].sort(), [...dependsOnJobs].sort()]);
  return `cna-${hashToShortId(key)}`;
}

export function isJobTerminal(status: JobRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Whether an existing provisioning record should be thrown away and re-run.
 *
 * A failed or cancelled one always should — it produced nothing. A COMPLETED one only when the
 * caller confirms the thing it installed is genuinely absent now (`resetCompleted`). The caller
 * reaches these methods for anything a presence sweep called missing, and that sweep reports
 * everything missing when it cannot reach ComfyUI at all — so without the qualifier, one offline
 * run would retire every provisioning record in the project.
 */
function isStaleProvisioning(
  status: JobRecord["status"],
  absenceConfirmed: boolean | undefined,
): boolean {
  if (status === "failed" || status === "cancelled") return true;
  return status === "completed" && absenceConfirmed === true;
}

// A generation job whose submitter died mid-transaction: claimed "running" but it never
// committed a backendJobId, and its submit lease has lapsed (or was never taken). Nothing
// re-submits a "running" job and the run-phase reclaim needs a backendJobId, so such a job
// is stranded forever unless reclaimed — claimForSubmission resets it under a fresh lease.
export function isStrandedSubmit(job: JobRecord, now: number = Date.now()): boolean {
  if (job.kind !== "generation" || job.status !== "running" || job.backendJobId != null) {
    return false;
  }
  return job.lease == null || Date.parse(job.lease.expiresAt) <= now;
}

// Job ids key on-disk log paths (.konte/logs/<id>.log). Many ids flow from user-supplied
// arguments (e.g. `konte job logs <jobId>`), so reject any id that isn't a single path segment
// before it reaches the filesystem — otherwise a crafted id like `../../etc/x` would escape the
// project's log directory. Every lookup checks it too, so a malformed id is a VALIDATION_FAILED
// rather than a JOB_NOT_FOUND.
function assertSafeJobId(id: string): void {
  if (
    id.length === 0 ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    id !== path.basename(id) ||
    id === "." ||
    id === ".."
  ) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `Invalid job id "${id}": must be a single path segment`,
    );
  }
}

// One connection per database file per process. A video root can be deleted and recreated under
// a long-lived daemon, so a cached handle is trusted only while it still points at the inode on
// disk; otherwise it is closed and reopened. A daemon that stops following a video closes its
// handle through closeJobDatabase, or the descriptors outlive the video.
const connections = new Map<string, { db: Database; ino: number }>();

export function closeJobDatabase(videoRoot: string): void {
  const dbPath = jobsDbPath(videoRoot);
  const cached = connections.get(dbPath);
  if (!cached) return;
  connections.delete(dbPath);
  cached.db.close();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  address TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_address ON jobs(address);
`;

function openDatabase(dbPath: string): Database {
  const cached = connections.get(dbPath);
  if (cached) {
    try {
      if (statSync(dbPath).ino === cached.ino) return cached.db;
    } catch {
      // gone — fall through and reopen
    }
    cached.db.close();
    connections.delete(dbPath);
  }
  try {
    // .konte only, never its parent: a daemon's in-flight work on a video removed under it must
    // not bring the video's root back as a bare jobs database.
    try {
      mkdirSync(path.dirname(dbPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const db = new Database(dbPath, { create: true });
    // The timeout first: switching the journal mode takes the write lock too, and two processes
    // opening a fresh database together would otherwise fail one of them with SQLITE_BUSY.
    db.run("PRAGMA busy_timeout = 10000");
    db.run("PRAGMA journal_mode = WAL");
    db.run(SCHEMA);
    connections.set(dbPath, { db, ino: statSync(dbPath).ino });
    return db;
  } catch (err) {
    throw new KonteError(
      "STATE_WRITE_FAILED",
      `Failed to open jobs database ${dbPath}: ${errorMessage(err)}`,
    );
  }
}

type JobRow = { data: string };

function parseRow(row: JobRow): JobRecord | null {
  try {
    const result = JobRecordSchema.safeParse(JSON.parse(row.data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export class JobManager {
  readonly videoRoot: string;
  private logQueue: Promise<void> = Promise.resolve();
  // Read once per process: a command creates its jobs from the definitions it loaded at startup,
  // and the files are the same for every job of that batch.
  private sourceFingerprint: Promise<string> | null = null;

  constructor(videoRoot: string) {
    this.videoRoot = videoRoot;
  }

  private definitionSourceFingerprint(): Promise<string> {
    this.sourceFingerprint ??= computeDefinitionSourceFingerprint(this.videoRoot);
    return this.sourceFingerprint;
  }

  private get logsDir(): string {
    return path.join(this.videoRoot, KONTE_DIR, LOGS_DIR);
  }

  private get db(): Database {
    return openDatabase(jobsDbPath(this.videoRoot));
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.logsDir, { recursive: true });
    openDatabase(jobsDbPath(this.videoRoot));
  }

  // --- Job ---

  async createJob(opts: {
    address: string;
    variantId: string;
    resolvedDeps: Record<string, string>;
    backendKind: BackendKind;
    dependsOnAssets?: string[];
    dependsOnJobs?: string[];
    metadata?: Record<string, unknown>;
    compositionCacheKeys?: Record<string, string>;
  }): Promise<GenerationJob> {
    await this.ensureDirs();
    // A job waits as "pending" when it depends on anything not yet available —
    // either upstream asset variants or other jobs (e.g. model downloads). With no
    // deps it is immediately submittable ("queued").
    const hasPendingDeps =
      (opts.dependsOnAssets?.length ?? 0) > 0 || (opts.dependsOnJobs?.length ?? 0) > 0;
    const sourceFingerprint = await this.definitionSourceFingerprint();
    const now = new Date().toISOString();
    const job: GenerationJob = {
      kind: "generation",
      id: opts.variantId,
      address: opts.address,
      variantId: opts.variantId,
      status: hasPendingDeps ? "pending" : "queued",
      dependsOnAssets: opts.dependsOnAssets ?? [],
      dependsOnJobs: opts.dependsOnJobs ?? [],
      lease: null,
      sourceFingerprint,
      staleReleases: 0,
      backendKind: opts.backendKind,
      backendJobId: null,
      submissionStartedAt: null,
      progress: null,
      error: null,
      outputFiles: [],
      metadata: opts.metadata ?? {},
      provenance: {
        workflowHash: null,
        inputHash: null,
        resolvedDependencies: hasPendingDeps ? {} : opts.resolvedDeps,
        compositionCacheKeys: opts.compositionCacheKeys ?? {},
      },
      createdAt: now,
      startedAt: null,
      processingStartedAt: null,
      updatedAt: now,
      completedAt: null,
      unconfirmedSince: null,
    };
    this.transaction(() => {
      if (this.read(job.id) !== undefined) {
        throw new KonteError(
          "STATE_ALREADY_EXISTS",
          `Job for variant "${opts.variantId}" already exists`,
        );
      }
      this.write(job);
    });
    return job;
  }

  // Create an export job: a leaf render job (no asset/variant of its own) that produces
  // a delivered MP4. Always created "pending" so it is claimed (pending → running) before
  // a single worker runs it — `run-export-job` is the mutual-exclusion point, like model
  // downloads. dependsOnAssets are full addresses (incl. #delivery); dependsOnJobs are the
  // upscale jobs it waits on.
  async createExportJob(opts: {
    outputDir: string;
    allowUnaccepted: boolean;
    noDelivery?: boolean;
    dependsOnAssets?: string[];
    dependsOnJobs?: string[];
    planDigest?: string;
  }): Promise<ExportJob> {
    await this.ensureDirs();
    const id = `exp-${shortId()}`;
    const sourceFingerprint = await this.definitionSourceFingerprint();
    const now = new Date().toISOString();
    const job: ExportJob = {
      kind: "export",
      id,
      status: "pending",
      backendKind: "local",
      dependsOnAssets: opts.dependsOnAssets ?? [],
      dependsOnJobs: opts.dependsOnJobs ?? [],
      lease: null,
      sourceFingerprint,
      staleReleases: 0,
      outputDir: opts.outputDir,
      outputFile: null,
      allowUnaccepted: opts.allowUnaccepted,
      noDelivery: opts.noDelivery ?? false,
      // Stamped on completion by the worker, from the definition it actually renders — see
      // run-export-job.ts. Null until then (and `status` only ever inspects completed exports).
      exportSignature: null,
      planDigest: opts.planDigest ?? null,
      progress: null,
      error: null,
      metadata: {},
      createdAt: now,
      startedAt: null,
      processingStartedAt: null,
      updatedAt: now,
      completedAt: null,
      unconfirmedSince: null,
    };
    this.write(job);
    return job;
  }

  /**
   * Ensure the shared download job for a comfy model exists, returning its id.
   * Idempotent and safe under concurrency: the job id is derived from the install
   * target, so every caller converges on one job. A still-active job (pending/running) is
   * reused as-is; any TERMINAL one is reset to "pending" so the download runs again.
   *
   * Completed included, which is the part worth stating: this is only reached for an install
   * target the live presence check just reported MISSING (see ensureComfyModelJobs), so a
   * "completed" record is vouching for a file that is no longer on the server — deleted, or lost
   * with a rebuilt ComfyUI. Trusting it makes the model unrecoverable short of deleting the job
   * by hand, since no `clean`/`prune`/`cancel` path touches a standalone job.
   *
   * Reusing a job also refreshes its stored declaration: the id keys the install target only, so
   * an edited declaration — a corrected `url` above all — lands on this same job, and the
   * worker downloads from what the record says. Without the refresh a retry repeats the old URL.
   */
  async ensureComfyModelDownloadJob(
    model: ComfyModelDeclaration,
    opts?: { resetCompleted?: boolean },
  ): Promise<{ id: string; created: boolean; reset: boolean }> {
    await this.ensureDirs();
    const id = comfyModelJobId(model);
    return this.transaction(() => {
      const existing = this.read(id);
      if (existing) {
        const refresh =
          existing.kind === "comfy-model-download" &&
          stableStringify(existing.model) !== stableStringify(model)
            ? { model }
            : {};
        if (isStaleProvisioning(existing.status, opts?.resetCompleted)) {
          this.apply(existing, {
            ...refresh,
            status: "pending",
            error: null,
            completedAt: null,
            lease: null,
          });
          return { id, created: false, reset: true };
        }
        if ("model" in refresh) this.apply(existing, refresh);
        return { id, created: false, reset: false };
      }

      const now = new Date().toISOString();
      this.write({
        kind: "comfy-model-download",
        id,
        status: "pending",
        dependsOnJobs: [],
        lease: null,
        backendKind: "comfy",
        progress: null,
        error: null,
        metadata: {},
        model,
        createdAt: now,
        startedAt: null,
        processingStartedAt: null,
        updatedAt: now,
        completedAt: null,
        unconfirmedSince: null,
        sourceFingerprint: null,
        staleReleases: 0,
      });
      return { id, created: true, reset: false };
    });
  }

  /**
   * Ensure the shared install job for a custom node pack exists, returning its id.
   * Mirrors ensureComfyModelDownloadJob: idempotent, concurrency-safe (the cnr_id-derived id
   * converges every caller on one record), reuses an active job, resets any terminal one —
   * completed included, since the caller only reaches here for a pack the live check just reported
   * missing. No declaration refresh, unlike the model equivalent: the declaration is the cnr_id the
   * id is derived from, so a reused job already carries it. This installs the pack to disk only;
   * loading it (a ComfyUI reboot) is the activate job's job.
   */
  async ensureComfyNodeInstallJob(
    node: ComfyNodeDeclaration,
    opts?: { resetCompleted?: boolean },
  ): Promise<{ id: string; created: boolean; reset: boolean }> {
    await this.ensureDirs();
    const id = comfyNodeJobId(node);
    return this.transaction(() => {
      const existing = this.read(id);
      if (existing) {
        if (isStaleProvisioning(existing.status, opts?.resetCompleted)) {
          this.apply(existing, { status: "pending", error: null, completedAt: null, lease: null });
          return { id, created: false, reset: true };
        }
        return { id, created: false, reset: false };
      }

      const now = new Date().toISOString();
      this.write({
        kind: "comfy-node-install",
        id,
        status: "pending",
        dependsOnJobs: [],
        lease: null,
        backendKind: "comfy",
        progress: null,
        error: null,
        metadata: {},
        node,
        createdAt: now,
        startedAt: null,
        processingStartedAt: null,
        updatedAt: now,
        completedAt: null,
        unconfirmedSince: null,
        sourceFingerprint: null,
        staleReleases: 0,
      });
      return { id, created: true, reset: false };
    });
  }

  /**
   * Ensure the activate job for a set of node packs exists, returning its id.
   *
   * A coordination job that depends on the run's comfy-node-install jobs and, under a server-wide
   * reboot lease, reboots ComfyUI once (only when newly-installed packs are not yet loaded). comfy
   * generation jobs depend on it so nothing generates before the new nodes are live. Created
   * "pending" so it is claimed before a single worker runs it (the reboot is the mutual-exclusion
   * point, like exports).
   *
   * Idempotent and concurrency-safe like ensureComfyNodeInstallJob: the id is derived from what is
   * being activated, so every asset of a run converges on ONE job — and one reboot. An active or
   * completed job is reused as-is (a completed one means those packs are loaded, which a later
   * ComfyUI restart does not undo); a failed/cancelled one is reset to "pending" so the next run
   * retries the reboot instead of failing every dependent against a dead run's verdict.
   *
   * One case breaks that reuse: an install this activation depends on is back to "pending"
   * because its pack went missing again. The packs are then NOT loaded, and a completed activation
   * would let the generation jobs depending on it submit straight into a ComfyUI without their
   * node classes. That is decided HERE, from the dependencies' state read in this job's
   * transaction — not from a flag the caller sets when it happens to be the process that reset an
   * install. With two runs racing, only one sees that transition, and the other would reuse the
   * stale activation.
   */
  async ensureComfyNodeActivateJob(opts: {
    dependsOnJobs: string[];
    cnrIds: string[];
  }): Promise<{ id: string; created: boolean; reset: boolean }> {
    await this.ensureDirs();
    const id = comfyNodeActivateJobId(opts.cnrIds, opts.dependsOnJobs);
    return this.transaction(() => {
      const existing = this.read(id);
      if (existing) {
        const stale =
          existing.status === "failed" ||
          existing.status === "cancelled" ||
          (existing.status === "completed" && !this.allJobsCompleted(opts.dependsOnJobs));
        if (stale) {
          this.apply(existing, { status: "pending", error: null, completedAt: null, lease: null });
          return { id, created: false, reset: true };
        }
        return { id, created: false, reset: false };
      }

      const now = new Date().toISOString();
      const job: ComfyNodeActivateJob = {
        kind: "comfy-node-activate",
        id,
        status: "pending",
        backendKind: "comfy",
        dependsOnJobs: opts.dependsOnJobs,
        cnrIds: opts.cnrIds,
        lease: null,
        progress: null,
        error: null,
        metadata: {},
        createdAt: now,
        startedAt: null,
        processingStartedAt: null,
        updatedAt: now,
        completedAt: null,
        unconfirmedSince: null,
        sourceFingerprint: null,
        staleReleases: 0,
      };
      this.write(job);
      return { id, created: true, reset: false };
    });
  }

  // Whether every named job exists and has completed. A missing one counts as not completed: the
  // thing it was to provide cannot be vouched for by a record that is gone.
  private allJobsCompleted(jobIds: readonly string[]): boolean {
    return jobIds.every((jobId) => this.read(jobId)?.status === "completed");
  }

  async getJob(jobId: string): Promise<JobRecord> {
    return this.readOrThrow(jobId);
  }

  // Overwrite a whole record as given, validated. For a caller that owns the record outright (a
  // fixture, a repair) — the transition-aware path is updateJob.
  async putJob(record: JobRecordInput): Promise<void> {
    this.write(record);
  }

  async updateJob(jobId: string, update: JobUpdate): Promise<JobRecord> {
    return this.transaction(() => this.apply(this.readOrThrow(jobId), update));
  }

  // Remove a job record. Returns whether one existed.
  async deleteJob(jobId: string): Promise<boolean> {
    return this.deleteJobIf(jobId, () => true);
  }

  /**
   * Remove a job record only if `predicate` holds for it — a compare-and-delete in one write
   * transaction, for a caller acting on a listing it snapshotted earlier (`prune`, whose
   * confirmation prompt sits for as long as a human takes). The predicate reads the record as it
   * is now and, through `active`, every non-terminal record in the same transaction, so a reset or
   * a new dependent landing since the snapshot is seen. Only the active rows, so the write lock is
   * held for the few jobs in flight rather than the whole history. Returns false when the job is
   * gone or kept.
   */
  async deleteJobIf(
    jobId: string,
    predicate: (job: JobRecord, active: () => JobRecord[]) => boolean,
  ): Promise<boolean> {
    return this.transaction(() => {
      const job = this.read(jobId);
      if (job === undefined) return false;
      if (job !== null && !predicate(job, () => this.listSync({ active: true }))) return false;
      this.db.run("DELETE FROM jobs WHERE id = ?", [jobId]);
      return true;
    });
  }

  /**
   * Atomically claim a generation job for submission, taking a time-bounded lease so a
   * crashed submitter is recoverable. In one write transaction, re-reads the job and
   * claims it when submittable but not yet under way — "pending" (deps not yet resolved at
   * creation) or "queued" (the eager no-deps path's fresh job) — or when a previous submitter
   * died mid-transaction (isStrandedSubmit), transitioning it to "running" under a fresh lease.
   * Returns null if another submitter (a re-entrant cascade or a separate process) holds it —
   * no longer claimable, or "running" with a live lease the owner keeps renewing across its
   * slow submit.
   * The slow backend.submit() runs outside this transaction under that lease (heartbeat-renewed);
   * the lease — not the bare pending → running flip — is the mutual-exclusion guarantee,
   * and it lets a stranded job be reclaimed instead of stuck forever.
   */
  async claimForSubmission(
    jobId: string,
    workerId: string,
    leaseTtlMs: number,
  ): Promise<JobRecord | null> {
    return this.transaction(() => {
      const job = this.readOrThrow(jobId);
      if (job.status !== "pending" && job.status !== "queued" && !isStrandedSubmit(job)) {
        return null;
      }
      return this.apply(job, {
        status: "running",
        lease: { owner: workerId, expiresAt: new Date(Date.now() + leaseTtlMs).toISOString() },
      });
    });
  }

  /**
   * Atomically claim a locally-run job (e.g. an export render) for a worker, taking a
   * time-bounded lease. Claimable when "pending", or when "running" with an expired/absent
   * lease (its previous owner crashed). A live owner renews its lease (see renewLease), so
   * its job is never reclaimed — this is what makes recovery safe with multiple concurrent
   * watchers. Returns the updated record, or null if the job is owned by a live worker (or
   * already terminal).
   */
  async claimJobForRun(
    id: string,
    workerId: string,
    leaseTtlMs: number,
  ): Promise<JobRecord | null> {
    return this.transaction(() => {
      const job = this.readOrThrow(id);
      const now = Date.now();
      const leaseValid = job.lease != null && Date.parse(job.lease.expiresAt) > now;
      const claimable = job.status === "pending" || (job.status === "running" && !leaseValid);
      if (!claimable) return null;
      return this.apply(job, {
        status: "running",
        lease: { owner: workerId, expiresAt: new Date(now + leaseTtlMs).toISOString() },
      });
    });
  }

  async beginSubmission(id: string, workerId: string): Promise<void> {
    this.transaction(() => {
      const job = this.readOrThrow(id);
      if (job.kind !== "generation" || job.status !== "running" || job.lease?.owner !== workerId) {
        throw new KonteError("GENERATION_FAILED", `Submission lease lost for ${id}`);
      }
      if (job.submissionStartedAt && job.backendKind !== "local") {
        throw new KonteError(
          "SUBMISSION_UNCONFIRMED",
          `Submission of ${id} to ${job.backendKind} began at ${job.submissionStartedAt}, ` +
            `but no backend job id was saved. It may already be running or completed. ` +
            `Automatic resubmission stopped. Check the backend before rerolling ${job.address}.`,
        );
      }
      this.apply(job, { submissionStartedAt: new Date().toISOString() });
    });
  }

  /**
   * Extend the lease of a running job, but only if `workerId` still owns it. Returns false
   * when ownership was lost (another worker reclaimed it after this one stalled past the
   * lease) — the caller should then discard its result rather than clobber the new owner's.
   */
  async renewLease(id: string, workerId: string, leaseTtlMs: number): Promise<boolean> {
    return this.transaction(() => {
      const job = this.readOrThrow(id);
      if (job.status !== "running" || job.lease?.owner !== workerId) return false;
      this.apply(job, {
        lease: { owner: workerId, expiresAt: new Date(Date.now() + leaseTtlMs).toISOString() },
      });
      return true;
    });
  }

  /**
   * Apply a terminal update only if `workerId` still owns the job's lease. Guards against a
   * stalled-but-alive owner overwriting the result of the worker that reclaimed it.
   */
  async finishIfOwner(id: string, workerId: string, update: JobUpdate): Promise<boolean> {
    return this.transaction(() => {
      const job = this.readOrThrow(id);
      if (job.lease?.owner !== workerId) return false;
      // A concurrent `job cancel` moves the job to a terminal state without touching the lease,
      // so the owner can still pass the ownership check. Honor the existing terminal state rather
      // than clobbering it (e.g. rolling cancelled back to ready when a cancel lands just before
      // this commit).
      if (isJobTerminal(job.status)) return false;
      this.apply(job, update);
      return true;
    });
  }

  /**
   * Hand a claimed job back to the queue: pending again, lease dropped, one more stale release on
   * its record. For a judge that found its own loaded definitions older than the files on disk —
   * it must neither submit from them (a stale workflow would be spent) nor fail the job (the job
   * is right); a process reading fresh takes it next. Only the lease owner may release, and only
   * a job still mid-claim — a concurrent cancel or a reclaimer's commit is honored instead.
   */
  async releaseIfOwner(id: string, workerId: string): Promise<boolean> {
    return this.transaction(() => {
      const job = this.readOrThrow(id);
      if (job.lease?.owner !== workerId || job.status !== "running") return false;
      this.apply(job, {
        status: "pending",
        lease: null,
        startedAt: null,
        staleReleases: job.staleReleases + 1,
      });
      return true;
    });
  }

  /**
   * Apply a terminal update only if the job is not already terminal — a compare-and-set in one
   * write transaction, for the terminal writes that don't hold a lease (finishIfOwner is the
   * lease-holding equivalent). Returns the updated record, or null when the job was already
   * terminal (a concurrent owner or `job cancel` won the race), so the caller leaves the
   * existing terminal state intact rather than clobbering a real "completed" with "failed"/
   * "cancelled" and wiping its output from state.
   */
  async updateIfNotTerminal(id: string, update: JobUpdate): Promise<JobRecord | null> {
    return this.transaction(() => {
      const job = this.readOrThrow(id);
      if (isJobTerminal(job.status)) return null;
      return this.apply(job, update);
    });
  }

  /**
   * Apply an update only if the job is still in one of `expected` statuses — a compare-and-set
   * in one write transaction, for a caller acting on a job list it snapshotted earlier (e.g.
   * `clean`, which snapshots before its confirmation prompt). Returns null when the job has since
   * moved on, so the caller leaves it — and its files — alone rather than failing a job the
   * watcher has meanwhile submitted to a backend or completed.
   */
  async updateIfStatus(
    id: string,
    expected: JobRecord["status"][],
    update: JobUpdate,
  ): Promise<JobRecord | null> {
    return this.transaction(() => {
      const job = this.readOrThrow(id);
      if (!expected.includes(job.status)) return null;
      return this.apply(job, update);
    });
  }

  // Oldest first, ties broken by id. A row that no longer parses as a job record is skipped
  // rather than crashing every command built on the listing (status/clean/prune/job list).
  async listJobs(filter?: { status?: JobRecord["status"] }): Promise<JobRecord[]> {
    return this.listSync(filter);
  }

  private listSync(filter?: { status?: JobRecord["status"]; active?: boolean }): JobRecord[] {
    let rows: JobRow[];
    try {
      rows = filter?.status
        ? this.db
            .query<JobRow, [string]>("SELECT data FROM jobs WHERE status = ?")
            .all(filter.status)
        : filter?.active
          ? this.db
              .query<JobRow, []>(
                "SELECT data FROM jobs WHERE status NOT IN ('completed', 'failed', 'cancelled')",
              )
              .all()
          : this.db.query<JobRow, []>("SELECT data FROM jobs").all();
    } catch (err) {
      throw new KonteError("STATE_READ_FAILED", `Failed to read jobs: ${errorMessage(err)}`);
    }
    const jobs: JobRecord[] = [];
    for (const row of rows) {
      const job = parseRow(row);
      if (job) jobs.push(job);
    }
    return jobs.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  // --- Logs ---

  appendLog(jobId: string, line: string): void {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${line}\n`;
    this.logQueue = this.logQueue
      .then(() => fs.mkdir(this.logsDir, { recursive: true }))
      .then(() => {
        const logPath = this.logFilePath(jobId);
        return fs.appendFile(logPath, entry, "utf-8");
      })
      .catch(() => {});
  }

  // Resolves once every line appended so far is on disk — for a process about to exit.
  flushLogs(): Promise<void> {
    return this.logQueue;
  }

  async readLog(jobId: string): Promise<string> {
    const logPath = this.logFilePath(jobId);
    try {
      return await fs.readFile(logPath, "utf-8");
    } catch {
      throw new KonteError("LOG_NOT_FOUND", `Log for job "${jobId}" not found`);
    }
  }

  private logFilePath(id: string): string {
    assertSafeJobId(id);
    return path.join(this.logsDir, `${id}.log`);
  }

  // --- Storage ---

  // Read-modify-write core: the transition-aware merge every update goes through. Must run
  // inside `transaction` (or on a record just read in one) so the merge is against the current
  // row, never a stale snapshot.
  private apply(job: JobRecord, update: JobUpdate): JobRecord {
    const now = new Date().toISOString();
    // Stamp the first transition into "running" so elapsed time is computable; keep
    // the original stamp on later updates (progress, ready) and for non-running ones. Only a
    // release (releaseIfOwner) names the field itself, to clear it: the claim it undoes never ran.
    const startedAt =
      update.startedAt !== undefined
        ? update.startedAt
        : update.status === "running" && job.startedAt == null
          ? now
          : job.startedAt;
    // Set-once, like startedAt: the first observed processing start wins, so a lease reclaimer
    // (or a late-landing write) can never overwrite an earlier, truer start with a later stamp.
    const processingStartedAt =
      update.processingStartedAt != null && job.processingStartedAt == null
        ? update.processingStartedAt
        : job.processingStartedAt;
    // `update` only carries fields common to every kind (Omit over the union drops
    // kind-specific ones), so the spread preserves `job`'s discriminant and payload.
    // TS widens `kind` across the union on spread, so re-assert the variant.
    const updated = {
      ...job,
      ...update,
      startedAt,
      processingStartedAt,
      updatedAt: now,
    } as JobRecord;
    this.write(updated);
    return updated;
  }

  private read(jobId: string): JobRecord | null | undefined {
    assertSafeJobId(jobId);
    let row: JobRow | null;
    try {
      row = this.db.query<JobRow, [string]>("SELECT data FROM jobs WHERE id = ?").get(jobId);
    } catch (err) {
      throw new KonteError("STATE_READ_FAILED", `Failed to read job: ${errorMessage(err)}`);
    }
    if (!row) return undefined;
    return parseRow(row);
  }

  // Missing → JOB_NOT_FOUND; present but not a valid record → VALIDATION_FAILED.
  private readOrThrow(jobId: string): JobRecord {
    const job = this.read(jobId);
    if (job === undefined) throw new KonteError("JOB_NOT_FOUND", `Job "${jobId}" not found`);
    if (job === null) {
      throw new KonteError("VALIDATION_FAILED", `Job record for "${jobId}" is corrupt`);
    }
    return job;
  }

  // Every write validates: the schema is what keeps a crafted id or outputDir out of the paths
  // built from a record, and a row that fails it would otherwise sit invisible to listings.
  private write(record: JobRecordInput): void {
    const result = JobRecordSchema.safeParse(record);
    if (!result.success) {
      throw new KonteError("VALIDATION_FAILED", `Invalid job record: ${result.error.message}`);
    }
    const job = result.data;
    try {
      this.db.run(
        `INSERT INTO jobs (id, kind, status, address, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, status = excluded.status, address = excluded.address,
           created_at = excluded.created_at, data = excluded.data`,
        [
          job.id,
          job.kind,
          job.status,
          job.kind === "generation" ? job.address : null,
          job.createdAt,
          JSON.stringify(job),
        ],
      );
    } catch (err) {
      throw new KonteError("STATE_WRITE_FAILED", `Failed to write job: ${errorMessage(err)}`);
    }
  }

  // A write transaction taken up front (BEGIN IMMEDIATE), so a read-then-write inside it is a
  // compare-and-set against every other process on the file: a concurrent writer waits on
  // busy_timeout rather than racing the read. konte's own errors pass through; the engine's
  // (a lock never granted, a full disk) surface as a store failure.
  private transaction<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn).immediate();
    } catch (err) {
      if (err instanceof KonteError) throw err;
      throw new KonteError("STATE_WRITE_FAILED", `Jobs transaction failed: ${errorMessage(err)}`);
    }
  }
}
