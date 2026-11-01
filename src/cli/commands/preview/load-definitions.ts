import * as fs from "node:fs";
import type { Direction } from "../../../core/dsl/direction.js";
import {
  loadDirectionDefinition,
  reloadAnimaticDefinition,
  reloadDirectionDefinition,
  reloadVideoDefinition,
} from "../../../core/loader.js";
import { loadStageDefinitions } from "../../../core/stage-definitions.js";
import type { ReferenceDefinition, VideoDefinition } from "../../../core/types/index.js";
import type { AnimaticDefinition } from "../../../core/types/animatic.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { stageEntryPath } from "../../../core/roots.js";
import type { AssetStage, ShotStage } from "../../../core/address.js";
import type { StageDefinition } from "../../../core/types/index.js";

// The one stage entry a reel submit re-reads: it must see whatever is on disk right now, so the
// plan it applies is the one the page was rendered from.
export async function reloadStageDefinition(
  videoRoot: string,
  videoPath: string,
  stage: ShotStage,
): Promise<StageDefinition> {
  return stage === "animatic"
    ? reloadAnimaticDefinition(stageEntryPath(videoRoot, "animatic"))
    : reloadVideoDefinition(videoPath);
}

type PreviewMode = "video-preview" | "animatic-preview" | "reference-preview" | "direction-preview";

interface PreviewDefinitions {
  reference: ReferenceDefinition | null;
  animatic: AnimaticDefinition | null;
  direction: Direction | null;
  video: VideoDefinition | null;
}

// The stage entries a mode reviews, which load fatally.
const OWN_STAGES: Record<PreviewMode, readonly AssetStage[]> = {
  "video-preview": ["animatic", "video"],
  "animatic-preview": ["animatic"],
  "reference-preview": ["reference"],
  "direction-preview": [],
};

// What each preview mode reads, in one place: the server loads this at startup and re-loads the
// same set when a definition file changes mid-review, and the two drifting apart is how a mode ends
// up reviewing one version and signing off another.
//
// Only the mode's OWN files are fatal. Everything else is tolerated — a broken animatic.tsx must not
// block reviewing the reference pool — so a mode carries what it can and the checks that consume it
// say nothing rather than refuse.
export async function loadPreviewDefinitions(opts: {
  videoRoot: string;
  mode: PreviewMode;
  reload?: boolean;
}): Promise<PreviewDefinitions> {
  // The direction is read by every mode: direction-preview reviews it, and every other mode's submit
  // cascades a media accept back into the parts describing it — off what is in memory, so a stage
  // preview re-reads it or an accept signs off the version the page opened on.
  const directionPath = stageEntryPath(opts.videoRoot, "direction");
  const loadDirection = opts.reload ? reloadDirectionDefinition : loadDirectionDefinition;
  const direction =
    opts.mode === "direction-preview"
      ? await loadDirection(directionPath)
      : fs.existsSync(directionPath)
        ? await loadDirection(directionPath).catch(() => null)
        : null;

  // The board is read by every mode that can accept a panel: a shared reference image used as a
  // panel is accepted in the REFERENCE review, and its prerequisite is owed on the board (see
  // findAllUnmetPrerequisites). The board reads video.tsx for the downstream half of its keep graph.
  const { errors, ...stages } = await loadStageDefinitions(opts.videoRoot, {
    tolerant: true,
    reload: opts.reload,
  });
  for (const stage of OWN_STAGES[opts.mode]) {
    if (stage in errors) throw errors[stage];
  }

  // Re-registered on every reload, for the reason the reload exists: the definition on disk moved.
  await applyResolutionDefinitions({ videoRoot: opts.videoRoot, definitions: stages });

  return { ...stages, direction };
}
