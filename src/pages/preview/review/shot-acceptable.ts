// Whether a review can sign a shot off at all. An undeveloped shot (`pendingShot`) has no
// composition and no assets; an aside on the board carries konte's own slug rather than anything the
// author made; a shot standing in with the board has nothing of its own on screen; a shot with a
// not-ready track is drawn over a placeholder. All are excluded from the accept toggle,
// from Accept all, from the `A` shortcut and from the unreviewed count — a disabled button is not
// enough, since the bulk paths reach no button and a mark made there would be submitted as a
// verdict on something the reviewer never watched.
export interface ShotAcceptabilityInput {
  pending: boolean;
  aside?: boolean;
  hasComposition?: boolean;
  showingStandIn?: boolean;
  notReady?: boolean;
}

export function shotAcceptable(shot: ShotAcceptabilityInput): boolean {
  // An aside is unacceptable only where it has nothing of the author's in it — the board. On the
  // video it is an ordinary shot with a picture to sign off, and `hasComposition` is what tells the
  // two apart.
  if (shot.aside && !shot.hasComposition) return false;
  return !shot.pending && !shot.showingStandIn && !shot.notReady;
}

/** A unit one reel review signs off: a shot, or the timeline stem the soundtrack beds mix into. */
export type ReelUnit = { kind: "shot"; shotId: string } | { kind: "stem" };

/**
 * Everything a reel review can sign off. A board whose shots are every one of them undeveloped
 * still offers its soundtrack.
 */
export function reelAcceptUnits(
  shots: ReadonlyArray<ShotAcceptabilityInput & { shotId: string }>,
  hasTimelineStem: boolean,
): ReelUnit[] {
  return [
    ...shots.filter(shotAcceptable).map((s): ReelUnit => ({ kind: "shot", shotId: s.shotId })),
    ...(hasTimelineStem ? [{ kind: "stem" } as ReelUnit] : []),
  ];
}
