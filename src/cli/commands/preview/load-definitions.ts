import * as fs from "node:fs";
import type { Direction } from "../../../core/dsl/direction.js";
import {
  loadDirectionDefinition,
  loadReferenceDefinition,
  loadAnimaticDefinition,
  loadVideoDefinition,
  reloadDirectionDefinition,
  reloadReferenceDefinition,
  reloadAnimaticDefinition,
  reloadVideoDefinition,
} from "../../../core/loader.js";
import type { ReferenceDefinition, VideoDefinition } from "../../../core/types/index.js";
import type { AnimaticDefinition } from "../../../core/types/animatic.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { assertNarrationStemsPlaced } from "../../../core/narration-stem.js";
import { stageEntryPath } from "../../../core/roots.js";
import type { ShotStage } from "../../../core/address.js";
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

interface Loaders {
  reference: typeof loadReferenceDefinition;
  animatic: typeof loadAnimaticDefinition;
  direction: typeof loadDirectionDefinition;
  video: typeof loadVideoDefinition;
}

const FRESH: Loaders = {
  reference: loadReferenceDefinition,
  animatic: loadAnimaticDefinition,
  direction: loadDirectionDefinition,
  video: loadVideoDefinition,
};

const RELOAD: Loaders = {
  reference: reloadReferenceDefinition,
  animatic: reloadAnimaticDefinition,
  direction: reloadDirectionDefinition,
  video: reloadVideoDefinition,
};

// What each preview mode reads, in one place: the server loads this at startup and re-loads the
// same set when a definition file changes mid-review, and the two drifting apart is how a mode ends
// up reviewing one version and signing off another.
//
// Only the mode's OWN file is fatal. Everything else is tolerated — a broken animatic.tsx must not
// block reviewing the reference pool — so a mode carries what it can and the checks that consume it
// say nothing rather than refuse.
export async function loadPreviewDefinitions(opts: {
  videoRoot: string;
  videoPath: string;
  mode: PreviewMode;
  reload?: boolean;
}): Promise<PreviewDefinitions> {
  const load = opts.reload ? RELOAD : FRESH;
  const referencePath = stageEntryPath(opts.videoRoot, "reference");
  const animaticPath = stageEntryPath(opts.videoRoot, "animatic");
  const directionPath = stageEntryPath(opts.videoRoot, "direction");

  const tolerant = async <T>(file: string, read: (p: string) => Promise<T>): Promise<T | null> =>
    fs.existsSync(file) ? await read(file).catch(() => null) : null;

  // The direction is read by every mode: direction-preview reviews it, and every other mode's submit
  // cascades a media accept back into the parts describing it — off what is in memory, so a stage
  // preview re-reads it or an accept signs off the version the page opened on.
  const direction =
    opts.mode === "direction-preview"
      ? await load.direction(directionPath)
      : await tolerant(directionPath, load.direction);

  // The board is read by every mode that can accept a panel. A shared reference image used as a
  // panel is accepted in the REFERENCE review, and its prerequisite is owed on the board — so
  // reference preview needs it too, or that accept is checked against nothing (see
  // findAllUnmetPrerequisites).
  const animatic =
    opts.mode === "animatic-preview" || opts.mode === "video-preview"
      ? await load.animatic(animaticPath)
      : await tolerant(animaticPath, load.animatic);

  const reference =
    opts.mode === "reference-preview"
      ? await load.reference(referencePath)
      : await tolerant(referencePath, load.reference);

  // Only the video page reviews video.tsx. The board reads it for the downstream half of its keep
  // graph, and a video.tsx mid-edit must not take the board down with it.
  const video =
    opts.mode === "video-preview"
      ? await load.video(opts.videoPath)
      : await tolerant(opts.videoPath, load.video);
  if (opts.mode === "video-preview" && video && animatic) {
    assertNarrationStemsPlaced(video, animatic);
  }

  // Re-registered on every reload, for the reason the reload exists: the definition on disk moved.
  await applyResolutionDefinitions({
    videoRoot: opts.videoRoot,
    definitions: { reference, animatic, video },
  });

  return {
    reference,
    animatic,
    direction,
    video,
  };
}
