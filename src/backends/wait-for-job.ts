import * as crypto from "node:crypto";
import * as path from "node:path";
import { ComfyUIBackend } from "../comfyui/backend.js";
import { resolveComfyUIConfig } from "../comfyui/config.js";
import {
  type DefinitionLike,
  getAssetEntryByAddress,
  getStage,
  isCompositionAddress,
  isDeliveryAddress,
} from "../core/address.js";
import type { GenerationBackend, WaitOptions } from "../core/backend.js";
import { hashFile } from "../core/content-hash.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { formatDuration } from "../core/format-duration.js";
import { type JobManager, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import { normalizeKeyframesIfSparse } from "../core/keyframe-normalize.js";
import {
  type PatchFinalize,
  type PatchOutputOrigin,
  materializePatchOutput,
} from "../core/patch-output.js";
import { type LoadedDefinitions, selectDefinition } from "../core/select-definition.js";
import { StateManager } from "../core/state/index.js";
import { ensureVariantThumbnails, type ThumbnailInfo } from "../core/thumbnail.js";
import type { GenerationJob, JobKind, JobRecord } from "../core/types/index.js";
import { variantDir } from "../core/variant-dir.js";
import { probeMediaInfo } from "../core/video-probe.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";
import { getBackendKindFromJob, resolveBackend } from "./resolve-backend.js";
import type { VideoRoots } from "../core/roots.js";
import { sleep } from "../core/sleep.js";
import { pollUntilTerminal } from "../core/poll-until-terminal.js";

// waitForJob only ever waits on generation jobs (model downloads run through
// run-comfy-install-job). Narrow once so the body can read the generation fields.
function requireGenerationJob(job: JobRecord): GenerationJob {
  if (job.kind !== "generation") {
    throw new KonteError(
      "VALIDATION_FAILED",
      `waitForJob expects a generation job, got "${job.kind}"`,
    );
  }
  return job;
}

const WAIT_FOR_BACKEND_JOB_ID_MS = 5000;
const POLL_INTERVAL_MS = 250;
// How often a non-owner re-reads a job it's monitoring (owned by another worker).
const MONITOR_POLL_INTERVAL_MS = 1000;

export type WaitForJobResult = {
  variantId: string;
  kind: JobKind;
  address: string;
  status: string;
  outputFiles: string[];
  thumbnails: ThumbnailInfo[];
  error: string | null;
  alreadyTerminal: boolean;
  // True when the job is still inside its submit transaction (claimed "running"
  // but backendJobId not committed yet) and the id did not appear within the
  // wait window. Not a failure — callers should stop waiting for now and retry
  // later (a live submitter will commit the id; a dead one persists "failed").
  submitPending: boolean;
  // True when this waiter's own timeout elapsed before the job reached a terminal
  // state. NOT a failure — the backend job is still running and left re-observable;
  // the caller should report "still running, stopped waiting", not "failed".
  waitTimedOut?: boolean;
};

type WaitForJobHooks = {
  timeoutMs?: number;
  onProgress?: (p: {
    variantId: string;
    address: string;
    value: number;
    max: number;
    node: string | null;
  }) => void;
  onStateUpdateError?: (info: {
    variantId: string;
    address: string;
    phase: "completed" | "failed";
    error: string;
  }) => void;
  onThumbnailError?: (info: { variantId: string; address: string; error: string }) => void;
  // Fired when a job crosses into (unconfirmed=true) or out of (unconfirmed=false) a long
  // run of transient status-check failures. The job keeps polling and is never auto-failed;
  // this is purely to surface "status unconfirmed" to the human.
  onUnconfirmed?: (info: {
    variantId: string;
    address: string;
    unconfirmed: boolean;
    lastError: string | null;
  }) => void;
};

export async function waitForJob(
  jobManager: JobManager,
  variantId: string,
  roots: VideoRoots,
  definitions: LoadedDefinitions,
  hooks: WaitForJobHooks = {},
): Promise<WaitForJobResult> {
  let job = requireGenerationJob(await jobManager.getJob(variantId));

  if (isTerminalStatus(job.status)) return terminalResult(job, true);

  // A job can briefly be in a non-terminal state with no backendJobId yet: it has
  // been claimed for submission (status "running") but backend.submit() has not
  // returned. Poll for the id before giving up rather than failing instantly.
  if (!job.backendJobId) {
    const idDeadline = Date.now() + WAIT_FOR_BACKEND_JOB_ID_MS;
    while (!job.backendJobId && Date.now() < idDeadline) {
      await sleep(POLL_INTERVAL_MS);
      job = requireGenerationJob(await jobManager.getJob(variantId));
      if (isTerminalStatus(job.status)) return terminalResult(job, true);
    }

    if (!job.backendJobId) {
      // The submit transaction has not committed an id within the window. This is
      // in-flight, not a failure: a slow backend.submit() (e.g. ComfyUI image
      // uploads) can outlast the window. Report submitPending so the caller stops
      // waiting and retries; a genuine submit failure persists "failed", which the
      // poll loop above detects on the next attempt.
      return submitPendingResult(job);
    }
  }

  const workerId = `w-${crypto.randomBytes(8).toString("hex")}`;
  const deadline = hooks.timeoutMs ? Date.now() + hooks.timeoutMs : undefined;

  // Claim-or-monitor loop. The run lease makes exactly ONE process the OWNER that runs the
  // backend wait and commits the result; other waiters MONITOR the job record instead of
  // redundantly downloading/normalizing/committing. If the owner crashes (lease lapses), a
  // monitor reclaims and re-attaches via the persisted backendJobId.
  while (true) {
    if (deadline && Date.now() > deadline) return waitTimedOutResult(job);

    job = requireGenerationJob(await jobManager.getJob(variantId));
    if (isTerminalStatus(job.status)) return terminalResult(job, false);
    if (!job.backendJobId) return submitPendingResult(job);

    const claimed = await jobManager.claimJobForRun(variantId, workerId, RUN_LEASE_TTL_MS);
    if (!claimed) {
      const monitored = await monitorJob(jobManager, variantId, deadline);
      if (monitored.kind === "terminal") return terminalResult(monitored.job, false);
      if (monitored.kind === "timedOut") return waitTimedOutResult(monitored.job);
      continue; // owner's lease lapsed — loop and reclaim
    }
    job = requireGenerationJob(claimed);

    const stopHeartbeat = startLeaseHeartbeat(jobManager, variantId, workerId);
    try {
      const result = await runAsOwner(jobManager, variantId, job, workerId, roots, definitions, {
        ...hooks,
        timeoutMs: deadline ? Math.max(1, deadline - Date.now()) : undefined,
      });
      if (result) return result;
      // null = lost the lease mid-run; loop to monitor/return the reclaimer's result.
    } finally {
      stopHeartbeat();
    }
  }
}

// Ownership check for the commit path. A renewLease that THROWS (a transient fs error reading the
// job file) says nothing about the backend result, but inside the owner's try block it would land in
// the generic catch and commit "failed" over a job the backend actually completed. Treat an
// unanswerable check as "not the owner": the worker bails without a terminal commit, the lease
// lapses, and a reclaimer re-observes the backend job and commits the real outcome.
async function stillOwnsLease(
  jobManager: JobManager,
  variantId: string,
  workerId: string,
): Promise<boolean> {
  try {
    return await jobManager.renewLease(variantId, workerId, RUN_LEASE_TTL_MS);
  } catch {
    return false;
  }
}

// Runs the backend wait and commits the result as the lease OWNER. Returns the terminal
// WaitForJobResult (ready/failed/waitTimedOut), or null if this worker lost the lease before
// committing (a reclaimer took over) — the caller then monitors for the reclaimer's result.
async function runAsOwner(
  jobManager: JobManager,
  variantId: string,
  job: GenerationJob,
  workerId: string,
  roots: VideoRoots,
  definitions: LoadedDefinitions,
  hooks: WaitForJobHooks,
): Promise<WaitForJobResult | null> {
  const videoRoot = roots.video;
  const backendJobId = job.backendJobId;
  if (!backendJobId) return null;

  const backendKind = getBackendKindFromJob(job);

  let backend: GenerationBackend;
  if (backendKind === "comfy") {
    const comfyClientId = (job.metadata.comfyClientId as string) ?? undefined;
    const config = await resolveComfyUIConfig(roots.workspace);
    backend = new ComfyUIBackend({ ...config, clientId: comfyClientId }, roots);
  } else {
    backend = await resolveBackend(backendKind, roots);
  }

  // A `#delivery` asset is synthesized (not in the definition) and is konte's to accept. Its
  // definition is built from the resolved source's real dimensions, which we don't re-probe here, so
  // we skip the comfy output-node hint.
  const isDelivery = isDeliveryAddress(job.address);
  let patchOutput: PatchOutputOrigin | null = null;
  try {
    const patchFinalize = job.metadata.patchFinalize as PatchFinalize | undefined;
    if (patchFinalize) {
      // A patch step's address is declared by `patches/<id>.ts`, not by a stage, so the lookup
      // below would find nothing. Everything it needs was snapshotted at submit time (see
      // patchFinalizeOf), including whether this step is the one the patched take comes from.
      patchOutput = patchFinalize.output ?? null;
      if (backend instanceof ComfyUIBackend) {
        backend.setOutputNodeId(backendJobId, patchFinalize.outputNodeId);
      }
    } else if (!isDelivery) {
      // Routed through selectDefinition so every stage that owns addresses is covered by one
      // exhaustive mapping.
      const def: DefinitionLike = selectDefinition(getStage(job.address), definitions).def;
      const assetDef = getAssetEntryByAddress(def, job.address);
      if (backend instanceof ComfyUIBackend && assetDef.kind === "comfy") {
        backend.setOutputNodeId(backendJobId, assetDef.outputNodeId);
      }
    }
  } catch {
    // asset may have been removed from definition
  }

  // Persist live progress (as an integer percent) to the job record so `job list`
  // / `status` reflect it without a live waiter. Throttled to actual percent
  // changes with at most one write in flight — bounding writes to ~100 per job
  // instead of one per poll. Best-effort: a dropped/failed write self-heals on the
  // next change, and the terminal update commits the final 100.
  // Stamp the run-window start the first time the backend reports actual work — for comfy, via
  // onExecutionStarted, fired from whichever path observes execution begin (a WebSocket
  // executing event, or the polling fallback seeing the prompt in queue_running / running-history)
  // after any serial-queue wait. This is what duration stats measure from, so a comfy job's
  // per-job runtime isn't inflated by the jobs queued ahead of it. Comfy-only: cloud backends
  // (fal) are provider-parallel, so their submit-time startedAt is already the right
  // basis and they never call onExecutionStarted. The write is set-once in JobManager (a
  // reclaimer can't overwrite an earlier true start); the local flag just avoids re-issuing it,
  // and stampWrite is awaited before the terminal commit so stats never race a still-null stamp.
  const stampsProcessingStart = backendKind === "comfy";
  let processingStamped = job.processingStartedAt != null;
  let stampWrite: Promise<unknown> = Promise.resolve();
  const stampProcessingStart = (): void => {
    if (processingStamped || !stampsProcessingStart) return;
    processingStamped = true;
    stampWrite = jobManager
      .updateJob(variantId, { processingStartedAt: new Date().toISOString() })
      .catch(() => {});
  };

  let lastPersistedPct = job.progress;
  let persisting = false;
  let lastPersistWrite: Promise<unknown> = Promise.resolve();
  const persistProgress = (value: number, max: number): void => {
    if (max <= 0 || persisting) return;
    const pct = Math.min(100, Math.max(0, Math.round((value / max) * 100)));
    if (pct === lastPersistedPct) return;
    lastPersistedPct = pct;
    persisting = true;
    lastPersistWrite = jobManager
      .updateJob(variantId, { progress: pct })
      .catch(() => {})
      .finally(() => {
        persisting = false;
      });
  };

  const onUnconfirmedChange: NonNullable<WaitOptions["onUnconfirmedChange"]> = ({
    unconfirmed,
    lastError,
  }) => {
    jobManager
      .updateJob(variantId, {
        unconfirmedSince: unconfirmed ? new Date().toISOString() : null,
      })
      .catch(() => {});
    hooks.onUnconfirmed?.({ variantId, address: job.address, unconfirmed, lastError });
  };

  try {
    const outputDir = variantDir(videoRoot, job.address, job.variantId);

    // Every entry here is an ATTACH to an already-submitted backend job: the first waiter after
    // submit, or a reclaimer taking over from an owner that died. Naming the worker and the job's
    // age makes a second line read as a takeover — the backend's old "Waiting for prompt" repeated
    // the same words hours apart, which read like a stalled wait rather than a new owner.
    const submittedAt = job.startedAt ?? job.createdAt;
    jobManager.appendLog(
      variantId,
      `Attached to backend job ${backendJobId} (worker ${workerId}, submitted ${formatDuration(
        Date.now() - Date.parse(submittedAt),
      )} ago)`,
    );

    const deadline = hooks.timeoutMs ? Date.now() + hooks.timeoutMs : undefined;
    const observed = await pollUntilTerminal(
      async () => ({
        state: "done" as const,
        result: await backend.waitForCompletion(backendJobId, outputDir, {
          onExecutionStarted: () => stampProcessingStart(),
          onProgress: (progress) => {
            persistProgress(progress.value, progress.max);
            hooks.onProgress?.({
              variantId,
              address: job.address,
              value: progress.value,
              max: progress.max,
              node: progress.node ?? null,
            });
          },
          timeoutMs: deadline ? Math.max(1, deadline - Date.now()) : undefined,
          onLog: (line) => {
            jobManager.appendLog(variantId, line);
          },
          onUnconfirmedChange,
        }),
      }),
      {
        deadline,
        shouldCancel: async () => !(await stillOwnsLease(jobManager, variantId, workerId)),
        onLog: (line) => jobManager.appendLog(variantId, line),
        onUnconfirmedChange,
        label: `result ${backendJobId}`,
      },
    );
    if (observed.kind === "cancelled") return null;
    const waitOutcome = observed.kind === "done" ? observed.value : { kind: "timedOut" as const };

    // The waiter's deadline elapsed — NOT a job failure. The backend job is still running and
    // left re-observable; stop here and report "still running". This is a returned value, never
    // a thrown error, so it can never be caught-and-failed by the handler below.
    if (waitOutcome.kind === "timedOut") {
      await Promise.all([lastPersistWrite, stampWrite]);
      await jobManager.finishIfOwner(variantId, workerId, { lease: null });
      return waitTimedOutResult(job);
    }
    const result = waitOutcome.result;

    // Let any in-flight progress write settle before the terminal "completed" update,
    // so a late percent write can't land after it and leave a ready job at <100%.
    await Promise.all([lastPersistWrite, stampWrite]);

    // Confirm we still own the lease BEFORE the destructive work below. The backend wait can run
    // for many minutes; if this worker stalled and a reclaimer took over during it, an in-place
    // keyframe re-encode + hash + state write from both owners would race — a hash could be
    // computed from a half-rewritten file. stillOwnsLease is false when ownership was lost (and
    // refreshes it when retained). Lost it → bail; the caller monitors for the reclaimer's result.
    if (!(await stillOwnsLease(jobManager, variantId, workerId))) return null;

    // Backends write into the absolute variantDir and return absolute paths, but konte
    // stores every variant/thumbnail/export path project-relative — konte.state.json is
    // committed, so an absolute path breaks the project on a checkout at a different path.
    // Normalize here, the one point every backend's result flows through.
    const outputFiles = result.files.map((f) =>
      path.isAbsolute(f) ? path.relative(videoRoot, f) : f,
    );

    const outputFile = outputFiles[0] ?? null;

    // Re-encode in place before hashing so the variant konte stores is always
    // seek-safe — AI video models often emit sparse keyframes that break
    // HyperFrames' frame-by-frame capture/render with freezing and A/V desync.
    // Doing it here covers every backend and both the MCP watcher and `job wait`.
    if (outputFile) {
      try {
        const norm = await normalizeKeyframesIfSparse(path.resolve(videoRoot, outputFile));
        if (norm.normalized) {
          jobManager.appendLog(
            variantId,
            `Normalized sparse keyframes (max interval ${norm.maxIntervalSeconds?.toFixed(2)}s > 2s) for reliable seeking.`,
          );
        } else if (norm.skipReason && norm.maxIntervalSeconds !== undefined) {
          jobManager.appendLog(
            variantId,
            `Left sparse keyframes (max interval ${norm.maxIntervalSeconds.toFixed(2)}s) unchanged: ${norm.skipReason}.`,
          );
        }
      } catch (normErr) {
        const msg = errorMessage(normErr);
        jobManager.appendLog(variantId, `Keyframe normalization failed (kept original): ${msg}`);
      }

      // Re-verify ownership after the in-place re-encode (which can itself take a while) and
      // before hashing/committing: had this worker stalled through the normalization, a reclaimer
      // that took over could be rewriting the same file, and the hash would read half-written
      // bytes. Lost the lease → bail and let the caller monitor for the reclaimer's result.
      if (!(await stillOwnsLease(jobManager, variantId, workerId))) return null;
    }

    const outputHash = outputFile
      ? await hashFile(path.resolve(videoRoot, outputFile)).catch(() => null)
      : null;
    // The one probe of these bytes, where the file has just landed.
    const media = outputFile ? await probeMediaInfo(path.resolve(videoRoot, outputFile)) : null;
    const inputFingerprints: Record<string, string> = {};
    for (const [depPath, depFile] of Object.entries(job.provenance.resolvedDependencies)) {
      // A patch feeds its source variant in under its OWN address; fingerprinting that would make
      // the output permanently input-stale against its own address's accepted output. The patch's
      // upstream picture is its source's, so it is inherited below instead.
      if (depPath === job.address) continue;
      try {
        // A composition dependency (a frame delivery upscale's source) is identified by its
        // definition + upstream fingerprints (compositionCacheKey) — NOT the rendered mp4's
        // bytes, which vary per render. Use the key snapshotted at submit time (provenance), not
        // a recompute from live state: the composition may have moved during this (long) upscale,
        // which would record the new composition's key onto an upscale of the old one — making the
        // next export cache-hit a stale shot forever.
        if (isCompositionAddress(depPath)) {
          const key = job.provenance.compositionCacheKeys[depPath];
          if (key) inputFingerprints[depPath] = key;
          continue;
        }
        inputFingerprints[depPath] = await hashFile(path.resolve(videoRoot, depFile));
      } catch {
        // dependency file unreadable; skip — staleness treats missing as not determinable
      }
    }

    // Commit the dependency-resolving state (variant.file) BEFORE flipping the job to
    // "completed". evaluateJob keys off state.file, and a cascade triggered the instant the
    // job is observed ready would otherwise see "ready job, no file, no active job" and
    // permanently fail dependents. Ordering state-first makes "completed" imply the file
    // exists. Both state.json and the job file are written atomically (temp+rename).
    try {
      const owned = await StateManager.withLock(videoRoot, async (manager) => {
        if (!(await stillOwnsLease(jobManager, variantId, workerId))) return false;
        const variant = manager.tryGetAssetState(job.address)?.variants?.[job.variantId];
        if (variant) {
          variant.file = outputFile;
          variant.readyAt = outputFile ? new Date().toISOString() : null;
          variant.outputHash = outputHash;
          // Absent unless the measurement came back, and only alongside the hash it is keyed to. A
          // retry commits over the same variant, so a failure has to clear rather than leave an
          // earlier take's numbers describing the bytes now at `outputHash`.
          if (media && outputHash) variant.media = media;
          else delete variant.media;
          variant.inputFingerprints = inputFingerprints;
          variant.metadata = result.metadata;
          // Recorded in the job's metadata at submission (see submitToBackend), so a reclaiming
          // waiter reads it back from the persisted job; absent for a seedless definition.
          if (typeof job.metadata.seed === "number") variant.seed = job.metadata.seed;
          if (isDelivery && outputFile) {
            manager.setAccepted(job.address, job.variantId);
          }
          // The chain's returned step just landed, so the patched take exists: register it at the
          // source's address, in this same lock. Committing it separately would leave a window
          // where the correction is on disk but nothing at the corrected address points at it.
          //
          // A failure here is NOT this commit's failure: the source take can have been removed
          // (`patch remove`, `clean`) while the chain ran, and the step's own take is on disk
          // either way. Letting it throw would abandon that commit and leave the job unable to
          // settle, re-failing for every waiter that reclaims it.
          if (patchOutput && outputFile) {
            try {
              materializePatchOutput(manager, patchOutput, {
                address: job.address,
                variantId: job.variantId,
              });
            } catch (err) {
              jobManager.appendLog(
                variantId,
                `Patched variant not registered: ${errorMessage(err)}`,
              );
            }
          }
        }
        return true;
      });
      if (!owned) return null;
    } catch (stateErr) {
      const msg = errorMessage(stateErr);
      hooks.onStateUpdateError?.({
        variantId,
        address: job.address,
        phase: "completed",
        error: msg,
      });
      // The dependency-resolving state (variant.file) did NOT commit. Flipping the job to
      // "completed" now would break the "completed implies file in state" invariant and fail
      // every dependent with a misleading "ready job, no file" cascade. Bail WITHOUT a terminal
      // commit: the job stays "running", the lease lapses (heartbeat stops on return), and a
      // reclaimer re-observes the still-live backend job (via backendJobId) and retries the write.
      return null;
    }

    // Commit the terminal state ONLY if we still own the lease — a prior owner that was
    // reclaimed mid-run must not clobber the new owner's result. Lost it → bail; the caller
    // loops and monitors for the reclaimer's outcome.
    const committed = await jobManager.finishIfOwner(variantId, workerId, {
      status: "completed",
      progress: 100,
      outputFiles,
      completedAt: new Date().toISOString(),
      unconfirmedSince: null,
    });
    if (!committed) return null;

    let thumbnails: ThumbnailInfo[] = [];
    try {
      const relFile = outputFiles[0];
      if (relFile) {
        thumbnails = await ensureVariantThumbnails(
          videoRoot,
          job.address,
          job.variantId,
          outputHash,
          relFile,
        );
      }
    } catch (thumbErr) {
      const msg = errorMessage(thumbErr);
      jobManager.appendLog(variantId, `Thumbnail extraction failed: ${msg}`);
      hooks.onThumbnailError?.({ variantId, address: job.address, error: msg });
    }

    return {
      variantId: job.variantId,
      kind: job.kind,
      address: job.address,
      status: "completed",
      outputFiles,
      thumbnails,
      error: null,
      alreadyTerminal: false,
      submitPending: false,
    };
  } catch (err) {
    // A waiter timeout never reaches here — it is a returned value handled above, not a throw.
    // Only a genuine backend failure (or an externally cancelled/orphaned prompt) lands here.
    await Promise.all([lastPersistWrite, stampWrite]);
    const errorMsg = errorMessage(err);
    // A prompt that vanished after we saw it alive was cancelled/removed externally — not a
    // failure (cancelled). One lost to a ComfyUI crash/restart (COMFYUI_JOB_ORPHANED) never
    // resumes and IS a failure — it falls through to the "failed" default below.
    const terminalStatus =
      err instanceof KonteError && err.code === "COMFYUI_JOB_GONE" ? "cancelled" : "failed";

    // Same ownership guard as the ready path — don't let a reclaimed owner clobber.
    const committed = await jobManager.finishIfOwner(variantId, workerId, {
      status: terminalStatus,
      error: errorMsg,
      completedAt: new Date().toISOString(),
      unconfirmedSince: null,
    });
    if (!committed) return null;

    try {
      await StateManager.withLock(videoRoot, async (manager) => {
        const target = manager.ensureAssetState(job.address);
        const variant = target.variants?.[job.variantId];
        if (variant) {
          variant.metadata = { error: errorMsg };
        }
      });
    } catch (stateErr) {
      const stateMsg = errorMessage(stateErr);
      hooks.onStateUpdateError?.({
        variantId,
        address: job.address,
        phase: "failed",
        error: stateMsg,
      });
    }

    return {
      variantId: job.variantId,
      kind: job.kind,
      address: job.address,
      status: terminalStatus,
      outputFiles: [],
      thumbnails: [],
      error: errorMsg,
      alreadyTerminal: false,
      submitPending: false,
    };
  }
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function terminalResult(job: GenerationJob, alreadyTerminal: boolean): WaitForJobResult {
  return {
    variantId: job.variantId,
    kind: job.kind,
    address: job.address,
    status: job.status,
    outputFiles: job.outputFiles,
    thumbnails: [],
    error: job.error,
    alreadyTerminal,
    submitPending: false,
  };
}

function submitPendingResult(job: GenerationJob): WaitForJobResult {
  return {
    variantId: job.variantId,
    kind: job.kind,
    address: job.address,
    status: job.status,
    outputFiles: [],
    thumbnails: [],
    error: null,
    alreadyTerminal: false,
    submitPending: true,
  };
}

function waitTimedOutResult(job: GenerationJob): WaitForJobResult {
  return {
    variantId: job.variantId,
    kind: job.kind,
    address: job.address,
    status: job.status,
    outputFiles: [],
    thumbnails: [],
    error: null,
    alreadyTerminal: false,
    submitPending: false,
    waitTimedOut: true,
  };
}

// Watch a job another worker owns until it goes terminal, this waiter's deadline passes, or
// the owner's lease lapses (it crashed) — in which case the caller reclaims and takes over.
async function monitorJob(
  jobManager: JobManager,
  variantId: string,
  deadline: number | undefined,
): Promise<
  | { kind: "terminal"; job: GenerationJob }
  | { kind: "timedOut"; job: GenerationJob }
  | { kind: "stale" }
> {
  while (true) {
    const job = requireGenerationJob(await jobManager.getJob(variantId));
    if (isTerminalStatus(job.status)) return { kind: "terminal", job };
    if (deadline && Date.now() > deadline) return { kind: "timedOut", job };
    const leaseValid = job.lease != null && Date.parse(job.lease.expiresAt) > Date.now();
    if (job.status === "running" && !leaseValid) return { kind: "stale" };
    await sleep(MONITOR_POLL_INTERVAL_MS);
  }
}
