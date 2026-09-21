import { KonteError } from "./errors.js";
import type { StateManager } from "./state/index.js";
import type { AssetDefinition, KonteState, VariantState } from "./types/index.js";

/** What identifies the patched take a chain produces: which take it corrects, under which script. */
export interface PatchOutputOrigin {
  sourceAddress: string;
  sourceVariantId: string;
  patchHash: string;
}

/**
 * What the waiter needs to finalize a patch step's job, snapshotted from the PATCH's own definition
 * at submit time — the step's address is declared by `patches/<id>.ts`, not by a stage, so the
 * ordinary definition lookup would find nothing. `output` is set on the returned step alone and is what turns its take into the patched variant at the source's address.
 */
export type PatchFinalize = {
  outputNodeId?: string;
  output?: PatchOutputOrigin;
};

export function patchFinalizeOf(
  assetDef: AssetDefinition,
  output?: PatchOutputOrigin,
): PatchFinalize {
  return {
    ...(assetDef.kind === "comfy" && assetDef.outputNodeId !== undefined
      ? { outputNodeId: assetDef.outputNodeId }
      : {}),
    ...(output ? { output } : {}),
  };
}

// Input fingerprints for the patched take. Two departures from the plain path, both required for it
// to present the same staleness surface as the take it corrected:
//
//   - Drop the self-address entry. The chain consumed the source at its own address, pinned to one
//     variant; recording it would compare the take against its own address's accepted output — it
//     would be input-stale against itself.
//   - Inherit the source's fingerprints. The correction was built on the source, which consumed
//     those upstreams; when one of them changes, the correction is just as out of date.
//
// Anything else the chain referenced (a character sheet fed to the edit model, an earlier step) is a
// genuine upstream of its own and is kept.
//
// An accepted source's kept inputs are inherited in place of what it was made from: the correction
// is built on the take as the human kept it.
function patchInputFingerprints(
  stepFingerprints: Record<string, string>,
  sourceAddress: string,
  source: VariantState,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...(source.inputFingerprints ?? {}),
    ...(source.status === "accepted" ? source.keptInputs : undefined),
  };
  for (const [depPath, hash] of Object.entries(stepFingerprints)) {
    if (depPath === sourceAddress) continue;
    merged[depPath] = hash;
  }
  delete merged[sourceAddress];
  return merged;
}

/**
 * The patched variant already registered for a step take, if there is one. The take's file
 * identifies it — one variant, one output directory — so recognizing a finished apply needs no
 * field recording which take a patched variant came from.
 */
export function existingPatchOutput(
  state: KonteState,
  origin: PatchOutputOrigin,
  stepFile: string,
): string | null {
  const variants = state.assets[origin.sourceAddress]?.variants ?? {};
  const found = Object.entries(variants).find(
    ([, v]) =>
      v.derivedFrom === origin.sourceVariantId &&
      v.patchHash === origin.patchHash &&
      v.file === stepFile,
  );
  return found ? found[0] : null;
}

/**
 * Registers the patched take: a variant at the SOURCE's address pointing at the file the chain's
 * returned step produced, and carrying the lineage (`derivedFrom`, `patchHash`) every surface reads
 * a correction through.
 *
 * It points rather than copies. A variant's file need not live under its own directory — a `file`
 * asset's variant already mirrors one anywhere in the video — and duplicating the bytes would buy
 * nothing but a second thing to keep in step. What it does buy is a deletion rule: a variant
 * directory holding another variant's file is not deleted (see `clean`/`prune`).
 *
 * Idempotent per step take: re-running the finalize for a take that already has its variant returns
 * that one, so a re-applied patch and a crash-recovered one both land a single output.
 *
 * Must be called with the state lock held; returns the output variant's id.
 */
export function materializePatchOutput(
  manager: StateManager,
  origin: PatchOutputOrigin,
  step: { address: string; variantId: string },
): string {
  const state = manager.getState();
  const target = manager.ensureAssetState(origin.sourceAddress);
  const source = target.variants?.[origin.sourceVariantId];
  if (!source?.file) {
    throw new KonteError(
      "PATCH_SOURCE_MISSING",
      `Patch source variant "${origin.sourceVariantId}" is gone or has no output file`,
    );
  }
  const stepVariant = state.assets[step.address]?.variants?.[step.variantId];
  if (!stepVariant?.file) {
    throw new KonteError(
      "PATCH_SOURCE_NOT_READY",
      `The chain's returned step "${step.address}" (variant ${step.variantId}) has no output file`,
    );
  }

  const existing = existingPatchOutput(state, origin, stepVariant.file);
  if (existing) return existing;

  const variantId = manager.reserveVariantId(origin.sourceAddress);
  const variant = target.variants![variantId]!;
  variant.file = stepVariant.file;
  variant.outputHash = stepVariant.outputHash;
  // Same file as the step, so the same measurements — inherited, never re-probed.
  if (stepVariant.media) variant.media = stepVariant.media;
  variant.readyAt = new Date().toISOString();
  // Inherited, not the step's: the patched take is still a take of the address's declared asset, so
  // an edit to that asset must stale the whole lineage at once. The chain's own definition is
  // tracked separately by `patchHash`.
  variant.definitionHash = source.definitionHash;
  variant.derivedFrom = origin.sourceVariantId;
  variant.patchHash = origin.patchHash;
  variant.inputFingerprints = patchInputFingerprints(
    stepVariant.inputFingerprints ?? {},
    origin.sourceAddress,
    source,
  );
  if (stepVariant.seed != null) variant.seed = stepVariant.seed;
  variant.metadata = stepVariant.metadata;
  return variantId;
}
