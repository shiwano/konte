import type { KonteState } from "./types/index.js";

export function findVariantAddress(state: KonteState, variantId: string): string | null {
  for (const [address, target] of Object.entries(state.assets)) {
    if (target.variants?.[variantId]) return address;
  }
  return null;
}

export function variantAddresses(state: KonteState): Map<string, string> {
  const out = new Map<string, string>();
  for (const [address, target] of Object.entries(state.assets)) {
    for (const variantId of Object.keys(target.variants ?? {})) out.set(variantId, address);
  }
  return out;
}
