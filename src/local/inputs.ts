import { z } from "zod";
import { KonteError } from "../core/errors.js";
import type { LocalAssetDefinition } from "../core/types/index.js";

const dependency = z.string();

const LOCAL_INPUTS = {
  resize: z.object({ image: dependency, width: z.number(), height: z.number() }),
  crop: z.object({
    image: dependency,
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    outWidth: z.number(),
    outHeight: z.number(),
  }),
  blank: z.object({ width: z.number(), height: z.number(), color: z.string().optional() }),
  trim: z.object({
    source: dependency,
    start: z.union([z.number(), z.literal("tail")]),
    duration: z.number(),
  }),
  retime: z.object({ source: dependency, duration: z.number(), waiver: z.string().optional() }),
  concat: z.object({ sources: z.array(dependency), crossfade: z.number() }),
  frame: z.object({ source: dependency, at: z.union([z.number(), z.literal("last")]) }),
  cutFrame: z.object({ shot: z.string(), at: z.number() }),
  orbit: z.object({
    master: dependency,
    pose: z.object({
      yaw: z.number(),
      pitch: z.number(),
      distance: z.number(),
      fovY: z.number(),
    }),
    width: z.number(),
    height: z.number(),
  }),
} satisfies Partial<Record<LocalAssetDefinition["operation"], z.ZodTypeAny>>;

type LocalOperation = keyof typeof LOCAL_INPUTS;

export type LocalInputs<O extends LocalOperation> = z.infer<(typeof LOCAL_INPUTS)[O]>;

// A definition built outside the DSL is refused here.
export function localInputs<O extends LocalOperation>(
  def: LocalAssetDefinition,
  operation: O,
): LocalInputs<O> {
  const result = LOCAL_INPUTS[operation].safeParse(def.inputs);
  if (!result.success) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `A local ${operation} asset's inputs do not match it: ${result.error.message}`,
    );
  }
  return result.data as LocalInputs<O>;
}
