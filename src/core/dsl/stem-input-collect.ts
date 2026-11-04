import type { StemInputOccurrence } from "../stem-mouth-check.js";
import type { AdapterMeta } from "./adapter.js";
import { parsePlaceholder } from "./shot-context.js";

// Where a stage's wired `stem` inputs are gathered as `asset()` runs, read by `stem-unmouthed`.
let sink: StemInputOccurrence[] | null = null;
let seen: Set<string> | null = null;

// Called from `beginPromptCollection`.
export function beginStemInputCollection(): void {
  sink = [];
  seen = new Set();
}

export function endStemInputCollection(): StemInputOccurrence[] {
  const collected = sink ?? [];
  sink = null;
  seen = null;
  return collected;
}

// A no-op outside a collection.
export function recordStemInputs(
  address: string,
  meta: AdapterMeta,
  inputs: Readonly<Record<string, unknown>>,
): void {
  if (!sink) return;
  for (const [name, def] of Object.entries(meta.inputs)) {
    if (!def.stem) continue;
    const value = inputs[name];
    const src =
      typeof value === "object" && value !== null ? (value as { src?: unknown }).src : undefined;
    if (typeof src !== "string") continue;
    const source = parsePlaceholder(src) ?? src;
    const key = `${address}\0${source}`;
    if (seen?.has(key)) continue;
    seen?.add(key);
    sink.push({ address, source });
  }
}
