import { useMemo } from "react";
import type { VariantInfo } from "../types.js";

/**
 * The variant each address shows: a gallery pick (`selectedVariants`) wins; else the newest fresh
 * (isNew) take, so a reroll beside the accepted one is visible without opening the gallery — a
 * default derived from state, not a user action, so it never counts as a pending change. An
 * address absent here shows its resolved/accepted variant. An asset reporting
 * `hasNewerVariant: false` keeps that one.
 */
export function useEffectiveVariants(
  assets: ReadonlyArray<{
    address: string;
    variants: VariantInfo[];
    hasNewerVariant?: boolean;
  }>,
  selectedVariants: Record<string, string>,
): Record<string, string> {
  const autoDefaults = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of assets) {
      if (a.hasNewerVariant === false) continue;
      const fresh = a.variants.find((v) => v.isNew);
      if (fresh) map[a.address] = fresh.variantId;
    }
    return map;
  }, [assets]);
  return useMemo(
    () => ({ ...autoDefaults, ...selectedVariants }),
    [autoDefaults, selectedVariants],
  );
}
