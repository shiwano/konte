import { parseAddress } from "../../../core/address.js";
import { KonteError } from "../../../core/errors.js";
import { variantsNewestFirst } from "../../../core/staleness.js";
import type { StateManager } from "../../../core/state/index.js";

/**
 * Resolve an asset-op argument that may be either a variant id (`v-…`) or a full
 * address (`<stage>:<path>`) to its `{ address, variantId }`. A variant id is looked
 * up directly; an address lands on the take it resolves to — accepted, else the newest
 * ready non-stale one, else the newest stale one: the same take `konte ref` prints and the
 * review surfaces show, so an accept made by address lands on what was on screen.
 *
 * An address that still resolves to nothing — every take fileless, or every one dismissed — fails
 * with the candidate list: there is no take on screen to mean, so the caller has to name one.
 *
 * `:` is the discriminator: variant ids never contain one, so any `:` signals address
 * intent and `parseAddress` owns validation (a malformed address fails as such, not as
 * a missing variant).
 */
export function resolveVariantArg(
  manager: StateManager,
  arg: string,
): { address: string; variantId: string } {
  if (!arg.includes(":")) {
    return { address: manager.resolveVariantAddress(arg), variantId: arg };
  }

  const address = arg;
  parseAddress(address);
  const variants = manager.getState().assets[address]?.variants;
  const ids = variants ? variantsNewestFirst(variants).map(([id]) => id) : [];
  if (ids.length === 0) {
    throw new KonteError("VARIANT_NOT_FOUND", `No variants found for address "${address}"`);
  }
  const resolved = manager.selectVariant(address, { includeStale: true });
  if (resolved) return { address, variantId: resolved.variantId };
  if (ids.length > 1) {
    throw new KonteError(
      "VARIANT_AMBIGUOUS",
      `Address "${address}" has ${ids.length} variants — pass a variant id instead. Candidates: ${ids.join(", ")}`,
    );
  }
  return { address, variantId: ids[0]! };
}
