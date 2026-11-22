import {
  formatAddress,
  formatCompositionAddress,
  formatTimelineOverlayAddress,
  isCompositionAddress,
  isOverlayAddress,
  isStemAddress,
  parseAddress,
} from "./address.js";
import { shotStemAssetNames } from "./definition-addresses.js";
import { findShotOverflows } from "./animatic-overflow.js";
import { compositionPictureNodes } from "./composition-builder.js";
import { substituteAssetPlaceholders } from "./composition-refs.js";
import { materializeCompositionVariant } from "./composition-resource.js";
import {
  compositionFingerprintRefs,
  compositionInputFingerprints,
  compositionRefsResolvable,
  definitionHashForAddress,
  memoizedInput,
  overlayFingerprintRefs,
  shotStemOf,
  shotStemStructure,
  timelineStemRefs,
} from "./leaf-hash.js";
import { materializeOverlayVariant } from "./overlay-resource.js";
import { shotById } from "./shot-index.js";
import { formatStaleCause } from "./staleness.js";
import { stableHash } from "./content-hash.js";
import { stableStringify } from "./stable-stringify.js";
import type { StateManager } from "./state/index.js";
import {
  commitShotStem,
  discardPreparedStem,
  materializeTimelineStem,
  prepareShotStem,
  type PreparedShotStem,
} from "./stem-resource.js";
import {
  isPendingShot,
  type AnimaticDefinition,
  type ShotDefinition,
  type StageDefinition,
} from "./types/index.js";

// Whether every shot accept on the stage stands: each developed shot's composition accepted at its
// current definition, and no shot left to develop. The overlay is signed off by these; only once
// they all stand is it reviewed on its own. A composition `counterpart` settles stands too.
export function shotAcceptsStand(
  manager: StateManager,
  video: StageDefinition,
  counterpart: StageDefinition | null = null,
): boolean {
  if (video.shots.some((s) => s.pending)) return false;
  return video.shots
    .filter((s) => s.shotFn)
    .every((s) => {
      const address = formatCompositionAddress(video.stage, s.id);
      return (
        leafSettledAcross(manager, video, counterpart, address) ||
        (manager.getAcceptedVariant(address) !== null &&
          !manager.stalenessView().isAcceptedStale(address))
      );
    });
}

/** Whether the overlay is owed an accept: it needs review, and every shot accept under it stands. */
export function overlayAwaitsAccept(
  manager: StateManager,
  video: StageDefinition,
  counterpart: StageDefinition | null = null,
): boolean {
  if (!video.overlay) return false;
  const address = formatTimelineOverlayAddress(video.stage);
  return (
    materializedLeafReviewStatus(manager, address).needsReview &&
    shotAcceptsStand(manager, video, counterpart)
  );
}

// ── Content-hash baseline (review snapshot) ─────────────────────────────────
// A materialized leaf's *content hash*: sha256 over its definition hash and resolved input
// fingerprints — the (definitionHash, inputFingerprints) pair variant identity is matched on
// (findMatchingCompositionVariant). No state write, and no *full-artifact* render: a stem's part is
// a pure structure hash, and a composition reuses the discovery-mode structure hash that
// definition-staleness already computes (lighter than the full rendered HTML). A review snapshots it
// per shown leaf so a refused handoff note can diff a leaf's current content against what was
// reviewed, catching a definition edit or an upstream take swap alike.
//
// Deliberately NOT a variant's `outputHash`, which hashes the produced *artifact* (a composition's
// full rendered HTML, a stem's manifest file) and tracks render details — a heavier, render-bound
// value; the content hash is the identity both leaves already match on.
function leafContentHash(
  definitionHash: string,
  inputFingerprints: Record<string, string>,
): string {
  return stableHash({ definitionHash, inputFingerprints });
}

// The refs a materialized leaf draws on: `compositionRefsOf` its shot for a composition, a shot
// stem's cues, the timeline beds, the overlay's refs. null when the address is not a renderable
// leaf (no shotFn / no audio cues / no soundtracks), which is not the same as a leaf whose refs do
// not resolve.
function leafRefs(
  video: StageDefinition,
  address: string,
  compositionRefsOf: (shot: ShotDefinition) => readonly string[],
): readonly string[] | null {
  if (isOverlayAddress(address)) return video.overlay?.compositionRefs ?? null;
  const parsed = parseAddress(address);
  if (isCompositionAddress(address)) {
    if (parsed.kind !== "shot") return null;
    const shot = shotById(video.shots, parsed.shotId);
    return shot?.shotFn ? compositionRefsOf(shot) : null;
  }
  if (isStemAddress(address)) {
    if (parsed.kind === "shot") return shotStemOf(video, address)?.refs ?? null;
    if (parsed.kind === "timeline") {
      return (video.timelineSoundtracks?.length ?? 0) > 0 ? timelineStemRefs(video) : null;
    }
  }
  return null;
}

// The refs a leaf's materializer fingerprints.
function leafInputRefs(video: StageDefinition, address: string): readonly string[] | null {
  return leafRefs(video, address, (shot) => compositionFingerprintRefs(video, shot));
}

// The content-hash baseline of one materialized leaf (composition / stem), or null when it is not a
// renderable leaf or its inputs do not resolve (nothing was shown to snapshot). Pure — no render, no
// state write. Shared by the review submit (records it) and the preview's handoff (diffs against it).
export function materializedLeafContentHash(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): string | null {
  const definitionHash = definitionHashForAddress(video, address);
  if (definitionHash == null) return null;
  const refs = leafInputRefs(video, address);
  if (refs === null) return null;
  if (!compositionRefsResolvable(manager, refs)) return null;
  const inputFingerprints = compositionInputFingerprints(
    manager,
    isOverlayAddress(address) ? overlayFingerprintRefs(video) : refs,
  );
  return leafContentHash(definitionHash, inputFingerprints);
}

// The refs a leaf's readiness is judged on: for a composition, the shot's whole pool, which the
// render plan gates its build on.
function leafReadinessRefs(video: StageDefinition, address: string): readonly string[] | null {
  return leafRefs(video, address, (shot) => {
    const pool = Object.keys(shot.assets ?? {}).map((name) =>
      formatAddress(video.stage, shot.id, name),
    );
    return [...new Set([...(shot.compositionRefs ?? []), ...pool])];
  });
}

// Whether a materialized leaf (composition / stem) is ready to be reviewed right now: it has a
// renderable structure and every ref it consumes resolves to a ready variant. The read-only twin
// of the materializers' own gates — status uses it to surface a never-accepted leaf for review
// without writing anything, now that leaves are materialized only on accept.
export function leafReadyForReview(
  manager: StateManager,
  video: StageDefinition,
  address: string,
  // The board, to count a stem the video's review re-mixes on opening (`boardStemAwaitsVideo`) ready.
  board?: StageDefinition | null,
): boolean {
  const refs = leafReadinessRefs(video, address);
  if (refs === null) return false;
  const remixed = (ref: string) => !!board && boardStemAwaitsVideo(manager, board, video, ref);
  return compositionRefsResolvable(
    manager,
    refs.filter((ref) => !remixed(ref)),
  );
}

// The review status of a materialized leaf (composition / stem / overlay): its accepted variant
// (null when none) and whether it needs review. An UNaccepted leaf needs review — it was never
// signed off in context — as does a stale accepted one, so "never accepted" and
// "accepted-then-stale" are treated alike.
export function materializedLeafReviewStatus(
  manager: StateManager,
  address: string,
): { variantId: string | null; needsReview: boolean } {
  const variantId = manager.getAcceptedVariant(address);
  return {
    variantId,
    needsReview: variantId === null || manager.stalenessView().isAcceptedStale(address),
  };
}

// A shot leaf one stage need not review because the other shot stage's accept already signs it off.
export function leafSettledAcross(
  manager: StateManager,
  own: StageDefinition | null,
  counterpart: StageDefinition | null,
  address: string,
): boolean {
  if (!own || !counterpart) return false;
  const stages = new Set([own.stage, counterpart.stage]);
  if (!stages.has("animatic") || !stages.has("video")) return false;
  const composition = isCompositionAddress(address);
  if (!composition && !isStemAddress(address)) return false;
  const parsed = parseAddress(address);
  if (parsed.stage !== own.stage || parsed.kind !== "shot") return false;
  const ownShot = shotById(own.shots, parsed.shotId);
  const counterpartShot = shotById(counterpart.shots, parsed.shotId);
  if (!ownShot?.shotFn || !counterpartShot?.shotFn) return false;
  const videoShot = own.stage === "video" ? ownShot : counterpartShot;
  const video = own.stage === "video" ? own : counterpart;
  if (composition && pictureDrawnOnBoth(manager, video, videoShot)) {
    return compositionCovered(manager, own, counterpart, ownShot, address);
  }
  if (!composition && own.stage === "video" && counterpart.stage === "animatic") {
    return videoStemPlaysBoardStems(manager, own, counterpart, address);
  }
  if (own.stage !== "animatic") return false;
  return boardLeafPastBoard(manager, own, counterpart, ownShot, counterpartShot, address);
}

// A video shot's stem whose every cue is a distinct signed-off stem of its board shot, played whole
// at its own level.
function videoStemPlaysBoardStems(
  manager: StateManager,
  video: StageDefinition,
  board: AnimaticDefinition,
  address: string,
): boolean {
  const structure = shotStemStructure(video, address);
  if (structure === null) return false;
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return false;
  const boardStems = new Set(
    shotStemAssetNames("animatic").map((name) => formatAddress("animatic", parsed.shotId, name)),
  );
  if (new Set(structure.cues.map((cue) => cue.src)).size !== structure.cues.length) return false;
  return structure.cues.every(
    (cue) =>
      boardStems.has(cue.src) &&
      cue.track === "sound" &&
      (cue.start ?? 0) === 0 &&
      cue.duration === null &&
      (cue.mediaStart ?? 0) === 0 &&
      cue.rate === 1 &&
      (cue.volume ?? 1) === 1 &&
      cue.fadeIn === null &&
      cue.fadeOut === null &&
      leafSignedOff(manager, board, cue.src),
  );
}

function pictureDrawnOnBoth(
  manager: StateManager,
  video: StageDefinition,
  videoShot: ShotDefinition,
): boolean {
  return videoShot.graphic === true || !videoShotHasVariant(manager, video, videoShot);
}

// A composition whose picture the other stage's signed-off composition holds, drawn over the same
// files.
function compositionCovered(
  manager: StateManager,
  own: StageDefinition,
  counterpart: StageDefinition,
  ownShot: ShotDefinition,
  address: string,
): boolean {
  if (!pictureContains(manager, counterpart, own, ownShot.id)) return false;
  const drawn = signedOffFingerprints(manager, counterpart, ownShot.id);
  if (drawn === null) return false;
  return leafInputsJudged(manager, own, ownShot, address, drawn);
}

// A board stem the video plays under a shot it builds without spending, aged out under an accept
// whose takes still stand: either review hears the same mix, so either one's accept settles it.
export function boardStemAwaitsVideo(
  manager: StateManager,
  board: StageDefinition | null,
  video: StageDefinition | null,
  address: string,
): boolean {
  if (board?.stage !== "animatic" || video?.stage !== "video") return false;
  if (!boardStemAgedUnderVideo(manager, board, video, address)) return false;
  // The video can review the shot once these re-mixes resolve: every other ref is ready.
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return false;
  const refs = leafReadinessRefs(video, formatCompositionAddress(video.stage, parsed.shotId)) ?? [];
  return compositionRefsResolvable(
    manager,
    refs.filter((ref) => !boardStemAgedUnderVideo(manager, board, video, ref)),
  );
}

function boardStemAgedUnderVideo(
  manager: StateManager,
  board: AnimaticDefinition,
  video: StageDefinition,
  address: string,
): boolean {
  if (!isStemAddress(address)) return false;
  const parsed = parseAddress(address);
  if (parsed.stage !== "animatic" || parsed.kind !== "shot") return false;
  const boardShot = shotById(board.shots, parsed.shotId);
  const videoShot = shotById(video.shots, parsed.shotId);
  if (!boardShot?.shotFn || !videoShot?.shotFn || isPendingShot(videoShot)) return false;
  if (!(videoShot.compositionRefs ?? []).includes(address)) return false;
  if (videoShotHasVariant(manager, video, videoShot)) return false;
  if (manager.getAcceptedVariant(address) === null) return false;
  if (!materializedLeafReviewStatus(manager, address).needsReview) {
    return false;
  }
  if (!leafInputsJudged(manager, board, boardShot, address, new Set())) return false;
  return !findShotOverflows(board, manager, boardShot, "resolved").some(
    (o) => o.address === address,
  );
}

// A board composition the video's own pending verdict will settle: the video's picture holds it
// over the takes it draws now, and the video's composition awaits review. Its review is the
// video's to route to.
export function boardCompositionAwaitsVideo(
  manager: StateManager,
  board: StageDefinition | null,
  video: StageDefinition | null,
  address: string,
): boolean {
  if (board?.stage !== "animatic" || video?.stage !== "video") return false;
  if (!isCompositionAddress(address)) return false;
  const parsed = parseAddress(address);
  if (parsed.stage !== "animatic" || parsed.kind !== "shot") return false;
  const boardShot = shotById(board.shots, parsed.shotId);
  const videoShot = shotById(video.shots, parsed.shotId);
  if (!boardShot?.shotFn || !videoShot?.shotFn) return false;
  if (!pictureDrawnOnBoth(manager, video, videoShot)) return false;
  if (!pictureContains(manager, video, board, parsed.shotId)) return false;
  const videoAddress = formatCompositionAddress(video.stage, parsed.shotId);
  if (
    !leafReadyForReview(manager, video, videoAddress, board) ||
    leafSignedOff(manager, video, videoAddress)
  ) {
    return false;
  }
  const drawn = compositionInputFingerprints(manager, compositionFingerprintRefs(video, videoShot));
  return leafInputsJudged(manager, board, boardShot, address, new Set(Object.values(drawn)));
}

// A board shot's composition or stem once the video develops the shot past the board: the board was
// reviewed (the leaf holds an accept) and the video has spent on it (a take of the shot). From then
// on the video's review is where the shot is judged, and konte keeps the leaf current itself
// (`remakeSettledLeaves`) — over the takes its accept recorded: a moved or new input, and
// what it is made from left unaccepted, stay the board's. So does a stem whose line the clamp cuts.
function boardLeafPastBoard(
  manager: StateManager,
  board: AnimaticDefinition,
  video: StageDefinition,
  boardShot: ShotDefinition,
  videoShot: ShotDefinition,
  address: string,
): boolean {
  if (manager.getAcceptedVariant(address) === null) return false;
  if (!videoShotHasVariant(manager, video, videoShot)) return false;
  if (!leafInputsJudged(manager, board, boardShot, address, new Set())) return false;
  if (isCompositionAddress(address)) return true;
  return !findShotOverflows(board, manager, boardShot, "resolved").some(
    (o) => o.address === address,
  );
}

// Whether every input a leaf consumes resolves to an accepted take, and every one it fingerprints
// stands at the take the leaf's own accept recorded, or at a file `drawn` (another accept's
// fingerprints, by output hash) holds.
function leafInputsJudged(
  manager: StateManager,
  stage: StageDefinition,
  shot: ShotDefinition,
  address: string,
  drawn: ReadonlySet<string>,
): boolean {
  const refs = leafReadinessRefs(stage, address);
  if (refs === null) return false;
  if (refs.some((ref) => !manager.resolveReference(ref, { requireAccepted: true }))) return false;
  const accepted = manager.stalenessView().acceptedStaleness(address);
  const judged = (current: string | null | undefined): boolean =>
    current != null && drawn.has(current);
  if (!accepted.changedInputs.every((i) => judged(i.current))) return false;
  const recorded =
    (accepted.variantId &&
      manager.tryGetAssetState(address)?.variants?.[accepted.variantId]?.inputFingerprints) ||
    {};
  const fingerprinted = isCompositionAddress(address)
    ? compositionFingerprintRefs(stage, shot)
    : (shotStemOf(stage, address)?.refs ?? []);
  return fingerprinted.every(
    (ref) => ref in recorded || judged(manager.resolveReference(ref)?.outputHash),
  );
}

// What a shot's composition puts on screen, and the frame it is put in.
function compositionPicture(
  video: StageDefinition,
  shotId: string,
): { frame: string; nodes: string[] } | null {
  return memoizedInput(video, `picture:${shotId}`, () => {
    const nodes = compositionPictureNodes(video, shotId);
    if (nodes === null) return null;
    const size = video.format.size;
    const frame = stableStringify({
      typography: video.typography,
      duration: shotById(video.shots, shotId)?.duration,
      width: size?.width,
      height: size?.height,
    });
    return { frame, nodes };
  }) as { frame: string; nodes: string[] } | null;
}

// Whether `outer`'s picture of a shot holds `inner`'s: the same frame, every node `inner` puts on
// screen standing in `outer` in the same order, and no node only `outer` has carrying a style or
// script. An asset is compared by the file it resolves to, so each stage's own asset of one file
// draws the same picture, and a `<Panel>` draws what an `<Image>` of its file does — unless
// something else in either picture reads the panel's mark.
function pictureContains(
  manager: StateManager,
  outer: StageDefinition,
  inner: StageDefinition,
  shotId: string,
): boolean {
  const o = compositionPicture(outer, shotId);
  const i = compositionPicture(inner, shotId);
  if (!o || !i || o.frame !== i.frame) return false;
  const bareImage = (node: string): boolean => /^<img\b[^<>]*\/>$/.test(node);
  const unmarked = ![...o.nodes, ...i.nodes].some(
    (node) => !bareImage(node) && /konte-?panel/i.test(node),
  );
  const byFile = (node: string): string =>
    substituteAssetPlaceholders(
      unmarked && bareImage(node) ? node.replace(/ data-konte-panel="[^"]*"/, "") : node,
      (ref) => {
        const hash = manager.resolveReference(ref)?.outputHash;
        return hash ? `__konte-file:${hash}__` : null;
      },
    );
  const innerNodes = i.nodes.map(byFile);
  let matched = 0;
  for (const node of o.nodes.map(byFile)) {
    if (node === innerNodes[matched]) matched++;
    else if (/<(?:style|script|link)\b/i.test(node)) return false;
  }
  return matched === innerNodes.length;
}

// The files a stage's shot composition was signed off over, by output hash; null while it stands
// unsigned.
function signedOffFingerprints(
  manager: StateManager,
  stage: StageDefinition,
  shotId: string,
): ReadonlySet<string> | null {
  const address = formatCompositionAddress(stage.stage, shotId);
  if (!leafSignedOff(manager, stage, address)) return null;
  const variantId = manager.getAcceptedVariant(address);
  const recorded =
    (variantId && manager.tryGetAssetState(address)?.variants?.[variantId]?.inputFingerprints) ||
    {};
  return new Set(Object.values(recorded));
}

// Whether the video has spent on a shot: a take of one of its generated assets.
function videoShotHasVariant(
  manager: StateManager,
  video: StageDefinition,
  shot: ShotDefinition,
): boolean {
  return Object.entries(shot.assets ?? {}).some(
    ([name, asset]) =>
      asset.kind !== "file" &&
      Object.values(
        manager.tryGetAssetState(formatAddress(video.stage, shot.id, name))?.variants ?? {},
      ).some((v) => v.file),
  );
}

// Whether a materialized leaf is signed off as of right now: reviewable, and accepted at its current
// definition and inputs. Both halves are required — staleness reads an input that resolves to
// nothing as "not determinable" rather than changed, so an accept whose inputs stopped resolving
// would otherwise read fresh.
export function leafSignedOff(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): boolean {
  if (!leafReadyForReview(manager, video, address)) return false;
  return !materializedLeafReviewStatus(manager, address).needsReview;
}

/** One ref a leaf consumes that resolves to nothing a spend may bake, and why. */
export interface UnresolvedLeafRef {
  address: string;
  // In the words `inspect` uses for the same state, so a reader is not made to translate between
  // this and `status`.
  cause: string;
}

/**
 * The refs behind a false `leafReadyForReview`, each with its cause — what a caller reports so the
 * reviewer is not sent to `status -v` to find out which input held the leaf back. Empty when the
 * leaf is ready, and when the address is no leaf at all (`leafReadyForReview` answers that half).
 */
export function unresolvedLeafRefs(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): UnresolvedLeafRef[] {
  const unresolved: UnresolvedLeafRef[] = [];
  for (const ref of leafReadinessRefs(video, address) ?? []) {
    const cause = unresolvedRefCause(manager, ref);
    if (cause !== null) unresolved.push({ address: ref, cause });
  }
  return unresolved;
}

// Why one ref resolves to nothing a spend may build on; null when it resolves. Every case here is
// the next `generate`'s work — a human accept resolves whatever its staleness, so a stale take that
// got this far is one `generate` re-bakes, as are a dismissed-only address and an unfinished job.
function unresolvedRefCause(manager: StateManager, address: string): string | null {
  if (manager.resolveReference(address, { includeStale: false })) return null;
  // Only strict resolution refused, so what a read surface still shows is a stale take.
  const stale = manager.selectVariant(address, { includeStale: true });
  if (stale) {
    const staleness = manager.variantStaleness(address, stale.variantId);
    return (staleness && formatStaleCause(staleness)) || "stale";
  }
  const variants = Object.values(manager.getState().assets[address]?.variants ?? {});
  if (variants.length === 0) return "no take yet";
  if (variants.every((v) => v.status === "dismissed")) return "every take was dismissed";
  return "no take has an output file yet";
}

/**
 * A leaf readied for its accept. Only a board shot's stem has work worth doing outside the lock
 * (its ffmpeg mix); every other leaf is materialized at commit.
 */
type PreparedLeaf = { kind: "inline" } | { kind: "shot-stem"; prepared: PreparedShotStem };

// Ready the composition/stem leaf an address names for its accept, without touching state. Null
// when the address is not a leaf or the leaf has nothing to materialize (pending shot, no audio).
export async function prepareLeafForAddress(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): Promise<PreparedLeaf | null> {
  // Gate on the same readiness `status` uses, so accept-materialize is possible exactly when the
  // leaf shows under "Needs review". A composition renders its <Audio> too (only its hash is
  // audio-independent), so every ref — audio included — must resolve before we build it.
  if (!leafReadyForReview(manager, video, address)) return null;
  if (isOverlayAddress(address)) return { kind: "inline" };
  const parsed = parseAddress(address);
  if (parsed.kind === "shot" && isStemAddress(address)) {
    const prepared = await prepareShotStem({ manager, video, address });
    return prepared ? { kind: "shot-stem", prepared } : null;
  }
  if (parsed.kind === "shot" || parsed.kind === "timeline") return { kind: "inline" };
  return null;
}

export async function discardPreparedLeaf(prepared: PreparedLeaf | null): Promise<void> {
  if (prepared?.kind === "shot-stem") await discardPreparedStem(prepared.prepared);
}

// Write a prepared leaf under the state lock and return its variant id (idempotent — reuses a
// matching variant). Mutates in-memory state — the caller persists.
export async function commitLeafForAddress(
  manager: StateManager,
  video: StageDefinition,
  address: string,
  prepared: PreparedLeaf,
): Promise<string | null> {
  if (prepared.kind === "shot-stem") {
    return commitShotStem({ manager, video, address, prepared: prepared.prepared });
  }
  if (!leafReadyForReview(manager, video, address)) return null;
  if (isOverlayAddress(address)) return materializeOverlayVariant({ manager, video });
  const parsed = parseAddress(address);
  if (parsed.kind === "shot") {
    return isCompositionAddress(address)
      ? materializeCompositionVariant({ manager, video, shotId: parsed.shotId })
      : null;
  }
  if (parsed.kind === "timeline") {
    return materializeTimelineStem({ manager, video });
  }
  return null;
}
