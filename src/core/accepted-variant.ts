import type { KonteState, VariantState } from "./types/index.js";

export type AcceptedVariant = { variantId: string; variant: VariantState };

export function acceptedVariant(state: KonteState, address: string): AcceptedVariant | null {
  for (const [variantId, variant] of Object.entries(state.assets[address]?.variants ?? {})) {
    if (variant.status === "accepted") return { variantId, variant };
  }
  return null;
}

export function acceptedVariantId(state: KonteState, address: string): string | null {
  return acceptedVariant(state, address)?.variantId ?? null;
}
