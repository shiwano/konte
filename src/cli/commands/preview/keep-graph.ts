import {
  type AssetStage,
  type DefinitionLike,
  formatPlateAssetPath,
  formatShotAddress,
  formatTimelineAssetPath,
  getAssetEntry,
  isMaterializedLeafAddress,
  listExposedReferenceAssetPaths,
  tryParseAddress,
} from "../../../core/address.js";
import { getBackendKind } from "../../../backends/resolve-backend.js";
import type { DependencyGraph } from "../../../core/graph.js";
import type { StateManager } from "../../../core/state/index.js";
import { isPendingShot, type StageDefinition } from "../../../core/types/index.js";
import { isReviewLeaf } from "../../../core/variant-lineage.js";
import type { KeepGraphInfo, KeepTakeInfo } from "../../../pages/preview/types.js";

/**
 * What the Keep-or-regenerate prompt reads: every take an accept on a review page can change, and
 * every accepted take made from one. `stages` is the page's own stage and every stage downstream of
 * it; a stage whose definition did not load contributes nothing.
 */
export function buildKeepGraph(opts: {
  manager: StateManager;
  graph: DependencyGraph;
  stages: ReadonlyArray<{ stage: AssetStage; definition: DefinitionLike | null }>;
}): KeepGraphInfo {
  const { manager, graph } = opts;
  const state = manager.getState();
  const definitionByStage = new Map(opts.stages.map((s) => [s.stage, s.definition]));

  const units: KeepGraphInfo["units"] = {};
  const reference = definitionByStage.get("reference");
  if (reference) {
    for (const address of listExposedReferenceAssetPaths(reference)) {
      units[address] = { stage: "reference", label: address.slice("reference:".length) };
    }
  }
  for (const stage of ["animatic", "video"] as const) {
    const definition = definitionByStage.get(stage) as StageDefinition | null | undefined;
    for (const shot of definition?.shots ?? []) {
      if (isPendingShot(shot)) continue;
      units[formatShotAddress(stage, shot.id)] = { stage, label: `Shot ${shot.id}` };
    }
    // A timeline asset and a plate are accepted through the shots that consume them — each is its own
    // unit.
    for (const name of Object.keys(definition?.topLevelAssets ?? {})) {
      units[formatTimelineAssetPath(stage, name)] = { stage, label: `Timeline: ${name}` };
    }
    for (const setupId of Object.keys(
      (definition as { plates?: Record<string, unknown> } | null | undefined)?.plates ?? {},
    )) {
      units[formatPlateAssetPath(setupId)] = { stage, label: `Plate: ${setupId}` };
    }
  }

  const unitOf = (address: string): string | null => {
    if (units[address]) return address;
    const parsed = tryParseAddress(address);
    if (parsed?.kind !== "shot" || parsed.stage === "reference") return null;
    const unit = formatShotAddress(parsed.stage, parsed.shotId);
    return units[unit] ? unit : null;
  };
  // A patch output is a human's verdict whatever its asset.
  const rerollable = (address: string): boolean => {
    if (isMaterializedLeafAddress(address)) return false;
    const acceptedId = manager.getAcceptedVariant(address);
    if (acceptedId && state.assets[address]?.variants?.[acceptedId]?.derivedFrom != null)
      return true;
    const definition = definitionByStage.get(tryParseAddress(address)?.stage as AssetStage);
    if (!definition) return false;
    try {
      const entry = getAssetEntry(definition, address);
      return (
        entry.kind !== "file" && entry.deterministic !== true && getBackendKind(entry) !== null
      );
    } catch {
      return false;
    }
  };

  const nodes = [...graph.dependencies.keys()].filter(
    (address) => unitOf(address) !== null && !isMaterializedLeafAddress(address),
  );
  const targets = new Set(nodes.filter(rerollable));

  // The rerollable addresses made from `address`, walking through the takes konte re-makes on its
  // own: a deterministic intermediate or a stem.
  const consumersOf = (address: string): KeepGraphInfo["addresses"][string]["consumers"] => {
    const out: KeepGraphInfo["addresses"][string]["consumers"] = [];
    const seen = new Set<string>();
    const walk = (node: string) => {
      for (const dependent of graph.dependents.get(node) ?? []) {
        const edge = `${node}>${dependent}`;
        if (seen.has(edge)) continue;
        seen.add(edge);
        if (targets.has(dependent)) out.push({ address: dependent, via: node });
        else if (manager.registeredDeterministic(dependent)) walk(dependent);
      }
    };
    walk(address);
    return out;
  };

  const takesOf = (address: string): Record<string, KeepTakeInfo> => {
    const takes: Record<string, KeepTakeInfo> = {};
    for (const [variantId, variant] of Object.entries(state.assets[address]?.variants ?? {})) {
      if (!variant.file || !isReviewLeaf(state, address, variantId)) continue;
      const inputs: Record<string, string[]> = {};
      for (const [dep, made] of Object.entries(variant.inputFingerprints ?? {})) {
        const kept = variant.keptInputs?.[dep];
        inputs[dep] = kept && kept !== made ? [made, kept] : [made];
      }
      takes[variantId] = { outputHash: variant.outputHash ?? null, inputs };
    }
    return takes;
  };

  const addresses: KeepGraphInfo["addresses"] = {};
  for (const address of nodes) {
    addresses[address] = {
      unit: unitOf(address)!,
      rerollable: targets.has(address),
      acceptedVariantId: manager.getAcceptedVariant(address),
      takes: takesOf(address),
      consumers: consumersOf(address),
    };
  }
  return { addresses, units };
}
