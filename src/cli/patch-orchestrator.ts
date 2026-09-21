import type { GenerationBackend } from "../core/backend.js";
import { assertSpendAllowed } from "../core/backend-policy.js";
import { computeDefinitionHash } from "../core/definition-hash.js";
import { KonteError } from "../core/errors.js";
import { extractRefs } from "../core/graph.js";
import type { JobManager } from "../core/job-manager.js";
import type { LoadedPatch } from "../core/patch.js";
import { activeGenerationJobs, patchAssetAddress, patchStepEntries } from "../core/patch.js";
import {
  type PatchFinalize,
  type PatchOutputOrigin,
  existingPatchOutput,
  materializePatchOutput,
  patchFinalizeOf,
} from "../core/patch-output.js";
import { resolveRefs } from "../core/ref-resolver.js";
import type { VideoRoots } from "../core/roots.js";
import { computeVariantStaleness, variantsNewestFirst } from "../core/staleness.js";
import { StateManager } from "../core/state/index.js";
import type {
  AssetDefinition,
  BackendKind,
  GenerationJob,
  JobRecord,
  KonteConfig,
  VariantState,
} from "../core/types/index.js";
import {
  type AssetResult,
  createPendingJobs,
  ensureComfyModelJobs,
  ensureComfyNodeJobs,
  resolveMissingComfyModels,
  resolveMissingComfyNodes,
  submitAssetJobs,
} from "./generate-orchestrator.js";

// A patch's steps exist outside any stage, so its spend items are built from the chain itself.
export function assertPatchSpendAllowed(patch: LoadedPatch, config: KonteConfig): void {
  assertSpendAllowed(
    Object.entries(patch.assets).map(([name, def]) => ({
      label: `${patch.filePath} → ${name}`,
      kind: def.kind,
    })),
    config,
  );
}

/**
 * Applies one patch: runs its chain with the source variant's file pinned in, and registers the
 * returned step's take as a new variant at the SOURCE's address pointing back at the take it
 * corrected (`derivedFrom`).
 *
 * The pin is the whole point. The patch's `source` placeholder is the source variant's own address,
 * so left to normal resolution it would pick whatever that address currently resolves to — an
 * accepted sibling, or a later reroll. Overriding that entry in `resolvedDeps` with the named
 * variant's file is what makes "fix the left hand in THIS take" mean the take the file is named
 * after, every time it is re-applied. Any step of the chain may be the one consuming it, so the pin
 * is carried by all of them.
 *
 * Every step, the returned one included, generates at its own `<stage>:patch.<variantId>.<name>`
 * address as an ordinary asset, and one already holding a current take is reused rather than
 * respent on. That the addresses do not depend on which step is returned is what lets a fix be
 * stacked by appending a step: the ones before it keep their takes.
 *
 * The patched variant is materialized from the returned step — here when that step's take is
 * already current, otherwise by the waiter when its job lands (`patchFinalize.output`).
 */
export async function applyPatch(
  patch: LoadedPatch,
  roots: VideoRoots,
  jobManager: JobManager,
  backendCache: Map<BackendKind, GenerationBackend>,
  config: KonteConfig,
): Promise<AssetResult> {
  const videoRoot = roots.video;
  // The job listing is taken BEFORE the state snapshot, and the order matters: a variant is
  // reserved (a state write) before its job file lands, so a state read at least as new as the
  // listing sees the variant behind every job the listing reported. Read the other way round, a
  // rival's job would be known while the variant it reserved was not yet in view — and this run
  // would launch a duplicate of the very step it was trying to join.
  const inFlight = activeGenerationJobs(await jobManager.listJobs());
  const manager = await StateManager.load(videoRoot);
  const state = manager.getState();

  const source = state.assets[patch.sourceAddress]?.variants?.[patch.sourceVariantId];
  if (!source) {
    throw new KonteError(
      "PATCH_SOURCE_MISSING",
      `Patch source variant "${patch.sourceVariantId}" is no longer in state (${patch.filePath})`,
    );
  }
  if (!source.file) {
    throw new KonteError(
      "PATCH_SOURCE_NOT_READY",
      `Patch source variant "${patch.sourceVariantId}" has no output file yet (${patch.filePath})`,
    );
  }

  const origin = {
    sourceAddress: patch.sourceAddress,
    sourceVariantId: patch.sourceVariantId,
    patchHash: patch.patchHash,
  };
  const pin: Record<string, string> = { [patch.sourceAddress]: patch.sourceVariantId };
  const pinnedFiles: Record<string, string> = { [patch.sourceAddress]: source.file };

  // Declaration order is dependency order: a step can only reference one whose handle already
  // exists, so a plain sequential walk never runs a step before what it consumes.
  const stepJobIds: string[] = [];
  // Addresses this run is rebuilding. A step consuming one must be rebuilt too: its recorded take
  // was built from the file that job replaces, and until the job lands the address still resolves
  // to that file — so the reuse check cannot tell the difference on its own.
  const rebuilding = new Set<string>();

  const steps = patchStepEntries(patch);
  for (const [name, assetDef] of steps) {
    const address = patchAssetAddress(patch, name);
    const isOutput = name === patch.outputName;
    // A step consuming something this run is rebuilding is new work whatever else is in flight: an
    // older job at this address was submitted against the take the rebuild replaces. The rule is
    // the reuse check's (below), applied to in-flight work too — without it, editing an early step
    // mid-flight would rebuild that step and then join the unedited later step's old job, leaving
    // the fresh upstream unused and the old chain to finalize.
    const consumesRebuild = extractRefs(assetDef).some((ref) => rebuilding.has(ref));
    // A step already being generated — by a concurrent `patch apply`, or by this patch's own
    // earlier run — is work in flight, not work to redo. It narrows the concurrent-apply race the
    // way the reservation's rival check does; it does not close it.
    const running = consumesRebuild
      ? null
      : runningStepVariant(manager, address, assetDef, inFlight, isOutput ? origin : null);
    if (running) {
      // Joining the returned step's job leaves this run nothing to do: that job carries the
      // finalize target, so the patched variant lands when it does.
      if (isOutput) {
        return { address, status: "submitted", jobs: [{ variantId: running, status: "running" }] };
      }
      pin[address] = running;
      stepJobIds.push(running);
      rebuilding.add(address);
      continue;
    }
    if (!consumesRebuild) {
      const current = currentPoolVariant(manager, address, assetDef, {
        address: patch.sourceAddress,
        variant: source,
      });
      // The returned step runs even when its take is current, because applying a patch again is how
      // an author asks for another attempt at the same correction — the roll IS the thing being
      // asked for. The one exception is a take whose patched variant never got registered: a crash
      // between the two, or a `clean` that took the variant and left the take. Re-deriving that
      // costs nothing, where re-rolling would spend for a correction already made.
      const finalizable =
        current && isOutput && !existingPatchOutput(state, origin, current.file) ? current : null;
      if (finalizable) {
        const outputId = await StateManager.withLock(videoRoot, async (m) =>
          materializePatchOutput(m, origin, { address, variantId: finalizable.variantId }),
        );
        return {
          address: patch.sourceAddress,
          status: "submitted",
          jobs: [{ variantId: outputId, status: "materialized" }],
        };
      }
      if (current && !isOutput) {
        pinnedFiles[address] = current.file;
        pin[address] = current.variantId;
        continue;
      }
    }
    const result = await launchStep({
      address,
      assetDef,
      roots,
      jobManager,
      backendCache,
      config,
      manager,
      pin,
      pinnedFiles,
      dependsOnJobs: stepJobIds,
      output: isOutput ? origin : null,
      consumesRebuild,
    });
    if (result.status === "failed" || isOutput) return result;
    // Pin the variant this run just reserved, not merely its job id. A later step submits from the
    // pending path, where deps resolve by the accepted-then-newest rule. Without the pin, editing an
    // early step would regenerate it and then feed an *old accepted* one to everything downstream.
    const reserved = result.jobs[0]?.variantId;
    if (reserved) pin[address] = reserved;
    stepJobIds.push(...result.jobs.map((j) => j.variantId));
    rebuilding.add(address);
  }

  // `patchStepEntries` always ends with the returned step, which returns above.
  throw new KonteError("PATCH_INVALID", `${patch.filePath} declared no output step`);
}

/**
 * The variant of an in-flight generation job already producing THIS definition of the step, if one
 * is running. The definition must match: a job queued before the step was edited is producing the
 * previous version, so joining it would feed the chain something the current script never asked
 * for. That one is left to finish on its own and a fresh job is queued alongside it.
 *
 * The returned step is held to more than its own definition. Its job carries the finalize origin,
 * so joining it hands this run's patched take to whatever chain that job belongs to — and
 * `patchHash` spans every step, so a job queued before ANY step was edited would finalize under the
 * previous script. Its origin must be the one this run would register.
 */
function runningStepVariant(
  manager: StateManager,
  address: string,
  assetDef: AssetDefinition,
  inFlight: ReadonlyMap<string, GenerationJob>,
  output: PatchOutputOrigin | null,
): string | null {
  const variants = manager.getState().assets[address]?.variants ?? {};
  const definitionHash = computeDefinitionHash(assetDef);
  for (const [variantId, variant] of Object.entries(variants)) {
    const job = inFlight.get(variantId);
    if (!job || variant.definitionHash !== definitionHash) continue;
    if (output && !finalizesAs(job, output)) continue;
    return variantId;
  }
  return null;
}

function finalizesAs(job: GenerationJob, output: PatchOutputOrigin): boolean {
  const finalize = job.metadata.patchFinalize as PatchFinalize | undefined;
  const origin = finalize?.output;
  return (
    origin?.sourceAddress === output.sourceAddress &&
    origin?.sourceVariantId === output.sourceVariantId &&
    origin?.patchHash === output.patchHash
  );
}

/**
 * The output a chain step already produced and that still reflects its definition, or null when it
 * has to be generated. Re-applying an edited patch must not respend on the steps it did not touch.
 *
 * The source's address is judged against the PINNED variant's own content, not against what that
 * address resolves to: the chain consumes that one take forever. Resolved the ordinary way, every
 * step would go input-stale the moment the patched take was accepted — the correction becomes what
 * the address resolves to — and re-applying would respend on all of them. Comparing against the
 * take itself still catches a source whose bytes changed under a stable variant id, which is what a
 * `file` asset's mirror does.
 */
function currentPoolVariant(
  manager: StateManager,
  address: string,
  assetDef: AssetDefinition,
  pinned: { address: string; variant: VariantState },
): { variantId: string; file: string } | null {
  const state = manager.getState();
  const variants = state.assets[address]?.variants ?? {};
  const definitionHash = computeDefinitionHash(assetDef);
  for (const [variantId, variant] of variantsNewestFirst(variants)) {
    if (!variant.file) continue;
    const { definitionStale, changedInputs } = computeVariantStaleness(
      state,
      address,
      variant,
      definitionHash,
      undefined,
      // Reuse is a spend decision — read its inputs as the apply that follows will.
      manager.stalenessCache(),
    );
    if (definitionStale) continue;
    if (changedInputs.some((c) => c.assetPath !== pinned.address)) continue;
    const recordedSource = variant.inputFingerprints?.[pinned.address];
    if (
      recordedSource !== undefined &&
      pinned.variant.outputHash != null &&
      recordedSource !== pinned.variant.outputHash
    ) {
      continue;
    }
    return { variantId, file: variant.file };
  }
  return null;
}

async function launchStep(opts: {
  address: string;
  assetDef: AssetDefinition;
  roots: VideoRoots;
  jobManager: JobManager;
  backendCache: Map<BackendKind, GenerationBackend>;
  config: KonteConfig;
  manager: StateManager;
  pin: Record<string, string>;
  pinnedFiles: Record<string, string>;
  dependsOnJobs: readonly string[];
  output: PatchOutputOrigin | null;
  consumesRebuild: boolean;
}): Promise<AssetResult> {
  const { address, assetDef, roots, jobManager, config, manager } = opts;
  const videoRoot = roots.video;

  // Everything the step references besides what is already pinned resolves normally — a character
  // sheet fed to the edit model is a real upstream, resolved to whatever take is currently
  // accepted.
  const refs = [...new Set(extractRefs(assetDef))];
  const unpinnedRefs = refs.filter((ref) => opts.pinnedFiles[ref] === undefined);

  // A comfy step needs its declared weights and node packs provisioned first, exactly as a comfy
  // asset does under `generate`. Without this the job submits against a ComfyUI that cannot run
  // the workflow. Skipped entirely for every other backend, so the common (fal) patch pays no
  // ComfyUI round-trip.
  const prereqJobIds: string[] = [...opts.dependsOnJobs];
  if (assetDef.kind === "comfy") {
    const missingModels = await resolveMissingComfyModels(
      roots,
      assetDef.models ?? [],
      config.comfyui?.autoInstallModels ?? true,
    );
    const missingNodes = await resolveMissingComfyNodes(
      roots,
      (assetDef.nodes ?? []).map((n) => n.id),
      config.comfyui?.autoInstallNodes ?? true,
    );
    prereqJobIds.push(
      ...(await ensureComfyModelJobs(assetDef, jobManager, missingModels)),
      ...(await ensureComfyNodeJobs(assetDef, jobManager, missingNodes)),
    );
  }

  const finalize = patchFinalizeOf(assetDef, opts.output ?? undefined);
  // The reservation re-runs the join question under the state lock, against a listing fresh enough
  // to catch a rival that reserved after this run's snapshot — so it must ask it the same way. An
  // in-flight variant this run declined to join is not a rival: it is producing something else, and
  // counting it would abort the apply instead of queueing the fresh job alongside.
  const rivals = opts.consumesRebuild
    ? new Set<string>()
    : rivalStepVariantIds(await jobManager.listJobs(), opts.output);

  if (prereqJobIds.length > 0) {
    // Deferred: the pin travels as `pinnedDeps` so the source variant is still the exact take when
    // the worker submits, however long the installs and earlier steps take.
    return createPendingJobs(
      address,
      assetDef,
      refs,
      1,
      videoRoot,
      jobManager,
      prereqJobIds,
      opts.pin,
      finalize,
      rivals,
    );
  }

  const resolvedDeps = { ...resolveRefs(unpinnedRefs, manager, {}), ...pinnedSubset(opts, refs) };
  return submitAssetJobs(
    address,
    assetDef,
    1,
    roots,
    jobManager,
    opts.backendCache,
    resolvedDeps,
    undefined,
    null,
    finalize,
    rivals,
  );
}

/** In-flight generation variants a fresh reservation must treat as the same work (see runningStepVariant). */
function rivalStepVariantIds(
  jobs: readonly JobRecord[],
  output: PatchOutputOrigin | null,
): Set<string> {
  const active = activeGenerationJobs(jobs);
  if (!output) return new Set(active.keys());
  const ids = new Set<string>();
  for (const [variantId, job] of active) {
    if (finalizesAs(job, output)) ids.add(variantId);
  }
  return ids;
}

function pinnedSubset(
  opts: { pinnedFiles: Record<string, string> },
  refs: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs) {
    const file = opts.pinnedFiles[ref];
    if (file !== undefined) out[ref] = file;
  }
  return out;
}
