import type { VariantInfo } from "../types.js";

// A variant still awaiting a verdict, accepted beside it or not — badged and counted "new".
export function isNewVariant(
  v: Pick<VariantInfo, "variantStatus" | "stale" | "dismissed">,
): boolean {
  return v.variantStatus !== "accepted" && !v.stale && !v.dismissed;
}
