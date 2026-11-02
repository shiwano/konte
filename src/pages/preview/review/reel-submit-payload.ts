import type { ReelSubmitBody } from "../../../core/types/review-submit.js";
import type { VideoPreviewState } from "../types.js";
import { keepDecisions, regenerateDecisions, type KeepChoice } from "./keep-or-regenerate.js";
import type { SubmitInput } from "./use-review-session.js";
import type { ReelMarks } from "./use-reel-decisions.js";

export function buildReelSubmitPayload({
  state,
  marks,
  keepChoices,
  effectiveVariants,
  input: { addedFeedback, feedbackPatches, overallComment },
}: {
  state: Pick<
    VideoPreviewState,
    "shots" | "audioAssets" | "timelineStem" | "overlay" | "compositionRefVariants"
  >;
  marks: ReelMarks;
  keepChoices: readonly KeepChoice[];
  effectiveVariants: Record<string, string>;
  input: SubmitInput;
}): ReelSubmitBody {
  // Where the comment was written, and nothing about what it was written against: the handler
  // derives the subject from the definition and the whole-view snapshots below. The page cannot
  // narrow a subject it does not send.
  const added = addedFeedback.map((pf) => ({
    address: pf.address,
    text: pf.text,
    annotation: pf.annotation,
    time: pf.time,
  }));
  const notes = addedFeedback.map((pf) => ({
    time: pf.time ?? 0,
    shotId: pf.shotId,
    address: pf.address,
    text: pf.text,
    ...(pf.annotation ? { x: pf.annotation.x, y: pf.annotation.y } : {}),
  }));
  // Snapshot the variant shown for every reviewable asset (preview override
  // wins over the resolved/accepted variant), so submit accepts exactly what
  // the reviewer saw — never a variant a reroll produced mid-review.
  //
  // Seeded with what the compositions were rendered from, since a composite draws addresses the
  // arrays below do not carry (a board panel, a reference sheet). The loops then overwrite every
  // address this page can switch a take on, so a gallery pick still wins.
  const displayedVariants: Record<string, string> = { ...state.compositionRefVariants };
  // Every take the gallery offered beside it. An accept dismisses the ones it did not choose,
  // and only the page knows which were on screen — a reroll that landed mid-review is in state
  // but was never a candidate this reviewer passed over.
  const displayedCandidates: Record<string, string[]> = {};
  for (const a of [...state.shots.flatMap((s) => s.assets), ...state.audioAssets]) {
    const vid = effectiveVariants[a.address] ?? a.variantId;
    if (vid) displayedVariants[a.address] = vid;
    displayedCandidates[a.address] = a.variants.map((v) => v.variantId);
  }
  // The materialized leaves the page was served: their live definition, which no take carries,
  // and — for a composition — the accepted variant it was showing. A stem's own take is left
  // out: the preview renders it live, so the accepted variant is not what played.
  const displayedDefinitionHashes: Record<string, string> = {};
  for (const shot of state.shots) {
    if (shot.compositionAddress) {
      if (shot.compositionVariantId) {
        displayedVariants[shot.compositionAddress] = shot.compositionVariantId;
      }
      if (shot.compositionDefinitionHash) {
        displayedDefinitionHashes[shot.compositionAddress] = shot.compositionDefinitionHash;
      }
    }
    for (const stem of shot.stems) {
      if (stem.definitionHash) displayedDefinitionHashes[stem.address] = stem.definitionHash;
    }
  }
  if (state.timelineStem?.definitionHash) {
    displayedDefinitionHashes[state.timelineStem.address] = state.timelineStem.definitionHash;
  }
  if (state.overlay?.definitionHash) {
    displayedDefinitionHashes[state.overlay.address] = state.overlay.definitionHash;
  }
  // Which shots stood in, snapshotted like `displayedVariants`: a build dependency finishing
  // mid-review flips it, and submit drops any verdict on one — accepting it would sign off a
  // composition nobody has seen.
  const displayedStandInShotIds = state.shots.filter((s) => s.showingStandIn).map((s) => s.shotId);
  return {
    decisions: marks.shots,
    notes: notes.length > 0 ? notes : undefined,
    ...(marks.stem ? { timelineStemDecision: marks.stem } : {}),
    ...(marks.overlay ? { overlayDecision: marks.overlay } : {}),
    addedFeedback: added,
    feedbackPatches,
    displayedVariants,
    displayedDefinitionHashes,
    displayedCandidates,
    displayedStandInShotIds,
    ...(overallComment ? { overallComment } : {}),
    ...(keepChoices.length > 0
      ? { keep: keepDecisions(keepChoices), regenerate: regenerateDecisions(keepChoices) }
      : {}),
  };
}
