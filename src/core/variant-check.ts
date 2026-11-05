// The variant check: what konte finds wrong with a landed variant before anyone reviews it, read off
// what was measured when it landed. A variant with a finding holds its stage's review until it is
// dismissed or vouched for (`konte vouch`); a reroll draws a take beside it and settles nothing.

import { type AssetStage, listAddresses } from "./address.js";
import type { StageDefinitions } from "./definition-hashes.js";
import type { Direction } from "./dsl/direction.js";
import { linesSaidAt, type SaidLines, variantMishearing } from "./speech-hearing.js";
import type { StateManager } from "./state/index.js";
import type { KonteState, VariantState } from "./types/index.js";
import { variantOwningFile } from "./variant-dir.js";

type VariantFindingType = "silent" | "line-misheard";

interface VariantFinding {
  type: VariantFindingType;
  detail: string;
}

interface VariantFindings {
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
export async function checkVariant(opts: {
  videoRoot: string;
  state: KonteState;
  address: string;
  variantId: string;
  variant: VariantState;
  said: SaidLines;
  lang: string;
}): Promise<VariantFinding[]> {
  const { variant, said } = opts;
  const lines = said.lines;
  if (measuredSilent(variant) && (variant.media?.kind === "audio" || lines.length > 0)) {
    return [{ type: "silent", detail: "is silent" }];
  }
  if (variant.media?.kind === "video" && variant.media.audio === null && lines.length > 0) {
    return [{ type: "silent", detail: "has no audio track" }];
  }
  // A patched take points at its chain's returned step, which was heard when it landed.
  const heardAt = (variant.file && variantOwningFile(opts.state, variant.file)) || opts;
  const wrong = await variantMishearing(
    opts.videoRoot,
    heardAt.address,
    heardAt.variantId,
    variant.outputHash,
    said,
    opts.lang,
  );
  return wrong ? [{ type: "line-misheard", detail: wrong }] : [];
}

const ASSET_STAGES: readonly AssetStage[] = ["reference", "animatic", "video"];

/**
 * The findings on every variant awaiting review that no one vouched for — at the addresses `stage`
 * defines, or every stage. An address the definition no longer holds is nobody's review.
 */
export async function unvouchedFindings(opts: {
  videoRoot: string;
  manager: StateManager;
  definitions: StageDefinitions;
  direction: Direction | null;
  lang: string;
  stage?: AssetStage;
}): Promise<VariantFindings[]> {
  const state = opts.manager.getState();
  const cache = opts.manager.stalenessCache();
  const found: VariantFindings[] = [];
  const addresses = (opts.stage ? [opts.stage] : ASSET_STAGES).flatMap((stage) => {
    const def = opts.definitions[stage];
    return def ? listAddresses(def, stage) : [];
  });
  for (const address of addresses) {
    if (!state.assets[address]) continue;
    const said = linesSaidAt(opts.definitions, opts.direction, address);
    for (const variantId of opts.manager.readyUndecidedVariants(address, cache)) {
      const variant = state.assets[address]!.variants![variantId]!;
      if (variant.vouchedAt) continue;
      const findings = await checkVariant({
        videoRoot: opts.videoRoot,
        state,
        address,
        variantId,
        variant,
        said,
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
