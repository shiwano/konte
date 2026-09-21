import type { PendingFeedback } from "./use-review-session.js";

/**
 * Each draft comment with the variant its address showed at authoring time (a gallery pick wins
 * over the resolved one), so the comment can go stale once that address switches take.
 */
export function withDisplayedVariants(
  addedFeedback: PendingFeedback[],
  assets: Iterable<{ address: string; variantId: string | null }>,
  effectiveVariants: Record<string, string>,
): Array<{
  address: string;
  text: string;
  annotation: PendingFeedback["annotation"];
  displayedVariants: Record<string, string>;
}> {
  const shown: Record<string, string> = {};
  for (const a of assets) {
    const vid = effectiveVariants[a.address] ?? a.variantId;
    if (vid) shown[a.address] = vid;
  }
  return addedFeedback.map(({ address, text, annotation }) => {
    const vid = shown[address];
    return { address, text, annotation, displayedVariants: vid ? { [address]: vid } : {} };
  });
}
