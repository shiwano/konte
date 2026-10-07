import { hasSeedPlaceholder } from "../backends/prepare-inputs.js";
import { ComfyUIBackend } from "../comfyui/backend.js";
import { ADAPTER_KEY_METADATA_KEY, adapterKeyFor } from "./adapter-key.js";
import type { GenerationBackend, GenerationRequest } from "./backend.js";
import { type JobManager, recordedSubmissionAttempt } from "./job-manager.js";
import type { GenerationJob } from "./types/index.js";
import { KonteError } from "./errors.js";
import { applyTurboInputs } from "./turbo.js";
import { StateManager } from "./state/index.js";

// The single seam where a generation job is handed to its backend: submit, log, and
// build the run-time metadata every submitted job carries. The caller holds a submit lease
// across this call and commits the backendJobId with lease-guarded finishIfOwner, so a crash
// mid-submit is reclaimable.
export async function submitToBackend(
  jobManager: JobManager,
  backend: GenerationBackend,
  job: GenerationJob,
  request: GenerationRequest,
): Promise<{
  backendJobId: string;
  metadata: Record<string, unknown>;
  // The input files actually sent — the first attempt's on a resubmission. What the caller records
  // as the job's provenance.
  resolvedDependencies: Record<string, string>;
}> {
  if (!job.lease)
    throw new KonteError("GENERATION_FAILED", `Submission lease missing for ${job.id}`);
  // One seed per job, generated here and reused for every
  // `__konte:seed__` occurrence. Recorded before the backend is called with the input files, so a
  // resubmission sends the same ones; returned in `metadata`, which the caller commits to the job
  // record via finishIfOwner right after submit (still under the submit lease) — so a reclaimer
  // that only re-runs waitForCompletion still reads it back from the persisted job.
  const recorded = recordedSubmissionAttempt(job);
  const site = recorded
    ? recorded.site
    : ((await backend.chooseSubmissionSite?.(request, job)) ?? null);
  const sent = await jobManager.beginSubmission(job.id, job.lease.owner, {
    seed: Math.floor(Math.random() * 2 ** 32),
    resolvedDependencies: request.resolvedDependencies,
    site,
  });
  const { seed, resolvedDependencies } = sent;
  const turbo = await isTurboVariant(jobManager.videoRoot, job, request);
  const backendJobId = await backend.submit(
    {
      ...request,
      resolvedDependencies,
      submissionSite: sent.site,
      ...(turbo ? { assetDefinition: applyTurboInputs(request.assetDefinition) } : {}),
      onLog: (line) => jobManager.appendLog(job.variantId, line),
      shouldCancel: async () =>
        (await jobManager.getJob(job.id).catch(() => null))?.status === "cancelled",
    },
    job,
    seed,
  );

  if (turbo) {
    jobManager.appendLog(
      job.variantId,
      "Turbo take: the address's first, on the adapter's turbo inputs",
    );
  }

  jobManager.appendLog(
    job.variantId,
    `Submitted to ${job.backendKind} (backendJobId: ${backendJobId})`,
  );

  const metadata: Record<string, unknown> = {
    // The caller commits this object as the job's WHOLE metadata, so anything recorded at
    // creation that the waiter still needs has to be carried across here. `patchFinalize` is
    // that: a patch step's definition is declared by its script, so losing it leaves the waiter
    // with no definition to finalize by — and, on the returned step, with no patched variant to
    // register. Silently, and only for patches.
    ...(job.metadata?.patchFinalize !== undefined
      ? { patchFinalize: job.metadata.patchFinalize }
      : {}),
    [ADAPTER_KEY_METADATA_KEY]: adapterKeyFor(request.assetDefinition),
  };
  if (backend instanceof ComfyUIBackend) {
    metadata.comfyClientId = backend.httpClient.clientId;
  }
  const def = request.assetDefinition;
  if ("inputs" in def && hasSeedPlaceholder(def.inputs)) {
    metadata.seed = seed;
  }

  return { backendJobId, metadata, resolvedDependencies };
}

// Read off the variant, where reservation decided it.
async function isTurboVariant(
  videoRoot: string,
  job: GenerationJob,
  request: GenerationRequest,
): Promise<boolean> {
  const def = request.assetDefinition;
  if ((def.kind !== "comfy" && def.kind !== "fal") || !def.turboInputs) return false;
  const state = (await StateManager.load(videoRoot)).getState();
  return state.assets[job.address]?.variants?.[job.variantId]?.turbo === true;
}
