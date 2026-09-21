import {
  formatCompositionAddress,
  formatTimelineStemAddress,
  listShotStems,
} from "../../../core/address.js";
import {
  compositionDefinitionHashForAddress,
  definitionHashForAddress,
} from "../../../core/composition-resource.js";
import { panelMoveHashes } from "../../../core/panel-move-hash.js";
import type { VideoDefinition } from "../../../core/types/index.js";
import type { AnimaticDefinition } from "../../../core/types/animatic.js";
import { loadVideoAndAnimatic } from "../../load-definition.js";

/**
 * The current live hash of everything a comment can snapshot that its take does not capture: each
 * video materialized leaf's definition (shot composition, stem, animatic, timeline stem) and each
 * animatic panel's declared movement (`blocking`/`camera`). Both axes in ONE map because a
 * comment's `displayedDefinitionHashes` is one map — a caller providing only half would read every
 * comment carrying the other half as stale.
 *
 * `undefined` when the definitions are absent or unloadable: staleness on this axis is then left
 * unevaluated rather than reported wholesale, matching `directionSubjectHashes`. A present map that
 * omits an address means that target left the definition, which reads as stale.
 */
export async function liveDefinitionHashes(
  videoRoot: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  const loaded = await loadVideoAndAnimatic(videoRoot).catch(() => null);
  if (!loaded) return undefined;
  return liveDefinitionHashesOf(loaded.video, loaded.animatic);
}

/** The same map, for a caller that already holds the definitions. */
export function liveDefinitionHashesOf(
  video: VideoDefinition,
  animatic: AnimaticDefinition | null,
): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  const set = (address: string, hash: string | null) => {
    if (hash) hashes.set(address, hash);
  };
  // Both composition stages carry leaves, and both have a reel review whose notes are keyed to them.
  for (const stage of [animatic, video]) {
    if (!stage) continue;
    for (const shot of stage.shots) {
      if (shot.shotFn) {
        const address = formatCompositionAddress(stage.stage, shot.id);
        set(address, compositionDefinitionHashForAddress(stage, address));
      }
      for (const { address } of listShotStems(stage.stage, shot)) {
        set(address, definitionHashForAddress(stage, address));
      }
    }
    if ((stage.timelineSoundtracks?.length ?? 0) > 0) {
      const address = formatTimelineStemAddress(stage.stage);
      set(address, definitionHashForAddress(stage, address));
    }
  }
  for (const [address, hash] of panelMoveHashes(animatic)) set(address, hash);
  return hashes;
}
