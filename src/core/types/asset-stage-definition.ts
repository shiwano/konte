import type { AnimaticDefinition } from "./animatic.js";
import type { VideoDefinition } from "./definition.js";
import type { ReferenceDefinition } from "./reference.js";

// What an asset stage's entry file loads to.
export type AssetStageDefinition = ReferenceDefinition | AnimaticDefinition | VideoDefinition;

export function isShotStageDefinition(
  definition: AssetStageDefinition,
): definition is AnimaticDefinition | VideoDefinition {
  return "stage" in definition;
}
