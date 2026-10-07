import { assetNameOf, parseAddress } from "../../../core/address.js";
import { parsePlaceholder } from "../../../core/dsl/shot-context.js";
import type { PromptOccurrence } from "../../../core/prompt-check.js";
import type { AssetDefinition } from "../../../core/types/index.js";
import type {
  AssetGenerationInfo,
  AssetInfo,
  AssetInputInfo,
  AssetPatchStepInfo,
  AssetPromptInfo,
  AssetRefInfo,
} from "../../../pages/preview/types.js";

function refOf(def: AssetDefinition): string {
  switch (def.kind) {
    case "comfy":
      return def.workflow;
    case "fal":
      return def.endpointId;
    case "local":
      return def.operation;
    case "file":
      return def.path;
  }
}

// A value as the panel prints it: every `__konte:…__` placeholder swapped for the address it names.
function displayValue(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "string") return parsePlaceholder(value) ?? value;
  if (typeof value === "function") return "[function]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out = Array.isArray(value)
    ? value.map((item) => displayValue(item, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, displayValue(item, seen)]),
      );
  seen.delete(value);
  return out;
}

function collectRefs(value: unknown, seen: Set<object>, out: Set<string>): void {
  if (typeof value === "string") {
    const address = parsePlaceholder(value);
    if (address) out.add(address);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectRefs(item, seen, out);
  }
}

function formatValue(value: unknown): string {
  const shown = displayValue(value, new Set());
  if (typeof shown === "string") return shown;
  return JSON.stringify(shown, null, 2) ?? String(shown);
}

// A fal target is a path into a nested object (`a.b`), a comfy one a flat key that happens to hold
// a dot (`136.width`) — so the flat lookup is tried first and the walk is the fal case.
function valueAt(inputs: Readonly<Record<string, unknown>>, key: string): unknown {
  if (key in inputs) return inputs[key];
  let cursor: unknown = inputs;
  for (const part of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

// Every path a value bottoms out at, in the shape `inputLabels` keys them. An array is a leaf — fal
// writes one whole (a list of image URLs).
function leafPaths(prefix: string, value: unknown, out: string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    out.push(prefix);
    return;
  }
  for (const [key, item] of Object.entries(value)) leafPaths(`${prefix}.${key}`, item, out);
}

// Whether the labels speak for a top-level key: either they name it outright, or — for a nested
// object a fal path writes into — they name every leaf under it. A partially labelled object is not
// accounted for and is printed whole below, so no input is silently dropped.
function accountedFor(key: string, value: unknown, labels: Record<string, string>): boolean {
  if (key in labels) return true;
  const leaves: string[] = [];
  leafPaths(key, value, leaves);
  return leaves.length > 0 && leaves.every((leaf) => leaf in labels);
}

// One row per DECLARED input, in declaration order, reading its value back out of the built
// definition; `also` targets collapse into the one input that wrote them. Whatever the labels do not
// account for follows, under the backend's own key — a hand-written definition, or one built before
// its adapter declared labels.
//
// The prompt section prints the conditioning text already, so it is dropped here — by input name
// where there are labels, and by value where there are none, which also suppresses a second input
// holding the same string.
function labelledInputs(
  def: Extract<AssetDefinition, { inputs: Record<string, unknown> }>,
  prompts: readonly AssetPromptInfo[],
  refInfo: (address: string) => AssetRefInfo,
): AssetInputInfo[] {
  const row = (name: string, value: unknown): AssetInputInfo => {
    const refs = new Set<string>();
    collectRefs(value, new Set(), refs);
    return { name, value: formatValue(value), refs: [...refs].map(refInfo) };
  };

  const labels: Record<string, string> = ("inputLabels" in def ? def.inputLabels : undefined) ?? {};
  const promptNames = new Set(prompts.map((p) => p.input));
  const promptValues = new Set(prompts.map((p) => p.value));

  const byName = new Map<string, string[]>();
  for (const [target, name] of Object.entries(labels)) {
    byName.set(name, [...(byName.get(name) ?? []), target]);
  }

  const out: AssetInputInfo[] = [];
  for (const [name, targets] of byName) {
    if (promptNames.has(name)) continue;
    const target = targets.find((t) => valueAt(def.inputs, t) !== undefined) ?? targets[0]!;
    const value = valueAt(def.inputs, target);
    if (value === undefined) continue;
    out.push(row(name, value));
  }
  for (const [key, value] of Object.entries(def.inputs)) {
    if (accountedFor(key, value, labels)) continue;
    if (typeof value === "string" && promptValues.has(value)) continue;
    out.push(row(key, value));
  }
  return out;
}

// A declared input's value by the name the adapter declares it under: through the labels for a
// backend-keyed definition, directly for a local one, whose inputs already carry those names.
function declaredValue(
  def: Extract<AssetDefinition, { inputs: Record<string, unknown> }>,
  name: string,
): unknown {
  const labels = "inputLabels" in def ? def.inputLabels : undefined;
  if (!labels) return def.inputs[name];
  for (const [target, label] of Object.entries(labels)) {
    if (label !== name) continue;
    const value = valueAt(def.inputs, target);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The chain step takes a patched take was produced by, upstream first. */
export interface PatchChainTakes {
  sourceVariantId: string;
  steps: ReadonlyArray<{ address: string; variantId: string }>;
}

/**
 * Reads the declaration one take was generated from — its `definition.json` snapshot — for the
 * review page's asset info panel. A take with no snapshot (cleaned, a `file` mirror) yields nothing.
 * A patched take reads as each chain step's own declaration and its source take's.
 *
 * `prompts` only says which inputs are prompt text, by the name the stage's or patch's prompt
 * collection recorded them under; every value is the snapshot's. `consumedPreviewUrl` supplies the
 * still of the take this one consumed at a referenced address.
 */
export function createAssetInfoBuilder(
  prompts: readonly PromptOccurrence[],
  snapshotOf: (address: string, variantId: string) => AssetDefinition | null,
  consumedPreviewUrl: (address: string, variantId: string, ref: string) => string | null,
  patchChainOf: (address: string, variantId: string) => PatchChainTakes | null = () => null,
): (address: string, variantId: string) => AssetInfo | undefined {
  const generation = (address: string, variantId: string): AssetGenerationInfo | undefined => {
    const def = snapshotOf(address, variantId);
    if (!def) return undefined;

    const promptInfos: AssetPromptInfo[] = [];
    if ("inputs" in def) {
      const seen = new Set<string>();
      for (const p of prompts) {
        if (p.address !== address || seen.has(p.input)) continue;
        seen.add(p.input);
        const value = declaredValue(def, p.input);
        if (typeof value !== "string" || value.trim() === "") continue;
        promptInfos.push({
          input: p.input,
          kind: p.negative ? "negative" : p.spoken ? "spoken" : "prompt",
          value,
        });
      }
    }

    const refInfo = (ref: string): AssetRefInfo => ({
      address: ref,
      imageUrl: consumedPreviewUrl(address, variantId, ref),
    });
    const inputs = "inputs" in def ? labelledInputs(def, promptInfos, refInfo) : [];

    return {
      backend: def.kind,
      ref: refOf(def),
      deterministic: def.deterministic === true,
      prompts: promptInfos,
      inputs,
    };
  };

  return (address: string, variantId: string): AssetInfo | undefined => {
    const source = generation(address, variantId);
    const chain = patchChainOf(address, variantId);
    if (!chain) return source;
    const steps = chain.steps.flatMap((step): AssetPatchStepInfo[] => {
      const info = generation(step.address, step.variantId);
      if (!info) return [];
      return [{ name: assetNameOf(parseAddress(step.address)), ...step, ...info }];
    });
    if (!source && steps.length === 0) return undefined;
    return { patch: { sourceVariantId: chain.sourceVariantId, source: source ?? null, steps } };
  };
}
