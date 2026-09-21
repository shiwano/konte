import * as crypto from "node:crypto";
import { type DefinitionLike, getAssetEntryByAddress, getStage } from "./address.js";
import { variantDir } from "./variant-dir.js";
import type { GenerationBackend } from "./backend.js";
import { submitToBackend } from "./submit-generation.js";
import { startLeaseHeartbeat } from "../backends/lease-heartbeat.js";
import { computeDefinitionHash } from "./definition-hash.js";
import { computeDefinitionSourceFingerprint } from "./definition-source.js";
import { KonteError, errorMessage } from "./errors.js";
import { JobIndex } from "./job-index.js";
import { isStrandedSubmit, type JobManager, RUN_LEASE_TTL_MS } from "./job-manager.js";
import { loadPatchStepDefinition } from "./patch.js";
import { resolveRefs } from "./ref-resolver.js";
import type { StalenessCache } from "./staleness.js";
import { type LoadedDefinitions, selectDefinition } from "./select-definition.js";
import { selectResolvedVariant } from "./staleness.js";
import { StateManager } from "./state/index.js";
import type {
  BackendKind,
  GenerationJob,
  KonteState,
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "./types/index.js";
import type { VideoRoots } from "./roots.js";

type ResolveBackendFn = (kind: BackendKind, roots: VideoRoots) => Promise<GenerationBackend>;

// The definitions a pass judges by, read AFTER the pass listed its jobs: every job in the listing
// was created before this read, so the definitions are never older than the job they judge. The
// reverse order — load, then list — judged a job created moments after the load (an agent's
// edit → reroll landing while a slow submit held the pass open) against definitions from before
// its edit, and failed it as "definition changed" when nothing had.
export type LoadDefinitionsFn = () => Promise<LoadedDefinitions>;

// A judge that released a job because its own definitions were stale, for the caller to report.
export interface StaleJudgeRelease {
  variantId: string;
  address: string;
  queuedHash: string;
  currentHash: string;
}

export interface SubmitReadyPendingJobsResult {
  submitted: string[];
  failed: string[];
  // Jobs handed back to the queue by this process because its loaded definitions proved older
  // than the files on disk. The process must not judge again from the same definitions — a
  // daemon restarts, a wait re-reads on its next pass.
  released: StaleJudgeRelease[];
}

// How a judge's own process presents itself in a diagnosis — the command and pid, so a stale
// process can be told apart from a stale definition when the message is read later.
function judgeIdentity(): string {
  const args = process.argv.slice(2).join(" ");
  return `konte${args ? ` ${args}` : ""}, pid ${process.pid}`;
}

export async function submitReadyPendingJobs(
  jobManager: JobManager,
  roots: VideoRoots,
  backendCache: Map<BackendKind, GenerationBackend>,
  resolveBackendFn: ResolveBackendFn,
  loadDefinitions: LoadDefinitionsFn,
): Promise<SubmitReadyPendingJobsResult> {
  const videoRoot = roots.video;
  const submitted: string[] = [];
  const failed: string[] = [];
  const released: StaleJudgeRelease[] = [];

  let changed = true;
  while (changed) {
    changed = false;

    const allJobs = await jobManager.listJobs();
    const jobIndex = new JobIndex(allJobs);
    // Only generation jobs are submitted here. comfy-model-download jobs are run
    // by the worker (run-comfy-install-job), not queued to a backend. Besides freshly
    // "pending" and "queued" jobs (the eager path claims a fresh "queued" job before
    // submitting, so one still sitting "queued" is an orphan whose submitter never got
    // that far), reclaim any whose submitter crashed mid-transaction (stranded "running"
    // with no backendJobId and a lapsed lease) — claimForSubmission flips them back to a
    // fresh-leased "running". beginSubmission refuses an uncertain external submission.
    const pendingJobs = allJobs.filter(
      (j): j is GenerationJob =>
        j.kind === "generation" &&
        (j.status === "pending" || j.status === "queued" || isStrandedSubmit(j)),
    );
    if (pendingJobs.length === 0) break;

    const { video, animatic, reference } = await loadDefinitions();
    const manager = await StateManager.load(videoRoot);

    for (const job of pendingJobs) {
      const evaluation = evaluateJob(job, manager, jobIndex);

      if (evaluation.action === "submit") {
        const workerId = `w-${crypto.randomBytes(8).toString("hex")}`;
        const claimed = await jobManager.claimForSubmission(
          job.variantId,
          workerId,
          RUN_LEASE_TTL_MS,
        );
        if (!claimed || claimed.kind !== "generation") {
          // Another submitter (a re-entrant cascade or a separate process) already
          // claimed this job; skip it to avoid double-submitting to the backend.
          continue;
        }
        const outcome = await trySubmitJob(
          claimed,
          workerId,
          manager,
          jobManager,
          roots,
          video,
          backendCache,
          resolveBackendFn,
          animatic,
          reference,
        );
        if (outcome === "submitted") {
          // A successful submit changes no other job's evaluation: the address already
          // counted as actively producing while pending, so no re-scan is needed for it.
          submitted.push(claimed.variantId);
        } else if (outcome === "failed") {
          // A failure can doom dependents (their upstream lost its producer), which the
          // next pass discovers against a fresh job listing.
          failed.push(claimed.variantId);
          changed = true;
        } else {
          // This process's definitions are older than the files: nothing it judges from them can
          // be trusted, so the pass ends here and the caller decides how to read fresh.
          released.push(outcome);
          return { submitted, failed, released };
        }
      } else if (evaluation.action === "fail") {
        // Compare-and-set: never overwrite a job a concurrent worker already completed — that
        // would drop its output from state. A no-op here means it went terminal on its own.
        const committed = await jobManager.updateIfNotTerminal(job.variantId, {
          status: "failed",
          error: evaluation.reason,
          completedAt: new Date().toISOString(),
        });

        if (committed) {
          try {
            await StateManager.withLock(videoRoot, async (mgr) => {
              const variant = mgr.getState().assets[job.address]?.variants?.[job.variantId];
              if (variant) {
                variant.metadata = { error: evaluation.reason };
              }
            });
          } catch {
            // best-effort
          }

          failed.push(job.variantId);
        }
        changed = true;
      }
    }
  }

  return { submitted, failed, released };
}

/**
 * Whether an upstream address holds material a dependent may be spent on — the same question
 * `resolveRefs` asks when the job is actually submitted, so a job is never let through to a
 * submission that would then abort on an unresolvable dependency.
 *
 * Stale is excluded: a stale take is what the next `generate` replaces, so submitting on it pays a
 * backend for a take that a rebuilt upstream immediately ages out. Within one stage nothing
 * else holds that line — the acceptance gate only guards the cross-stage edges — so a dependent
 * waits here, pending and unbilled, until its upstream is rebuilt.
 */
export function assetResolves(state: KonteState, address: string, cache?: StalenessCache): boolean {
  const selected = selectResolvedVariant(state, address, { includeStale: false }, cache);
  return selected !== null && state.assets[address]?.variants?.[selected.variantId]?.file != null;
}

// A job's pinned upstream dependencies (asset-path → variant-id), set by
// `reroll --with-dependents` so a cascaded dependent consumes the specific freshly
// rerolled upstream variant rather than whatever newest-ready/accepted resolution
// would pick. Absent for ordinary jobs.
function readPinnedDeps(job: GenerationJob): Record<string, string> {
  const pinned = job.metadata.pinnedDeps;
  return pinned && typeof pinned === "object" ? (pinned as Record<string, string>) : {};
}

/**
 * The files this job's dependencies resolve to: each pinned one taken straight from its named
 * variant, every other one by the ordinary newest-ready/accepted rule.
 *
 * A pinned dep bypasses resolution entirely rather than overriding its result. Resolution can
 * legitimately come up empty for an address a pin names — a patch chain's earlier step goes
 * input-stale the moment a later take lands at the source address it was built from, and a stale
 * unaccepted variant resolves to nothing — and resolving it anyway would fail the submit before the
 * pin it does not need could be applied.
 *
 * The job only submits once its upstream cascade jobs are completed (dependsOnJobs gating), so the
 * pinned variant always has a file by now; a missing one means state was clobbered, so fail loudly
 * rather than silently falling back to the wrong upstream.
 */
export function resolveJobDeps(job: GenerationJob, manager: StateManager): Record<string, string> {
  const pinned = readPinnedDeps(job);
  const resolved = resolveRefs(
    job.dependsOnAssets.filter((depPath) => pinned[depPath] === undefined),
    manager,
  );
  const state = manager.getState();
  for (const [depPath, variantId] of Object.entries(pinned)) {
    // A dep path is the upstream address directly (address ≡ asset path).
    const file = state.assets[depPath]?.variants?.[variantId]?.file;
    if (!file) {
      throw new KonteError(
        "DEPENDENCY_NOT_RESOLVED",
        `Pinned dependency "${depPath}" (variant ${variantId}) for ${job.address} has no file`,
      );
    }
    resolved[depPath] = file;
  }
  return resolved;
}

export type PendingReason = { submittable: true } | { submittable: false; waitingOn: string[] };

// Derives, for a still-pending generation job, whether its dependencies are all
// satisfied (so it is merely awaiting a cascade pass) or what it is still waiting
// on. Shares its satisfaction predicates with evaluateJob() so the two never drift.
// A failed/missing dependency would have already moved the job out of "pending",
// so here a not-ready dependency is always a genuine wait.
export function describePendingJob(
  job: GenerationJob,
  state: KonteState,
  jobs: JobIndex,
  cache?: StalenessCache,
): PendingReason {
  const waitingOn: string[] = [];
  const pinned = readPinnedDeps(job);

  // A dep asset path IS its upstream address (address ≡ asset path). A job producing the
  // upstream counts as a wait even when a stale variant already has a file (see evaluateJob).
  // A pinned dep waits on its own producer instead, reported by the dependsOnJobs pass below.
  for (const depAddress of job.dependsOnAssets) {
    if (pinned[depAddress] !== undefined) continue;
    if (jobs.hasActiveJobFor(depAddress) || !assetResolves(state, depAddress, cache))
      waitingOn.push(depAddress);
  }

  let pendingModels = 0;
  let pendingNodes = 0;
  for (const depJobId of job.dependsOnJobs) {
    const depJob = jobs.get(depJobId);
    if (depJob?.status === "completed") continue;
    if (depJob?.kind === "comfy-model-download") pendingModels++;
    else if (depJob?.kind === "comfy-node-activate" || depJob?.kind === "comfy-node-install")
      pendingNodes++;
    else waitingOn.push(depJobId);
  }
  if (pendingModels > 0) waitingOn.push(`${pendingModels} model${pendingModels === 1 ? "" : "s"}`);
  if (pendingNodes > 0) waitingOn.push("custom nodes");

  if (waitingOn.length === 0) return { submittable: true };
  return { submittable: false, waitingOn };
}

type JobEvaluation = { action: "submit" | "wait" } | { action: "fail"; reason: string };

// How to tell the user to re-run this job's stage.
function rerunHint(address: string): string {
  return `re-run "konte generate ${getStage(address)}"`;
}

function evaluateJob(job: GenerationJob, manager: StateManager, jobs: JobIndex): JobEvaluation {
  const state = manager.getState();
  const cache = manager.stalenessCache();
  const rerun = rerunHint(job.address);

  // Every job this one depends on (e.g. a comfy-model-download) must be "completed"
  // before it can submit. A failed/cancelled/missing dependency dooms the job.
  for (const depJobId of job.dependsOnJobs) {
    const depJob = jobs.get(depJobId);
    if (!depJob) {
      return {
        action: "fail",
        reason: `Prerequisite job ${depJobId} is gone (it was likely cleaned). To recreate it, ${rerun}.`,
      };
    }
    if (depJob.status === "completed") continue;
    if (depJob.status === "failed" || depJob.status === "cancelled") {
      const what =
        depJob.kind === "comfy-model-download"
          ? `model download "${depJob.model.filename}"`
          : depJob.kind === "comfy-node-install"
            ? `node install "${depJob.node.id}"`
            : depJob.kind === "comfy-node-activate"
              ? `custom node activation`
              : `job ${depJobId}`;
      const detail = depJob.error ? `: ${depJob.error.replace(/\.$/, "")}` : "";
      return {
        action: "fail",
        reason: `Prerequisite ${what} ${depJob.status}${detail}, so this job cannot run. Fix the cause, then ${rerun}.`,
      };
    }
    return { action: "wait" };
  }

  // A dep asset path IS its upstream address (address ≡ asset path).
  const pinned = readPinnedDeps(job);
  for (const depAddress of job.dependsOnAssets) {
    // A pin names the variant outright, so what else is running at that address is not this job's
    // business — a rival apply's step, or a reroll of the source a patch chain is correcting, would
    // otherwise hold it back for an output it will never read. The pin's own producer is gated
    // above, in dependsOnJobs.
    const pinnedVariant = pinned[depAddress];
    if (pinnedVariant !== undefined) {
      if (state.assets[depAddress]?.variants?.[pinnedVariant]?.file) continue;
      return {
        action: "fail",
        reason: `Pinned dependency ${depAddress} (variant ${pinnedVariant}) has no output file — it failed or was cleaned. To rebuild it, ${rerun}.`,
      };
    }
    // A job producing this upstream takes precedence over an existing file: wait for the
    // fresh output even when a stale variant already has one (see JobIndex.hasActiveJobFor).
    if (jobs.hasActiveJobFor(depAddress)) return { action: "wait" };
    if (assetResolves(state, depAddress, cache)) continue;
    return {
      action: "fail",
      reason: `Dependency ${depAddress} has no ready variant and no active job — it failed or was never generated. Generate it first, then ${rerun}.`,
    };
  }

  return { action: "submit" };
}

async function trySubmitJob(
  job: GenerationJob,
  workerId: string,
  manager: StateManager,
  jobManager: JobManager,
  roots: VideoRoots,
  video: VideoDefinition,
  backendCache: Map<BackendKind, GenerationBackend>,
  resolveBackendFn: ResolveBackendFn,
  animatic: AnimaticDefinition,
  reference: ReferenceDefinition,
): Promise<"submitted" | "failed" | StaleJudgeRelease> {
  const videoRoot = roots.video;
  // Hold the submit lease across the slow backend.submit() so a crashed submitter is
  // reclaimable but a live one is never double-submitted (see claimForSubmission).
  const stopHeartbeat = startLeaseHeartbeat(jobManager, job.variantId, workerId);
  try {
    const resolvedDeps = resolveJobDeps(job, manager);

    // A patch job's definition is declared by `patches/<sourceVariantId>.ts`, not by any stage
    // definition: a step's address has no stage entry at all. Falls through to the ordinary lookup
    // for every non-patch job.
    const patchDef = await loadPatchStepDefinition(videoRoot, manager.getState(), job.address);
    const assetDef =
      patchDef ??
      getAssetEntryByAddress(
        getDefinitionForStage(video, animatic, job.address, reference) as DefinitionLike,
        job.address,
      );

    const savedHash = job.metadata.definitionHash as string | undefined;
    if (savedHash) {
      const currentHash = computeDefinitionHash(assetDef);
      if (savedHash !== currentHash) {
        const rerun = rerunHint(job.address);
        const hashes = `(definition hash: queued ${savedHash}, current ${currentHash})`;
        // The job's hash came from the files it records; if those files are still what is on
        // disk, this process — not the definition — is what changed. It hands the job back
        // rather than failing it or spending on a workflow built from what it holds.
        const sourceUnchanged =
          job.sourceFingerprint != null &&
          job.sourceFingerprint === (await computeDefinitionSourceFingerprint(videoRoot));
        if (sourceUnchanged && job.staleReleases === 0) {
          if (await jobManager.releaseIfOwner(job.variantId, workerId)) {
            jobManager.appendLog(
              job.variantId,
              `Released without submitting: this process (${judgeIdentity()}) computed a ` +
                `different definition hash for ${job.address} although no definition file changed ` +
                `since the job was queued — its loaded definitions are stale. A fresh process ` +
                `submits it. ${hashes}`,
            );
            return {
              variantId: job.variantId,
              address: job.address,
              queuedHash: savedHash,
              currentHash,
            };
          }
        }
        throw new Error(
          sourceUnchanged
            ? `Definition for ${job.address} disagrees with this job in two processes, although ` +
                `no definition file under the video or the workspace adapters changed since it ` +
                `was queued — a module imported from outside them changed, or both processes ` +
                `(the last: ${judgeIdentity()}) hold stale definitions. No generation ran. ` +
                `To queue a fresh job against the current definition, ${rerun}. ${hashes}`
            : `Definition for ${job.address} changed after this job was queued, so it was not ` +
                `submitted to the backend — no generation ran. The current definition no longer ` +
                `matches the one captured when the job was created. ` +
                `To queue a fresh job against the current definition, ${rerun}. ${hashes}`,
        );
      }
    }

    let backend = backendCache.get(job.backendKind);
    if (!backend) {
      backend = await resolveBackendFn(job.backendKind, roots);
      backendCache.set(job.backendKind, backend);
    }

    const outputDir = variantDir(videoRoot, job.address, job.variantId);
    const request = {
      address: job.address,
      assetDefinition: assetDef,
      variantId: job.variantId,
      outputDir,
      resolvedDependencies: resolvedDeps,
    };

    const { backendJobId, metadata } = await submitToBackend(jobManager, backend, job, request);

    // Commit the backendJobId and release the submit lease, handing off to the wait/run
    // phase — but only if we still own the lease. If a slow submit outran the lease and a
    // reclaimer took over, finishIfOwner returns false: don't clobber its work (this leaves
    // our backend job orphaned, the rare cost of a submit that outlived RUN_LEASE_TTL_MS).
    const committed = await jobManager.finishIfOwner(job.variantId, workerId, {
      status: "running",
      backendJobId,
      lease: null,
      metadata,
      provenance: {
        ...job.provenance,
        resolvedDependencies: resolvedDeps,
      },
    });
    if (!committed) {
      jobManager.appendLog(
        job.variantId,
        `Submit lease lost before committing backendJobId ${backendJobId}; reclaimed by another worker`,
      );
      return "failed";
    }

    return "submitted";
  } catch (err) {
    const errorMsg = errorMessage(err);
    // Only record the failure if we still own the lease, so a reclaimer's in-flight
    // submit isn't overwritten with our error.
    const committed = await jobManager.finishIfOwner(job.variantId, workerId, {
      status: "failed",
      error: errorMsg,
      lease: null,
      completedAt: new Date().toISOString(),
    });

    if (committed) {
      try {
        await StateManager.withLock(videoRoot, async (mgr) => {
          const variant = mgr.getState().assets[job.address]?.variants?.[job.variantId];
          if (variant) {
            variant.metadata = { error: errorMsg };
          }
        });
      } catch {
        // best-effort
      }
    }

    return "failed";
  } finally {
    stopHeartbeat();
  }
}

function getDefinitionForStage(
  video: VideoDefinition,
  animatic: AnimaticDefinition,
  address: string,
  reference: ReferenceDefinition,
): DefinitionLike {
  return selectDefinition(getStage(address), { video, animatic, reference }).def;
}
