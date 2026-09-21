import type { AssetDefinition } from "../types/definition.js";
import { KonteError } from "../errors.js";
import type { AdapterInputs, AssetAdapter } from "./adapter.js";
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
 * A delivery upscale is the one generated asset declared outside `asset()`, so an adapter that names
 * the `asset()` sites it takes is refused here.
 */
export function upscale<A extends AssetAdapter<any, any>>(
  adapter: A,
  given: AdapterInputs<A>,
): AssetDefinition {
  if (adapter.meta.allowedIn) {
    throw new KonteError(
      "ADAPTER_OUT_OF_SCOPE",
      `${adapter.meta.ref} may only be declared in ${adapter.meta.allowedIn.join(" or ")}, ` +
        "so it cannot upscale a delivery",
    );
  }
  const inputs = assemblePromptInputs(adapter.meta.inputs, given);
  recordPromptInputs(UNADDRESSED, adapter.meta, inputs as Record<string, unknown>);
  recordPinInputs(UNADDRESSED, adapter.meta, inputs as Record<string, unknown>);
  return adapter.createDefinition(inputs);
}
