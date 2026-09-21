import type { AssetStage } from "../address.js";
import type { AssetDefinition } from "../types/index.js";
import type { PinOccurrence } from "../pin-check.js";
import type { PromptOccurrence } from "../prompt-check.js";
import type { MediaAsset, MediaKind } from "./builders.js";
import { makeMediaAsset } from "./builders.js";
import { endPinCollection } from "./pin-collect.js";
import { beginPromptCollection, endPromptCollection } from "./prompt-collect.js";
import { endRespellCollection } from "./respell.js";
import type { BuildFormat } from "./shot-context.js";
import {
  makeAddressPlaceholder,
  makePatchPlaceholder,
  runInPatchDiscoveryMode,
} from "./shot-context.js";

/**
 * What a patch file's callback receives. `source` is the variant being patched, as a MediaAsset
 * whose placeholder is the variant's own address, so the adapter sees exactly the take named by the
 * file, never whatever currently resolves. Its kind is the type argument, so the take can be fed to a
 * typed adapter input.
 */
export interface PatchContext<TKind extends MediaKind> {
  source: MediaAsset<TKind>;
}

/**
 * The steps a patch declared, and which one is its output. `assets` are addressed
 * `<stage>:patch.<sourceVariantId>.<name>`; the output's definition is what lands as a new variant
 * at the source's own address.
 */
export interface PatchBuild {
  assets: Record<string, AssetDefinition>;
  outputName: string;
  // The `"prompt"` values the chain's steps were built with — the prompt gate reads them before the
  // correction is applied. A patch declares no waivers of its own: a delta naming an exclusion is
  // either the model's own way of being written (which its adapter exempts) or a rewrite.
  prompts?: readonly PromptOccurrence[];
  // The same for the chain's `pin` inputs, read by the pin gate at the same point.
  pins?: readonly PinOccurrence[];
}

export interface PatchDefinition {
  build(ctx: PatchBuildContext): PatchBuild;
}

export interface PatchBuildContext {
  stage: AssetStage;
  sourceAddress: string;
  sourceVariantId: string;
  format?: BuildFormat;
}

/**
 * Declares a correction to one generated variant, authored in `patches/<variantId>.ts`. The
 * callback runs like a stage's `timeline()`: it declares steps with `asset(...)` and returns the
 * one that is the correction's output. A step is a real generated asset with its own address, so a
 * multi-step fix (resize, then edit) is ordinary graph work.
 *
 * The type argument pins the source's media kind and holds the output to that same kind.
 */
export function definePatch<TKind extends MediaKind>(
  fn: (ctx: PatchContext<TKind>) => MediaAsset<TKind>,
): PatchDefinition {
  return {
    build(ctx) {
      const source = makeMediaAsset<TKind>(makeAddressPlaceholder(ctx.sourceAddress));
      // Nothing here stores or validates a respelling: a collection a failed stage build left open
      // is closed rather than inherited.
      endRespellCollection();
      beginPromptCollection();
      const { assets, result } = runInPatchDiscoveryMode(
        ctx.stage,
        ctx.sourceVariantId,
        () => fn({ source }),
        ctx.format,
      );
      const prompts = endPromptCollection();
      const pins = endPinCollection();

      const names = Object.keys(assets);
      if (names.length === 0) {
        throw new Error(
          "definePatch: the callback declared no asset() — the scaffold's `return source` is a " +
            "placeholder, replace it with the adapter that performs the correction",
        );
      }

      const returned = result as MediaAsset<TKind> | undefined;
      const src = returned && typeof returned === "object" ? returned.src : undefined;
      const outputName = names.find(
        (name) => src === makePatchPlaceholder(ctx.stage, ctx.sourceVariantId, name),
      );
      if (!outputName) {
        throw new Error(
          "definePatch: the callback must return one of the asset() results — that is the step " +
            "whose output becomes the patched take",
        );
      }

      return {
        assets,
        outputName,
        ...(prompts.length > 0 ? { prompts } : {}),
        ...(pins.length > 0 ? { pins } : {}),
      };
    },
  };
}
