import {
  formatAddress,
  formatAssetPath,
  formatCompositionAddress,
  formatTimelineAddress,
  formatTimelineStemAddress,
  getStage,
  isNarrationStemAddress,
  isStemAddress,
  listShotStems,
  shotCueRefs,
  shotStemAssetNames,
  tryParseAddress,
} from "./address.js";
import { definitionHashForAddress, removedShotStemAddresses } from "./composition-resource.js";
import { newestReadyUndecidedTake } from "./staleness.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { extractRefs } from "./graph.js";
import { variantMediaKind } from "./media-type.js";
import { shotById } from "./shot-index.js";
import type { StateManager } from "./state/index.js";
import { isPendingShot, type AssetDefinition, type StageDefinition } from "./types/index.js";

/**
 * The addresses ONE shot decision lands on, split by how each is accepted.
 *
 * This is the definition of what a stage's review can decide about a shot: the submit accepts from
 * it, the post-condition read-back confirms against it, and `status` checks its "Needs review" rows
 * against it. An address that earns no entry here is one no toggle reaches — which is a konte bug,
 * and is reported as one rather than sitting under "Needs review" forever.
 */
export interface ShotAcceptTargets {
  /** Per-asset picture takes — accepted from the review's `displayed` snapshot. */
  pictureAssets: string[];
  /** The audio takes the shot's stems are mixed from — accepted before a stem materializes. */
  stemSources: string[];
  /** Materialized leaves, in review order. `what` is the read-back's wording for each. */
  leaves: { address: string; what: string }[];
}

const EMPTY: ShotAcceptTargets = {
  pictureAssets: [],
  stemSources: [],
  leaves: [],
};

/**
 * `resolvedVariants` is the render plan's, so `pictureAssets` names what the reviewer was shown.
 * Omitted (the read-back's shot shape), the shot's declared assets stand in, split by the media each
 * take on disk is.
 */
export function shotAcceptTargets(
  manager: StateManager,
  video: StageDefinition,
  shot: {
    shotId: string;
    pending: boolean;
    shotFn: unknown;
    resolvedVariants?: Record<string, string>;
  },
): ShotAcceptTargets {
  // A pendingShot has no take of any kind — its decision is a no-op by definition, not a miss.
  if (shot.pending) return EMPTY;
  const stage = video.stage;
  const definition = shotById(video.shots, shot.shotId);

  const assetNames = shot.resolvedVariants
    ? Object.keys(shot.resolvedVariants)
    : Object.keys(definition?.assets ?? {});
  // Audio takes ride the stem's accept, never the picture path — even a cue that names a per-shot
  // asset.
  const pictureAssets = assetNames
    .map((assetName) => ({
      address: formatAddress(stage, shot.shotId, assetName),
      variantId:
        shot.resolvedVariants?.[assetName] ??
        manager.resolveReference(formatAddress(stage, shot.shotId, assetName), {
          includeStale: true,
        })?.variantId ??
        null,
    }))
    .filter(({ address, variantId }) => variantMediaKind(manager, address, variantId) !== "audio")
    .map(({ address }) => address);

  // A stem the shot still mixes, or one still accepted after its last cue left it.
  const stems = new Set([
    ...(definition ? listShotStems(stage, definition).map((stem) => stem.address) : []),
    ...removedShotStemAddresses(manager.getState(), video, shot.shotId),
  ]);
  return {
    pictureAssets,
    stemSources: definition ? shotCueRefs(definition) : [],
    leaves: [
      ...(shot.shotFn
        ? [{ address: formatCompositionAddress(stage, shot.shotId), what: "the composition" }]
        : []),
      ...shotStemAssetNames(stage)
        .map((name) => formatAssetPath(stage, shot.shotId, name))
        .filter((address) => stems.has(address))
        .map((address) => ({
          address,
          what: isNarrationStemAddress(address) ? "the narration stem" : "the audio stem",
        })),
    ],
  };
}

/**
 * Whether the half a shot is showing still holds a verdict to make — the ONE answer to "is this
 * shot done", read by the review page for its accept toggle. Derived from `shotAcceptTargets`, so
 * what settles a shot is exactly what its accept signs off; a target added there is covered here
 * without an edit.
 *
 * An address is settled when it carries an accepted take that is still current and no ready,
 * undecided take stands beside it. A materialized leaf answers through `leafSettled`, which the
 * caller supplies (it needs the leaf materializer). A shot whose half signs off nothing at all is
 * never settled: an accept over nothing is vacuous.
 */
export function shotNeedsVerdict(
  manager: StateManager,
  video: StageDefinition,
  shot: {
    shotId: string;
    pending: boolean;
    shotFn: unknown;
    resolvedVariants?: Record<string, string>;
  },
  leafSettled: (address: string) => boolean,
): boolean {
  if (shot.pending) return false;
  const targets = shotAcceptTargets(manager, video, shot);
  const takes = [...targets.pictureAssets, ...targets.stemSources];
  if (takes.length === 0 && targets.leaves.length === 0) return true;
  if (targets.leaves.some(({ address }) => !leafSettled(address))) return true;
  return takes.some((address) => !takeSettled(manager, video, address));
}

function takeSettled(manager: StateManager, video: StageDefinition, address: string): boolean {
  if (manager.getAcceptedVariant(address) === null) return false;
  // Whether a rival stands beside that accept is only answerable where this definition reaches. A
  // cross-stage source (a shared `reference:` SFX a shot plays, a board frame under a video shot) is
  // judged on its own stage's page.
  if (getStage(address) !== video.stage) return true;
  return !hasUndecidedTake(manager, video, address);
}

function hasUndecidedTake(manager: StateManager, video: StageDefinition, address: string): boolean {
  let definitionHash: string | null = null;
  try {
    definitionHash = definitionHashForAddress(video, address);
  } catch {
    // An address the definition no longer carries. Nothing to flip a shot for.
    return false;
  }
  return (
    newestReadyUndecidedTake(
      manager.getState(),
      address,
      definitionHash,
      undefined,
      // The registered patch axis, so a take whose correction moved reads stale here exactly as it
      // does on the page and in `status`.
      manager.patchHashes(),
      manager.stalenessCache(),
    ) !== null
  );
}

/**
 * Every address `konte preview video` can take a verdict on, over BOTH halves of every shot plus the
 * timeline — the union, not the half a given reel is showing. Which half is on screen decides where
 * a verdict lands, never whether the address is reachable at all, and the union is what makes this
 * answerable from the definition alone (no render plan, so `status` can afford it).
 *
 * Closed over each target's own refs, because an accept cascades into what its take consumed
 * (`cascadeAcceptConsumedDeps`) — and closed the way that walk actually runs, audio boundary
 * included: a picture-rooted cascade never signs off an audio dep, so an audio address hanging off
 * a delivered picture take and named by no stem is NOT decidable, whatever the ref graph says.
 *
 * Within a permitted branch the closure is still a definition-level over-approximation of the walk
 * — it may include an address a particular state's cascade would not reach — which is the safe
 * direction for a detector: a reported address is one nothing here reaches.
 */
export function stageReviewDecidableAddresses(
  manager: StateManager,
  video: StageDefinition,
): Set<string> {
  // Each root carries whether a cascade from it may sign off audio: a stem and a stem source may, a
  // picture take may not (`cascadeAcceptConsumedDeps`'s `allowAudio`).
  const roots: Array<{ address: string; allowAudio: boolean }> = [];
  const add = (address: string | null | undefined, allowAudio: boolean): void => {
    if (address) roots.push({ address, allowAudio });
  };

  for (const shot of video.shots) {
    const shape = { shotId: shot.id, pending: isPendingShot(shot), shotFn: shot.shotFn ?? null };
    const targets = shotAcceptTargets(manager, video, shape);
    for (const address of targets.pictureAssets) add(address, false);
    for (const address of targets.stemSources) add(address, true);
    for (const leaf of targets.leaves) add(leaf.address, isStemAddress(leaf.address));
  }

  if ((video.timelineSoundtracks?.length ?? 0) > 0) {
    add(formatTimelineStemAddress(video.stage), true);
  }
  for (const soundtrack of video.timelineSoundtracks ?? []) {
    add(parsePlaceholder(soundtrack.src.src), true);
  }
  // A timeline asset rides the composition accept's cascade, which is picture-rooted — so an audio
  // one is decidable only as a soundtrack source, already rooted above.
  for (const assetName of Object.keys(video.topLevelAssets ?? {})) {
    const address = formatTimelineAddress(video.stage, assetName);
    if (!isAudioAddress(manager, address)) add(address, false);
  }
  return closeOverRefs(manager, video, roots);
}

// Walk each root's definition refs transitively, keeping only what this stage owns — an animatic
// panel or a reference asset is decided on its own stage's page, so naming it here would
// claim a reachability this surface does not have. An audio ref under a picture-rooted branch is
// dropped for the same reason: the cascade would not sign it off either.
function closeOverRefs(
  manager: StateManager,
  video: StageDefinition,
  roots: ReadonlyArray<{ address: string; allowAudio: boolean }>,
): Set<string> {
  const reached = new Set(roots.map((root) => root.address));
  // Visited is keyed by (address, allowAudio), not by address: an intermediate both a picture take
  // and a stem source consume is walked under BOTH modes, because only the audio-permitting one
  // reaches the audio deps beneath it. Keyed by address alone, whichever mode arrived first would
  // suppress the other. Each address is walked at most twice.
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const { address, allowAudio } = queue.pop()!;
    const key = `${allowAudio ? "a" : "p"}:${address}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const ref of refsOf(video, address)) {
      if (getStage(ref) !== video.stage) continue;
      if (!allowAudio && isAudioAddress(manager, ref)) continue;
      reached.add(ref);
      queue.push({ address: ref, allowAudio });
    }
  }
  return reached;
}

// An address whose take on disk is audio. An address with no take yet reads as non-audio, so it
// stays in the closure — the over-approximating direction, and the only one available before
// anything has been generated.
function isAudioAddress(manager: StateManager, address: string): boolean {
  const variantId = manager.resolveReference(address, { includeStale: true })?.variantId ?? null;
  return variantId !== null && variantMediaKind(manager, address, variantId) === "audio";
}

function refsOf(video: StageDefinition, address: string): readonly string[] {
  const parsed = tryParseAddress(address);
  if (!parsed || parsed.stage !== video.stage || !parsed.assetName) return [];
  const definition =
    parsed.kind === "shot"
      ? shotById(video.shots, parsed.shotId)?.assets?.[parsed.assetName]
      : parsed.kind === "plate"
        ? (video as { plates?: Record<string, AssetDefinition> }).plates?.[parsed.assetName]
        : video.topLevelAssets?.[parsed.assetName];
  return definition ? extractRefs(definition) : [];
}
