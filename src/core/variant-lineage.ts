import type { KonteState, VariantState } from "./types/index.js";

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

/**
 * Whether a variant is a decision to keep: accepted, or the source of an accepted patch. What `clean`
 * never deletes and what `assets/.gitignore` lets git track (see `assets-gitignore.ts`).
 */
export function isProtectedVariant(state: KonteState, address: string, variantId: string): boolean {
  return (
    variantsOf(state, address)[variantId]?.status === "accepted" ||
    hasAcceptedDescendant(state, address, variantId)
  );
}
