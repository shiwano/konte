// The variant check: what konte finds wrong with a landed variant before anyone reviews it, read off
// what was measured when it landed. A variant with a finding holds its stage's review until it is
// dismissed or vouched for (`konte vouch`); a reroll draws a take beside it and settles nothing.

import { type AssetStage, listAssetPaths } from "./address.js";
import type { StageDefinitions } from "./definition-hashes.js";
import { KonteError } from "./errors.js";
import { linesOwedAt, takeMishearing } from "./speech-hearing.js";
import type { StateManager } from "./state/index.js";
import type { KonteState, VariantState } from "./types/index.js";
import { variantOwningFile } from "./variant-dir.js";

export type VariantFindingType = "silent" | "line-misheard";

export interface VariantFinding {
  type: VariantFindingType;
  detail: string;
}

export interface VariantFindings {
  address: string;
  variantId: string;
  findings: VariantFinding[];
}

export function measuredSilent(variant: VariantState): boolean {
  const media = variant.media;
  if (media?.kind === "audio") return media.silent === true;
  return media?.kind === "video" && media.audio?.silent === true;
}

/**
 * What is wrong with the variant `variantId` at `address`. Silence counts on an audio take and on
 * one that owes a line, as does a video that owes one with no audio track. `lang` is the language
 * the lines are written in.
 */
export function checkVariant(opts: {
  videoRoot: string;
  state: KonteState;
  address: string;
  variantId: string;
  variant: VariantState;
  lines: readonly string[];
  lang: string;
}): VariantFinding[] {
  const { variant, lines } = opts;
  if (measuredSilent(variant) && (variant.media?.kind === "audio" || lines.length > 0)) {
    return [{ type: "silent", detail: "is silent" }];
  }
  if (variant.media?.kind === "video" && variant.media.audio === null && lines.length > 0) {
    return [{ type: "silent", detail: "has no audio track" }];
  }
  // A patched take points at its chain's returned step, which was heard when it landed.
  const heardAt = (variant.file && variantOwningFile(opts.state, variant.file)) || opts;
  const wrong = takeMishearing(
    opts.videoRoot,
    heardAt.address,
    heardAt.variantId,
    variant.outputHash,
    lines,
    opts.lang,
  );
  return wrong ? [{ type: "line-misheard", detail: wrong }] : [];
}

const ASSET_STAGES: readonly AssetStage[] = ["reference", "animatic", "video"];

/**
 * The findings on every variant awaiting review that no one vouched for — at the addresses `stage`
 * defines, or every stage. An address the definition no longer holds is nobody's review.
 */
export function unvouchedFindings(opts: {
  videoRoot: string;
  manager: StateManager;
  definitions: StageDefinitions;
  lang: string;
  stage?: AssetStage;
}): VariantFindings[] {
  const state = opts.manager.getState();
  const cache = opts.manager.stalenessCache();
  const found: VariantFindings[] = [];
  const addresses = (opts.stage ? [opts.stage] : ASSET_STAGES).flatMap((stage) => {
    const def = opts.definitions[stage];
    return def ? listAssetPaths(def, stage) : [];
  });
  for (const address of addresses) {
    if (!state.assets[address]) continue;
    const lines = linesOwedAt(opts.definitions, address);
    for (const variantId of opts.manager.readyUndecidedTakes(address, cache)) {
      const variant = state.assets[address]!.variants![variantId]!;
      if (variant.vouchedAt) continue;
      const findings = checkVariant({
        videoRoot: opts.videoRoot,
        state,
        address,
        variantId,
        variant,
        lines,
        lang: opts.lang,
      });
      if (findings.length > 0) found.push({ address, variantId, findings });
    }
  }
  return found;
}

export function formatFindings(findings: readonly VariantFinding[]): string {
  return findings.map((f) => f.detail).join("; ");
}

export function formatVariantFindings(v: VariantFindings): string {
  return `${v.address} ${v.variantId}: ${formatFindings(v.findings)}`;
}

export function assertNoVariantFindings(found: readonly VariantFindings[], blocked: string): void {
  if (found.length === 0) return;
  throw new KonteError(
    "VARIANT_CHECK_FAILED",
    `${blocked} — the variant check found ${found.length} take(s) wrong; dismiss a broken one ` +
      `(reroll for another beside it), or \`konte vouch <variantId>\` one that is fine`,
    found.map((v) => `  ${formatVariantFindings(v)}`),
  );
}
