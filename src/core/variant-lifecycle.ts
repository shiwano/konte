import type { VariantState } from "./types/index.js";

// `reserved`: its job has yet to settle, or it never got one.
export type VariantLifecycle = "ready" | "reserved" | "failed" | "cancelled";

export function variantLifecycle(variant: VariantState): VariantLifecycle {
  if (variant.file) return "ready";
  if (variant.metadata?.error) return "failed";
  if (variant.metadata?.cancelledAt) return "cancelled";
  return "reserved";
}
