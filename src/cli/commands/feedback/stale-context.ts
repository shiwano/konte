import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import type { FeedbackStaleContext } from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/manager.js";
import type { KonteState } from "../../../core/types/index.js";
import { liveDefinitionHashes } from "./definition-hashes.js";
import { directionSubjectHashes } from "./subject-hashes.js";

// The state and staleness context a read-only feedback command judges each comment against — the
// takes resolved the way the review surfaces display them, plus the live direction and definition
// hashes.
export async function loadFeedbackStaleContext(
  videoRoot: string,
): Promise<{ state: KonteState; ctx: FeedbackStaleContext }> {
  const manager = await StateManager.load(videoRoot);
  const state = manager.getState();
  await applyResolutionDefinitions({ videoRoot, state });
  return {
    state,
    ctx: {
      subjectHashes: await directionSubjectHashes(videoRoot),
      definitionHashes: await liveDefinitionHashes(videoRoot),
      cache: manager.stalenessCache(),
    },
  };
}
