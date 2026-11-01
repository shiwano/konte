import { formatAddress, type ShotStage, shownShotAssetNames } from "./address.js";
import { buildStageReviewPlan, type RenderPlan, type ShotRenderPlan } from "./render-plan.js";
import type { ShotAcceptabilityInput } from "./shot-acceptable.js";
import { shotById } from "./shot-index.js";
import type { StateManager } from "./state/index.js";
import type { ShotDefinition, StageDefinition } from "./types/index.js";

/**
 * Whether a shot carries a track with no take yet — the timeline's dashed "Not ready" clip. The
 * shot's accept toggle is closed on it: a verdict there signs off a composition drawn over a
 * placeholder. Read off the definition rather than the harvested clips, which a render failure
 * leaves empty. A stem is not a track: the page mixes the cues live, and the accept materializes
 * the stem from the takes it signs off.
 */
function shotNotReady(
  manager: StateManager,
  stage: ShotStage,
  shots: readonly ShotDefinition[],
  plan: ShotRenderPlan,
  shot: ShotDefinition | undefined,
): boolean {
  if (plan.pending || !shot) return false;
  const ownNames = shownShotAssetNames(stage, shots, shot);
  if (ownNames.some((name) => plan.resolvedVariants[name] === undefined)) return true;
  const ownPaths = new Set(ownNames.map((name) => formatAddress(stage, shot.id, name)));
  return (shot.compositionRefs ?? []).some(
    (ref) => !ownPaths.has(ref) && manager.resolveReference(ref, { includeStale: true }) === null,
  );
}

/** The plan a reel review is read and submitted under. */
export function buildReelReviewPlan(
  manager: StateManager,
  video: StageDefinition,
  animatic: StageDefinition | null,
): RenderPlan {
  return buildStageReviewPlan(
    video,
    manager,
    video.stage === "video" && animatic ? buildStageReviewPlan(animatic, manager) : null,
  );
}

/** Each shot's `shotAcceptable` inputs — what its accept toggle, Accept all and `konte accept <stage>` read. */
export function reelShotAcceptability(
  manager: StateManager,
  video: StageDefinition,
  plan: RenderPlan,
): Array<Required<ShotAcceptabilityInput> & { shotId: string }> {
  return plan.shots.map((s) => ({
    shotId: s.shotId,
    pending: s.pending,
    aside: s.aside,
    hasComposition: s.shotFn !== null,
    showingStandIn: s.showStandIn,
    notReady: shotNotReady(manager, video.stage, video.shots, s, shotById(video.shots, s.shotId)),
  }));
}

// The take a reference card shows, and so the one its accept and Accept all sign off: accepted,
// else newest non-stale (stale only as a last resort so the card is never empty) — the same take
// `konte path` prints.
export function displayedReferenceVariant(manager: StateManager, address: string) {
  return manager.selectVariant(address, { includeStale: true });
}
