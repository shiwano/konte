import type { AssetDefinition } from "../types/definition.js";
import { type AdapterInputs, type AnyAssetAdapter, outOfScope } from "./adapter.js";
import { recordPinInputs } from "./pin-collect.js";
import { recordPromptInputs, UNADDRESSED } from "./prompt-collect.js";
import { assemblePromptInputs } from "./prompt-structure.js";

/**
 * Apply an upscale adapter to its inputs, returning the definition (AssetDefinition). Used
 * inside `export.delivery.upscale.video` / `.frame` to wire konte's injected
 * inputs into the chosen adapter:
 *
 *   upscale: {
 *     video: ({ video, scale }) => upscale(falVideoUpscale, { video, scale }),
 *     // or, for an absolute/preset upscaler:
 *     frame: ({ video, width, height }) => upscale(someUpscaler, { video, width, height }),
 *   }
 *
 * The adapter's input names drive completion, so you only pass what that upscaler takes.
 *
 * An adapter whose `allowedIn` lacks `upscale` is refused.
 */
export function upscale<A extends AnyAssetAdapter>(
  adapter: A,
  given: AdapterInputs<A>,
): AssetDefinition {
  if (!adapter.meta.allowedIn.includes("upscale")) {
    throw outOfScope(adapter.meta, "A delivery upscale");
  }
  const inputs = assemblePromptInputs(adapter.meta.inputs, given);
  recordPromptInputs(UNADDRESSED, adapter.meta, inputs as Record<string, unknown>);
  recordPinInputs(UNADDRESSED, adapter.meta, inputs as Record<string, unknown>);
  return adapter.createDefinition(inputs);
}
