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
 * `drafts` holds every asset the `drafts` callback declared, each addressed `animatic:draft.<name>`;
 * `draftShots` is the consecutive direction shots each returned draft covers, in order.
 */
export const AnimaticDefinitionSchema = StageDefinitionSchema.extend({
  stage: z.literal("animatic"),
  drafts: z.record(z.string(), AssetDefinitionSchema).optional(),
  draftShots: z.record(z.string(), z.array(z.string())).optional(),
});

export type AnimaticDefinition = z.infer<typeof AnimaticDefinitionSchema>;
