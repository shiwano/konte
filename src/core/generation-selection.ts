import { acceptedVariant } from "./accepted-variant.js";
import { type AssetStage, type DefinitionLike, getAssetEntry, listAddresses } from "./address.js";
import { computeDefinitionHash } from "./definition-hash.js";
import { type DependencyGraph, listUnusedAddresses } from "./graph.js";
import { type LoadedDefinitions, selectDefinition } from "./select-definition.js";
import { computeVariantStaleness, isVariantStale } from "./staleness.js";
import { isJobTerminal } from "./job-manager.js";
import { StateManager } from "./state/index.js";
import type { GenerationJob, JobRecord, KonteState } from "./types/index.js";

export type SkipReason = "active" | "accepted" | "accepted-stale" | "ready";

/**
 * Why `generate` leaves this asset alone, or null when it must generate.
 *
 * generate fills holes; a rival to a take a human accepted is `reroll`'s job, and the accept
 * between them is the human's. Generating under a standing accept would spend on a variant
 * resolution never picks (the accepted one wins), so an accepted asset is skipped even when
 * stale. One whose upstream alone moved stands as "accepted"; one whose definition moved is
 * "accepted-stale", and its accept stands too. A deterministic take is the exception: there is nothing else to pick, so re-running the op IS the
 * correction — unless a take matching the current definition is already there.
 *
 * Everything else turns on readiness, both axes of it: pass the asset's current definition
 * hash so an edited definition ages its variant out here exactly as it does in `status`.
 * `inputRebuilt` — an upstream is generated in the same run — voids readiness: the ready take
 * goes input-stale the moment that job lands.
 */
export function assetSkipReason(
  manager: StateManager,
  liveJobs: ReadonlySet<string>,
  address: string,
  currentDefinitionHash: string,
  deterministic = false,
  inputRebuilt = false,
): SkipReason | null {
  if (inFlightVariantIds(manager.getState(), address, liveJobs).length > 0) return "active";
  const target = manager.tryGetAssetState(address);
  if (!target) return null;
  const state = manager.getState();
  const variants = Object.values(target.variants ?? {});
  // `currentDefinitionHash` answers this address's own axis; the cache answers its inputs', which
  // are judged against what each RESOLVES to. Skipping an asset resolution then finds nothing for is
  // a deadlock: the skip is what would have repaired it.
  const cache = manager.stalenessCache();

  const accepted = acceptedVariant(state, address)?.variant;
  if (accepted?.file) {
    const staleness = computeVariantStaleness(
      state,
      address,
      accepted,
      currentDefinitionHash,
      undefined,
      cache,
    );
    if (!staleness.inputStale && !staleness.definitionStale) return "accepted";
    // A patch output sits at the SOURCE address, whose own asset may be deterministic. Its refresh
    // is re-applying the correction (this run's own patch pass), so generating here would spend on a fresh original
    // and orphan the very take the patch names.
    if (accepted.derivedFrom != null || !deterministic) {
      return staleness.definitionStale ? "accepted-stale" : "accepted";
    }
  }

  // An address left holding only takes the reviewer decided against is generated afresh.
  const hasReady = variants.some(
    (v) =>
      v.file &&
      v.status !== "dismissed" &&
      !isVariantStale(state, address, v, currentDefinitionHash, undefined, cache),
  );
  return hasReady && !inputRebuilt ? "ready" : null;
}

// The generation jobs still making a take `state` holds fileless. A completed one counts only while
// the state on disk, read after `jobs` was listed, holds its file.
export async function liveGenerationVariantIds(
  videoRoot: string,
  jobs: readonly JobRecord[],
  state: KonteState,
): Promise<Set<string>> {
  const live = new Set<string>();
  const completed: GenerationJob[] = [];
  for (const job of jobs) {
    if (job.kind !== "generation") continue;
    if (!isJobTerminal(job.status)) live.add(job.id);
    else if (job.status === "completed") {
      const variant = state.assets[job.address]?.variants?.[job.variantId];
      if (variant && !variant.file) completed.push(job);
    }
  }
  if (completed.length > 0) {
    const fresh = (await StateManager.load(videoRoot)).getState();
    for (const job of completed) {
      if (fresh.assets[job.address]?.variants?.[job.variantId]?.file) live.add(job.id);
    }
  }
  return live;
}

// Whether `state` holds a fileless take with no terminal marker and no job: a registration still
// creating its jobs under the state lock, or one interrupted before it did.
export function holdsJoblessReservation(state: KonteState, jobs: readonly JobRecord[]): boolean {
  const jobIds = new Set(jobs.map((job) => job.id));
  return Object.values(state.assets).some((asset) =>
    Object.entries(asset.variants ?? {}).some(
      ([id, v]) => !v.file && !v.metadata?.error && !v.metadata?.cancelledAt && !jobIds.has(id),
    ),
  );
}

// Outside the state lock a registration between its save and its `createJob` reads as absent;
// `registerJobsBatch` judges again inside the lock.
export function inFlightVariantIds(
  state: KonteState,
  address: string,
  liveJobs: ReadonlySet<string>,
): string[] {
  return Object.entries(state.assets[address]?.variants ?? {})
    .filter(([id, v]) => !v.file && liveJobs.has(id))
    .map(([id]) => id);
}

// What a whole-stage `generate` would submit, before the spend gate leaves out what it holds.
export function selectGenerationAssets(opts: {
  definitions: LoadedDefinitions;
  stage: AssetStage;
  manager: StateManager;
  liveJobs: ReadonlySet<string>;
  graph: DependencyGraph;
}): {
  stageAddresses: Set<string>;
  skippedUnused: string[];
  spending: string[];
} {
  const { definitions, stage, manager, liveJobs, graph } = opts;
  const { video, animatic, reference } = definitions;
  const { def } = selectDefinition(stage, definitions);
  const stageAddresses = new Set(listAddresses(def, stage));
  const skippedUnused = listUnusedAddresses(video, animatic, graph, reference).filter((p) =>
    stageAddresses.has(p),
  );
  for (const p of skippedUnused) stageAddresses.delete(p);
  const spending = listSpendingAssets(def, stageAddresses, manager, liveJobs, graph);
  return { stageAddresses, skippedUnused, spending };
}

// The assets a run over `addresses` generates, in their given order.
export function listSpendingAssets(
  def: DefinitionLike,
  addresses: ReadonlySet<string>,
  manager: StateManager,
  liveJobs: ReadonlySet<string>,
  graph: DependencyGraph | null,
): string[] {
  const spending = new Set<string>();
  for (const address of graph?.topologicalOrder ?? addresses) {
    if (!addresses.has(address)) continue;
    const asset = getAssetEntry(def, address);
    if (asset.kind === "file") continue;
    const skip = assetSkipReason(
      manager,
      liveJobs,
      address,
      computeDefinitionHash(asset),
      asset.deterministic === true,
      (graph?.dependencies.get(address) ?? []).some((d) => spending.has(d)),
    );
    if (!skip) spending.add(address);
  }
  return [...addresses].filter((address) => spending.has(address));
}
