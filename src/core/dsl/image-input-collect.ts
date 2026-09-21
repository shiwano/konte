import type { ImageInputOccurrence } from "../image-inputs.js";
import type { AdapterMeta } from "./adapter.js";
import { parsePlaceholder } from "./shot-context.js";

// Where a stage's plain image inputs are gathered while it is being built, read by `panel-unlinked`
// and `plate-unnested`. Collected as `asset()` runs, like the pins (see pin-collect). Alongside them,
// every address declared with a `readsPrevPanel` adapter.
let sink: ImageInputOccurrence[] | null = null;
let readers: Set<string> | null = null;
let seen: Set<string> | null = null;

// Called from `beginPromptCollection`.
export function beginImageInputCollection(): void {
  sink = [];
  readers = new Set();
  seen = new Set();
}

export function endImageInputCollection(): {
  imageInputs: ImageInputOccurrence[];
  prevPanelReaders: string[];
} {
  const collected = { imageInputs: sink ?? [], prevPanelReaders: [...(readers ?? [])] };
  sink = null;
  readers = null;
  seen = null;
  return collected;
}

// Records every wired plain image input of one declared asset. A no-op outside a collection.
export function recordImageInputs(
  address: string,
  meta: AdapterMeta,
  inputs: Readonly<Record<string, unknown>>,
): void {
  if (!sink) return;
  if (meta.readsPrevPanel) readers?.add(address);
  for (const [name, def] of Object.entries(meta.inputs)) {
    if (def.type !== "image" || def.pin) continue;
    const value = inputs[name];
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const sources = values.flatMap((v) => {
      const src = typeof v === "object" && v !== null ? (v as { src?: unknown }).src : undefined;
      return typeof src === "string" ? [parsePlaceholder(src) ?? src] : [];
    });
    if (sources.length === 0) continue;
    // A build function may run more than once inside one collection.
    const key = `${address}\0${name}`;
    if (seen?.has(key)) continue;
    seen?.add(key);
    sink.push({ address, sources });
  }
}
