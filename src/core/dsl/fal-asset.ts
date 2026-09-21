import type { FalAssetDefinition } from "../types/index.js";
import { KonteError } from "../errors.js";
import type { MediaKind, MediaAsset } from "./builders.js";
import { getShotContext, seed } from "./shot-context.js";
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
  type: "string";
  values: readonly (infer V)[];
}
  ? V
  : T extends { type: "prompt"; structure: infer S extends PromptStructure }
    ? PromptStructureValue<S>
    : T extends { type: "string" | "prompt" | "negativePrompt" | "spokenText" }
      ? string
      : T extends { type: "number" }
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
