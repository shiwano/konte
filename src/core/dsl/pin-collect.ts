import type { PinOccurrence } from "../pin-check.js";
import type { AdapterMeta } from "./adapter.js";
import { parsePlaceholder } from "./shot-context.js";

// Where a stage's `pin` inputs are gathered while it is being built, read at the spend gate and by
// `status`. Collected as `asset()` runs, like the prompts (see prompt-collect).
//
// Kept off the AssetDefinition: copying it into `inputs` would move every definition hash.
let sink: PinOccurrence[] | null = null;
let seen: Set<string> | null = null;

// Begins a collection, discarding whatever a previous one leaked. Called from
// `beginPromptCollection`, which every build entry already runs: the two span the same pass.
export function beginPinCollection(): void {
  sink = [];
  seen = new Set();
}

export function endPinCollection(): PinOccurrence[] {
  const collected = sink ?? [];
  sink = null;
  seen = null;
  return collected;
}

// Records every `pin` input of one declared asset, WIRED OR NOT — an empty slot is what tells
// `join-unpinned` that this model could have carried the seam. A no-op outside a collection — only
// the discovery pass describes the definition.
export function recordPinInputs(
  address: string,
  meta: AdapterMeta,
  inputs: Readonly<Record<string, unknown>>,
  clip?: PinOccurrence["clip"],
): void {
  if (!sink) return;
  for (const [name, def] of Object.entries(meta.inputs)) {
    if (!def.pin) continue;
    const value = inputs[name];
    const raw =
      typeof value === "object" && value !== null ? (value as { src?: unknown }).src : undefined;
    const source = typeof raw === "string" ? (parsePlaceholder(raw) ?? raw) : undefined;
    // A build function may run more than once inside one collection. The same declaration is one
    // occurrence.
    const key = `${address}\0${name}\0${source ?? ""}`;
    if (seen?.has(key)) continue;
    seen?.add(key);
    sink.push({
      address,
      input: name,
      pin: def.pin,
      ...(source !== undefined ? { source } : {}),
      ...(clip ? { clip } : {}),
    });
  }
}
