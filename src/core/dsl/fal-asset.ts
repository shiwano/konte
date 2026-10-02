import type { FalAssetDefinition } from "../types/index.js";
import { KonteError } from "../errors.js";
import type { MediaKind, MediaAsset } from "./builders.js";
import { getActiveFormat, getShotContext, seed } from "./shot-context.js";
import { setFieldPath } from "./set-field-path.js";
import {
  assertTurboInputs,
  assertFixedInputs,
  assertPinInputs,
  buildMetaInputs,
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

/**
 * `"prompt"` and `"negativePrompt"` are the two halves of the conditioning the prompt check reads,
 * each on its own polarity; see AdapterInputType.
 */
export type FalInputType =
  | "string"
  | "prompt"
  | "negativePrompt"
  | "spokenText"
  | "number"
  | "boolean"
  | "seed"
  // The clip's length in seconds, derived from the shot it plays in when the caller passes none. With
  // `values` the provider takes one of a set of lengths: the shortest numeric one that holds the shot
  // is sent, and the take plays windowed to the shot. Without them it is whole seconds, raised to
  // `min`. Outside a shot `default` stands.
  | "seconds"
  | "image"
  | "video"
  | "audio";

export type FalInputDef = FalInputDefBase &
  (
    | { type: Exclude<FalInputType, "prompt">; structure?: never }
    | { type: "prompt"; structure?: PromptStructure }
  );

interface FalInputDefBase {
  field: string;
  // A provider field this adapter pins: `default` is always sent, the key is absent from the call
  // options, and a runtime value for it is never read. Scalar types only, and `default` is required.
  fixed?: true;
  default?: string | number | boolean;
  // See `AdapterInputDef.pin`.
  pin?: "start" | "end";
  values?: readonly string[];
  // The shortest and longest `"seconds"` the model takes. A derived length is raised to `min`; one
  // past `max` is refused at load.
  min?: number;
  max?: number;
  required?: boolean;
  array?: boolean;
  description?: string;
}

export interface FalAssetConfig<
  TInputs extends Record<string, FalInputDef>,
  TMedia extends MediaKind = MediaKind,
> {
  endpointId: string;
  description: string;
  mediaType: TMedia;
  inputs: TInputs;
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
  turbo?: FalTurbo<TInputs>;
}

// See `ComfyTurbo`.
export type FalTurbo<TInputs extends Record<string, FalInputDef>> = {
  [K in keyof TInputs as TInputs[K] extends { type: "string" | "number" | "boolean" }
    ? K
    : never]?: FalInputTSType<TInputs[K]>;
};

type FalInputTSType<T extends FalInputDef> = T extends {
  type: "string" | "seconds";
  values: readonly (infer V)[];
}
  ? V
  : T extends { type: "prompt"; structure: infer S extends PromptStructure }
    ? PromptStructureValue<S>
    : T extends { type: "string" | "prompt" | "negativePrompt" | "spokenText" }
      ? string
      : T extends { type: "number" | "seconds" }
        ? number
        : T extends { type: "boolean" }
          ? boolean
          : T extends { type: "seed" }
            ? number | string
            : T extends { type: "image" }
              ? T extends { array: true }
                ? MediaAsset<"image">[]
                : MediaAsset<"image">
              : T extends { type: "video" }
                ? T extends { array: true }
                  ? MediaAsset<"video">[]
                  : MediaAsset<"video">
                : T extends { type: "audio" }
                  ? T extends { array: true }
                    ? MediaAsset<"audio">[]
                    : MediaAsset<"audio">
                  : never;

type FalFixedKeys<T extends Record<string, FalInputDef>> = {
  [K in keyof T]: T[K] extends { fixed: true } ? K : never;
}[keyof T];

type FalRequiredKeys<T extends Record<string, FalInputDef>> = {
  [K in keyof T]: T[K] extends { fixed: true }
    ? never
    : T[K] extends { required: true }
      ? K
      : never;
}[keyof T];

type FalOptionalKeys<T extends Record<string, FalInputDef>> = Exclude<
  keyof T,
  FalRequiredKeys<T> | FalFixedKeys<T>
>;

export type FalCallOptions<
  TInputs extends Record<string, FalInputDef>,
  TTurboKey extends PropertyKey = never,
> = {
  [K in Exclude<FalRequiredKeys<TInputs>, TTurboKey>]: FalInputTSType<TInputs[K]>;
} & {
  [K in Exclude<FalOptionalKeys<TInputs>, TTurboKey>]?: FalInputTSType<TInputs[K]>;
};

function missingRequiredInput(key: string, def: FalInputDef): KonteError {
  return new KonteError(
    "MISSING_REQUIRED_INPUT",
    `Required input "${key}" (${def.type}, field "${def.field}") was not provided`,
  );
}

// A frame-aligned span can sit a hair under the whole second it was written as.
const SPAN_EPSILON = 1e-6;

// The length a shot of `duration` seconds asks a `"seconds"` input for, in the form the provider
// takes it; undefined outside a shot.
function shotSeconds(
  key: string,
  def: FalInputDef,
  duration: number | undefined,
): string | number | undefined {
  if (duration === undefined) return undefined;
  if (def.values) {
    const lengths = def.values
      .map((value) => ({ value, seconds: Number(value) }))
      .filter((c) => Number.isFinite(c.seconds))
      .sort((a, b) => a.seconds - b.seconds);
    const fit = lengths.find((c) => c.seconds >= duration - SPAN_EPSILON);
    if (!fit) {
      throw new KonteError(
        "INVALID_ADAPTER_INPUT",
        `Input "${key}" has no length that holds the ${duration}s shot — the longest this model ` +
          `takes is ${lengths.at(-1)?.seconds ?? 0}s. Shorten the shot, or split it into segments.`,
      );
    }
    return fit.value;
  }
  const whole = Math.max(def.min ?? 0, Math.ceil(duration - SPAN_EPSILON));
  if (def.max !== undefined && whole > def.max) {
    throw new KonteError(
      "INVALID_ADAPTER_INPUT",
      `Input "${key}" resolves to ${whole}s for the ${duration}s shot, past this model's maximum ` +
        `of ${def.max}s. Shorten the shot, or split it into segments.`,
    );
  }
  return whole;
}

export function defineFalAsset<
  const TInputs extends Record<string, FalInputDef>,
  const TMedia extends MediaKind,
  const TTurbo extends FalTurbo<TInputs> = {},
>(
  config: FalAssetConfig<TInputs, TMedia> & { turbo?: TTurbo },
): AssetAdapter<FalCallOptions<TInputs, keyof TTurbo>, TMedia> {
  assertFixedInputs(config.inputs);
  assertTurboInputs(config.turbo, config.inputs);
  assertPinInputs(config.inputs);
  assertValidatorInputs(config.validators, config.inputs);
  const promptInput = promptInputName(config.inputs);

  return {
    type: config.mediaType,
    meta: {
      backend: "fal",
      mediaType: config.mediaType,
      description: config.description,
      ref: config.endpointId,
      inputs: buildMetaInputs(config.inputs, config.turbo),
      ...(config.guide ? { guide: config.guide } : {}),
      ...(config.promptExemptions ? { promptExemptions: config.promptExemptions } : {}),
      ...(config.spokenTextPattern ? { spokenTextPattern: config.spokenTextPattern } : {}),
      ...(config.allowedIn ? { allowedIn: config.allowedIn } : {}),
      ...(config.readsPrevPanel ? { readsPrevPanel: true } : {}),
      ...(config.turbo ? { turbo: config.turbo as Record<string, string | number | boolean> } : {}),
    },
    createDefinition(userInputs: FalCallOptions<TInputs, keyof TTurbo>): FalAssetDefinition {
      const turbo: Record<string, unknown> = config.turbo ?? {};
      const inputs: Record<string, unknown> = {};
      const inputLabels: Record<string, string> = {};
      // The same values keyed by input name rather than provider field — what `validators` read.
      const resolved: Record<string, unknown> = {};
      const put = (key: string, field: string, value: unknown): void => {
        resolved[key] = value;
        inputLabels[field] = key;
        setFieldPath(inputs, field, value);
      };

      for (const [key, def] of Object.entries(config.inputs) as [string, FalInputDef][]) {
        if (def.fixed) {
          if (def.default !== undefined) put(key, def.field, def.default);
          continue;
        }

        const userValue = key in turbo ? undefined : (userInputs as Record<string, unknown>)[key];

        if (def.type === "seed") {
          put(key, def.field, userValue !== undefined ? userValue : seed());
        } else if (def.type === "seconds") {
          const value =
            userValue !== undefined
              ? userValue
              : (shotSeconds(key, def, getActiveFormat()?.duration) ?? def.default);
          if (value !== undefined) {
            put(key, def.field, value);
          } else if (def.required) {
            throw missingRequiredInput(key, def);
          }
        } else if (def.type === "image" || def.type === "video" || def.type === "audio") {
          if (userValue !== undefined) {
            if (def.array) {
              put(
                key,
                def.field,
                (userValue as MediaAsset[]).map((asset) => asset.src),
              );
            } else {
              put(key, def.field, (userValue as MediaAsset).src);
            }
          } else if (def.required) {
            throw missingRequiredInput(key, def);
          }
        } else {
          const value = userValue !== undefined ? userValue : def.default;
          if (value !== undefined) {
            put(key, def.field, value);
          } else if (def.required) {
            throw missingRequiredInput(key, def);
          }
        }
      }

      runValidators(config.validators, resolved, {
        promptInput,
        shotId: getShotContext()?.shotId,
      });

      const turboInputs = Object.fromEntries(
        Object.entries(turbo).map(([key, value]) => [config.inputs[key]!.field, value]),
      );

      return {
        kind: "fal",
        endpointId: config.endpointId,
        mediaType: config.mediaType,
        inputs,
        inputLabels,
        ...(Object.keys(turboInputs).length > 0 ? { turboInputs } : {}),
        ...(config.deterministic ? { deterministic: true } : {}),
      };
    },
  };
}
