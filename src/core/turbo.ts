import { parseAddress } from "./address.js";
import { setFieldPath } from "./dsl/set-field-path.js";
import type { AssetDefinition, AssetState } from "./types/index.js";

/**
 * Whether the take about to be reserved at `address` is generated on turbo: the first take of a shot
 * or timeline asset whose adapter declares `turbo`. Anything that already produced a file at the
 * address — a take kept, dismissed or patched — spends it; a failed one does not.
 *
 * A reference and a plate are consumed by many takes, and a deterministic asset has no reroll to
 * leave its turbo take by, so none of them is ever generated on turbo.
 */
export function isTurboTake(
  address: string,
  assetDef: AssetDefinition,
  asset: AssetState | undefined,
): boolean {
  if ((assetDef.kind !== "comfy" && assetDef.kind !== "fal") || !assetDef.turboInputs) return false;
  if (assetDef.deterministic) return false;
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot" && parsed.kind !== "timeline") return false;
  if (parsed.delivery) return false;
  return !Object.values(asset?.variants ?? {}).some((v) => v.file !== null);
}

export function applyTurboInputs(assetDef: AssetDefinition): AssetDefinition {
  if (assetDef.kind === "comfy" && assetDef.turboInputs) {
    return { ...assetDef, inputs: { ...assetDef.inputs, ...assetDef.turboInputs } };
  }
  if (assetDef.kind === "fal" && assetDef.turboInputs) {
    const inputs = structuredClone(assetDef.inputs);
    for (const [field, value] of Object.entries(assetDef.turboInputs)) {
      setFieldPath(inputs, field, value);
    }
    return { ...assetDef, inputs };
  }
  return assetDef;
}
