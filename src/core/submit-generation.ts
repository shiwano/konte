import { hasSeedPlaceholder } from "../backends/prepare-inputs.js";
import { ComfyUIBackend } from "../comfyui/backend.js";
import { ADAPTER_KEY_METADATA_KEY, adapterKeyFor } from "./adapter-key.js";
import type { GenerationBackend, GenerationRequest } from "./backend.js";
import type { JobManager } from "./job-manager.js";
import type { GenerationJob } from "./types/index.js";
import { KonteError } from "./errors.js";
import { applyTurboInputs } from "./turbo.js";
import { StateManager } from "./state/index.js";

// The single seam where a generation job is handed to its backend: submit, log, and
// build the run-time metadata every submitted job carries. Both submit paths — the eager
// no-deps path in generate-orchestrator and the pending-worker path in pending-jobs —
// route through here so the recorded metadata can never drift between them. Both also hold
// a submit lease across this call and commit the backendJobId with lease-guarded
// finishIfOwner, so a crash mid-submit is reclaimable on either path.
export async function submitToBackend(
  jobManager: JobManager,
  backend: GenerationBackend,
  job: GenerationJob,
  request: GenerationRequest,
): Promise<{ backendJobId: string; metadata: Record<string, unknown> }> {
  if (!job.lease)
    throw new KonteError("GENERATION_FAILED", `Submission lease missing for ${job.id}`);
  await jobManager.beginSubmission(job.id, job.lease.owner);
  // One seed per job, generated here so both submit paths share it and reuse it for every
  // `__konte:seed__` occurrence. Returned in `metadata`, which the caller commits to the job
  // record via finishIfOwner right after submit (still under the submit lease) — so a reclaimer
  // that only re-runs waitForCompletion still reads it back from the persisted job.
  const seed = Math.floor(Math.random() * 2 ** 32);
  const turbo = await isTurboVariant(jobManager.videoRoot, job, request);
  const backendJobId = await backend.submit(
    {
      ...request,
      ...(turbo ? { assetDefinition: applyTurboInputs(request.assetDefinition) } : {}),
      onLog: (line) => jobManager.appendLog(job.variantId, line),
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
    // Both callers commit this object as the job's WHOLE metadata, so anything recorded at
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

  return { backendJobId, metadata };
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
