import type { AssetStage } from "../../core/address.js";
import { assertNever } from "../../core/assert.js";
import { loadAnimatic, loadReference } from "../../core/loader.js";
import type { PromptOccurrence } from "../../core/prompt-check.js";
import { loadVideoAndAnimatic } from "../../core/stage-definitions.js";
import type { Respelling } from "../../core/types/definition.js";
import type { AssetDefinition, ShotDefinition } from "../../core/types/index.js";

export interface ShotLike {
  id: string;
  duration: number;
  assets: Record<string, AssetDefinition>;
  pending?: boolean;
  // What makes the shot carry a composition / an audio stem. Both are declared here so a listing
  // can offer those no-job leaves without casting to VideoDefinition per call.
  shotFn?: unknown;
  stemRefs?: readonly string[];
  narrationStemRefs?: readonly string[];
  compositionRefs?: string[];
  panels?: ShotDefinition["panels"];
  cutin?: ShotDefinition["cutin"];
}

export interface DefinitionWithDuration {
  shots: ShotLike[];
  topLevelAssets?: Record<string, AssetDefinition>;
  timelineSoundtracks?: readonly unknown[];
  prompts?: readonly PromptOccurrence[];
  respellings?: readonly Respelling[];
  // Animatic only: the returned plates, in return order.
  exposedPlateIds?: string[];
}

export async function loadDefinitionWithDuration(
  videoRoot: string,
  stage: AssetStage,
): Promise<DefinitionWithDuration> {
  switch (stage) {
    case "reference":
      return loadReference(videoRoot);
    case "video": {
      const { video } = await loadVideoAndAnimatic(videoRoot);
      return video;
    }
    case "animatic":
      return await loadAnimatic(videoRoot);
    default:
      return assertNever(stage, "loadDefinitionWithDuration");
  }
}
