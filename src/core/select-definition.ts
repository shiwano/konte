import type { Stage } from "./address.js";
import { assertNever } from "./assert.js";
import { KonteError } from "./errors.js";
import type { ReferenceDefinition, AnimaticDefinition, VideoDefinition } from "./types/index.js";

// The definitions a command has loaded — one per stage entry, all three required.
export interface LoadedDefinitions {
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  reference: ReferenceDefinition;
}

// The active definition for a stage, tagged so callers narrow on `stage` to the concrete
// definition type instead of carrying four nullable variables and `!`-asserting the right one.
type LoadedDefinition =
  | { stage: "reference"; def: ReferenceDefinition }
  | { stage: "animatic"; def: AnimaticDefinition }
  | { stage: "video"; def: VideoDefinition };

// Resolve a stage to its loaded definition, or throw the stage-appropriate not-found error.
// The exhaustive switch makes a new Stage a compile error here — the single place that maps a
// dynamic stage to "which definition", replacing the scattered `stage === "reference" ? …` picks.
export function selectDefinition(stage: Stage, defs: LoadedDefinitions): LoadedDefinition {
  switch (stage) {
    case "reference":
      return { stage, def: defs.reference };
    case "animatic":
      return { stage, def: defs.animatic };
    case "video":
      return { stage, def: defs.video };
    case "direction":
      // The direction stage is feedback-only — it has no asset definition to select.
      throw new KonteError(
        "INVALID_ADDRESS",
        "The direction stage has no asset definition — it is a feedback-only stage",
      );
    default:
      return assertNever(stage, "selectDefinition");
  }
}
