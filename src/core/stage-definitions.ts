import { type AssetStage, type DefinitionLike, getStage } from "./address.js";
import { assertNever } from "./assert.js";
import type { Direction } from "./dsl/direction.js";
import { KonteError } from "./errors.js";
import {
  loadAnimatic,
  loadDirectionDefinition,
  loadIfPresent,
  loadReference,
  loadVideoDefinition,
  reloadVideoDefinition,
} from "./loader.js";
import { assertNarrationStemsPlaced } from "./narration-stem.js";
import { stageEntryPath } from "./roots.js";
import { type LoadedDefinitions, loadShotStages } from "./select-definition.js";
import type { AnimaticDefinition, ReferenceDefinition, VideoDefinition } from "./types/index.js";

export type LoadOptions = { reload?: boolean };

// The stage entries as far as they load. A stage that did not load is null, with its error under
// `errors` — an absent file included. The video is not read when the board did not load.
export type TolerantStageDefinitions = {
  reference: ReferenceDefinition | null;
  animatic: AnimaticDefinition | null;
  video: VideoDefinition | null;
  errors: Partial<Record<AssetStage, unknown>>;
};

// Animatic before video, never in parallel: video.tsx statically imports the animatic module, so a
// failure during animatic evaluation otherwise resurfaces from video's import as an unrelated TDZ
// error ("Cannot access 'animatic' before initialization").
export async function loadVideoAndAnimatic(
  videoRoot: string,
  opts?: LoadOptions,
): Promise<{ video: VideoDefinition; animatic: AnimaticDefinition }> {
  const animatic = await loadAnimatic(videoRoot, opts);
  const video = await readVideo(videoRoot, opts);
  assertNarrationStemsPlaced(video, animatic);
  return { video, animatic };
}

function readVideo(videoRoot: string, opts?: LoadOptions): Promise<VideoDefinition> {
  const videoPath = stageEntryPath(videoRoot, "video");
  return opts?.reload ? reloadVideoDefinition(videoPath) : loadVideoDefinition(videoPath);
}

// The three stage entries a video holds. `reload` evicts the project's modules first, so an edit to
// any of them or to an adapter is seen.
export function loadStageDefinitions(
  videoRoot: string,
  opts?: LoadOptions & { tolerant?: false },
): Promise<LoadedDefinitions>;
export function loadStageDefinitions(
  videoRoot: string,
  opts: LoadOptions & { tolerant: true },
): Promise<TolerantStageDefinitions>;
export async function loadStageDefinitions(
  videoRoot: string,
  opts?: LoadOptions & { tolerant?: boolean },
): Promise<LoadedDefinitions | TolerantStageDefinitions> {
  if (opts?.tolerant) return loadTolerant(videoRoot, opts);
  const shots = await loadShotStages(videoRoot, () => loadVideoAndAnimatic(videoRoot, opts));
  return { reference: await loadReference(videoRoot, opts), ...shots };
}

async function loadTolerant(
  videoRoot: string,
  opts: LoadOptions,
): Promise<TolerantStageDefinitions> {
  const errors: TolerantStageDefinitions["errors"] = {};
  const attempt = async <T>(stage: AssetStage, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load();
    } catch (err) {
      errors[stage] = err;
      return null;
    }
  };
  const reference = await attempt("reference", () => loadReference(videoRoot, opts));
  const animatic = await attempt("animatic", () => loadAnimatic(videoRoot, opts));
  const video = animatic
    ? await attempt("video", async () => {
        const video = await readVideo(videoRoot, opts);
        assertNarrationStemsPlaced(video, animatic);
        return video;
      })
    : null;
  return { reference, animatic, video, errors };
}

// The direction (direction.ts). Absent file => null; an existing but invalid file throws.
export function loadDirectionIfPresent(videoRoot: string): Promise<Direction | null> {
  return loadIfPresent(stageEntryPath(videoRoot, "direction"), loadDirectionDefinition);
}

export async function loadDefinitionForAddress(
  videoRoot: string,
  address: string,
): Promise<DefinitionLike> {
  const stage = getStage(address);
  switch (stage) {
    case "reference":
      return loadReference(videoRoot);
    case "animatic":
      return loadAnimatic(videoRoot);
    case "video":
      return loadVideoDefinition(stageEntryPath(videoRoot, "video"));
    case "direction":
      throw new KonteError(
        "INVALID_ADDRESS",
        `Address "${address}" references the direction stage, which is feedback-only with no asset definition`,
      );
    default:
      return assertNever(stage, "loadDefinitionForAddress");
  }
}
