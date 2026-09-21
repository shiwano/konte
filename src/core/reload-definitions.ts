import { applyResolutionDefinitions } from "./definition-hashes.js";
import { loadAnimatic, loadReference, reloadVideoDefinition } from "./loader.js";
import { assertNarrationStemsPlaced } from "./narration-stem.js";
import { stageEntryPath } from "./roots.js";
import type { LoadedDefinitions } from "./select-definition.js";

// The three stage entries read fresh from disk — the project's modules evicted first, so an edit
// to any of them or to an adapter is seen — and registered for resolution, so a submit resolves
// the job's inputs against the same definitions it judges the job by. Every long-lived judge
// (the daemon, a `job wait` cascade) reads through this rather than through a snapshot it took at
// startup.
export async function reloadLoadedDefinitions(videoRoot: string): Promise<LoadedDefinitions> {
  const video = await reloadVideoDefinition(stageEntryPath(videoRoot, "video"));
  const animatic = await loadAnimatic(videoRoot, { reload: true });
  assertNarrationStemsPlaced(video, animatic);
  const reference = await loadReference(videoRoot, { reload: true });
  await applyResolutionDefinitions({ videoRoot, definitions: { video, animatic, reference } });
  return { video, animatic, reference };
}
