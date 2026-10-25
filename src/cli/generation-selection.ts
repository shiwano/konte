import { getAssetEntry, listAssetPaths, type AssetStage } from "../core/address.js";
import { computeDefinitionHash } from "../core/definition-hash.js";
import { type DependencyGraph, listUnusedAssetPaths } from "../core/graph.js";
import { selectDefinition, type LoadedDefinitions } from "../core/select-definition.js";
import type { StateManager } from "../core/state/index.js";
import { assetSkipReason } from "./generate-orchestrator.js";

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
  const stageAssetPaths = new Set(listAssetPaths(def, stage));
  const skippedUnused = listUnusedAssetPaths(video, animatic, graph, reference).filter((p) =>
    stageAssetPaths.has(p),
  );
  for (const p of skippedUnused) stageAssetPaths.delete(p);
  const spending = [...stageAssetPaths].filter((address) => {
    const asset = getAssetEntry(def, address);
    return (
      asset.kind !== "file" &&
      !assetSkipReason(manager, address, computeDefinitionHash(asset), asset.deterministic === true)
    );
  });
  return { stageAssetPaths, skippedUnused, spending };
}

/** What a spend prints for the board stems it re-mixed before its gate, and the ones it could not. */
export function printRemixedBoardStems(
  result: {
    accepted: ReadonlyArray<{ address: string }>;
    failed?: ReadonlyArray<{ address: string; reason: string }>;
  },
  opts: { plan?: boolean } = {},
): void {
  if (result.accepted.length > 0) {
    console.log(
      `${opts.plan ? "Would re-mix" : "Re-mixed"} ${result.accepted.length} board stem(s) the ` +
        `video develops past their review: ${result.accepted.map((s) => s.address).join(", ")}`,
    );
  }
  for (const { address, reason } of result.failed ?? []) {
    console.log(`Could not re-mix ${address}: ${reason}`);
  }
}
