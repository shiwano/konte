import { directionPartHashes } from "../../../core/direction-hash.js";
import { loadDirectionIfPresent } from "../../load-definition.js";

/**
 * The current content hash of every direction feedback target — what a direction comment's snapshot
 * is compared against to decide staleness. `undefined` when direction.ts is absent or unloadable:
 * staleness is then left unevaluated rather than reported wholesale, since a read-only listing must
 * not turn a broken direction into "every comment is stale".
 */
export async function directionSubjectHashes(
  videoRoot: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  const direction = await loadDirectionIfPresent(videoRoot).catch(() => null);
  return direction ? directionPartHashes(direction) : undefined;
}
