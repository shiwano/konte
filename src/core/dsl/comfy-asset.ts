import type {
  ComfyAssetDefinition,
  ComfyModelDeclaration,
  ComfyNodeDeclaration,
} from "../types/index.js";
import { KonteError } from "../errors.js";
import type { MediaKind, MediaAsset } from "./builders.js";
import { getActiveFormat, getShotContext, seed, type BuildFormat } from "./shot-context.js";
import { estimateSpeechSec } from "../speech-duration.js";
import { OVERFLOW_FLOOR, recordClipLength } from "./clip-length-collect.js";
import {
  assertTurboInputs,
  assertPinInputs,
  buildMetaInputs,
  type DeclaredPin,
  type AssetAdapter,
  type AssetDeclarationSite,
} from "./adapter.js";
import {
  assertValidatorInputs,
  promptInputName,
  runValidators,
  type AdapterValidator,
} from "./validators/index.js";
import type { PromptStructure, PromptStructureValue } from "./prompt-structure.js";

export type AdapterInputType =
  | "string"
  // Natural-language conditioning handed to a generative model — an image/video/SE `prompt`, a
  // patch's delta description.
  | "prompt"
  // The exclusion half of the same conditioning. The prompt check reads it on the opposite
  // polarity: a negation inside it re-admits what it names.
  | "negativePrompt"
  // The words a speech or music model voices — a TTS `text`/`script`, a lyric sheet. The prompt
  // check skips it: a negation in a line is something said.
  | "spokenText"
  | "number"
  | "boolean"
  | "seed"
  // Format-derived: resolved from the stage canvas (format.size / format.fps / format.duration) at
  // definition-build time when the user omits them, so the number lands in the hashed
  // definition and a format edit stales the variant. `default` is the fallback when no
  // format is in scope (e.g. a delivery upscale).
  | "width"
  | "height"
  | "fps"
  // A frame count: the shot's duration on `clock` frames per second — the model's own sampling
  // rate, which the canvas `fps` need not match.
  | "frames"
  // The same length said in seconds, for a model that asks for it that way. Both are the clip's
  // length, and an adapter declares one of them.
  | "seconds"
  | "image"
  | "video"
  | "audio";

/**
 * A `default` may be a value or a pure function of the active build format. The function must be
 * deterministic: its result lands in the hashed AssetDefinition. `format` is undefined outside a
 * discovery pass (a delivery upscale) and `format.duration` is set only inside a video shot, so
 * guard for both and return a static fallback.
 */
export type AdapterInputDefault =
  | string
  | number
  | boolean
  | ((format: BuildFormat | undefined) => string | number | boolean);

/**
 * The arithmetic grid a model accepts a number on: `step * k + offset` for a whole `k >= 0`, so
 * the offset is also the floor. `{ step: 32 }` is a plain multiple (H3's 32-pixel size grid),
 * `{ step: 17, offset: 5 }` an offset one (H3's 5, 22, 39, … frame counts).
 */
export interface AdapterInputGrid {
  // A positive integer.
  step: number;
  // A non-negative integer.
  offset?: number;
}

export type AdapterInputDef = AdapterInputDefBase &
  (
    | { type: Exclude<AdapterInputType, "prompt">; structure?: never }
    | { type: "prompt"; structure?: PromptStructure }
  );

interface AdapterInputDefBase {
  nodeId: string;
  field: string;
  default?: AdapterInputDefault;
  // The grid this number lands on. The resolved value — from the caller, the canvas format or the
  // default — is raised to the next point on it.
  grid?: AdapterInputGrid;
  // The largest value the model handles. A value that resolves past it is rejected at load, before
  // any spend. Checked after the grid raise, so a value the grid lifts into range passes. There is
  // no matching floor — a short clip is ordinary work.
  max?: number;
  // Frames per second for a `"frames"` input, when the model samples on its own clock. Omitted,
  // the count follows `format.fps`.
  clock?: number;
  // What a `"frames"` input is derived from when the caller declares no count. The default is the
  // shot: the clip fills the span it plays in. `"speech"` names
  // the other case — a model reading a line, whose clip is as long as the words take, and which
  // spreads or repeats the read to fill anything longer. Only a speech model declares it: a music
  // model carries its lyrics the same way and still plays for the whole shot.
  fill?: "speech";
  // The model reproduces this image as the clip's first (`"start"`) or last (`"end"`) frame, pixel
  // for pixel, so what it takes has to be a frame of the picture the piece shows — see pin-check.ts,
  // which reads this. `"image"` inputs only, one input per end.
  //
  // `{ end: { nodeId, field } }` is an end the workflow anchors by frame index, written to that
  // target. The image then lands on the first frame past the shot: the clip is derived one frame
  // longer than the shot, and the frames past it are never played. Only a clip at least one frame
  // longer than the shot has that frame; a shorter one is anchored at its last (`-1`).
  pin?: DeclaredPin;
  values?: readonly string[];
  required?: boolean;
  // Additional workflow targets that receive the same value. Used when one
  // litegraph primitive (e.g. a shared seed or song duration) fed several nodes:
  // the value is written to `nodeId.field` and to every `also` target too.
  also?: readonly { nodeId: string; field: string }[];
  // The rest of the branch this optional media input drives — everything the workflow holds only
  // for its sake (a ControlNet's model-patch loader, the node that applies it). Omitting the input
  // takes the whole branch out of the graph, so an optional conditioning path costs nothing when
  // unused instead of demanding a placeholder image and a second flag to say "ignore it".
  //
  // A node that sits IN a chain rather than at its head is named with `passThrough`: the input
  // socket whose source stands in for its output. Pruning it splices it out — edges into it
  // re-point at that source — where a plain prune would leave the consumer unwired.
  branch?: readonly (string | { nodeId: string; passThrough: string })[];
  // One line about this input alone, printed by `adapter show` beside its type and default. A rule
  // spanning several inputs, or the prompt, belongs in the adapter's guide instead — the table gives
  // it one unwrapped line.
  description?: string;
}

export interface AdapterOutputDef {
  nodeId: string;
  type: MediaKind;
}

export interface ComfyAssetConfig<
  TInputs extends Record<string, AdapterInputDef>,
  TOutputs extends Record<string, AdapterOutputDef>,
> {
  workflow: string;
  description: string;
  inputs: TInputs;
  outputs: TOutputs;
  primary?: keyof TOutputs & string;
  models?: readonly ComfyModelDeclaration[];
  nodes?: readonly ComfyNodeDeclaration[];
  deterministic?: boolean;
  guide?: string | readonly string[];
  validators?: AdapterValidator | readonly AdapterValidator[];
  promptExemptions?: readonly RegExp[];
  spokenTextPattern?: RegExp;
  // Where `asset()` may declare this adapter, when it is not every site (see AdapterMeta).
  allowedIn?: readonly AssetDeclarationSite[];
  // See `AdapterMeta.readsPrevPanel`.
  readsPrevPanel?: true;
  // See `AdapterMeta.turbo`.
  turbo?: ComfyTurbo<TInputs>;
}

// See `AdapterMeta.turbo`.
export type ComfyTurbo<TInputs extends Record<string, AdapterInputDef>> = {
  [K in keyof TInputs as TInputs[K] extends { type: "string" | "number" | "boolean" }
    ? K
    : never]?: InputTSType<TInputs[K]>;
};

type InputTSType<T extends AdapterInputDef> = T extends {
  type: "string";
  values: readonly (infer V)[];
}
  ? V
  : T extends { type: "prompt"; structure: infer S extends PromptStructure }
    ? PromptStructureValue<S>
    : T extends { type: "string" | "prompt" | "negativePrompt" | "spokenText" }
      ? string
      : T extends { type: "number" | "width" | "height" | "fps" | "frames" | "seconds" }
        ? number
        : T extends { type: "boolean" }
          ? boolean
          : T extends { type: "seed" }
            ? number | string
            : T extends { type: "image" }
              ? MediaAsset<"image">
              : T extends { type: "video" }
                ? MediaAsset<"video">
                : T extends { type: "audio" }
                  ? MediaAsset<"audio">
                  : never;

type ComfyRequiredKeys<T extends Record<string, AdapterInputDef>> = {
  [K in keyof T]: T[K] extends { required: true } ? K : never;
}[keyof T];

type ComfyOptionalKeys<T extends Record<string, AdapterInputDef>> = Exclude<
  keyof T,
  ComfyRequiredKeys<T>
>;

export type ComfyCallOptions<
  TInputs extends Record<string, AdapterInputDef>,
  TTurboKey extends PropertyKey = never,
> = {
  [K in Exclude<ComfyRequiredKeys<TInputs>, TTurboKey>]: InputTSType<TInputs[K]>;
} & {
  [K in Exclude<ComfyOptionalKeys<TInputs>, TTurboKey>]?: InputTSType<TInputs[K]>;
};

type PrimaryOutputKind<
  TOutputs extends Record<string, AdapterOutputDef>,
  TPrimary extends (keyof TOutputs & string) | undefined,
> = TPrimary extends string
  ? TOutputs[TPrimary]["type"]
  : TOutputs[keyof TOutputs & string]["type"];

function resolveOutputNodeId<TOutputs extends Record<string, AdapterOutputDef>>(
  outputs: TOutputs,
  primary: string | undefined,
): string | undefined {
  const outputEntries = Object.entries(outputs);
  if (outputEntries.length <= 1 && !primary) return undefined;

  const targetKey = primary ?? outputEntries[0]![0];
  const targetDef = outputs[targetKey]!;
  return targetDef.nodeId;
}

const GRID_TYPES = new Set<AdapterInputType>([
  "number",
  "width",
  "height",
  "fps",
  "frames",
  "seconds",
]);

/**
 * How many of an input's units make one second of clip, or undefined when the input is not a clip
 * length.
 */
function clipUnitsPerSecond(def: AdapterInputDef): number | undefined {
  if (def.type === "seconds") return 1;
  if (def.type === "frames") return def.clock;
  return undefined;
}

// A grid on a non-numeric input and a clock on anything but a frame count never reach the resolved
// value, yet both are reported by `adapter show`. Rejected where the adapter is declared, as
// `fixed` inputs are.
function assertComfyInputs(inputs: Record<string, AdapterInputDef>): void {
  // A clip has one length, however it is spelled. Two would leave which of them the shot is
  // measured against to the order they happen to be declared in.
  const lengths = Object.entries(inputs).filter(([, d]) => clipUnitsPerSecond(d) !== undefined);
  if (lengths.length > 1) {
    throw new Error(
      `Inputs ${lengths.map(([k]) => `"${k}"`).join(" and ")} each give the clip's length, and a clip has one`,
    );
  }
  for (const [key, def] of Object.entries(inputs)) {
    if (typeof def.pin === "object") {
      const { nodeId, field } = def.pin.end;
      const writer = Object.entries(inputs).find(([, d]) =>
        [d, ...(d.also ?? [])].some((t) => t.nodeId === nodeId && t.field === field),
      );
      if (writer) {
        throw new Error(
          `Input "${writer[0]}" writes ${nodeId}.${field}, which "${key}" anchors its image by — the anchor overwrites it, so the input changes nothing`,
        );
      }
      // The anchor is read against the length at build time; a count narrowed after it (a speech
      // fill) would leave it pointing past the clip.
      const length = Object.values(inputs).find((d) => d.type === "frames");
      if (!length || length.fill !== undefined) {
        throw new Error(
          `Input "${key}" anchors its image at a frame, so the adapter needs a "frames" length that follows the shot`,
        );
      }
    }
    if (def.clock !== undefined) {
      if (def.type !== "frames") {
        throw new Error(
          `Input "${key}" is typed "${def.type}", so its clock is never read — only a "frames" input counts on one`,
        );
      }
      if (!Number.isFinite(def.clock) || def.clock <= 0) {
        throw new Error(`Input "${key}" needs a positive clock, got ${def.clock}`);
      }
    }
    if (def.fill !== undefined && clipUnitsPerSecond(def) === undefined) {
      throw new Error(
        def.type === "frames"
          ? `Input "${key}" fills from the words, so it needs the clock they are counted on`
          : `Input "${key}" is typed "${def.type}", so it has nothing to fill — only a clip's length is derived`,
      );
    }
    if (def.max !== undefined) {
      if (!GRID_TYPES.has(def.type)) {
        throw new Error(
          `Input "${key}" is typed "${def.type}", so its max is never enforced — only a number carries a ceiling`,
        );
      }
      if (!Number.isFinite(def.max)) {
        throw new Error(`Input "${key}" needs a finite max, got ${def.max}`);
      }
    }
    if (!def.grid) continue;
    if (!GRID_TYPES.has(def.type)) {
      throw new Error(
        `Input "${key}" is typed "${def.type}", so its grid is never applied — only a number lands on one`,
      );
    }
    const { step, offset } = def.grid;
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new Error(`Input "${key}" needs a positive integer grid step, got ${step}`);
    }
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new Error(`Input "${key}" needs a non-negative integer grid offset, got ${offset}`);
    }
  }
}

export function defineComfyAsset<
  const TInputs extends Record<string, AdapterInputDef>,
  const TOutputs extends Record<string, AdapterOutputDef>,
  TPrimary extends (keyof TOutputs & string) | undefined = undefined,
  const TTurbo extends ComfyTurbo<TInputs> = {},
>(
  config: ComfyAssetConfig<TInputs, TOutputs> & { primary?: TPrimary; turbo?: TTurbo },
): AssetAdapter<ComfyCallOptions<TInputs, keyof TTurbo>, PrimaryOutputKind<TOutputs, TPrimary>> {
  assertComfyInputs(config.inputs);
  assertTurboInputs(config.turbo, config.inputs);
  assertPinInputs(config.inputs);
  assertSpeechFill(config);
  assertValidatorInputs(config.validators, config.inputs);
  const outputKind = resolveOutputKind(config.outputs, config.primary);
  const outputNodeId = resolveOutputNodeId(config.outputs, config.primary);
  const promptInput = promptInputName(config.inputs);

  return {
    type: outputKind as PrimaryOutputKind<TOutputs, TPrimary>,
    meta: {
      backend: "comfy",
      mediaType: outputKind,
      description: config.description,
      ref: config.workflow,
      inputs: buildMetaInputs(config.inputs, config.turbo),
      ...(config.guide ? { guide: config.guide } : {}),
      ...(config.promptExemptions ? { promptExemptions: config.promptExemptions } : {}),
      ...(config.spokenTextPattern ? { spokenTextPattern: config.spokenTextPattern } : {}),
      ...(config.allowedIn ? { allowedIn: config.allowedIn } : {}),
      ...(config.readsPrevPanel ? { readsPrevPanel: true } : {}),
      ...(config.turbo ? { turbo: config.turbo as Record<string, string | number | boolean> } : {}),
    },
    createDefinition(userInputs: ComfyCallOptions<TInputs, keyof TTurbo>): ComfyAssetDefinition {
      const turbo: Record<string, unknown> = config.turbo ?? {};
      const inputs: Record<string, unknown> = {};
      const inputLabels: Record<string, string> = {};
      // The same values keyed by input name rather than workflow target — what `validators` read.
      const resolved: Record<string, unknown> = {};
      const prunedNodes: string[] = [];
      const prunedPassThroughs: Record<string, string> = {};
      const format = getActiveFormat();
      const validatorContext = { promptInput, shotId: getShotContext()?.shotId };
      const resolveDefault = (
        d: AdapterInputDefault | undefined,
      ): string | number | boolean | undefined => (typeof d === "function" ? d(format) : d);
      // Resolved before the loop rather than inside it: the words live in another input, and which
      // of the two is declared first is the adapter author's business.
      const speechWords = Object.values(config.inputs).some((d) => d.fill === "speech")
        ? spokenWordsOf(config, userInputs as Record<string, unknown>, resolveDefault)
        : "";
      // Every input giving the clip's length, so what is built here can be read against the shot
      // once the composition places it (`clip-length-collect`).
      const clipTargets: Record<string, string[]> = {};
      const derivedSec: Record<string, number> = {};
      const anchored = Object.entries(config.inputs).find(
        ([key, def]) =>
          typeof def.pin === "object" && (userInputs as Record<string, unknown>)[key] !== undefined,
      );

      for (const [key, def] of Object.entries(config.inputs) as [string, AdapterInputDef][]) {
        const userValue = key in turbo ? undefined : (userInputs as Record<string, unknown>)[key];
        const isMedia = def.type === "image" || def.type === "video" || def.type === "audio";

        let value: unknown;
        if (def.type === "seed") {
          value = userValue !== undefined ? userValue : seed();
        } else if (def.type === "width") {
          value =
            userValue !== undefined
              ? userValue
              : (format?.size.width ?? resolveDefault(def.default));
        } else if (def.type === "height") {
          value =
            userValue !== undefined
              ? userValue
              : (format?.size.height ?? resolveDefault(def.default));
        } else if (def.type === "fps") {
          value =
            userValue !== undefined ? userValue : (format?.fps ?? resolveDefault(def.default));
        } else if (def.type === "frames" || def.type === "seconds") {
          const derived =
            userValue === undefined && def.fill === "speech" && speechWords !== ""
              ? deriveSpeechLength(speechWords, def, format)
              : undefined;
          if (derived) derivedSec[key] = derived.wantSec;
          const fromShot = resolveClipLength(
            clipUnitsPerSecond(def) ?? format?.fps,
            format?.duration,
            def,
          );
          value =
            userValue !== undefined
              ? userValue
              : (derived?.length ??
                (fromShot !== undefined && anchored ? fromShot + 1 : fromShot) ??
                resolveDefault(def.default));
        } else if (isMedia) {
          value = userValue !== undefined ? (userValue as MediaAsset).src : undefined;
        } else {
          value = userValue !== undefined ? userValue : resolveDefault(def.default);
        }

        if (def.grid && typeof value === "number") {
          value = snapToGrid(value, def.grid);
        }

        if (value === undefined) {
          if (def.required) {
            throw new KonteError(
              "MISSING_REQUIRED_INPUT",
              `Required input "${key}" (${def.type}, node ${def.nodeId}.${def.field}) was not provided`,
            );
          }
          // An omitted optional media input leaves its source node (a LoadImage
          // and friends) pointing at whatever placeholder file the workflow
          // shipped with, which usually isn't present on the server and fails
          // validation. Prune the node so the downstream (optional) socket is
          // simply left unconnected.
          if (isMedia) {
            prunedNodes.push(def.nodeId);
            if (def.also) {
              for (const target of def.also) prunedNodes.push(target.nodeId);
            }
            for (const entry of def.branch ?? []) {
              if (typeof entry === "string") {
                prunedNodes.push(entry);
                continue;
              }
              prunedNodes.push(entry.nodeId);
              prunedPassThroughs[entry.nodeId] = entry.passThrough;
            }
          }
          continue;
        }

        resolved[key] = value;
        inputs[`${def.nodeId}.${def.field}`] = value;
        inputLabels[`${def.nodeId}.${def.field}`] = key;
        if (def.also) {
          for (const target of def.also) {
            inputs[`${target.nodeId}.${target.field}`] = value;
            inputLabels[`${target.nodeId}.${target.field}`] = key;
          }
        }
        if (clipUnitsPerSecond(def) !== undefined) {
          clipTargets[key] = [
            `${def.nodeId}.${def.field}`,
            ...(def.also ?? []).map((t) => `${t.nodeId}.${t.field}`),
          ];
        }
      }

      // A pruned node is not in the submitted graph, so an input aimed at it is dead: it would
      // never be applied, and leaving it in the definition would let a knob on an absent branch
      // (a ControlNet's strength) age out every consumer for nothing.
      const pruned = new Set(prunedNodes);
      for (const key of Object.keys(inputs)) {
        if (pruned.has(key.slice(0, key.indexOf(".")))) {
          delete inputs[key];
          delete inputLabels[key];
        }
      }
      // …and out of what `validators` see, so they judge the definition that will be submitted.
      for (const key of Object.keys(resolved)) {
        if (pruned.has(config.inputs[key]!.nodeId)) delete resolved[key];
      }

      // After pruning, so a ceiling on an input aimed at a dropped branch judges a value that is
      // not submitted.
      for (const [key, value] of Object.entries(resolved)) {
        const def = config.inputs[key]!;
        if (typeof value !== "number") continue;
        if ((def.grid || def.max !== undefined) && !Number.isFinite(value)) {
          throw new KonteError(
            "INVALID_ADAPTER_INPUT",
            `Input "${key}" resolved to ${value}, which is not a finite number`,
          );
        }
        if (def.max !== undefined && value > def.max) {
          throw new KonteError("INVALID_ADAPTER_INPUT", overMaxMessage(key, def, value));
        }
      }

      let anchorFrame: number | undefined;
      if (anchored && anchored[0] in resolved && format?.duration !== undefined) {
        const [lengthKey, lengthDef] = Object.entries(config.inputs).find(
          ([, d]) => d.type === "frames",
        )!;
        const length = resolved[lengthKey];
        const perSecond = clipUnitsPerSecond(lengthDef) ?? format.fps;
        if (typeof length === "number" && perSecond !== undefined) {
          const shown = Math.round(format.duration * perSecond);
          const { nodeId, field } = (anchored[1].pin as Exclude<DeclaredPin, string>).end;
          inputs[`${nodeId}.${field}`] = length > shown ? shown : -1;
          anchorFrame = length > shown ? shown : length - 1;
        }
      }

      for (const [key, targets] of Object.entries(clipTargets)) {
        const length = resolved[key];
        if (typeof length !== "number") continue;
        const def = config.inputs[key]!;
        recordClipLength({
          inputs,
          targets,
          unit: def.type === "frames" ? "frames" : "seconds",
          perSecond: clipUnitsPerSecond(def)!,
          ...(def.grid ? { grid: def.grid } : {}),
          ...(anchorFrame !== undefined ? { anchorFrame } : {}),
          length,
          ...(derivedSec[key] !== undefined ? { wantSec: derivedSec[key] } : {}),
          // Narrowing the count happens after the build, so the validators below judged a value
          // that is no longer the one submitted. Only a decrease is possible, so the `max` ceiling
          // needs no second look.
          revalidate: (corrected: number) =>
            runValidators(config.validators, { ...resolved, [key]: corrected }, validatorContext),
        });
      }

      runValidators(config.validators, resolved, validatorContext);

      const result: ComfyAssetDefinition = {
        kind: "comfy",
        workflow: config.workflow,
        inputs,
        inputLabels,
      };

      if (prunedNodes.length > 0) {
        result.prunedNodes = [...new Set(prunedNodes)];
      }

      if (Object.keys(prunedPassThroughs).length > 0) {
        result.prunedPassThroughs = prunedPassThroughs;
      }

      if (outputNodeId) {
        result.outputNodeId = outputNodeId;
      }

      const turboInputs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(turbo)) {
        const def = config.inputs[key]!;
        for (const t of [def, ...(def.also ?? [])]) {
          if (!pruned.has(t.nodeId)) turboInputs[`${t.nodeId}.${t.field}`] = value;
        }
      }
      if (Object.keys(turboInputs).length > 0) {
        result.turboInputs = turboInputs;
      }

      // A model whose loader node was pruned is not needed by this take, and konte provisions every
      // declared model before generating — so leaving it declared would download multiple gigabytes
      // for a branch that is not in the graph. Keyed on the declaration's own `nodeId`, not on a
      // filename: two loaders can name one file (the LTX adapters do), and a filename match would
      // drop it out from under the one that survived.
      const models = (config.models ?? []).filter((m) => !(m.nodeId && pruned.has(m.nodeId)));
      if (models.length > 0) {
        result.models = models;
      }

      if (config.nodes && config.nodes.length > 0) {
        result.nodes = [...config.nodes];
      }

      if (config.deterministic) {
        result.deterministic = true;
      }

      return result;
    },
  };
}

// Up, never down: a take under the canvas is enlarged when it is composed, and that costs detail
// no later stage can put back; a take under the shot leaves a gap the timeline cannot fill.
function overMaxMessage(key: string, def: AdapterInputDef, value: number): string {
  const seconds = (n: number): string =>
    def.clock ? ` (${(n / def.clock).toFixed(1)}s at ${def.clock}fps)` : "";
  return (
    `Input "${key}" resolves to ${value}${seconds(value)}, past this adapter's maximum of ` +
    `${def.max}${seconds(def.max!)}. Shorten the shot, or split it into segments and chain each ` +
    `one onto the frame the one before it ends on (adapters.videoFrame).`
  );
}

// The adapter must be able to read the words it derives a length from: either it takes them in an
// input of their own, or it marks where they are written inside its prompt.
function assertSpeechFill(config: {
  inputs: Record<string, AdapterInputDef>;
  spokenTextPattern?: RegExp;
}): void {
  const filled = Object.entries(config.inputs).filter(([, d]) => d.fill === "speech");
  if (filled.length === 0) return;
  const readable =
    config.spokenTextPattern !== undefined ||
    Object.values(config.inputs).some((d) => d.type === "spokenText");
  if (!readable) {
    throw new Error(
      `Input "${filled[0]![0]}" fills from the words, but this adapter declares neither a ` +
        `"spokenText" input nor a spokenTextPattern, so it has no words to read`,
    );
  }
}

// The words one call hands the model: its `"spokenText"` inputs, else the lines marked inside its
// prompt (`spokenTextPattern`). Joined, because a call carrying two lines says both in one take.
function spokenWordsOf(
  config: { inputs: Record<string, AdapterInputDef>; spokenTextPattern?: RegExp },
  userInputs: Record<string, unknown>,
  resolveDefault: (d: AdapterInputDefault | undefined) => string | number | boolean | undefined,
): string {
  const valueOf = (key: string, def: AdapterInputDef): string => {
    const raw = userInputs[key] ?? resolveDefault(def.default);
    return typeof raw === "string" ? raw : "";
  };
  const spoken = Object.entries(config.inputs)
    .filter(([, def]) => def.type === "spokenText")
    .map(([key, def]) => valueOf(key, def))
    .filter((v) => v !== "");
  if (spoken.length > 0) return spoken.join(" ");

  const pattern = config.spokenTextPattern;
  if (!pattern) return "";
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const said: string[] = [];
  for (const [key, def] of Object.entries(config.inputs)) {
    if (def.type !== "prompt") continue;
    for (const match of valueOf(key, def).matchAll(new RegExp(pattern.source, flags))) {
      const line = (match[1] ?? "").trim();
      if (line !== "") said.push(line);
    }
  }
  return said.join(" ");
}

// The grid rounds up, so a derived count already carries half a step of slack on average — 0.35s at
// H3's 17-frame step. Trimming the estimate by this keeps the two from both paying for the same
// margin.
const GRID_HEADROOM_SEC = 0.15;

// The largest grid point at or below `value` — how a derived count is held inside a window. The
// mirror of `snapToGrid`, which only ever raises.
export function floorToGrid(value: number, grid: AdapterInputGrid): number {
  const offset = grid.offset ?? 0;
  const steps = Math.max(0, Math.floor((value - offset) / grid.step));
  return steps * grid.step + offset;
}

/**
 * The clip length the words ask for, in the input's own unit, or undefined when there is no
 * language to rate them in. Held
 * inside the shot when one is in scope, so konte's own length never asks for a clip longer than the
 * span it plays in. Where the cue sits inside the shot is not known until the composition is built;
 * `tightenDerivedClipLengths` narrows it then.
 */
function deriveSpeechLength(
  words: string,
  def: AdapterInputDef,
  format: BuildFormat | undefined,
): { length: number; wantSec: number } | undefined {
  const perSecond = clipUnitsPerSecond(def);
  if (perSecond === undefined) return undefined;
  const wantSec = estimateSpeechSec(words, format?.typography?.lang);
  if (wantSec === null) return undefined;
  const grid = def.grid;
  const raw = Math.max(0, wantSec - GRID_HEADROOM_SEC) * perSecond;
  let length = grid ? snapToGrid(raw, grid) : raw;
  if (format?.duration !== undefined) {
    const window = format.duration * perSecond;
    const held = grid ? floorToGrid(window, grid) : window;
    // A grid floors at its own offset, so the smallest count it can name may not fit either.
    // Nothing legal does then, and the words' own count stands: the load check reports the line the
    // author wrote rather than the stub konte would have shrunk it to.
    if (length > window + OVERFLOW_FLOOR * perSecond && held > 0 && held <= window) length = held;
  }
  // A frame count is whole; seconds are not.
  return { length: def.type === "frames" ? Math.round(length) : length, wantSec };
}

function snapToGrid(value: number, grid: AdapterInputGrid): number {
  const offset = grid.offset ?? 0;
  const steps = Math.max(0, Math.ceil((value - offset) / grid.step));
  return steps * grid.step + offset;
}

// The clip length a shot's duration asks for, in the input's own unit, or undefined when either is
// out of scope and the static default takes over. A frame count is whole; seconds are not.
function resolveClipLength(
  perSecond: number | undefined,
  duration: number | undefined,
  def: AdapterInputDef,
): number | undefined {
  if (perSecond === undefined || duration === undefined) return undefined;
  const length = duration * perSecond;
  return def.type === "frames" ? Math.round(length) : length;
}

function resolveOutputKind(
  outputs: Record<string, AdapterOutputDef>,
  primary: string | undefined,
): MediaKind {
  if (primary) return outputs[primary]!.type;
  const first = Object.values(outputs)[0];
  return first?.type ?? "video";
}
