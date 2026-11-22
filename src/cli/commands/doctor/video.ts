import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadCheckContext } from "../../../core/check-context.js";
import { collectFindings, formatStaleWaiverLine } from "../../../core/checks.js";
import {
  getAssetEntry,
  listAddresses,
  listReferenceAddresses,
  listReviewableAddresses,
} from "../../../core/definition-addresses.js";
import { definitionForAddress } from "../../../core/definition-hashes.js";
import { errorMessage } from "../../../core/errors.js";
import {
  formatFindingBlockLines,
  formatFindingBlocks,
  groupByFixIn,
} from "../../../core/finding.js";
import {
  buildDependencyGraph,
  type DependencyGraph,
  listBoardlessVideoShots,
  listUnusedAddresses,
} from "../../../core/graph.js";
import { STAGE_ENTRY_FILE, type VideoRoots } from "../../../core/roots.js";
import { loadDirectionIfPresent } from "../../../core/stage-definitions.js";
import type { StateManager } from "../../../core/state/index.js";
import type {
  AnimaticDefinition,
  AssetDefinition,
  ReferenceDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import { capInline } from "../../format-list.js";
import type { CheckResult, DefinitionSet } from "./types.js";

// Spell out the reviewable subset when `file` assets pad the raw count, so the
// number here lines up with the lower count shown by `konte status` / preview.
function assetCountMessage(
  definition: VideoDefinition | AnimaticDefinition | ReferenceDefinition,
  stage: "video" | "animatic" | "reference",
): string {
  const total = listAddresses(definition, stage).length;
  const reviewable = listReviewableAddresses(definition, stage).length;
  return reviewable < total ? `${total} assets, ${reviewable} reviewable` : `${total} assets`;
}

// A missing reference.tsx or animatic.tsx is a FAIL like a broken one: both are required entries.
export function stageCheck(
  stage: "video" | "animatic" | "reference",
  definition: VideoDefinition | AnimaticDefinition | ReferenceDefinition | null,
  error: unknown,
): CheckResult {
  return definition
    ? { name: stage, status: "PASS", message: `valid (${assetCountMessage(definition, stage)})` }
    : { name: stage, status: "FAIL", message: errorMessage(error) };
}

export async function checkWorkflowFiles(
  roots: VideoRoots,
  video: VideoDefinition,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
): Promise<CheckResult> {
  const missing: string[] = [];
  const addresses = listAddresses(video, "video");
  if (animatic) {
    addresses.push(...listAddresses(animatic, "animatic"));
  }
  if (reference) {
    addresses.push(...listReferenceAddresses(reference));
  }

  for (const addr of addresses) {
    const def = definitionForAddress({ video, animatic, reference }, addr);
    if (!def) continue;
    const entry = getAssetEntry(def, addr);
    if (entry.kind !== "comfy") continue;

    const workflowPath = path.join(roots.workspace, "adapters", "comfy", entry.workflow);
    try {
      await fs.access(workflowPath);
    } catch {
      missing.push(entry.workflow);
    }
  }

  const unique = [...new Set(missing)];
  if (unique.length === 0) {
    return { name: "workflow files", status: "PASS", message: "all found" };
  }
  return {
    name: "workflow files",
    status: "FAIL",
    message: `missing: ${unique.join(", ")}`,
  };
}

// Assets defined but consumed by no composition or panel: not part of any deliverable,
// so they need no review/accept and aren't generated. WARN (not FAIL) — it's a tidiness
// hint, not a broken project; removing them means editing video.tsx / animatic.tsx, so
// (unlike orphaned targets) clean is not suggested.
export function checkUnusedAssets(
  video: VideoDefinition,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition,
): CheckResult {
  let unused: string[];
  try {
    unused = listUnusedAddresses(
      video,
      animatic,
      buildDependencyGraph(video, animatic ?? undefined, reference),
      reference,
    );
  } catch {
    // Invalid refs surface via the "missing assets" check; don't double-report here.
    return { name: "unused assets", status: "PASS", message: "skipped (dependency graph invalid)" };
  }
  if (unused.length === 0) {
    return { name: "unused assets", status: "PASS", message: "none found" };
  }
  const preview = capInline(unused, { cap: 3 });
  return {
    name: "unused assets",
    status: "WARN",
    message: `${unused.length} asset(s) used by no composition, panel, or reference export: ${preview} — remove from ${STAGE_ENTRY_FILE.video} / ${STAGE_ENTRY_FILE.animatic} / ${STAGE_ENTRY_FILE.reference} if unneeded`,
  };
}

export function checkCrossStageConsistency(
  video: VideoDefinition,
  animatic: AnimaticDefinition,
  reference?: ReferenceDefinition,
): CheckResult[] {
  const results: CheckResult[] = [];

  let graph: DependencyGraph;
  try {
    graph = buildDependencyGraph(video, animatic, reference);
    results.push({
      name: "cross-stage dependencies",
      status: "PASS",
      message: "all video dependencies on animatic resolved",
    });
  } catch (err) {
    results.push({
      name: "cross-stage dependencies",
      status: "FAIL",
      message: errorMessage(err),
    });
    return results;
  }

  // A shot that spends is the `animatic-unconsumed` finding. One built from footage or konte's own
  // ffmpeg ops has no input a board could be wired into, so no gate refuses it; it is still a board
  // reviewed and then left out of the piece. A `pendingShot` is listed by neither.
  const assembled = listBoardlessVideoShots(video, animatic, graph)
    .filter((s) => !s.spends)
    .map((s) => s.shotId);
  if (assembled.length > 0) {
    results.push({
      name: "animatic wiring",
      status: "WARN",
      message: `video shot(s) draw nothing from the board they develop: ${assembled.join(", ")}`,
    });
  }

  return results;
}

export function collectUsedKinds(
  video: VideoDefinition | null,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
): Set<AssetDefinition["kind"]> {
  const kinds = new Set<AssetDefinition["kind"]>();
  if (video) {
    for (const addr of listAddresses(video, "video")) {
      kinds.add(getAssetEntry(video, addr).kind);
    }
  }
  if (animatic) {
    for (const addr of listAddresses(animatic, "animatic")) {
      kinds.add(getAssetEntry(animatic, addr).kind);
    }
  }
  if (reference) {
    for (const addr of listReferenceAddresses(reference)) {
      kinds.add(getAssetEntry(reference, addr).kind);
    }
  }
  return kinds;
}

// Every machine finding `status` reports, and every waiver that cancels nothing.
export async function checkFindings(
  videoRoot: string,
  defs: DefinitionSet,
  manager: StateManager | null,
): Promise<CheckResult[]> {
  let direction: Awaited<ReturnType<typeof loadDirectionIfPresent>>;
  try {
    direction = await loadDirectionIfPresent(videoRoot);
  } catch (err) {
    return [{ name: "direction", status: "FAIL", message: errorMessage(err) }];
  }
  const { findings: all, staleWaivers } = await collectFindings(
    await loadCheckContext({
      cueTakes: "played",
      videoRoot,
      definitions: defs,
      direction,
      manager,
    }),
  );
  const results: CheckResult[] = [];

  // A fresh video ships `shots: []`: a WARN alone (the `generate` gate still hard-blocks it).
  if (all.some((f) => f.code === "empty-direction")) {
    results.push({
      name: "direction",
      status: "WARN",
      message: "direction is empty — declare at least one shot to begin",
    });
  }
  const findings = all.filter((f) => f.code !== "empty-direction");
  if (findings.length > 0) {
    results.push({
      name: "findings",
      status: "FAIL",
      message: `${findings.length} unresolved finding(s) — fix each in the file it is listed under, or waive it`,
      details: groupByFixIn(findings).flatMap(({ file, findings: group }) => [
        `${file}:`,
        ...formatFindingBlockLines(formatFindingBlocks(group)).map((l) => `  ${l}`),
      ]),
    });
  } else {
    results.push({ name: "findings", status: "PASS", message: "no findings" });
  }

  if (staleWaivers.length > 0) {
    results.push({
      name: "direction waivers",
      status: "WARN",
      message: `${staleWaivers.length} waiver(s) to remove from direction.ts`,
      details: staleWaivers.map(formatStaleWaiverLine),
    });
  }

  return results;
}
