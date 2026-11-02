import { acceptedVariant } from "./accepted-variant.js";
import { type AssetStage, type DefinitionLike, getAssetEntry, listAddresses } from "./address.js";
import { computeDefinitionHash } from "./definition-hash.js";
import { type DependencyGraph, listUnusedAddresses } from "./graph.js";
import { type LoadedDefinitions, selectDefinition } from "./select-definition.js";
import { computeVariantStaleness, isVariantStale } from "./staleness.js";
import type { StateManager } from "./state/index.js";

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
  address: string,
  currentDefinitionHash: string,
  deterministic = false,
  inputRebuilt = false,
): SkipReason | null {
  if (getActiveVariantIds(manager, address).length > 0) return "active";
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

export function getActiveVariantIds(manager: StateManager, address: string): string[] {
  const target = manager.tryGetAssetState(address);
  if (!target) return [];
  const variantIds: string[] = [];
  for (const [variantId, v] of Object.entries(target.variants ?? {})) {
    // A variant with no file is only "active" (an in-flight job) when it has no
    // terminal marker. A failed job records metadata.error and a cancelled one
    // metadata.cancelledAt, both leaving no file; treating either as active would make
    // a re-run skip the asset forever with a false "active job(s) exist". Same terminal
    // set as status-sections/suggested-actions/clean.
    if (!v.file && !v.metadata?.error && !v.metadata?.cancelledAt) {
      variantIds.push(variantId);
    }
  }
  return variantIds;
}

// What a whole-stage `generate` would submit, before the spend gate leaves out what it holds.
export function selectGenerationAssets(opts: {
  definitions: LoadedDefinitions;
  stage: AssetStage;
  manager: StateManager;
  graph: DependencyGraph;
}): {
  stageAssetPaths: Set<string>;
  skippedUnused: string[];
  spending: string[];
} {
  const { definitions, stage, manager, graph } = opts;
  const { video, animatic, reference } = definitions;
  const { def } = selectDefinition(stage, definitions);
  const stageAssetPaths = new Set(listAddresses(def, stage));
  const skippedUnused = listUnusedAddresses(video, animatic, graph, reference).filter((p) =>
    stageAssetPaths.has(p),
  );
  for (const p of skippedUnused) stageAssetPaths.delete(p);
  const spending = listSpendingAssets(def, stageAssetPaths, manager, graph);
  return { stageAssetPaths, skippedUnused, spending };
}

// The assets a run over `assetPaths` generates, in their given order.
export function listSpendingAssets(
  def: DefinitionLike,
  assetPaths: ReadonlySet<string>,
  manager: StateManager,
  graph: DependencyGraph | null,
): string[] {
  const spending = new Set<string>();
  for (const address of graph?.topologicalOrder ?? assetPaths) {
    if (!assetPaths.has(address)) continue;
    const asset = getAssetEntry(def, address);
    if (asset.kind === "file") continue;
    const skip = assetSkipReason(
      manager,
      address,
      computeDefinitionHash(asset),
      asset.deterministic === true,
      (graph?.dependencies.get(address) ?? []).some((d) => spending.has(d)),
    );
    if (!skip) spending.add(address);
  }
  return [...assetPaths].filter((address) => spending.has(address));
}
