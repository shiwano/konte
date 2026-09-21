import type { ReviewRecord } from "./review-record.js";

interface ShotChange {
  shotId: string;
  changedAssets: Record<string, { previous: string; current: string }>;
  previousNotes: Array<{ time: number; shotId?: string; text: string }>;
}

interface ChangeInfo {
  previousReview: string;
  changedShots: ShotChange[];
}

/**
 * Compares the currently resolved variants against the variants recorded in the
 * last review. `currentVariantsByShot` maps each shotId to its resolved
 * variants (assetName -> variantId); callers build it from whatever plan they
 * have (video-preview RenderPlan, animatic panels), keeping this mode-agnostic.
 */
export function computeChangeInfo(
  currentVariantsByShot: Map<string, Record<string, string>>,
  lastRecord: ReviewRecord | null,
): ChangeInfo | null {
  if (!lastRecord) return null;

  const previousVariantsByShotId = new Map<string, Record<string, string>>();
  for (const shot of lastRecord.context.shots) {
    previousVariantsByShotId.set(shot.shotId, shot.variants);
  }

  const changedShots: ShotChange[] = [];
  for (const [shotId, currentVariants] of currentVariantsByShot) {
    const prevVariants = previousVariantsByShotId.get(shotId);
    if (!prevVariants) continue;

    const changedAssets: Record<string, { previous: string; current: string }> = {};
    for (const [assetName, currentVariantId] of Object.entries(currentVariants)) {
      const prevVariantId = prevVariants[assetName];
      if (prevVariantId && prevVariantId !== currentVariantId) {
        changedAssets[assetName] = { previous: prevVariantId, current: currentVariantId };
      }
    }

    if (Object.keys(changedAssets).length > 0) {
      const previousNotes = (lastRecord.notes ?? []).filter((n) => n.shotId === shotId);
      changedShots.push({ shotId, changedAssets, previousNotes });
    }
  }

  if (changedShots.length === 0) return null;

  return { previousReview: lastRecord.createdAt, changedShots };
}
