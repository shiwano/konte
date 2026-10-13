import { z } from "zod";
import {
  AssetDefinitionSchema,
  PanelDefinitionSchema,
  StageDefinitionSchema,
  VideoFormatSchema,
  type ShotDefinition,
} from "./definition.js";

/**
 * The animatic's render canvas — `size` and `fps`, the same working canvas the video stage targets.
 * `defineAnimatic` derives both from the direction canvas (`direction.policy.format`) and stores them
 * here.
 */
export const AnimaticFormatSchema = VideoFormatSchema;

export type AnimaticFormat = z.infer<typeof AnimaticFormatSchema>;

export { PanelDefinitionSchema };
export type { PanelDefinition } from "./definition.js";

// An animatic shot is a video shot that also carries keyframes — same `<Composition>` build, same
// refs, same materialized leaves.
export type AnimaticShotDefinition = ShotDefinition;

export function isPendingAnimaticShot(shot: AnimaticShotDefinition): boolean {
  return shot.pending === true;
}

/**
 * `plates` holds every asset the `plates` callback declared, each addressed `animatic:plate.<name>`.
 * `exposedPlateIds` are the ones it returned — filed under a `setups` roster id and handed to
 * `timeline`. Same split as the reference stage's `topLevelAssets` / `exposedAssetNames`: a
 * declared-but-unreturned plate is an intermediate another plate consumes, generated and tracked
 * like any other but never review work, and no accept is ever owed on it.
 *
 * `platePrompts` is keyed by the same exposed ids — the sentence the author wrote for that frame.
 * Only a returned plate says what it holds.
 */
export const AnimaticDefinitionSchema = StageDefinitionSchema.extend({
  stage: z.literal("animatic"),
  plates: z.record(z.string(), AssetDefinitionSchema).optional(),
  exposedPlateIds: z.array(z.string()).optional(),
  platePrompts: z.record(z.string(), z.string()).optional(),
});

export type AnimaticDefinition = z.infer<typeof AnimaticDefinitionSchema>;
