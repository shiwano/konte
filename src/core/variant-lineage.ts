import type { KonteState, VariantState } from "./types/index.js";
import * as path from "node:path";
import { variantDir } from "./variant-dir.js";

/**
 * A patch produces a new variant at the same address, pointing back at the take it corrected
 * (`derivedFrom`). That turns an address's variants into a forest, and the shape of that forest
 * decides two things nothing else does:
 *
 * - **What is reviewable.** Only a leaf (no descendants) is a candidate. A variant that has been
 *   patched is no longer one of the choices — it is the "before" of the one that replaced it.
 * - **What dies together.** A lineage is cleaned as a unit, and a variant with an accepted
 *   descendant is protected (its file is still the input for re-applying the patch).
 *
 * These are pure state functions so staleness, status, clean and the preview server can all agree
 * without any of them re-deriving the rule.
 *
 * The forest is one level deep: a take a patch produced cannot itself be patched
 * (`assertPatchableTarget`), so a source's children are all leaves. `collectDescendants` stays
 * transitive anyway — it feeds the deletion paths, where over-including is safe and re-deriving the
 * depth invariant at each caller is not.
 */

function variantsOf(state: KonteState, address: string): Record<string, VariantState> {
  return state.assets[address]?.variants ?? {};
}

/** Variant ids directly derived from `variantId`. */
function childVariantIds(state: KonteState, address: string, variantId: string): string[] {
  return Object.entries(variantsOf(state, address))
    .filter(([, v]) => v.derivedFrom === variantId)
    .map(([id]) => id);
}

/** Whether `variantId` is a review candidate: nothing was derived from it. */
export function isReviewLeaf(state: KonteState, address: string, variantId: string): boolean {
  return childVariantIds(state, address, variantId).length === 0;
}

/** Every variant derived from `variantId`, transitively. Excludes `variantId` itself. */
export function collectDescendants(
  state: KonteState,
  address: string,
  variantId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([variantId]);
  const queue = [variantId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childVariantIds(state, address, current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Whether any descendant of `variantId` is accepted — the signal that its file must be kept even
 * though the variant itself is no longer a review candidate: it is the patch's input, and deleting
 * it would strand the accepted correction with nothing to re-derive from.
 */
export function hasAcceptedDescendant(
  state: KonteState,
  address: string,
  variantId: string,
): boolean {
  const variants = variantsOf(state, address);
  return collectDescendants(state, address, variantId).some(
    (id) => variants[id]?.status === "accepted",
  );
}

export type VariantRef = { address: string; variantId: string };

/**
 * `<address> <variantId>` of a take -> the accepted takes made from it, directly or through the
 * takes they consumed: an `inputFingerprints` entry matched against a take's `outputHash`. A patched
 * take's fingerprints are merged rather than consumed, so its provenance also runs through the take
 * it corrected and the step that owns its file.
 */
export function acceptedConsumers(state: KonteState): Map<string, VariantRef[]> {
  const out = new Map<string, VariantRef[]>();
  // The `variantOwningFile` rule, indexed once: a file inside its own variant's directory.
  const owners = new Map<string, VariantRef>();
  for (const [address, asset] of Object.entries(state.assets)) {
    for (const [variantId, variant] of Object.entries(asset.variants ?? {})) {
      if (!variant.file) continue;
      const file = path.join(variant.file);
      try {
        if (file.startsWith(`${variantDir("", address, variantId)}${path.sep}`)) {
          owners.set(file, { address, variantId });
        }
      } catch {
        // unparseable address: owns no directory
      }
    }
  }
  for (const [address, asset] of Object.entries(state.assets)) {
    for (const [variantId, variant] of Object.entries(asset.variants ?? {})) {
      if (variant.status !== "accepted") continue;
      const root = { address, variantId };
      const seen = new Set<string>([`${address} ${variantId}`]);
      const visit = (at: string, id: string, v: VariantState | undefined) => {
        const key = `${at} ${id}`;
        if (!v || seen.has(key)) return;
        seen.add(key);
        out.set(key, [...(out.get(key) ?? []), root]);
        walk(at, v);
      };
      const walk = (at: string, consumer: VariantState) => {
        for (const [dep, hash] of Object.entries(consumer.inputFingerprints ?? {})) {
          for (const [depId, depVariant] of Object.entries(variantsOf(state, dep))) {
            if (depVariant.outputHash === hash) visit(dep, depId, depVariant);
          }
        }
        if (consumer.derivedFrom) {
          visit(at, consumer.derivedFrom, variantsOf(state, at)[consumer.derivedFrom]);
        }
        const owner = consumer.file ? owners.get(path.join(consumer.file)) : undefined;
        if (owner) {
          visit(owner.address, owner.variantId, variantsOf(state, owner.address)[owner.variantId]);
        }
      };
      walk(address, variant);
    }
  }
  return out;
}

/**
 * Whether a variant is a decision to keep: accepted, the source of an accepted patch, or what an
 * accepted take was made from. What `clean` never deletes and what `assets/.gitignore` lets git
 * track (see `assets-gitignore.ts`). Pass `consumers` when asking about many variants of one state.
 */
export function isProtectedVariant(
  state: KonteState,
  address: string,
  variantId: string,
  consumers: Map<string, VariantRef[]> = acceptedConsumers(state),
): boolean {
  return (
    variantsOf(state, address)[variantId]?.status === "accepted" ||
    hasAcceptedDescendant(state, address, variantId) ||
    consumers.has(`${address} ${variantId}`)
  );
}

// The take a patch lineage was generated from: a patched take is generated from nothing of its own,
// and its fingerprints are merged (see `patchInputFingerprints`), not what anything consumed.
export function generatedOrigin(state: KonteState, address: string, variantId: string): string {
  const variants = state.assets[address]?.variants ?? {};
  let origin = variantId;
  const seen = new Set<string>();
  for (let from = variants[origin]?.derivedFrom; from && !seen.has(from); ) {
    seen.add(from);
    origin = from;
    from = variants[origin]?.derivedFrom;
  }
  return origin;
}
