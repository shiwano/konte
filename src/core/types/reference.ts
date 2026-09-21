import { z } from "zod";
import type { PinOccurrence } from "../pin-check.js";
import type { PromptOccurrence } from "../prompt-check.js";
import type { AssetDefinition } from "./definition.js";
import {
  AssetDefinitionSchema,
  PinsSchema,
  PromptsSchema,
  PromptWaiversSchema,
} from "./definition.js";

/**
 * A reference is the shared upstream stage: a flat pool of named assets (characters, backgrounds,
 * bgm) shared across the animatic and video stages. Assets are stored in `topLevelAssets` (the
 * shared non-shot pool) with no shots.
 *
 * `exposedAssetNames` are the asset names the callback returned — the ones published as
 * `reference.<name>` to the other stages. They are the usage roots for the reference pool:
 * an exposed asset (and anything it transitively consumes) is "used" even before a panel
 * references it, while a declared asset that is neither exposed nor consumed is unused.
 */
export interface ReferenceDefinition {
  shots: never[];
  topLevelAssets?: Record<string, AssetDefinition>;
  exposedAssetNames?: string[];
  prompts?: readonly PromptOccurrence[];
  pins?: readonly PinOccurrence[];
  waivers?: Record<string, string>;
}

// Validation gate for a user's `reference.tsx` default export. Extra keys (the ReferenceRef
// placeholder props the DSL merges on) are stripped by z.object.
export const ReferenceDefinitionSchema = z.object({
  shots: z.array(z.unknown()),
  topLevelAssets: z.record(z.string(), AssetDefinitionSchema).optional(),
  exposedAssetNames: z.array(z.string()).optional(),
  prompts: PromptsSchema,
  pins: PinsSchema,
  waivers: PromptWaiversSchema,
});
