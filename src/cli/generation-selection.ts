import { getAssetEntry, listAssetPaths, type AssetStage } from "../core/address.js";
import { computeDefinitionHash } from "../core/definition-hash.js";
import { type DependencyGraph, listUnusedAssetPaths } from "../core/graph.js";
import { selectDefinition, type LoadedDefinitions } from "../core/select-definition.js";
import type { StateManager } from "../core/state/index.js";
import { assetSkipReason } from "./generate-orchestrator.js";
import { holdForUpstreamAcceptance } from "./load-definition.js";

export function selectGenerationAssets(opts: {
  definitions: LoadedDefinitions;
  stage: AssetStage;
  manager: StateManager;
  graph: DependencyGraph;
}): {
  stageAssetPaths: Set<string>;
  skippedUnused: string[];
  spending: string[];
  heldLines: string[];
  heldCount: number;
} {
  const { definitions, stage, manager, graph } = opts;
  const { video, animatic, reference } = definitions;
  const { def } = selectDefinition(stage, definitions);
  const stageAssetPaths = new Set(listAssetPaths(def, stage));
  const skippedUnused = listUnusedAssetPaths(video, animatic, graph, reference).filter((p) =>
    stageAssetPaths.has(p),
  );
  for (const p of skippedUnused) stageAssetPaths.delete(p);
  let spending = [...stageAssetPaths].filter((address) => {
    const asset = getAssetEntry(def, address);
    return (
      asset.kind !== "file" &&
      !assetSkipReason(manager, address, computeDefinitionHash(asset), asset.deterministic === true)
    );
  });
  if (stage === "reference") {
    return { stageAssetPaths, skippedUnused, spending, heldLines: [], heldCount: 0 };
  }
  const { held, lines } = holdForUpstreamAcceptance({
    manager,
    graph,
    assetPaths: spending,
    stage,
    animatic,
  });
  for (const address of held) stageAssetPaths.delete(address);
  spending = spending.filter((address) => !held.has(address));
  return { stageAssetPaths, skippedUnused, spending, heldLines: lines, heldCount: held.size };
}
