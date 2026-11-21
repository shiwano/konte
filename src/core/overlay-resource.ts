import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  formatTimelineOverlayAddress,
  isMaterializedLeafAddress,
  OVERLAY_HTML_FILE,
  tryParseAddress,
} from "./address.js";
import { buildOverlayCompositionHtml, compositionRecord } from "./composition-builder.js";
import { sha256Hex } from "./content-hash.js";
import {
  CANONICAL_ASSET_BASE,
  compositionInputFingerprints,
  findMatchingCompositionVariant,
  overlayDefinitionHash,
  overlayFingerprintRefs,
  recordLeafVariant,
} from "./leaf-hash.js";
import { overlayLineTimer } from "./line-timing.js";
import type { StateManager } from "./state/index.js";
import type { StageDefinition } from "./types/index.js";
import { variantDir } from "./variant-dir.js";

// The overlay is a leaf like a composition: konte renders it, and the shot accepts under it sign it
// off. Its identity is its own structure over the timeline — it is no part of the compositions of
// the shots it is laid over — and the refs it draws.

/** The overlay's own timeline takes: what its accept signs off beside the overlay itself. */
export function overlayTimelineRefs(video: StageDefinition): string[] {
  return (video.overlay?.compositionRefs ?? []).filter((ref) => {
    const parsed = tryParseAddress(ref);
    return (
      parsed?.stage === video.stage &&
      parsed.kind === "timeline" &&
      !parsed.delivery &&
      !isMaterializedLeafAddress(ref)
    );
  });
}

/**
 * Idempotently materialize the overlay's variant: reused while its definition and inputs are
 * unchanged, else rendered to `overlay.html`. Null when the stage declares no overlay. Mutates
 * in-memory state — the caller persists.
 */
export async function materializeOverlayVariant(opts: {
  manager: StateManager;
  video: StageDefinition;
}): Promise<string | null> {
  const { manager, video } = opts;
  if (!video.overlay) return null;
  const definitionHash = overlayDefinitionHash(video);
  const inputFingerprints = compositionInputFingerprints(manager, overlayFingerprintRefs(video));
  const address = formatTimelineOverlayAddress(video.stage);
  const existing = manager.tryGetAssetState(address);
  if (existing) {
    const match = findMatchingCompositionVariant(existing, definitionHash, inputFingerprints);
    if (match) return match;
  }
  const html = compositionRecord(
    await buildOverlayCompositionHtml({
      video,
      manager,
      assetBaseUrl: CANONICAL_ASSET_BASE,
      timeLines: overlayLineTimer(manager),
    }),
  );
  const variantId = manager.reserveVariantId(address);
  const htmlPath = path.join(variantDir(manager.videoRoot, address, variantId), OVERLAY_HTML_FILE);
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html, "utf-8");
  return recordLeafVariant(manager, address, variantId, htmlPath, sha256Hex(html), {
    definitionHash,
    inputFingerprints,
  });
}
