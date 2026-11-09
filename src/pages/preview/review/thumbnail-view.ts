import type { VideoPreviewState } from "../types.js";

type Thumbnail = NonNullable<VideoPreviewState["thumbnail"]>;

/**
 * The thumbnail's own assets whose take on screen is not the one its still was made from: an accept
 * takes that take, and `generate` makes the still again from it.
 */
export function thumbnailSwitched(
  thumbnail: Thumbnail,
  effectiveVariants: Record<string, string>,
): string[] {
  return thumbnail.assets
    .filter((a) => {
      const made = thumbnail.sources[a.address];
      const shown = effectiveVariants[a.address] ?? a.variantId;
      return made !== undefined && shown !== null && shown !== made;
    })
    .map((a) => a.address);
}

/** Whether the thumbnail stands accepted as the page shows it. */
export function thumbnailShownAccepted(
  thumbnail: VideoPreviewState["thumbnail"],
  effectiveVariants: Record<string, string>,
): boolean {
  if (!thumbnail || thumbnail.needsReview || thumbnail.cover.variantStatus !== "accepted") {
    return false;
  }
  return thumbnailSwitched(thumbnail, effectiveVariants).length === 0;
}
