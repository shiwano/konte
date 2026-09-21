import type { AssetDefinition } from "../types/index.js";
import { KonteError } from "../errors.js";
import type { MediaKind, MediaAsset } from "./builders.js";
import { makeMediaAsset } from "./builders.js";
import {
  getPatchContext,
  getReferenceContext,
  getPlatePoolContext,
  getTimelineContext,
  getShotContext,
  makePatchPlaceholder,
  makePlaceholder,
  makeReferencePlaceholder,
  makePlatePlaceholder,
  makeTimelinePlaceholder,
  parsePlaceholder,
  type BuildFormat,
} from "./shot-context.js";
import { recordImageInputs } from "./image-input-collect.js";
import type { PinOccurrence } from "../pin-check.js";
import { clipLengthOf } from "./clip-length-collect.js";
import { recordPinInputs } from "./pin-collect.js";
import { recordPromptInputs } from "./prompt-collect.js";
import {
  assemblePromptInputs,
  promptStructureMeta,
  type PromptStructure,
  type PromptStructureMeta,
} from "./prompt-structure.js";
import type { Identifier } from "./validate-identifier.js";
import { validateAssetName } from "./validate-identifier.js";

export type AdapterBackendKind = "comfy" | "fal" | "local" | "file";

/**
 * The five places `asset()` can be called from. A stage build reaches exactly one — a shot build
 * clears the timeline context.
 */
export type AssetDeclarationSite = "patch" | "plate" | "reference" | "timeline" | "shot";

export interface AdapterMetaInput {
  type: string;
  required: boolean;
  default?: string | number | boolean;
  // The default is a function of the build format, so it has no static value to report. A JSON
  // schema consumer reads this instead of a missing default.
  computed?: boolean;
  // The `step * k + offset` grid this number lands on — konte raises whatever it resolves to onto it.
  grid?: { step: number; offset?: number };
  // The ceiling declared on the input, reported by `adapter show`. Enforced where it is declared —
  // see `AdapterInputDef.max`.
  max?: number;
  // Frames per second a `"frames"` input counts on, when the model samples on its own clock.
  clock?: number;
  // Which end of the clip this image is pinned to — see `AdapterInputDef.pin`. Read by the pin
  // check, and reported by `adapter show`.
  pin?: "start" | "end";
  values?: readonly string[];
  array?: boolean;
  // Optional per-input prose, surfaced by `konte adapter show`. Reserved for what
  // type/values/default can't already convey (units, interactions, gotchas) — omit it
  // where the name and structured fields already say everything.
  description?: string;
  structure?: PromptStructureMeta;
}

// The specifier a `guide` takes: a konte-managed craft doc under the workspace's `.konte/guides/`.
export const GUIDE_SPECIFIER_PREFIX = "konte/guides/";

export function adapterGuides(meta: Pick<AdapterMeta, "guide">): readonly string[] {
  return meta.guide === undefined ? [] : typeof meta.guide === "string" ? [meta.guide] : meta.guide;
}

/**
 * What `konte adapter list`/`show` reports about an adapter without calling it: enough
 * to pick one (backend, media kind, required inputs, prose) and to write the asset()
 * call. `ref` is the backend's own identifier — a workflow filename, an endpoint id,
 * a model slug, an ffmpeg operation.
 */
export interface AdapterMeta {
  backend: AdapterBackendKind;
  mediaType: MediaKind;
  description: string;
  ref: string;
  inputs: Record<string, AdapterMetaInput>;
  // Where the adapter's craft doc lives — prompt-craft for a model, usage for a local op — as
  // `konte/guides/<name>.md` for a konte-managed one or a `./`-relative path beside the adapter
  // file. A list is read in order: the grammar a model's decodes share first, this decode's own
  // last. `adapter show` resolves each to an absolute path and prints that, never the body.
  guide?: string | readonly string[];
  // Where `asset()` may declare this adapter, when it is not every site. An edit model works on a
  // take that has to exist first, so it names `patch` and `reference`. Enforced in `registerAsset`.
  allowedIn?: readonly AssetDeclarationSite[];
  // The negations this model reads as an instruction rather than as an exclusion — H3's freeze
  // clause (`nothing slides, turns, tilts`). A span one of these matches is cut out of a `prompt`
  // or `negativePrompt` value before the prompt check reads it.
  promptExemptions?: readonly RegExp[];
  // Where the spoken words sit inside a `"prompt"` value, for a model whose lines are written
  // into its conditioning instead of into a `"spokenText"` input (H3's `<d>[Japanese] …</d>`).
  // Capture group 1 is the words. Without it konte cannot say which line a take carries: the
  // per-line SCRIPT_UNVOICED rule falls back to the whole-shot one, and the prompt check reads a
  // quoted line as prompt text.
  spokenTextPattern?: RegExp;
  // The model reads the previous shot's last panel, passed to one of its image inputs, as the frame
  // a cut comes from (H3's `[Shot 1]`). `panel-unlinked` asks only such an adapter for that panel.
  readsPrevPanel?: true;
  // The inputs an address's first take is generated with, over their defaults — the model's fast
  // setting. A later take goes back to the defaults. The inputs it names are not in
  // `inputs`: konte sets them, never a stage file.
  turbo?: Record<string, string | number | boolean>;
}

export interface AssetAdapter<TInputs extends Record<string, unknown>, TOutput extends MediaKind> {
  type: TOutput;
  meta: AdapterMeta;
  createDefinition(inputs: TInputs): AssetDefinition;
}

// See `AdapterInputDef.pin`.
export type DeclaredPin = "start" | "end" | { end: { nodeId: string; field: string } };

export function pinnedEnd(pin: DeclaredPin | undefined): "start" | "end" | undefined {
  return typeof pin === "object" ? "end" : pin;
}

interface DeclaredInput {
  type: string;
  fixed?: boolean;
  default?:
    | string
    | number
    | boolean
    | ((format: BuildFormat | undefined) => string | number | boolean);
  grid?: { step: number; offset?: number };
  max?: number;
  clock?: number;
  pin?: DeclaredPin;
  values?: readonly string[];
  required?: boolean;
  array?: boolean;
  description?: string;
  structure?: PromptStructure;
}

export function buildMetaInputs(
  inputs: Record<string, DeclaredInput>,
  turbo: Record<string, unknown> = {},
): Record<string, AdapterMetaInput> {
  return Object.fromEntries(
    Object.entries(inputs)
      .filter(([name, def]) => !def.fixed && !(name in turbo))
      .map(([name, def]) => [
        name,
        {
          type: def.type,
          required: def.required === true,
          ...(typeof def.default === "function"
            ? { computed: true }
            : def.default !== undefined
              ? { default: def.default }
              : {}),
          ...(def.grid ? { grid: def.grid } : {}),
          ...(def.max !== undefined ? { max: def.max } : {}),
          ...(def.clock ? { clock: def.clock } : {}),
          ...(def.pin ? { pin: pinnedEnd(def.pin) } : {}),
          ...(def.values ? { values: [...def.values] } : {}),
          ...(def.array ? { array: true } : {}),
          ...(def.description ? { description: def.description } : {}),
          ...(def.structure ? { structure: structureMeta(name, def) } : {}),
        },
      ]),
  );
}

function structureMeta(name: string, def: DeclaredInput): PromptStructureMeta {
  if (def.type !== "prompt") {
    throw new Error(
      `Input "${name}" is typed "${def.type}", so it takes no structure — only a "prompt" does`,
    );
  }
  return promptStructureMeta(name, def.structure!);
}

// Every invalid turbo declaration is silent (a value the model never reads, a required input nobody
// can pass), so it is rejected where the adapter is declared, as `fixed` inputs are.
export function assertTurboInputs(
  turbo: Record<string, unknown> | undefined,
  inputs: Record<string, DeclaredInput>,
): void {
  for (const [key, value] of Object.entries(turbo ?? {})) {
    const def = inputs[key];
    if (!def) throw new Error(`Turbo names input "${key}", which the adapter does not declare`);
    if (def.type !== "string" && def.type !== "number" && def.type !== "boolean") {
      throw new Error(
        `Turbo input "${key}" must be a string, number or boolean, not "${def.type}"`,
      );
    }
    if (def.fixed || def.required) {
      throw new Error(`Turbo input "${key}" cannot also be fixed or required`);
    }
    if (typeof value !== def.type) {
      throw new Error(`Turbo input "${key}" is typed "${def.type}" but is set to ${typeof value}`);
    }
    if (def.values && !def.values.includes(value as string)) {
      throw new Error(`Turbo input "${key}" sets "${String(value)}", outside its values`);
    }
  }
}

// `fixed` has one coherent shape — a scalar with a literal default, and none of the flags that only
// mean something for a caller-supplied value. Every invalid combination is silent (an unsent field, a
// media field carrying a raw string, an ignored `required`), so they are rejected where the adapter is
// declared: at module load for a prebuilt one, per file for a workspace's own.
export function assertFixedInputs(inputs: Record<string, DeclaredInput>): void {
  for (const [key, def] of Object.entries(inputs)) {
    if (!def.fixed) continue;
    if (def.default === undefined || typeof def.default === "function") {
      throw new Error(`Fixed input "${key}" needs a literal default — that value is what it sends`);
    }
    if (def.type !== "string" && def.type !== "number" && def.type !== "boolean") {
      throw new Error(
        `Fixed input "${key}" must be a string, number or boolean, not "${def.type}"`,
      );
    }
    if (def.required || def.array || def.values) {
      throw new Error(`Fixed input "${key}" cannot also set required, array or values`);
    }
    if (typeof def.default !== def.type) {
      throw new Error(
        `Fixed input "${key}" is typed "${def.type}" but defaults to ${typeof def.default}`,
      );
    }
  }
}

// A pin names one frame of one clip, so the shape is narrow: an image, singular, one input per end.
// Every invalid combination is silent (a pin the check never reads, two images fighting over the
// same frame), so they are rejected where the adapter is declared, as `fixed` inputs are.
export function assertPinInputs(inputs: Record<string, DeclaredInput>): void {
  const byEnd = new Map<string, string>();
  for (const [key, def] of Object.entries(inputs)) {
    const end = pinnedEnd(def.pin);
    if (!end) continue;
    if (def.type !== "image") {
      throw new Error(
        `Input "${key}" is typed "${def.type}", so it pins no frame — only an image is reproduced as one`,
      );
    }
    if (def.array) {
      throw new Error(`Input "${key}" pins one frame, so it cannot also take an array`);
    }
    const taken = byEnd.get(end);
    if (taken) {
      throw new Error(
        `Inputs "${taken}" and "${key}" both pin the clip's ${end}, and a clip has one frame there`,
      );
    }
    byEnd.set(end, key);
  }
}

export function isAssetAdapter(value: unknown): value is AssetAdapter<never, MediaKind> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AssetAdapter<never, MediaKind>>;
  return typeof candidate.createDefinition === "function" && typeof candidate.meta === "object";
}

export type AdapterInputs<T> = T extends AssetAdapter<infer I, any> ? I : never;
export type AdapterOutput<T> = T extends AssetAdapter<any, infer O> ? O : never;

// A second asset() with an existing name would silently overwrite the first in the
// context Map, so reject it at declaration time (where the loader's post-parse
// duplicate check can't — it only sees the already-deduped record).
function assertUniqueAsset(
  assets: ReadonlyMap<string, unknown>,
  name: string,
  where: string,
): void {
  if (assets.has(name)) {
    throw new Error(`Duplicate asset "${name}" declared in ${where}`);
  }
}

type BrandedMediaAsset<TName extends string, TAdapter extends AssetAdapter<any, any>> = MediaAsset<
  AdapterOutput<TAdapter>
> & { readonly __partName: TName };

/**
 * Declares an asset in the active context: a stage asset inside a `timeline()`/`shot()`, or a
 * shared asset inside `defineReference()` (addressed `reference:<name>`).
 */
export function asset<TName extends string, TAdapter extends AssetAdapter<any, any>>(
  name: TName & Identifier<TName>,
  adapter: TAdapter,
  inputs: AdapterInputs<TAdapter>,
): BrandedMediaAsset<TName, TAdapter> {
  return registerAsset(name, adapter, inputs);
}

function declarationSite(): AssetDeclarationSite | undefined {
  if (getPatchContext()) return "patch";
  if (getPlatePoolContext()) return "plate";
  if (getReferenceContext()) return "reference";
  if (getTimelineContext()) return "timeline";
  if (getShotContext()) return "shot";
  return undefined;
}

// Where the active declaration is, for an error the adapter raises about the inputs — sibling shots
// reuse asset names, so the name alone does not locate the one to fix.
function assetLocation(): string {
  const patchCtx = getPatchContext();
  if (patchCtx) return `patch "${patchCtx.sourceVariantId}"`;
  if (getPlatePoolContext()) return "the animatic's plates";
  if (getReferenceContext()) return "the reference stage";
  const timelineCtx = getTimelineContext();
  if (timelineCtx) return `the ${timelineCtx.stage} timeline`;
  const shotCtx = getShotContext();
  return shotCtx ? `${shotCtx.stage} shot "${shotCtx.shotId}"` : "an unknown context";
}

// A length said in seconds has no frames of its own, so one frame of the model's output is assumed.
const SECONDS_FRAME_SEC = 1 / 24;

function clipOf(def: AssetDefinition): PinOccurrence["clip"] {
  const clip = "inputs" in def ? clipLengthOf(def.inputs as Record<string, unknown>) : undefined;
  if (!clip) return undefined;
  const sec = clip.length / clip.perSecond;
  const frameSec = clip.unit === "frames" ? 1 / clip.perSecond : SECONDS_FRAME_SEC;
  const landsAt =
    clip.anchorFrame !== undefined ? clip.anchorFrame / clip.perSecond : sec - frameSec;
  return { sec, frameSec, landsAt };
}

function registerAsset<TName extends string, TAdapter extends AssetAdapter<any, any>>(
  name: TName,
  adapter: TAdapter,
  given: AdapterInputs<TAdapter>,
): BrandedMediaAsset<TName, TAdapter> {
  validateAssetName(name);
  const allowedIn = adapter.meta.allowedIn;
  if (allowedIn) {
    const site = declarationSite();
    if (!site || !allowedIn.includes(site)) {
      throw new KonteError(
        "ADAPTER_OUT_OF_SCOPE",
        `Asset "${name}" in ${assetLocation()}: ${adapter.meta.ref} may only be declared in ` +
          allowedIn.join(" or "),
      );
    }
  }
  let inputs: AdapterInputs<TAdapter>;
  try {
    inputs = assemblePromptInputs(adapter.meta.inputs, given);
  } catch (error) {
    if (!(error instanceof KonteError)) throw error;
    throw new KonteError(error.code, `Asset "${name}" in ${assetLocation()}: ${error.message}`);
  }
  // The prompt values, pin wiring and image inputs of this declaration, addressed by the
  // placeholder the discovery branch below hands back (see prompt-collect, pin-collect,
  // image-input-collect).
  const record = (placeholder: string): void => {
    const address = parsePlaceholder(placeholder) ?? placeholder;
    recordPromptInputs(address, adapter.meta, inputs);
    recordPinInputs(address, adapter.meta, inputs, clipOf(def));
    recordImageInputs(address, adapter.meta, inputs);
  };
  let def: AssetDefinition;
  // The name a reference canvas resolves against (see ReferenceContext) has to stand while the
  // adapter builds, under the same site precedence the branches below register by. Restored rather
  // than cleared: an adapter may declare assets of its own while building — a `jsxImage` whose
  // `build` calls `asset()` — and the outer name has to survive that.
  const referenceCtx = declarationSite() === "reference" ? getReferenceContext() : null;
  const outerAssetName = referenceCtx?.activeAssetName;
  if (referenceCtx) referenceCtx.activeAssetName = name;
  try {
    def = adapter.createDefinition(inputs);
  } catch (error) {
    if (!(error instanceof KonteError)) throw error;
    throw new KonteError(error.code, `Asset "${name}" in ${assetLocation()}: ${error.message}`);
  } finally {
    if (referenceCtx) referenceCtx.activeAssetName = outerAssetName;
  }

  // A patch build declares the steps of one correction. They are addressed off the source variant,
  // not the stage's shot/timeline axis, so this is checked before every other context.
  const patchCtx = getPatchContext();
  if (patchCtx) {
    assertUniqueAsset(patchCtx.assets, name, `patch "${patchCtx.sourceVariantId}"`);
    patchCtx.assets.set(name, def);
    const placeholder = makePatchPlaceholder(patchCtx.stage, patchCtx.sourceVariantId, name);
    record(placeholder);
    return makeMediaAsset(placeholder) as BrandedMediaAsset<TName, TAdapter>;
  }

  // Registered like any other take. A plate is ordinary review work: the frame it
  // fixes is delivered inside every panel on that setup. What spares the author a click is the
  // cascade, the plate being what those keyframes were built from, so accepting the first panel on it
  // signs it off (see `cascadeAcceptConsumedDeps`).
  const poolCtx = getPlatePoolContext();
  if (poolCtx) {
    assertUniqueAsset(poolCtx.assets, name, assetLocation());
    poolCtx.assets.set(name, def);
    const placeholder = makePlatePlaceholder(name);
    record(placeholder);
    return makeMediaAsset(placeholder) as BrandedMediaAsset<TName, TAdapter>;
  }

  if (referenceCtx) {
    assertUniqueAsset(referenceCtx.assets, name, "reference");
    referenceCtx.assets.set(name, def);
    const placeholder = makeReferencePlaceholder(name);
    record(placeholder);
    return makeMediaAsset(placeholder) as BrandedMediaAsset<TName, TAdapter>;
  }

  const timelineCtx = getTimelineContext();
  if (timelineCtx) {
    if (timelineCtx.mode === "discovery") {
      assertUniqueAsset(timelineCtx.assets, name, `${timelineCtx.stage} timeline`);
      timelineCtx.assets.set(name, def);
      const placeholder = makeTimelinePlaceholder(timelineCtx.stage, name);
      record(placeholder);
      return makeMediaAsset(placeholder) as BrandedMediaAsset<TName, TAdapter>;
    }

    const resolved = timelineCtx.resolvedFiles.get(name);
    return makeMediaAsset(
      resolved ?? makeTimelinePlaceholder(timelineCtx.stage, name),
    ) as BrandedMediaAsset<TName, TAdapter>;
  }

  const ctx = getShotContext();
  if (!ctx) {
    throw new Error("asset() must be called inside a timeline() or shot() function");
  }

  ctx.assetKinds.set(name, adapter.type);
  if (ctx.mode === "discovery") {
    assertUniqueAsset(ctx.assets, name, `shot "${ctx.shotId}"`);
    ctx.assets.set(name, def);
    const placeholder = makePlaceholder(ctx.stage, ctx.shotId, name);
    record(placeholder);
    return makeMediaAsset(placeholder) as BrandedMediaAsset<TName, TAdapter>;
  }

  const resolved = ctx.resolvedFiles.get(name);
  return makeMediaAsset(
    resolved ?? makePlaceholder(ctx.stage, ctx.shotId, name),
  ) as BrandedMediaAsset<TName, TAdapter>;
}
