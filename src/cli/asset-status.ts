import {
  getStage,
  type Stage,
  isDeliveryAddress,
  listAddresses,
  listCompositionAddresses,
  listReferenceAddresses,
  listStemAddresses,
} from "../core/address.js";
import { assertNever } from "../core/assert.js";
import { listRemovedShotStemAddresses } from "../core/composition-resource.js";
import { KonteError } from "../core/errors.js";
import { buildDependencyGraph, type DependencyGraph, listUnusedAssetPaths } from "../core/graph.js";
import { JobManager } from "../core/job-manager.js";
import type { StateManager } from "../core/state/index.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "../core/types/index.js";
import { buildStatusReport, type StatusReport } from "./print-status.js";
import { applyResolutionDefinitions } from "../core/definition-hashes.js";

interface AssetStatus {
  report: StatusReport;
  /** The addresses the report covers — every stage's, minus the ones no deliverable consumes. */
  addresses: string[];
  /** Null when the definitions do not form a valid graph (a bad ref); graph-derived views are then skipped. */
  graph: DependencyGraph | null;
  /** Asset paths no composition or panel consumes. */
  unusedPaths: Set<string>;
}

/** The address set and status report behind `konte status`, over already-loaded definitions. */
export async function buildAssetStatus(opts: {
  videoRoot: string;
  manager: StateManager;
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  reference: ReferenceDefinition | null;
  /** Progress/readiness only — no section depends on these. */
  unacceptedCast?: readonly string[];
  pendingShotsByStage?: Partial<Record<Stage, number>>;
}): Promise<AssetStatus> {
  const { videoRoot, manager, video, animatic, reference } = opts;
  const state = manager.getState();

  // Delivery (#delivery) targets are synthesized at export, not part of the definition — surface
  // whichever already exist in state so they can be tracked and cleaned.
  let addresses = [
    ...new Set([
      ...(reference ? listReferenceAddresses(reference) : []),
      ...listAddresses(animatic, "animatic"),
      ...listAddresses(video, "video"),
      // Both composition stages carry materialized leaves.
      ...listCompositionAddresses(animatic),
      ...listStemAddresses(animatic),
      ...listCompositionAddresses(video),
      ...listStemAddresses(video),
      ...listRemovedShotStemAddresses(state, animatic),
      ...listRemovedShotStemAddresses(state, video),
      ...Object.keys(state.assets).filter(isDeliveryAddress),
    ]),
  ];

  let graph: DependencyGraph | null = null;
  try {
    graph = buildDependencyGraph(video, animatic, reference ?? undefined);
  } catch {
    // dependency graph invalid (e.g. a bad ref) — skip the unused split; other commands report it.
  }
  // Drop assets no composition/panel consumes: they aren't part of any deliverable, so they must
  // not count toward acceptance or be nagged as needing review. `konte doctor` owns reporting them.
  const unusedPaths = new Set(graph ? listUnusedAssetPaths(video, animatic, graph, reference) : []);
  if (graph) {
    addresses = addresses.filter((addr) => !unusedPaths.has(addr));
  }

  const getDefinition = (addr: string) => {
    const stage = getStage(addr);
    switch (stage) {
      case "reference":
        return reference;
      case "animatic":
        return animatic;
      case "video":
        return video;
      case "direction":
        // The direction stage is feedback-only — its addresses never enter the status report
        // (they are not among any stage's listed asset addresses).
        throw new KonteError("INVALID_ADDRESS", "The direction stage has no asset definition");
      default:
        return assertNever(stage, "status getDefinition");
    }
  };

  // Registered before the report resolves anything.
  await applyResolutionDefinitions({
    videoRoot,
    state,
    definitions: { video, animatic, reference },
  });

  // After applyResolutionDefinitions: the gate reads `assetSkipReason`, which judges staleness by
  // the registered definitions. Each animatic's hash is memoized on the definition, so the report's
  // own pass over the same leaves pays for it once.

  const report = await buildStatusReport(
    addresses,
    manager,
    new JobManager(videoRoot),
    getDefinition,
    {
      videoRoot,
      unacceptedCast: opts.unacceptedCast,
      pendingShotsByStage: opts.pendingShotsByStage,
      videoDefinition: video,
      graph,
    },
  );

  return { report, addresses, graph, unusedPaths };
}

/** The "Needs review" items, in report order. */
export function needsReviewItems(report: StatusReport): {
  address: string;
  detail: string;
  variantId?: string;
}[] {
  return report.sections.find((s) => s.title === "Needs review")?.items ?? [];
}
