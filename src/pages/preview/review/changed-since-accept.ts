// "Changed" for a video shot, which has no single variant to compare: it is N picture assets
// plus its materialized leaves (composition, stems), and the server pre-folds each leaf into a
// `needsReview` that means "never accepted OR accepted-then-stale". So the baseline is the shot's
// own sign-off — any leaf holding an accepted variant — and against it a leaf needing review is
// a change. Keying on the shot rather than per-leaf is what catches a stem that did not exist at
// sign-off: adding the first <Audio> to an accepted shot mints its stem unaccepted, which is a
// change to what was signed off, not a fresh target.
export function shotChangedSinceAccept(shot: {
  assets: Array<{ hasNewerVariant: boolean }>;
  compositionVariantId: string | null;
  compositionNeedsReview: boolean;
  stems: Array<{ variantId: string | null; needsReview: boolean }>;
  showingStandIn?: boolean;
}): boolean {
  // Standing in with the board: nothing of what was signed off is on screen, so there is nothing
  // here to read as changed.
  if (shot.showingStandIn) return false;
  if (shot.assets.some((a) => a.hasNewerVariant)) return true;
  const signedOff =
    shot.compositionVariantId !== null || shot.stems.some((stem) => stem.variantId !== null);
  return signedOff && (shot.compositionNeedsReview || shot.stems.some((stem) => stem.needsReview));
}
