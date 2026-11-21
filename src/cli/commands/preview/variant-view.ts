import * as path from "node:path";
import { addressToUrlPath, patchSourceVariantIdOf } from "../../../core/address.js";
import type { StalenessView } from "../../../core/staleness.js";
import { generatedOrigin, isReviewLeaf } from "../../../core/variant-lineage.js";
import { variantOwningFile } from "../../../core/variant-dir.js";
import { mediaVisualSize } from "../../../core/variant-media.js";
import type {
  AssetInfo,
  SongReadingInfo,
  VariantInfo,
  VariantStatus,
} from "../../../core/types/review-state.js";
import type { StateManager } from "../../../core/state/index.js";
import type { VariantState } from "../../../core/types/index.js";
import type { PatchChainVariants } from "./asset-info.js";
import { readVariantThumbnails } from "../../../core/variant-thumbnails.js";
import { inferMediaType } from "../../../core/media-type.js";
import { auditionGain, type LevelKind } from "../../../core/audio-level.js";

/**
 * Switchable variant candidates for an address: recommended (non-stale) first in
 * newest-first order, then de-emphasized (stale).
 * `buildVariantUrl` returns the tile's preview still (see `variantPreviewUrl`).
 *
 * Only lineage leaves are candidates. A take that has been patched is not an alternative to its
 * correction — it is the "before" of it — so it is attached to its descendant's `before` instead
 * of standing beside it, and the gallery shows one tile per decision rather than filling up with
 * pre-fix images.
 */
export function buildVariantCandidates(
  manager: StateManager,
  addr: string,
  acceptedId: string | null,
  buildVariantUrl: (variantId: string, variant: VariantState) => string | null,
  buildFileUrl?: (variantId: string, variant: VariantState) => string | null,
  buildInfo?: (variantId: string) => AssetInfo | undefined,
  buildSong?: (variantId: string) => SongReadingInfo | undefined,
  // What the mix levels this address as; its audio takes are auditioned at that level.
  levelKind?: LevelKind,
  // The view the page's own resolution uses, or the gallery calls current what it is not showing.
  view: StalenessView = manager.stalenessView(),
): VariantInfo[] {
  const variants: VariantInfo[] = [];
  try {
    const target = manager.getAssetState(addr);
    const staleState = manager.getState();
    const hasAccepted = acceptedId != null && target.variants?.[acceptedId] != null;
    const entries = Object.entries(target.variants ?? {})
      .filter(([vid, v]) => v?.file && isReviewLeaf(staleState, addr, vid))
      .map(([vid, v]) => {
        const stale = view.isStale(addr, v);
        const source = v.derivedFrom ? target.variants?.[v.derivedFrom] : null;
        const info = buildInfo?.(vid);
        const song = buildSong?.(vid);
        const size = mediaVisualSize(v.media ?? null);
        const gain = auditionGain(levelKind, v.media);
        const sourceGain = auditionGain(levelKind, source?.media);
        return {
          variantId: vid,
          variantStatus: (vid === acceptedId ? "accepted" : "none") as VariantStatus,
          stale,
          undecidedBesideAccepted:
            hasAccepted && vid !== acceptedId && !stale && v.status === "none",
          dismissed: v.status === "dismissed",
          createdAt: v.createdAt,
          imageUrl: buildVariantUrl(vid, v),
          fileUrl: buildFileUrl ? buildFileUrl(vid, v) : null,
          before:
            v.derivedFrom && source?.file
              ? {
                  variantId: v.derivedFrom,
                  variantStatus: (v.derivedFrom === acceptedId
                    ? "accepted"
                    : "none") as VariantStatus,
                  imageUrl: buildVariantUrl(v.derivedFrom, source),
                  fileUrl: buildFileUrl ? buildFileUrl(v.derivedFrom, source) : null,
                  ...(sourceGain !== undefined ? { auditionGain: sourceGain } : {}),
                }
              : null,
          ...(gain !== undefined ? { auditionGain: gain } : {}),
          ...(size ? { size } : {}),
          ...(info ? { info } : {}),
          ...(song ? { song } : {}),
        };
      })
      .reverse();
    const isRecommended = (e: VariantInfo) => !e.stale && !e.dismissed;
    variants.push(...entries.filter(isRecommended), ...entries.filter((e) => !isRecommended(e)));
  } catch {
    // no state
  }
  return variants;
}

/**
 * The status of the take a surface is showing. `accepted` only when resolution itself says so: an
 * accept konte made itself keeps that status on disk after it goes stale, while resolution stops
 * honouring it.
 */
export function displayedVariantStatus(
  manager: StateManager,
  addr: string,
  variantId: string | null,
): "none" | "accepted" {
  if (variantId === null) return "none";
  const resolved = manager.selectVariant(addr, { includeStale: true });
  return resolved?.variantId === variantId && resolved.isAccepted ? "accepted" : "none";
}

/**
 * True when a ready, non-stale take stands undecided beside the accepted one — a reroll or a patch
 * output sitting in the gallery with no verdict. The accepted variant otherwise stays the
 * resolved/shown one and hides it, so the UI surfaces this to prompt a decision: accept the rival,
 * or re-accept the shown take, which dismisses it.
 */
export function hasUndecidedBesideAccepted(
  manager: StateManager,
  addr: string,
  acceptedId: string | null,
  view: StalenessView = manager.stalenessView(),
): boolean {
  if (!acceptedId) return false;
  try {
    return view.undecidedBesideAccepted(addr) !== null;
  } catch {
    return false;
  }
}

/** Video variant preview image: the variant's first cached thumbnail, or null. */
export function videoVariantThumbUrl(
  videoRoot: string,
  address: string,
  variantId: string,
  variant: VariantState,
): string | null {
  const thumbs = readVariantThumbnails(
    videoRoot,
    address,
    variantId,
    variant.outputHash,
    variant.file,
  );
  if (thumbs.length === 0) return null;
  return `/api/thumbnail-assets/${encodeURIComponent(thumbs[0]!.file)}`;
}

/** Served URL for a variant's own file. */
export function variantFileUrl(
  address: string,
  variantId: string,
  file: string,
  assetBaseUrl: string,
): string {
  return `${assetBaseUrl}/${addressToUrlPath(address)}/${encodeURIComponent(variantId)}/${encodeURIComponent(path.basename(file))}`;
}

/**
 * The still a variant shows on a card or a gallery tile: the file itself for an image, the first
 * cached thumbnail for a video, null for audio. An image goes through `/api/assets` — its own file
 * is not in the thumbnail cache the thumbnail endpoint is confined to.
 */
export function variantPreviewUrl(
  videoRoot: string,
  address: string,
  variantId: string,
  variant: VariantState,
  assetBaseUrl: string,
): string | null {
  if (!variant.file) return null;
  const kind = inferMediaType(variant.file);
  if (kind === "image") return variantFileUrl(address, variantId, variant.file, assetBaseUrl);
  if (kind === "video") return videoVariantThumbUrl(videoRoot, address, variantId, variant);
  return null;
}

/**
 * The chain step takes a patched take was produced by, upstream first, or null for a take no patch
 * produced. Walked back from the step take that owns its file, each step to the take its
 * `inputFingerprints` recorded at an earlier step's address — what made this take, not what the
 * script declares now.
 */
export function patchChainVariants(
  manager: StateManager,
  address: string,
  variantId: string,
): PatchChainVariants | null {
  const state = manager.getState();
  const variant = state.assets[address]?.variants?.[variantId];
  const sourceVariantId = variant?.derivedFrom;
  if (!sourceVariantId) return null;
  const steps: Array<{ address: string; variantId: string }> = [];
  const seen = new Set<string>();
  const visit = (stepAddress: string, stepId: string): void => {
    if (seen.has(stepAddress)) return;
    seen.add(stepAddress);
    const fingerprints = state.assets[stepAddress]?.variants?.[stepId]?.inputFingerprints ?? {};
    for (const [ref, hash] of Object.entries(fingerprints)) {
      if (patchSourceVariantIdOf(ref) !== sourceVariantId) continue;
      const consumed = Object.entries(state.assets[ref]?.variants ?? {}).find(
        ([, v]) => v.file && v.outputHash === hash,
      );
      if (consumed) visit(ref, consumed[0]);
    }
    steps.push({ address: stepAddress, variantId: stepId });
  };
  const owner = variant.file ? variantOwningFile(state, variant.file) : null;
  if (owner && patchSourceVariantIdOf(owner.address) === sourceVariantId) {
    visit(owner.address, owner.variantId);
  }
  return { sourceVariantId, steps };
}

/**
 * A still for the take at `ref` that a take's lineage consumed when it was generated — matched by
 * the output hash its `inputFingerprints` recorded. Null when no take left in state carries those
 * bytes. What the asset info panel draws beside a consumed address.
 */
export function consumedVariantPreviewUrl(
  manager: StateManager,
  videoRoot: string,
  address: string,
  variantId: string,
  ref: string,
  assetBaseUrl: string,
): string | null {
  const origin = generatedOrigin(manager.getState(), address, variantId);
  const hash = manager.tryGetAssetState(address)?.variants?.[origin]?.inputFingerprints?.[ref];
  if (!hash) return null;
  const match = Object.entries(manager.tryGetAssetState(ref)?.variants ?? {}).find(
    ([, v]) => v.file && v.outputHash === hash,
  );
  return match ? variantPreviewUrl(videoRoot, ref, match[0], match[1], assetBaseUrl) : null;
}

/** Served URL for a variant's playable media (video or audio) file, or undefined otherwise. */
export function variantMediaUrl(
  manager: StateManager,
  addr: string,
  variantId: string,
  assetBaseUrl: string,
): string | undefined {
  try {
    const file = manager.getAssetState(addr).variants?.[variantId]?.file;
    if (!file) return undefined;
    const mediaType = inferMediaType(file);
    if (mediaType !== "video" && mediaType !== "audio") return undefined;
    return variantFileUrl(addr, variantId, file, assetBaseUrl);
  } catch {
    return undefined;
  }
}
