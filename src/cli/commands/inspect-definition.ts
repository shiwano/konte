import type { AssetStage, ShotStage } from "../../core/address.js";
import { assertNever } from "../../core/assert.js";
import { loadAnimatic, loadReference } from "../../core/loader.js";
import { loadVideoAndAnimatic } from "../../core/stage-definitions.js";
import type {
  AnimaticDefinition,
  AssetStageDefinition,
  StageDefinition,
} from "../../core/types/index.js";

export function loadAssetStageDefinition(
  videoRoot: string,
  stage: "animatic",
): Promise<AnimaticDefinition>;
export function loadAssetStageDefinition(
  videoRoot: string,
  stage: ShotStage,
): Promise<StageDefinition>;
export function loadAssetStageDefinition(
  videoRoot: string,
  stage: AssetStage,
): Promise<AssetStageDefinition>;
export async function loadAssetStageDefinition(
  videoRoot: string,
  stage: AssetStage,
): Promise<AssetStageDefinition> {
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
      return assertNever(stage, "loadAssetStageDefinition");
  }
}
