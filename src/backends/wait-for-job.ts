import { randomBytes } from "node:crypto";
import {
  type DefinitionLike,
  getAssetEntry,
  getStage,
  isDeliveryAddress,
} from "../core/address.js";
import type { WaitOptions } from "../core/backend.js";
import { KonteError, errorMessage } from "../core/errors.js";
import { redactPersisted } from "../core/redact.js";
import { formatDuration } from "../core/format-duration.js";
import { isJobTerminal, type JobManager, RUN_LEASE_TTL_MS } from "../core/job-manager.js";
import { startProgressWriter } from "./progress-writer.js";
import { finalizeTake } from "../core/finalize-take.js";
import type { PatchFinalize, PatchOutputOrigin } from "../core/patch-output.js";
import {
  type LoadedDefinitions,
  selectDefinition,
  songOfDefinitions,
  speechLangOf,
} from "../core/select-definition.js";
import { StateManager } from "../core/state/index.js";
import { ensureVariantThumbnails } from "../core/variant-thumbnails.js";
import { type ThumbnailInfo } from "../core/frame-extract.js";
import type { GenerationJob, JobKind, JobRecord } from "../core/types/index.js";
import { variantDir } from "../core/variant-dir.js";
import { spokenLinesAt } from "../core/prompt-check.js";
import { startLeaseHeartbeat } from "../core/lease-heartbeat.js";
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
  // The worker id this wait claims under; a live lease the same worker already holds (its own
  // submit's) is taken over rather than monitored out.
  workerId?: string;
  onStateUpdateError?: (info: {
    variantId: string;
    address: string;
    phase: "completed" | "failed";
    error: string;
  }) => void;
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

  if (isJobTerminal(job.status)) return terminalResult(job, true);

  // A job can briefly be in a non-terminal state with no backendJobId yet: it has
  // been claimed for submission (status "running") but backend.submit() has not
  // returned. Poll for the id before giving up rather than failing instantly.
  if (!job.backendJobId) {
    const idDeadline = Date.now() + WAIT_FOR_BACKEND_JOB_ID_MS;
    while (!job.backendJobId && Date.now() < idDeadline) {
      await sleep(POLL_INTERVAL_MS);
      job = requireGenerationJob(await jobManager.getJob(variantId));
      if (isJobTerminal(job.status)) return terminalResult(job, true);
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

  const workerId = hooks.workerId ?? `w-${randomBytes(8).toString("hex")}`;
  const deadline = hooks.timeoutMs ? Date.now() + hooks.timeoutMs : undefined;

  // Claim-or-monitor loop. The run lease makes exactly ONE process the OWNER that runs the
  // backend wait and commits the result; other waiters MONITOR the job record instead of
  // redundantly downloading/normalizing/committing. If the owner crashes (lease lapses), a
  // monitor reclaims and re-attaches via the persisted backendJobId.
  while (true) {
    if (deadline && Date.now() > deadline) return waitTimedOutResult(job);

    job = requireGenerationJob(await jobManager.getJob(variantId));
    if (isJobTerminal(job.status)) return terminalResult(job, false);
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
      const result = await runAsOwner(
        jobManager,
        variantId,
        job,
        workerId,
        roots,
        definitions,
        deadline,
        hooks,
      );
      if (result) return result;
      // null = lost the lease mid-run; loop to monitor/return the reclaimer's result.
    } finally {
      stopHeartbeat();
    }
    // Also null where the finalize's state write failed: this waiter still owns the job and would
    // re-claim it at once.
    await sleep(POLL_INTERVAL_MS);
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

// What the take's definition says about finishing it: the comfy output-node hint, the patched
// take a patch step lands, and whether the take owes a line (the song is heard off its vocal track
// instead).
function takeDefinitionOf(
  job: GenerationJob,
  definitions: LoadedDefinitions,
): { outputNodeId: string | undefined; patchOutput: PatchOutputOrigin | null; owesLine: boolean } {
  let outputNodeId: string | undefined;
  let patchOutput: PatchOutputOrigin | null = null;
  let owesLine = false;
  try {
    const patchFinalize = job.metadata.patchFinalize as PatchFinalize | undefined;
    if (patchFinalize) {
      // A patch step's address is declared by `patches/<id>.ts`, not by a stage, so the lookup
      // below would find nothing. Everything it needs was snapshotted at submit time (see
      // patchFinalizeOf), including whether this step is the one the patched take comes from.
      patchOutput = patchFinalize.output ?? null;
      // The step a patched take is made from owes the lines of the take it corrects.
      if (patchOutput) {
        const source = selectDefinition(getStage(patchOutput.sourceAddress), definitions).def;
        owesLine =
          patchOutput.sourceAddress !== songOfDefinitions(definitions) &&
          spokenLinesAt(source.prompts ?? [], patchOutput.sourceAddress).length > 0;
      }
      outputNodeId = patchFinalize.outputNodeId;
    } else if (!isDeliveryAddress(job.address)) {
      // A `#delivery` definition is built from the resolved source's real dimensions, which are
      // not re-probed here, so it gets no output-node hint. Routed through selectDefinition so
      // every stage that owns addresses is covered by one exhaustive mapping.
      const def: DefinitionLike = selectDefinition(getStage(job.address), definitions).def;
      const assetDef = getAssetEntry(def, job.address);
      owesLine =
        job.address !== songOfDefinitions(definitions) &&
        spokenLinesAt(def.prompts ?? [], job.address).length > 0;
      if (assetDef.kind === "comfy") outputNodeId = assetDef.outputNodeId;
    }
  } catch {
    // asset may have been removed from definition
  }
  return { outputNodeId, patchOutput, owesLine };
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
  deadline: number | undefined,
  hooks: WaitForJobHooks,
): Promise<WaitForJobResult | null> {
  const videoRoot = roots.video;
  const backendJobId = job.backendJobId;
  if (!backendJobId) return null;

  const backend = await resolveBackend(getBackendKindFromJob(job), roots, job);

  const { outputNodeId, patchOutput, owesLine } = takeDefinitionOf(job, definitions);

  // Stamp the run-window start the first time the backend reports actual work (onExecutionStarted),
  // after any serial-queue wait. This is what duration stats measure from, so a queued job's
  // per-job runtime isn't inflated by the jobs queued ahead of it; a backend that never reports it
  // keeps its submit-time startedAt as the basis. The write is set-once in JobManager (a
  // reclaimer can't overwrite an earlier true start); the local flag just avoids re-issuing it,
  // and stampWrite is awaited before the terminal commit so stats never race a still-null stamp.
  let processingStamped = job.processingStartedAt != null;
  let stampWrite: Promise<unknown> = Promise.resolve();
  const stampProcessingStart = (): void => {
    if (processingStamped) return;
    processingStamped = true;
    stampWrite = jobManager
      .updateJob(variantId, { processingStartedAt: new Date().toISOString() })
      .catch(() => {});
  };

  const progressWriter = startProgressWriter(jobManager, variantId, job.progress);

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

    const observed = await pollUntilTerminal(
      async () => ({
        state: "done" as const,
        result: await backend.waitForCompletion(backendJobId, outputDir, {
          outputNodeId,
          onExecutionStarted: () => stampProcessingStart(),
          onProgress: (progress) => progressWriter.write(progress.value, progress.max),
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
      await Promise.all([progressWriter.settle(), stampWrite]);
      await jobManager.finishIfOwner(variantId, workerId, { lease: null });
      return waitTimedOutResult(job);
    }

    // Let any in-flight progress write settle before the terminal "completed" update,
    // so a late percent write can't land after it and leave a ready job at <100%.
    await Promise.all([progressWriter.settle(), stampWrite]);

    const finalized = await finalizeTake({
      videoRoot,
      job,
      result: waitOutcome.result,
      owesLine,
      lang: speechLangOf(definitions),
      patchOutput,
      workerId,
      log: (line) => jobManager.appendLog(variantId, line),
      stillOwns: () => stillOwnsLease(jobManager, variantId, workerId),
    });
    // Lost the lease → bail; the caller monitors for the reclaimer's result.
    if (finalized.kind === "lost") return null;
    if (finalized.kind === "stateUncommitted") {
      hooks.onStateUpdateError?.({
        variantId,
        address: job.address,
        phase: "completed",
        error: finalized.error,
      });
      // The dependency-resolving state (variant.file) did NOT commit. Flipping the job to
      // "completed" now would break the "completed implies file in state" invariant and fail
      // every dependent with a misleading "ready job, no file" cascade. Bail WITHOUT a terminal
      // commit: the job stays "running", the lease lapses (heartbeat stops on return), and a
      // reclaimer re-observes the still-live backend job (via backendJobId) and retries the write.
      return null;
    }
    const { outputFiles, outputFile, outputHash } = finalized;

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
      thumbnails = await ensureVariantThumbnails(
        videoRoot,
        job.address,
        job.variantId,
        outputHash,
        outputFile,
      );
    } catch (thumbErr) {
      const msg = errorMessage(thumbErr);
      jobManager.appendLog(variantId, `Thumbnail extraction failed: ${msg}`);
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
    await Promise.all([progressWriter.settle(), stampWrite]);
    const errorMsg = redactPersisted(errorMessage(err));
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
      await StateManager.withLock(videoRoot, async (manager) =>
        manager.markVariantFailed(job.address, job.variantId, errorMsg),
      );
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
    if (isJobTerminal(job.status)) return { kind: "terminal", job };
    if (deadline && Date.now() > deadline) return { kind: "timedOut", job };
    const leaseValid = job.lease != null && Date.parse(job.lease.expiresAt) > Date.now();
    if (job.status === "running" && !leaseValid) return { kind: "stale" };
    await sleep(MONITOR_POLL_INTERVAL_MS);
  }
}
