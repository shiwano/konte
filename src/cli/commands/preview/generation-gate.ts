import { loadCheckContext } from "../../../core/check-context.js";
import { collectFindings } from "../../../core/checks.js";
import type { DependencyGraph } from "../../../core/graph.js";
import { KonteError } from "../../../core/errors.js";
import {
  holdsJoblessReservation,
  liveGenerationVariantIds,
  selectGenerationAssets,
} from "../../../core/generation-selection.js";
import { JobManager } from "../../../core/job-manager.js";
import { judgeSpend, spendHeldError, type SpendRequest } from "../../../core/spend-gate.js";
import { spendContext } from "../../finding-gates.js";
import type { LoadedDefinitions } from "../../../core/select-definition.js";
import { StateManager } from "../../../core/state/index.js";
import { formatStaleCause } from "../../../core/staleness.js";
import { drawsStaleRefAsWritten } from "../../../core/render-plan.js";
import { variantLifecycle } from "../../../core/variant-lifecycle.js";

// A take whose job failed: `generate` was run and the asset is that failure's to answer.
function newestTakeFailed(
  manager: StateManager,
  address: string,
  failedJobs: ReadonlySet<string>,
): boolean {
  const variants = Object.entries(manager.tryGetAssetState(address)?.variants ?? {});
  const newest = variants.reduce<(typeof variants)[number] | null>(
    (latest, entry) =>
      latest === null || entry[1].createdAt > latest[1].createdAt ? entry : latest,
    null,
  );
  return newest !== null && (variantLifecycle(newest[1]) === "failed" || failedJobs.has(newest[0]));
}

function unsubmittedCause(manager: StateManager, address: string): string {
  const variants = Object.entries(manager.tryGetAssetState(address)?.variants ?? {});
  if (variants.length === 0) return "never generated";
  const kept = variants
    .filter(([, v]) => v.file && v.status !== "dismissed")
    .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt));
  const newest = kept[0];
  if (!newest) {
    return variants.every(([, v]) => v.status === "dismissed")
      ? "every take dismissed"
      : "no undismissed take has a file";
  }
  const staleness = manager.variantStaleness(address, newest[0]);
  const cause = staleness ? formatStaleCause(staleness) : "";
  return cause ? `${newest[0]} is stale (${cause})` : `${newest[0]} is stale`;
}

// A take the page draws although `generate` would replace it — stale only under its adapter, left to
// the shot's accept.
function drawnAsWritten(
  manager: StateManager,
  definitions: LoadedDefinitions,
  address: string,
): boolean {
  const video = definitions.video;
  if (!video) return false;
  return video.shots.some(
    (shot) =>
      (shot.compositionRefs ?? []).includes(address) &&
      drawsStaleRefAsWritten(manager, video, shot, address),
  );
}

/**
 * Refuses a video review while `konte generate video` would still submit work, leaving out what the
 * spend gate holds and a take the page draws as written.
 */
export async function assertVideoGenerationSubmitted(opts: {
  videoRoot: string;
  definitions: LoadedDefinitions;
  manager: StateManager;
  graph: DependencyGraph;
}): Promise<void> {
  const { videoRoot, definitions, manager, graph } = opts;
  const jobManager = new JobManager(videoRoot);
  let jobs = await jobManager.listJobs();
  if (holdsJoblessReservation(manager.getState(), jobs)) {
    await StateManager.writersSettled(videoRoot);
    jobs = await jobManager.listJobs();
  }
  const liveJobs = await liveGenerationVariantIds(videoRoot, jobs, manager.getState());
  const { spending } = selectGenerationAssets({
    definitions,
    stage: "video",
    manager,
    liveJobs,
    graph,
  });
  if (spending.length === 0) return;
  const ctx = await loadCheckContext({
    cueTakes: "resolved",
    videoRoot,
    definitions,
    manager,
    graph,
  });
  const report = await collectFindings(
    spendContext(ctx),
    (traits) => traits.holds.spend !== undefined,
    {
      signedOff: true,
    },
  );
  const req: SpendRequest = {
    command: "generate",
    stage: "video",
    addresses: spending,
    targeted: false,
  };
  const verdict = judgeSpend(ctx, report, req);
  if (spendHeldError(req, verdict)) return;
  const error = unsubmittedGenerationError(
    manager,
    definitions,
    spending.filter((address) => !verdict.held.has(address)),
    new Set(
      jobs.filter((job) => job.kind === "generation" && job.status === "failed").map((j) => j.id),
    ),
  );
  if (error) throw error;
}

/**
 * The refusal over what a whole-stage `generate video` would submit, or null when the page draws
 * every take or every job failed.
 */
export function unsubmittedGenerationError(
  manager: StateManager,
  definitions: LoadedDefinitions,
  submittable: readonly string[],
  failedJobs: ReadonlySet<string>,
): KonteError | null {
  const unsubmitted = submittable.filter(
    (address) =>
      !drawnAsWritten(manager, definitions, address) &&
      !newestTakeFailed(manager, address, failedJobs),
  );
  if (unsubmitted.length === 0) return null;
  return new KonteError(
    "GENERATION_UNSUBMITTED",
    `Cannot open the video review — run \`konte generate video\` first: ${unsubmitted.length} asset(s) have no current take and no job making one, so the page would play the board in their place`,
    unsubmitted.map((address) => `  ${address} — ${unsubmittedCause(manager, address)}`),
  );
}
