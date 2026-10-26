import { getStage, isStemAddress } from "./address.js";
import {
  commitShotStem,
  definitionHashForAddress,
  discardPreparedStem,
  leafSettledAcross,
  materializeCompositionVariant,
  materializedLeafReviewStatus,
  prepareShotStem,
  type PreparedShotStem,
  shotStemIdentityFor,
} from "./composition-resource.js";
import { errorMessage } from "./errors.js";
import type { DependencyGraph } from "./graph.js";
import { shotAcceptTargets } from "./shot-accept-targets.js";
import { StateManager } from "./state/index.js";
import { isPendingShot, type StageDefinition } from "./types/index.js";

// The leaves of `stage` the other shot stage settles (`leafSettledAcross`) that have aged out, by
// shot.
export function staleSettledLeaves(
  manager: StateManager,
  stage: StageDefinition,
  counterpart: StageDefinition,
  shotIds: ReadonlySet<string> | null,
  include: "stems" | "compositions",
  addresses: ReadonlySet<string> | null = null,
): Array<{ shotId: string; address: string }> {
  return stage.shots
    .filter((shot) => shot.shotFn && !isPendingShot(shot) && (!shotIds || shotIds.has(shot.id)))
    .flatMap((shot) =>
      shotAcceptTargets(manager, stage, { shotId: shot.id, pending: false, shotFn: shot.shotFn })
        .leaves.map(({ address }) => address)
        .filter((address) => isStemAddress(address) === (include === "stems"))
        .filter((address) => !addresses || addresses.has(address))
        .filter(
          (address) =>
            leafSettledAcross(manager, stage, counterpart, address) &&
            materializedLeafReviewStatus(manager, address, definitionHashForAddress(stage, address))
              .needsReview,
        )
        .map((address) => ({ shotId: shot.id, address })),
    );
}

type BoardLeaf = { shotId: string; address: string };

/** The board stems a spend on `assetPaths` (and on `extraRefs`) reaches through the graph. */
export function consumedBoardStems(
  graph: DependencyGraph,
  assetPaths: Iterable<string>,
  extraRefs: Iterable<string> = [],
): Set<string> {
  const stems = new Set<string>();
  const seen = new Set<string>();
  const queue = [...extraRefs];
  for (const assetPath of assetPaths) queue.push(...(graph.dependencies.get(assetPath) ?? []));
  while (queue.length > 0) {
    const dep = queue.pop()!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    if (isStemAddress(dep) && getStage(dep) === "animatic") stems.add(dep);
    queue.push(...(graph.dependencies.get(dep) ?? []));
  }
  return stems;
}

/**
 * Re-makes and accepts the leaves of `stage` the other shot stage settles that have aged out — the
 * board stems a spend or a video leaf is about to consume, or the compositions the other stage's
 * accept or an export reads. Stems are mixed outside the state lock; a leaf no longer settled by the
 * commit is left alone. Returns what was accepted, and what could not be made with why.
 */
export async function remakeSettledLeaves(opts: {
  videoRoot: string;
  stage: StageDefinition;
  counterpart: StageDefinition;
  shotIds?: Iterable<string>;
  // Only these leaves — what a targeted spend consumes (`consumedBoardStems`).
  addresses?: Iterable<string>;
  include: "stems" | "compositions";
}): Promise<{ accepted: BoardLeaf[]; failed: Array<BoardLeaf & { reason: string }> }> {
  const { videoRoot, stage, counterpart, include } = opts;
  const shotIds = opts.shotIds ? new Set(opts.shotIds) : null;
  const addresses = opts.addresses ? new Set(opts.addresses) : null;
  const snapshot = await StateManager.load(videoRoot);
  const pending = staleSettledLeaves(snapshot, stage, counterpart, shotIds, include, addresses);
  const failed: Array<BoardLeaf & { reason: string }> = [];
  if (pending.length === 0) return { accepted: [], failed };

  const prepared = new Map<string, PreparedShotStem>();
  try {
    for (const leaf of pending) {
      if (!isStemAddress(leaf.address)) continue;
      try {
        const p = await prepareShotStem({ manager: snapshot, video: stage, address: leaf.address });
        if (p) prepared.set(leaf.address, p);
        else failed.push({ ...leaf, reason: "its cues do not resolve to a take" });
      } catch (err) {
        failed.push({ ...leaf, reason: errorMessage(err) });
      }
    }
    const accepted = await StateManager.withLock(videoRoot, async (mgr) => {
      const still = new Set(
        staleSettledLeaves(mgr, stage, counterpart, shotIds, include, addresses).map(
          (l) => l.address,
        ),
      );
      const landed: BoardLeaf[] = [];
      for (const leaf of pending) {
        if (!still.has(leaf.address)) continue;
        const p = prepared.get(leaf.address);
        if (isStemAddress(leaf.address) && !p) continue;
        try {
          const variantId = p
            ? await commitShotStem({
                manager: mgr,
                video: stage,
                address: leaf.address,
                prepared: p,
              })
            : await materializeCompositionVariant({
                manager: mgr,
                video: stage,
                shotId: leaf.shotId,
              });
          if (!variantId) {
            failed.push({ ...leaf, reason: "it has nothing to build from" });
            continue;
          }
          mgr.setAccepted(leaf.address, variantId);
          landed.push(leaf);
        } catch (err) {
          failed.push({ ...leaf, reason: errorMessage(err) });
        }
      }
      return landed;
    });
    return { accepted, failed };
  } finally {
    for (const p of prepared.values()) await discardPreparedStem(p);
  }
}

/**
 * The run `remakeSettledLeaves` would make on the board's stems, in memory only, for a plan: each stale stem
 * stands accepted at its live identity, on a sentinel output, so what consumes it reads as the run
 * will leave it. Returns the stems it stood in for.
 */
export function planSupersededStemRemakes(
  manager: StateManager,
  board: StageDefinition,
  video: StageDefinition,
): BoardLeaf[] {
  const pending = staleSettledLeaves(manager, board, video, null, "stems");
  for (const { address } of pending) {
    const identity = shotStemIdentityFor(manager, board, address);
    const current = manager.getAcceptedVariant(address);
    const file = current ? manager.getAssetState(address).variants![current]!.file : null;
    if (!identity || !file) continue;
    const variantId = manager.reserveVariantId(address);
    Object.assign(manager.getAssetState(address).variants![variantId]!, {
      file,
      outputHash: `planned-remix-${variantId}`,
      definitionHash: identity.definitionHash,
      inputFingerprints: identity.inputFingerprints,
    });
    manager.setAccepted(address, variantId);
  }
  return pending;
}
