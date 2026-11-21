import { holdsHumanVerdict, keepAcceptedInputs } from "../../../core/accept-cascade.js";
import { keptViaMarker, parseKeptVia } from "../../../core/kept-via.js";
import type { StateManager } from "../../../core/state/index.js";
import type { KeepEntryBody, RegenerateEntryBody } from "../../../core/types/review-submit.js";

/**
 * Keeps each take a Keep named, bar the ones a Regenerate names — only while it is still the
 * accepted take, and only against the upstream the page kept it against. Returns the addresses kept.
 * Run under the state lock, after every accept of the review.
 */
export function applyKeepDecisions(
  mgr: StateManager,
  entries: readonly KeepEntryBody[],
  regenerate: readonly RegenerateEntryBody[] = [],
): string[] {
  const skip = new Set(regenerate.map((r) => r.address));
  const kept: string[] = [];
  for (const entry of entries) {
    if (skip.has(entry.address) || !acceptedVerdict(mgr, entry)) continue;
    const direct = keepAcceptedInputs(
      mgr,
      entry.address,
      entry.variantId,
      (input) => input.current === entry.inputs[input.address],
    );
    const viaKept = keepVia(mgr, entry);
    if (direct.length > 0 || viaKept) kept.push(entry.address);
  }
  return kept;
}

// An input konte re-makes is kept against the upstream takes it is to be made from, while each is
// still what its address resolves to.
function keepVia(mgr: StateManager, entry: KeepEntryBody): boolean {
  const variant = mgr.getAssetState(entry.address).variants![entry.variantId]!;
  let wrote = false;
  for (const [dep, seen] of Object.entries(entry.inputs)) {
    const upstreams = parseKeptVia(seen);
    if (!upstreams || !(dep in (variant.inputFingerprints ?? {}))) continue;
    const standing = Object.entries(upstreams).every(
      ([upstream, hash]) =>
        mgr.tryGetAssetState(upstream) !== undefined &&
        mgr.resolveReference(upstream)?.outputHash === hash,
    );
    if (!standing) continue;
    const prior = parseKeptVia(variant.keptInputs?.[dep] ?? "") ?? {};
    variant.keptInputs = {
      ...variant.keptInputs,
      [dep]: keptViaMarker({ ...prior, ...upstreams }),
    };
    wrote = true;
  }
  return wrote;
}

function acceptedVerdict(
  mgr: StateManager,
  variant: { address: string; variantId: string },
): boolean {
  return (
    mgr.tryGetAssetState(variant.address) !== undefined &&
    mgr.getAcceptedVariant(variant.address) === variant.variantId &&
    holdsHumanVerdict(mgr, variant.address)
  );
}

/**
 * Takes each take a Regenerate named off its accept and dismisses it, while it is still the accepted
 * take: an address holding only dismissed takes is what `generate` makes again. Returns the
 * addresses. Run under the state lock.
 */
export function applyRegenerateDecisions(
  mgr: StateManager,
  entries: readonly RegenerateEntryBody[] = [],
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!acceptedVerdict(mgr, entry)) continue;
    mgr.setUnaccepted(entry.address, entry.variantId);
    try {
      mgr.setDismissed(entry.address, entry.variantId, true);
    } catch {
      // A take a patch was made from cannot be dismissed; unaccepted, it is still regenerated.
    }
    out.push(entry.address);
  }
  return out;
}
