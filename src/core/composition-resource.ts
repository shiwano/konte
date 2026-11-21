import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatCompositionAddress } from "./address.js";
import { buildShotCompositionHtml, compositionRecord } from "./composition-builder.js";
import { sha256Hex } from "./content-hash.js";
import {
  CANONICAL_ASSET_BASE,
  compositionDefinitionHash,
  compositionFingerprintRefs,
  compositionInputFingerprints,
  compositionRefsResolvable,
  findMatchingCompositionVariant,
} from "./leaf-hash.js";
import { shotById } from "./shot-index.js";
import type { StateManager } from "./state/index.js";
import type { StageDefinition } from "./types/index.js";
import { variantDir } from "./variant-dir.js";

const COMPOSITION_HTML_FILE = "composition.html";

interface MaterializeCompositionOptions {
  manager: StateManager;
  video: StageDefinition;
  shotId: string;
}

/**
 * Idempotently materialize a composition variant for a shot. Reuses an existing
 * variant when the definition hash AND input fingerprints are unchanged (no churn,
 * so feedback pinned to it stays valid); otherwise renders the canonical HTML,
 * writes it as the variant artifact, and records the hashes. Returns the variant
 * id, or null if the shot has no composition (shotFn). Mutates in-memory state —
 * the caller is responsible for persisting (e.g. via StateManager.withLock).
 */
export async function materializeCompositionVariant(
  opts: MaterializeCompositionOptions,
): Promise<string | null> {
  const { manager, video, shotId } = opts;
  const shot = shotById(video.shots, shotId);
  if (!shot?.shotFn) return null;

  const definitionHash = compositionDefinitionHash(video, shotId);
  const inputFingerprints = compositionInputFingerprints(
    manager,
    compositionFingerprintRefs(video, shot),
  );

  const compAddress = formatCompositionAddress(video.stage, shotId);
  const existing = manager.tryGetAssetState(compAddress);
  if (existing) {
    const match = findMatchingCompositionVariant(existing, definitionHash, inputFingerprints);
    if (match) return match;
  }

  const built = await buildShotCompositionHtml({
    video,
    manager,
    shotId,
    assetBaseUrl: CANONICAL_ASSET_BASE,
  });

  const variantId = manager.reserveVariantId(compAddress);
  const htmlPath = path.join(
    variantDir(manager.videoRoot, compAddress, variantId),
    COMPOSITION_HTML_FILE,
  );
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  const record = compositionRecord(built.html);
  await fs.writeFile(htmlPath, record, "utf-8");

  const variant = manager.getAssetState(compAddress).variants![variantId]!;
  variant.file = path.relative(manager.videoRoot, htmlPath);
  variant.readyAt = new Date().toISOString();
  variant.outputHash = sha256Hex(record);
  variant.definitionHash = definitionHash;
  variant.inputFingerprints = inputFingerprints;

  return variantId;
}

/**
 * Composition variants that are dead leftovers — safe to drop. A composition is
 * auto-materialized, never rerolled, so it has no "alternative" variants: a variant is dead
 * when it is unaccepted, unlocked, and not the one the current definition + resolved inputs
 * would keep (the live variant). Two cases produce one: the composition's inputs no longer
 * resolve (nothing is materializable, so every unaccepted variant is a stale leftover — e.g.
 * an empty-inputFingerprints ghost from an earlier definition), or the variant simply predates
 * the current definition/inputs. Accepted (the signed-off baseline, kept for re-review) and
 * locked variants are always preserved. Pure — performs no deletion.
 */
export function collectDeadCompositionVariants(
  manager: StateManager,
  video: StageDefinition,
): { address: string; variantId: string }[] {
  const dead: { address: string; variantId: string }[] = [];

  const collect = (
    address: string,
    refs: readonly string[],
    definitionHash: () => string,
    // The refs the variant records, when they are narrower than the ones it renders — the live
    // variant is matched on what was recorded.
    fingerprintRefs: readonly string[] = refs,
  ): void => {
    const target = manager.tryGetAssetState(address);
    if (!target?.variants) return;

    // The variant the current definition would keep, if its inputs resolve; otherwise
    // nothing is materializable and there is no keeper (every unaccepted variant is dead).
    let liveId: string | null = null;
    if (compositionRefsResolvable(manager, refs)) {
      liveId = findMatchingCompositionVariant(
        target,
        definitionHash(),
        compositionInputFingerprints(manager, fingerprintRefs),
      );
    }

    for (const [variantId, v] of Object.entries(target.variants)) {
      if (v.status === "accepted" || variantId === liveId) continue;
      dead.push({ address, variantId });
    }
  };

  for (const shot of video.shots) {
    if (!shot.shotFn) continue;
    collect(
      formatCompositionAddress(video.stage, shot.id),
      shot.compositionRefs ?? [],
      () => compositionDefinitionHash(video, shot.id),
      compositionFingerprintRefs(video, shot),
    );
  }

  return dead;
}
