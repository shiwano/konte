import type { PromptOccurrence } from "../prompt-check.js";
import type { AdapterMeta } from "./adapter.js";
import { beginClipLengthCollection } from "./clip-length-collect.js";
import { beginImageInputCollection } from "./image-input-collect.js";
import { beginPinCollection } from "./pin-collect.js";

// Where a stage's `"prompt"`, `"negativePrompt"` and `"spokenText"` values are gathered while it
// is being built, read at the spend gate and by `konte inspect --prompts`.
// They are collected as `asset()` runs because only that pass knows the address each belongs to; an
// AssetDefinition's inputs are keyed by workflow target and carry no type.
//
// Kept off the AssetDefinition: exemptions are RegExps, and a prompt value already lives in
// `inputs` — copying it there would move every definition hash.
let sink: PromptOccurrence[] | null = null;
let seen: Set<string> | null = null;
// Mutable, and every occurrence holds this same array: a `respell()` reached during the build
// declares another spelling of a line konte must not read as prompt text.
let script: string[] = [];

// Begins a collection, discarding whatever a previous one leaked (a definition that threw mid-build
// never ends its scope, and the next build must not inherit its prompts).
// Also begins the clip-length, pin and image-input collections: each spans exactly this
// pass, and every build entry already calls this one.
export function beginPromptCollection(spokenLines: readonly string[] = []): void {
  beginClipLengthCollection();
  beginPinCollection();
  beginImageInputCollection();
  sink = [];
  seen = new Set();
  script = [...spokenLines];
}

// Another spelling of a line the direction already declared — see `respell`. A no-op outside a
// collection, which is every render pass re-running the same build.
export function recordSpokenLine(text: string): void {
  if (sink && !script.includes(text)) script.push(text);
}

export function endPromptCollection(): PromptOccurrence[] {
  const collected = sink ?? [];
  sink = null;
  seen = null;
  script = [];
  return collected;
}

// The address a declaration built outside any stage discovery is recorded under, for the caller to
// stamp with the real one afterwards: a delivery upscale is written in `video.tsx` but belongs to
// the `#delivery` address the export synthesizes for it, which only the export layer knows.
export const UNADDRESSED = "";

// The words a prompt value carries, for an adapter that declares where its model's lines are
// written, each with the marked text it was written inside (`<d>[English] …</d>`), which the prompt
// check splices the words back out of. A fresh RegExp per call: a
// declared `/g` pattern keeps `lastIndex` between matches, and one adapter's meta is shared by every
// asset built from it.
function spokenWithin(pattern: RegExp, value: string): { words: string[]; marks: string[] } {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const words: string[] = [];
  const marks: string[] = [];
  for (const match of value.matchAll(new RegExp(pattern.source, flags))) {
    const said = (match[1] ?? "").trim();
    if (said === "") continue;
    words.push(said);
    marks.push(match[0]);
  }
  return { words, marks };
}

// Records every `"prompt"`, `"negativePrompt"` and `"spokenText"` input of one declared asset. A no-op outside a
// collection — the render passes re-run the same shot functions, and only the discovery pass
// describes the definition.
export function recordPromptInputs(
  address: string,
  meta: AdapterMeta,
  inputs: Readonly<Record<string, unknown>>,
): void {
  if (!sink) return;
  for (const [name, def] of Object.entries(meta.inputs)) {
    if (def.type !== "prompt" && def.type !== "negativePrompt" && def.type !== "spokenText") {
      continue;
    }
    // The default is what the model receives when the caller passes nothing; a computed one has no
    // static text to read.
    const value = inputs[name] ?? def.default;
    if (typeof value !== "string" || value.trim() === "") continue;
    // A build function may be evaluated more than once inside one collection (a starter that
    // discovers a shot the stage then discovers again). The same declaration is one occurrence.
    const key = `${address}\0${name}\0${value}`;
    if (seen?.has(key)) continue;
    seen?.add(key);
    const within =
      def.type === "prompt" && meta.spokenTextPattern
        ? spokenWithin(meta.spokenTextPattern, value)
        : { words: [], marks: [] };
    sink.push({
      address,
      input: name,
      value,
      ...(def.type === "negativePrompt" ? { negative: true as const } : {}),
      ...(def.type === "spokenText" ? { spoken: true as const } : {}),
      ...(within.words.length > 0 ? { spokenWithin: within.words, spokenMarks: within.marks } : {}),
      ...(meta.promptExemptions ? { exemptions: meta.promptExemptions } : {}),
      ...(script.length > 0 ? { script } : {}),
    });
  }
}
