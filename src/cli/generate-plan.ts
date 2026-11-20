import {
  type SkipReason,
  assetSkipReason,
  inFlightVariantIds,
} from "../core/generation-selection.js";
import type { DependencyGraph } from "../core/graph.js";
import { comfyModelJobId } from "../core/job-manager.js";
import { formatNotice } from "../core/notice.js";
import { assetResolves } from "../core/pending-jobs.js";
import type { SetupFork } from "../core/stale-refresh.js";
import type { StateManager } from "../core/state/index.js";
import type { AssetDefinition, BackendKind, ComfyTarget } from "../core/types/index.js";
import { jobBackendKind } from "./job-registration.js";

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  active: "active job(s) exist",
  accepted: "accepted",
  "accepted-stale": "accepted but stale — the accept stands",
  ready: "already ready",
};

export type AcceptedStaleAsset = {
  address: string;
  cause: string;
  /** The `staleRefreshStep` for the accepted take, when it is not a reroll. */
  step: string | null;
  /** Whether a reroll is what takes the edited definition. */
  reroll: boolean;
  /** Set only for a plate two or more shots stand on. */
  fork?: SetupFork;
};

// The assets this run skipped because their accepted take is stale — the one skip a user is
// liable to read as a silent no-op ("I edited the prompt and nothing happened"), so it names
// each address with its stale cause and what settles it. A plate carries a second door: the edit
// is charged to every shot on that setup. Null when clean.
export function formatAcceptedStaleNotice(assets: readonly AcceptedStaleAsset[]): string | null {
  if (assets.length === 0) return null;
  const lines: string[] = [];
  for (const a of assets) {
    const shared = a.fork ? ` — shared frame for shots ${a.fork.shotIds.join(", ")}` : "";
    lines.push(a.cause ? `${a.address}: ${a.cause}${shared}` : `${a.address}${shared}`);
    if (a.step) lines.push(`  ${a.step}`);
    if (!a.reroll) continue;
    const reroll = `konte reroll ${a.address}`;
    if (a.fork) {
      lines.push(
        "  for one shot: fork the setup — add one to `setups` in direction.ts, point that shot's `setup` at it, declare its plate in `plates` in animatic.tsx",
      );
      lines.push(`  for all ${a.fork.shotIds.length}: ${reroll}`);
    } else {
      lines.push(`  for a take of the edited definition: ${reroll}`);
    }
  }
  return formatNotice(
    "accepted but stale — generate never replaces an accepted take, so these were skipped:",
    lines,
  );
}

type PlanAction = "start" | "wait" | "skip" | "synced";

type PlanEntry = {
  address: string;
  action: PlanAction;
  reason?: string;
  /** The skip's code — `reason` is its prose form. */
  skipReason?: SkipReason;
  backendKind: BackendKind | null;
  // Where a comfy asset runs; null for every other kind.
  comfyTarget: ComfyTarget | null;
  variantCount: number;
  deps: string[];
};

type GeneratePlan = {
  levels: Array<{ level: number; entries: PlanEntry[] }>;
  summary: { start: number; wait: number; skip: number; synced: number };
};

/**
 * A stage's dependency levels, numbered without the gaps the cross-stage graph leaves.
 */
export function stageLevels(
  levels: readonly (readonly string[])[],
  stageAddresses: ReadonlySet<string>,
): string[][] {
  return levels
    .map((addresses) => addresses.filter((a) => stageAddresses.has(a)))
    .filter((addresses) => addresses.length > 0);
}

export type GenerateVerdict =
  | { action: "synced" }
  | { action: "skip"; skipReason: SkipReason }
  | { action: "build" };

/**
 * What `generate` does with one asset before registering it, for the plan and the run alike.
 * `inputRebuilt` says whether this run builds one of its inputs.
 */
export function classifyGenerateAsset(opts: {
  manager: StateManager;
  liveJobs: ReadonlySet<string>;
  address: string;
  assetDef: AssetDefinition;
  inputRebuilt: boolean;
}): GenerateVerdict {
  const { manager, liveJobs, address, assetDef, inputRebuilt } = opts;
  if (assetDef.kind === "file") return { action: "synced" };
  const skipReason = assetSkipReason(manager, liveJobs, address, inputRebuilt);
  return skipReason ? { action: "skip", skipReason } : { action: "build" };
}

// Dry-run counterpart to the generate loop, with no side effects. Submit-time failure cascades
// are omitted.
export function buildGeneratePlan(params: {
  levels: readonly (readonly string[])[];
  graph: DependencyGraph;
  manager: StateManager;
  liveJobs: ReadonlySet<string>;
  stageAddresses: ReadonlySet<string>;
  variantCount: number;
  getAssetDef: (address: string) => AssetDefinition;
  missingModels?: ReadonlySet<string>;
  missingNodes?: ReadonlySet<string>;
  targetOf?: (def: AssetDefinition) => ComfyTarget | null;
}): GeneratePlan {
  const {
    levels,
    graph,
    manager,
    liveJobs,
    stageAddresses,
    variantCount,
    getAssetDef,
    missingModels = new Set<string>(),
    missingNodes = new Set<string>(),
    targetOf = () => null,
  } = params;

  const planLevels: GeneratePlan["levels"] = [];
  const summary = { start: 0, wait: 0, skip: 0, synced: 0 };
  const state = manager.getState();
  // Whether a dep will still lack a usable file when this level's job registers — the question
  // describePendingJob answers for the real run to decide queued vs waiting. Its three
  // predicates, in the plan's terms: an upstream this plan builds; one an earlier run has in
  // flight (which blocks even when an older take left a file behind, so the dependent consumes
  // the fresh one); one with no file at all. File assets need no case of their own — the caller
  // syncs them into `state` before planning, so an absent one has no variant to find.
  const notYetBuilt = new Set<string>();
  // One memo for the whole plan — it writes nothing to state.
  const planView = manager.stalenessView();
  const depBlocks = (dep: string) =>
    notYetBuilt.has(dep) ||
    inFlightVariantIds(state, dep, liveJobs).length > 0 ||
    !assetResolves(planView, dep);

  const levelsOfStage = stageLevels(levels, stageAddresses);
  for (let levelIdx = 0; levelIdx < levelsOfStage.length; levelIdx++) {
    const addresses = levelsOfStage[levelIdx]!;

    const entries: PlanEntry[] = [];
    for (const address of addresses) {
      const assetDef = getAssetDef(address);
      const deps = [...(graph.dependencies.get(address) ?? [])];
      const comfyTarget = targetOf(assetDef);
      const backendKind = jobBackendKind(assetDef, comfyTarget);

      let action: PlanAction;
      let reason: string | undefined;
      let skipReason: SkipReason | undefined;
      const verdict = classifyGenerateAsset({
        manager,
        liveJobs,
        address,
        assetDef,
        inputRebuilt: deps.some((d) => notYetBuilt.has(d)),
      });
      if (verdict.action === "synced") {
        action = "synced";
      } else {
        if (verdict.action === "skip") {
          const skip = verdict.skipReason;
          action = "skip";
          skipReason = skip;
          reason =
            skip === "active"
              ? `${inFlightVariantIds(state, address, liveJobs).length} active job(s) exist`
              : SKIP_REASON_TEXT[skip];
        } else if (
          deps.some(depBlocks) ||
          (assetDef.kind === "comfy" &&
            (comfyTarget === null || comfyTarget === "comfyui") &&
            ((assetDef.models?.some((m) => missingModels.has(comfyModelJobId(m))) ?? false) ||
              (assetDef.nodes?.some((n) => missingNodes.has(n.id)) ?? false)))
        ) {
          // An upstream still to build, or comfy models/nodes still to install → the job is
          // registered blocked and submits once those land.
          action = "wait";
        } else {
          // No deps, or deps already generated: the worker submits it on its next pass.
          action = "start";
        }
        if (action === "start" || action === "wait") notYetBuilt.add(address);
      }

      summary[action]++;
      entries.push({
        address,
        action,
        reason,
        skipReason,
        backendKind,
        comfyTarget,
        variantCount,
        deps,
      });
    }
    planLevels.push({ level: levelIdx, entries });
  }

  return { levels: planLevels, summary };
}

function formatPlanEntry(e: PlanEntry): string {
  if (e.action === "synced") return "synced (file)";
  if (e.action === "skip") return `skip (${e.reason})`;

  const detail: string[] = [];
  if (e.comfyTarget) detail.push(`comfy → ${e.comfyTarget}`);
  else if (e.backendKind) detail.push(e.backendKind);
  let line = detail.length > 0 ? `${e.action} (${detail.join(", ")})` : e.action;
  if (e.deps.length > 0) line += ` [deps: ${e.deps.join(", ")}]`;
  return line;
}

// Human-readable plan.
export function formatGeneratePlan(plan: GeneratePlan): string {
  const lines: string[] = [];
  if (plan.levels.length === 0) {
    lines.push("Nothing to generate.");
    return lines.join("\n");
  }

  for (const lvl of plan.levels) {
    lines.push(`\nLevel ${lvl.level + 1}: ${lvl.entries.length} asset(s)`);
    for (const e of lvl.entries) {
      lines.push(`  ${e.address}: ${formatPlanEntry(e)}`);
    }
  }

  const { start, wait, skip, synced } = plan.summary;
  lines.push(`\nPlan: ${start} to start, ${wait} waiting, ${skip} skipped, ${synced} synced`);
  lines.push("\nRun without --plan to start these jobs.");
  return lines.join("\n");
}
