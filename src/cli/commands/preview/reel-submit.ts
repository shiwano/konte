import {
  cascadeAcceptConsumedDeps,
  cascadeDirectionShotAccepts,
} from "../../../core/accept-cascade.js";
import { remakeSettledLeaves } from "../../../core/board-leaves.js";
import { shotById } from "../../../core/shot-index.js";
import {
  assetNameOf,
  formatAddress,
  formatCompositionAddress,
  formatShotAddress,
  formatShotStemAddress,
  formatTimelineAddress,
  formatTimelineOverlayAddress,
  formatTimelineStemAddress,
  isHeardStemAddress,
  isMaterializedLeafAddress,
  isOverlayAddress,
  isStemAddress,
  listCompositionAddresses,
  listOverlayAddresses,
  formatThumbnailAddress,
  THUMBNAIL_FRAME_ADDRESS,
  thumbnailCoverAddress,
  listShotStems,
  listStemAddresses,
  parseAddress,
  parseAddressStream,
  parseShotAddress,
  shotStemAssetNames,
} from "../../../core/address.js";
import { resolveCompositionRef } from "../../../core/composition-refs.js";
import {
  commitShotStem,
  definitionHashForAddress,
  discardPreparedStem,
  leafReadyForReview,
  leafSignedOff,
  materializeCompositionVariant,
  materializedLeafContentHash,
  materializeOverlayVariant,
  materializeTimelineStem,
  overlayAwaitsAccept,
  overlayTimelineRefs,
  prepareShotStem,
  removedShotStemAddresses,
  timelineStemRefs,
  unresolvedLeafRefs,
  type PreparedShotStem,
  type UnresolvedLeafRef,
} from "../../../core/composition-resource.js";
import { variantMediaKind } from "../../../core/media-type.js";
import { shotAcceptTargets } from "../../../core/shot-accept-targets.js";
import { Semaphore } from "../../../core/semaphore.js";
import { computeAcceptedStaleness, formatStaleCause } from "../../../core/staleness.js";
import { errorMessage } from "../../../core/errors.js";
import { errorResponse, jsonResponse, parseJsonBody } from "../../page-host/http.js";
import {
  ReelSubmitSchema,
  type ReelSubmitBody,
  type ReelSubmitResponse,
} from "../../../core/types/review-submit.js";
import { buildReelReviewPlan } from "../../../core/review-acceptability.js";
import type {
  AnimaticDefinition,
  StageDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import { type RenderPlan, shotSpans } from "../../../core/render-plan.js";
import { type ReviewRecord, saveReviewRecord } from "../../../core/review-record.js";
import {
  type CommentSubjectAddresses,
  FeedbackManager,
  commentSubjectAddresses,
} from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  applyFeedbackMutations,
  applyKeepDecisions,
  applyRegenerateDecisions,
  handoffRecordFields,
  noteOverturned,
  storeOverallComment,
  withShotLocalTime,
  type FeedbackMutationResult,
} from "./review-shared.js";
import type { ReportOutcome } from "./review-outcome.js";
import type { ReelReviewContext } from "./reel-review.js";
import { reviewHeldFindings } from "../../finding-gates.js";
import { loadCheckContext } from "../../../core/check-context.js";
import { collectFindings, waiverCoverageOf } from "../../../core/checks.js";
import type { WaiverCoverage } from "../../../core/direction.js";
import { type Finding, formatFindingLine } from "../../../core/finding.js";

// ffmpeg mixes run per accepted shot; a whole-reel Accept all must not spawn one per shot at once.
const STEM_MIX_CONCURRENCY = 4;

/**
 * Which leaves of one shot accept did NOT land — read back from state after the accept blocks ran,
 * asked as `materializedLeafReviewStatus`: the review page's own "does this still need reviewing?".
 *
 * A shot's single accept is a promise about more than one leaf, and each of them can fail on its own
 * (each accept block swallows per-item failures so one bad shot cannot sink a whole review). An
 * animatic accept covers the provisional pass alone; a delivered accept covers the picture AND the
 * audio, so a stem that never materialized is a half-landed accept, not a landed one.
 *
 * A leaf landed only when it is BOTH reviewable right now and does not need reviewing. Neither half
 * suffices alone, and both exist to disqualify an accept left over from an earlier review that this
 * one failed to refresh:
 *
 * - `needsReview` catches the leftover whose definition moved on (definition-stale).
 * - `leafReadyForReview` catches the leftover whose inputs stopped resolving. Staleness deliberately
 *   reads an input that resolves to nothing as "not determinable" rather than changed
 *   (`computeVariantStalenessInternal` skips a `null` current), so that leftover would otherwise
 *   report perfectly fresh — while the materializers, which DO refuse on an unresolvable ref, had
 *   just declined to rebuild it. This is the read-only twin of their gate, so the two agree.
 *
 * Exported for its own tests — the invariant is the point, and it must not be reachable only by
 * driving a whole submit.
 */
export function unlandedShotLeaves(
  manager: StateManager,
  video: StageDefinition,
  shot: { shotId: string; pending: boolean; shotFn: unknown },
): Array<{ address: string; what: string }> {
  return shotAcceptTargets(manager, video, shot).leaves.filter(
    ({ address }) => !leafSignedOff(manager, video, address),
  );
}

/**
 * Why one leaf did not land, as the reviewer needs it: the cause, one line per input that held it
 * back, and the command that clears it. Reported instead of "check that every asset it references
 * resolves", which named nothing and sent the reader to `status -v` to find out what.
 *
 * Both halves of `leafSignedOff` are covered, because they send the reader to different places: refs
 * that stopped resolving are upstream work, while a leaf whose accepted take aged out is one
 * re-accept here.
 *
 * The detail lines carry no indentation of their own — each surface that prints a reason (the
 * review record, the page's skipped list) indents them to its own block.
 */
export function unlandedLeafReason(
  manager: StateManager,
  video: StageDefinition,
  leaf: { address: string; what: string },
): string {
  const { address, what } = leaf;
  const unresolved = unresolvedLeafRefs(manager, video, address);
  if (unresolved.length > 0) {
    return [
      `${what} could not be materialized; these inputs have no take a spend may use:`,
      ...unresolved.map((ref) => `${ref.address} (${ref.cause})`),
      ...unresolvedRefFixes(unresolved),
    ].join("\n");
  }
  // Every ref resolves, so what is left is the leaf's own baseline: an accept from an earlier
  // review that this one failed to refresh.
  const accepted = computeAcceptedStaleness(
    manager.getState(),
    address,
    definitionHashForAddress(video, address),
    manager.stalenessCache(),
  );
  if (accepted.variantId !== null) {
    return [
      `${what} still needs review — the accepted take is ${formatStaleCause(accepted) || "stale"}`,
      `konte accept ${address}`,
    ].join("\n");
  }
  return [
    `${what} still needs review — the accept did not land and reported no error`,
    `konte inspect ${address}`,
  ].join("\n");
}

// The generate each unresolved ref is waiting on, deduplicated. Keyed on the REF's stage, not the
// leaf's: a video composition standing on an animatic panel is cleared by generating the board.
function unresolvedRefFixes(unresolved: readonly UnresolvedLeafRef[]): string[] {
  const commands: string[] = [];
  for (const ref of unresolved) {
    const command = `konte generate ${parseAddressStream(ref.address).stage}`;
    if (!commands.includes(command)) commands.push(command);
  }
  return commands;
}

/**
 * The mirror of the above for a release: everything a shot's "none" was meant to let go of that is
 * still accepted. `unacceptVideoShots` swallows per-address failures too, so a release is confirmed
 * the same way an accept is — by reading state, not by having run the code.
 *
 * The address set is the release's, not the accept's: `unacceptVideoShots` also drops the shot's
 * per-asset accepts (audio excluded — those ride the stem), so checking the leaves alone would let a
 * half-taken release be recorded as a whole one.
 */
export function unreleasedShotLeaves(
  manager: StateManager,
  video: StageDefinition,
  shot: {
    shotId: string;
    pending: boolean;
    shotFn: unknown;
    resolvedVariants?: Record<string, string>;
  },
): Array<{ address: string; what: string }> {
  const targets = shotAcceptTargets(manager, video, shot);
  const perAsset = targets.pictureAssets.map((address) => ({
    address,
    what: `the ${assetNameOf(parseAddress(address))} take`,
  }));
  return [...perAsset, ...targets.leaves].filter(
    ({ address }) => manager.getAcceptedVariant(address) !== null,
  );
}

/**
 * The beds' verdict as it actually settled, read back from state — the timeline twin of
 * `unlandedShotLeaves`/`unreleasedShotLeaves`, and gated the same way its own accept block is.
 *
 * `landed` is what the record may claim. It is dropped outright when the beds no longer exist: the
 * accept block is gated on them too, so nothing was applied either way, and a verdict on something
 * removed from video.tsx mid-review is not an outcome — the same rule a removed animatic gets.
 * `skipped` is set only when the beds ARE there and the verdict still failed to take.
 */
export function timelineStemVerdict(
  manager: StateManager,
  video: StageDefinition,
  decision: "accepted" | "none" | undefined,
): {
  landed: "accepted" | "none" | undefined;
  skipped: { address: string; reason: string } | null;
} {
  if (!decision) return { landed: undefined, skipped: null };
  if ((video.timelineSoundtracks?.length ?? 0) === 0) return { landed: undefined, skipped: null };
  const address = formatTimelineStemAddress(video.stage);
  const settled =
    decision === "accepted"
      ? leafSignedOff(manager, video, address)
      : manager.getAcceptedVariant(address) === null;
  if (settled) return { landed: decision, skipped: null };
  return {
    landed: undefined,
    skipped: {
      address,
      reason:
        decision === "accepted"
          ? unlandedLeafReason(manager, video, { address, what: "the timeline audio stem" })
          : "the timeline audio stem is still accepted — the release did not take",
    },
  };
}

/**
 * The overlay decision's read-back, as `timelineStemVerdict` reads the beds'. An overlay removed
 * from the definition mid-review is no outcome.
 */
export function overlayVerdict(
  manager: StateManager,
  video: StageDefinition,
  decision: "accepted" | "none",
): {
  landed: "accepted" | "none" | undefined;
  skipped: { address: string; reason: string } | null;
} {
  if (!video.overlay) return { landed: undefined, skipped: null };
  const address = formatTimelineOverlayAddress(video.stage);
  const settled =
    decision === "accepted"
      ? leafSignedOff(manager, video, address)
      : manager.getAcceptedVariant(address) === null;
  if (settled) return { landed: decision, skipped: null };
  return {
    landed: undefined,
    skipped: {
      address,
      reason:
        decision === "accepted"
          ? unlandedLeafReason(manager, video, { address, what: "the overlay" })
          : "the overlay is still accepted — the release did not take",
    },
  };
}

// Accept the audio-source takes the reviewer saw (from the `displayed` snapshot) before a stem is
// materialized, so the stem fingerprints the chosen take rather than whatever currently resolves.
// Each pre-accepted source is cascaded so its own consumed deps are accepted too, under the
// `forceAllowAudio` root an audio source needs. Returns the addresses newly accepted.
export async function acceptDisplayedStemSources(
  manager: StateManager,
  jobManager: JobManager,
  sourcePaths: readonly string[],
  displayed: Record<string, string>,
  // The takes the gallery offered per source address, so the ones passed over are settled here too
  // — including under a source whose accept does not move.
  candidates: Record<string, string[]>,
  // `animatic` must be threaded through: a source's own cascade can reach an animatic panel (an
  // adapter that consumed one), and without the board `findAllUnmetPrerequisites` cannot see an
  // unwritten `blocking`/`camera` — so the panel would be signed off sideways, past the gate its own
  // accept has to clear.
  opts: {
    video: StageDefinition;
    animatic?: AnimaticDefinition | null;
    held?: (address: string, variantId?: string) => boolean;
  },
  overturned?: NonNullable<ReviewRecord["overturned"]>,
): Promise<string[]> {
  const accepted: string[] = [];
  for (const depPath of sourcePaths) {
    // A dep path is the upstream asset's address directly.
    const srcAddr = depPath;
    const sel = displayed[srcAddr];
    if (!sel || opts.held?.(srcAddr, sel)) continue;
    if (manager.getAcceptedVariant(srcAddr) === sel) {
      manager.dismissVariants(srcAddr, candidates[srcAddr] ?? [], sel);
      continue;
    }
    {
      if (overturned) noteOverturned(manager, srcAddr, sel, overturned);
      manager.setAccepted(srcAddr, sel, { dismiss: candidates[srcAddr] ?? [] });
      accepted.push(srcAddr);
      // forceAllowAudio: the source is audio being signed off via the stem, so its own audio
      // sub-deps should cascade too (a source-rooted walk would otherwise skip them).
      accepted.push(
        ...(await cascadeAcceptConsumedDeps(manager, jobManager, srcAddr, sel, {
          ...opts,
          forceAllowAudio: true,
        })),
      );
    }
  }
  return accepted;
}

// Un-accepts each toggled-off shot: clears the accepted variant for the shot's assets, its
// composition and its stems, returning the addresses actually un-accepted. A local
// status flip only — no cascade up to consumed deps. A shot with nothing accepted yields nothing,
// so a no-op "none" decision never forces a review save.
export function unacceptReelShots(
  mgr: StateManager,
  video: StageDefinition,
  shots: Array<{
    shotId: string;
    resolvedVariants: Record<string, string>;
    shotFn: unknown;
  }>,
  unacceptShotIds: Set<string>,
): string[] {
  const stage = video.stage;
  const unaccepted: string[] = [];
  for (const shot of shots) {
    if (!unacceptShotIds.has(shot.shotId)) continue;
    const addresses = Object.entries(shot.resolvedVariants)
      // Audio sources are accepted (cascaded) via the shot's stem, not per-asset here.
      .filter(([assetName, variantId]) => {
        const addr = formatAddress(stage, shot.shotId, assetName);
        return variantMediaKind(mgr, addr, variantId) !== "audio";
      })
      .map(([assetName]) => formatAddress(stage, shot.shotId, assetName));
    if (shot.shotFn) addresses.push(formatCompositionAddress(stage, shot.shotId));
    // Release the shot's audio stems symmetrically — a no-op for one the shot has none of.
    for (const name of shotStemAssetNames(stage)) {
      addresses.push(formatAddress(stage, shot.shotId, name));
    }
    for (const address of addresses) {
      try {
        const acceptedId = mgr.getAcceptedVariant(address);
        if (acceptedId) {
          mgr.setUnaccepted(address, acceptedId);
          unaccepted.push(address);
        }
      } catch {
        // skip individual failures
      }
    }
  }
  return unaccepted;
}

// The subject each comment is written against: the addresses its target perceives, derived from the
// definition, filled in from what the page reported it displayed across the WHOLE view. The two
// halves are split that way on purpose — the page is the only side that knows which take was on
// screen (a gallery pick, a reroll that landed mid-review), and the definition is the only side that
// knows which addresses a target perceives. A page answering the second question from one of its own
// asset arrays is what dropped every audio take out of a shot comment's subject.
//
// An address the page reported nothing for is left out rather than re-resolved here: a take nobody
// saw is not what the comment stands against.
function withCommentSubjects<T extends { address: string }>(
  added: T[],
  subjectOf: (address: string) => CommentSubjectAddresses | null,
  // The stage's own definition, for the vanished-leaf check: whether a leaf is gone is a question
  // about THIS shot, which a stand-in's subject (the board's) cannot answer.
  def: StageDefinition,
  displayedVariants: Record<string, string>,
  displayedDefinitionHashes: Record<string, string>,
): Array<
  T & {
    displayedVariants: Record<string, string>;
    displayedDefinitionHashes: Record<string, string | null>;
  }
> {
  return added.map((fb) => {
    // Non-null by `assertCommentTargets`, which runs before any of this submit is applied.
    const subject = subjectOf(fb.address)!;
    const variants: Record<string, string> = {};
    const hashes: Record<string, string | null> = {};
    for (const address of subject.assets) {
      const variantId = displayedVariants[address];
      if (variantId) variants[address] = variantId;
    }
    for (const address of subject.leaves) {
      // A composition's accepted take is what the page drew, so it stands in the subject. A stem's
      // is not: the preview mixes one live from the definition, so pointing at the accepted take
      // would age the comment out the moment that take read definition-stale — which is exactly
      // when the audio changed and someone had reason to comment. An overlay is drawn live the
      // same way.
      if (!isStemAddress(address) && !isOverlayAddress(address)) {
        const variantId = displayedVariants[address];
        if (variantId) variants[address] = variantId;
      }
      // A leaf the definition holds that the page reported no hash for: the definition moved
      // between the page loading and this submit (a shot's first `<Audio>` added mid-review mints a
      // stem nothing on screen had). Recorded as null — "not knowable" — rather than dropped, which
      // would leave the comment reading fresh against a leaf it never saw. An asset takes no such
      // sentinel: it legitimately has no take yet, which is not the definition moving.
      hashes[address] = displayedDefinitionHashes[address] ?? null;
    }
    // The other direction of the same drift: a leaf the page WAS showing that the definition no
    // longer holds (a shot's last `<Audio>` removed mid-review takes its stem with it). Keeping the
    // hash the page reported is what makes it readable — the leaf is absent from `liveDefinitionHashes`
    // now, so the comparison finds no current value and the comment reads stale. Dropped, the shot
    // would have lost half of itself under a comment still reading fresh.
    const ownLeaves = commentSubjectAddresses(def, fb.address)?.leaves ?? [];
    for (const address of vanishedLeavesOf(fb.address, ownLeaves, displayedDefinitionHashes)) {
      hashes[address] = displayedDefinitionHashes[address]!;
    }
    return { ...fb, displayedVariants: variants, displayedDefinitionHashes: hashes };
  });
}

// A shot's leaf slots the page reported a hash for that the definition no longer derives.
function vanishedLeavesOf(
  address: string,
  derived: readonly string[],
  displayedDefinitionHashes: Record<string, string>,
): string[] {
  const shot = parseShotAddress(address);
  if (!shot) return [];
  return [
    formatCompositionAddress(shot.stage, shot.shotId),
    ...shotStemAssetNames(shot.stage).map((name) => formatAddress(shot.stage, shot.shotId, name)),
  ].filter((leaf) => !derived.includes(leaf) && displayedDefinitionHashes[leaf] !== undefined);
}

// A comment must land on a target this stage holds, or it saves with no subject and reads as still
// standing forever. Checked before any accept, feedback write or record — the whole submit fails, so
// nothing lands half-applied.
function assertCommentTargets(
  subjectOf: (address: string) => CommentSubjectAddresses | null,
  added: Array<{ address: string }>,
): string[] {
  return added.filter((fb) => subjectOf(fb.address) === null).map((fb) => fb.address);
}

/**
 * What a comment on this reel stands against, once the reel's stand-ins are taken into account.
 *
 * A video shot showing the board draws the ANIMATIC's shot — its panels, not its own, which are not
 * made yet (see `renderShotHtml`'s stand-in branch). Deriving from the video definition there gives
 * an all-but-empty subject on the very shots whose picture is entirely somebody else's, so a comment
 * on one could never go stale.
 *
 * Only the board's takes, not its leaves: those are the animatic's own, and the page reports no hash
 * for them. What the comment tracks is the frame that was on screen switching take.
 */
function reelSubjectResolver(
  video: StageDefinition,
  animatic: AnimaticDefinition | null,
  standInShotIds: readonly string[],
): (address: string) => CommentSubjectAddresses | null {
  const standingIn = new Set(standInShotIds);
  return (address) => {
    const shot = parseShotAddress(address);
    if (animatic && shot && standingIn.has(shot.shotId)) {
      const board = commentSubjectAddresses(animatic, formatShotAddress("animatic", shot.shotId));
      if (board) return { assets: board.assets, leaves: [] };
    }
    return commentSubjectAddresses(video, address);
  };
}
type SkippedDecision = NonNullable<ReviewRecord["skippedDecisions"]>[number];

// A submit that passed validation: the reel it lands on, the plan it was reviewed under, and what the
// page reported it displayed.
interface ReelSubmit {
  ctx: ReelReviewContext;
  body: ReelSubmitBody;
  video: StageDefinition;
  stage: StageDefinition["stage"];
  counterpart: StageDefinition | null;
  // As loaded before any accept below.
  manager: StateManager;
  plan: RenderPlan;
  subjectOf: (address: string) => CommentSubjectAddresses | null;
  // What the reviewer saw, keyed by address. The record and the accepts both read from this
  // snapshot — not the freshly re-resolved plan — so "recorded == shown == accepted" even when a
  // reroll completed during review.
  displayed: Record<string, string>;
  candidates: Record<string, string[]>;
  jobManager: JobManager;
  heldFor: (addresses: readonly string[]) => Finding[];
  cascade: {
    video: StageDefinition;
    animatic: AnimaticDefinition | null;
    held: (address: string, variantId?: string) => boolean;
    waiverCoverage: WaiverCoverage | undefined;
  };
}

// What the submit has applied so far, appended to by each phase in order.
interface ReelSubmitLedger {
  acceptedAssets: string[];
  unacceptedAssets: string[];
  // Audio sources accepted only as a side effect of a stem accept, tagged with the stem they were
  // signed off through — persisted on the record so `review record show` can surface them.
  cascadeAccepted: Array<{ address: string; via: string }>;
  overturned: NonNullable<ReviewRecord["overturned"]>;
  skippedDecisions: SkippedDecision[];
  // Why a leaf's materialization threw, by address. Each accept phase swallows its failures so one
  // shot cannot sink the review, but the message is the diagnosis — a mix refusing on a cue names
  // the cue — so it is kept for the read-back's reason rather than replaced by a guess.
  leafFailures: Map<string, string>;
}

// The shot verdicts still standing: each phase drops a shot whose verdict it could not land.
interface ShotVerdicts {
  accept: Set<string>;
  release: Set<string>;
}

const heldReason = (findings: readonly Finding[]) =>
  `held — ${findings.map(formatFindingLine).join("; ")}`;

// Handles a reel review's submit (`/api/animatic/submit`, `/api/video/submit`). Both composition
// stages are reviewed the same way — one verdict per shot over a playing reel — so one handler
// serves both, told which by the definition it is handed.
export async function handleReelSubmit(
  ctx: ReelReviewContext,
  reload: () => Promise<StageDefinition>,
  req: Request,
  reportOutcome?: ReportOutcome,
): Promise<Response> {
  // Stamped before anything is written, so every comment this review carries predates the
  // accepts it was submitted with (see applyFeedbackMutations). The record carries it too: a
  // comment's own review is the one submitted at its createdAt.
  const reviewedAt = new Date().toISOString();
  const submit = await prepareReelSubmit(ctx, reload, req);
  if (submit instanceof Response) return submit;

  const record = buildReelRecord(submit, reviewedAt);
  const ledger: ReelSubmitLedger = {
    acceptedAssets: [],
    unacceptedAssets: [],
    cascadeAccepted: [],
    overturned: [],
    skippedDecisions: [],
    leafFailures: new Map(),
  };

  const verdicts = collectShotVerdicts(submit, ledger);
  await remakeSettledLeavesFor(submit, verdicts, ledger, "stems");
  await acceptShotPictures(submit, verdicts, ledger);
  const acceptedShots = submit.plan.shots.filter((s) => verdicts.accept.has(s.shotId));
  const settledSources = await acceptShotStemSources(submit, acceptedShots, ledger);
  await materializeShotStems(submit, acceptedShots, settledSources, ledger);
  await materializeShotCompositions(submit, verdicts, ledger);
  await remakeSettledLeavesFor(submit, verdicts, ledger, "compositions");
  await releaseShots(submit, verdicts, ledger);
  await readBackShotVerdicts(submit, verdicts, ledger);
  await cascadeDirectionParts(submit, verdicts, ledger);
  const timelineStemLanded = await applyTimelineStemDecision(submit, ledger);
  const overlayLanded = await applyOverlayDecision(submit, ledger);
  const thumbnailLanded = await applyThumbnailDecision(submit, ledger);

  const { kept, regenerate } = await applyKeepAndRegenerate(submit);
  if (kept.length > 0) record.kept = kept;
  if (regenerate.length > 0) record.regenerate = regenerate;

  // The record's decisions are rebuilt from what was APPLIED, never from what was submitted. A
  // decision naming a shot this plan does not have (renamed or deleted mid-review), one dropped
  // because its animatic disappeared, a pendingShot's no-op, and anything the read-back caught are
  // all absent from these two sets — so none of them can be written down as an outcome.
  record.decisions = {
    ...Object.fromEntries([...verdicts.accept].map((shotId) => [shotId, "accepted" as const])),
    ...Object.fromEntries([...verdicts.release].map((shotId) => [shotId, "none" as const])),
  };
  if (timelineStemLanded) record.timelineStemDecision = timelineStemLanded;
  else delete record.timelineStemDecision;
  if (overlayLanded) record.overlayDecision = overlayLanded;
  if (thumbnailLanded) record.thumbnailDecision = thumbnailLanded;
  const { skippedDecisions, acceptedAssets, unacceptedAssets } = ledger;
  if (skippedDecisions.length > 0) record.skippedDecisions = skippedDecisions;

  await saveReelFeedback(submit, record, reviewedAt);

  if (ledger.cascadeAccepted.length > 0) record.cascadeAccepted = ledger.cascadeAccepted;
  if (ledger.overturned.length > 0) record.overturned = ledger.overturned;

  const contentHashes = await materializedLeafBaseline(submit);
  if (Object.keys(contentHashes).length > 0) record.context.contentHashes = contentHashes;

  // Accept-only reviews carry no feedback, but the accept is a real review outcome —
  // persist the record so `review record show` reflects it.
  const filePath = await saveReviewRecord(ctx.videoRoot, record, {
    // A review that only skipped is still a review worth keeping — it is the record of accepts the
    // reviewer made and did not get. Without this, a submit whose every accept failed writes no
    // file at all and `skippedDecisions` is reported to a terminal and then lost.
    force: acceptedAssets.length > 0 || unacceptedAssets.length > 0 || skippedDecisions.length > 0,
  });

  if (filePath) await storeOverallComment(ctx.videoRoot, submit.stage, record);

  reportOutcome?.({
    stage: submit.stage,
    filePath,
    ...(regenerate.length > 0 ? { regenerate } : {}),
  });

  return jsonResponse({
    saved: filePath !== null,
    filePath,
    acceptedAssets,
    unacceptedAssets,
    skippedDecisions,
    kept,
    regenerate,
  } satisfies ReelSubmitResponse);
}

// Everything that refuses the whole submit, ahead of every accept, feedback write and record — so
// nothing lands half-applied.
async function prepareReelSubmit(
  ctx: ReelReviewContext,
  reload: () => Promise<StageDefinition>,
  req: Request,
): Promise<ReelSubmit | Response> {
  const raw = await parseJsonBody<unknown>(req);
  if (raw === null) {
    return errorResponse("Invalid request body", "INVALID_REQUEST", 400);
  }
  const parsed = ReelSubmitSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("Invalid review payload", "INVALID_REQUEST", 400);
  }
  const body = parsed.data;

  const { videoRoot, animatic, downstreamVideo } = ctx;
  const manager = await StateManager.load(videoRoot);
  const video = await reload();
  const stage = video.stage;

  // The same plan handleGetReelState renders under (one builder, no options here).
  //
  // A plan this submit cannot build is a review it cannot apply. It must never fall through with a
  // null plan: that skipped the entire accept block while still writing a record full of "accepted"
  // and answering 200.
  let plan: RenderPlan;
  try {
    plan = buildReelReviewPlan(manager, video, animatic);
  } catch (error) {
    return errorResponse(
      `Failed to build the review plan — no part of this review was applied: ${errorMessage(
        error,
      )}`,
      "RENDER_PLAN_FAILED",
      500,
    );
  }

  const subjectOf = reelSubjectResolver(video, animatic, body.displayedStandInShotIds);
  const unknownTargets = assertCommentTargets(subjectOf, body.addedFeedback ?? []);
  if (unknownTargets.length > 0) {
    return errorResponse(
      `This stage holds no target for ${unknownTargets.join(", ")} — no part of this review was applied.`,
      "INVALID_REQUEST",
      400,
    );
  }

  // A shot whose accept a finding holds is not signed off. A dep a cascade reaches that one holds is left for its own accept.
  const checkContext = await loadCheckContext({
    videoRoot,
    definitions: {
      reference: ctx.reference,
      animatic,
      video: (stage === "video" ? video : downstreamVideo) as VideoDefinition | null,
    },
    direction: ctx.direction,
    manager,
  });
  const report = await collectFindings(checkContext, (t) => t.holds.accept === true);
  const displayed = body.displayedVariants ?? {};
  const heldFor = (addresses: readonly string[]) =>
    reviewHeldFindings(
      report,
      addresses.map((address) => ({ op: "accept", address, variantId: displayed[address] })),
    );

  return {
    ctx,
    body,
    video,
    stage,
    counterpart: stage === "video" ? animatic : downstreamVideo,
    manager,
    plan,
    subjectOf,
    displayed,
    candidates: body.displayedCandidates ?? {},
    jobManager: new JobManager(videoRoot),
    heldFor,
    cascade: {
      video,
      animatic,
      held: (address, variantId) =>
        reviewHeldFindings(report, [
          { op: "accept", address, variantId: variantId ?? displayed[address] },
        ]).length > 0,
      waiverCoverage: waiverCoverageOf(checkContext),
    },
  };
}

// Each asset at the take the reviewer saw, falling back to the one the plan resolved.
function displayedByAsset(
  submit: ReelSubmit,
  resolved: Record<string, string>,
  addressOf: (assetName: string) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(resolved).map((assetName) => [
      assetName,
      submit.displayed[addressOf(assetName)] ?? resolved[assetName]!,
    ]),
  );
}

function displayedRefVariants(submit: ReelSubmit, refs: readonly string[]): Record<string, string> {
  const variants: Record<string, string> = {};
  for (const ref of refs) {
    if (isMaterializedLeafAddress(ref) || variants[ref]) continue;
    const variantId =
      submit.displayed[ref] ??
      resolveCompositionRef(submit.manager, ref, { includeStale: true })?.variantId;
    if (variantId) variants[ref] = variantId;
  }
  return variants;
}

function buildReelRecord(submit: ReelSubmit, reviewedAt: string): ReviewRecord {
  const { body, video, stage, plan, manager } = submit;
  const timing = shotSpans(plan.shots, plan.fps);
  return {
    mode: stage === "animatic" ? "animatic-preview" : "video-preview",
    stage,
    createdAt: reviewedAt,
    context: {
      shots: plan.shots.map((s, i) => ({
        shotId: s.shotId,
        start: timing.spans[i]!.start,
        duration: s.duration,
        variants: displayedByAsset(submit, s.resolvedVariants, (name) =>
          formatAddress(stage, s.shotId, name),
        ),
        ...(s.shotFn
          ? {
              sources: displayedRefVariants(submit, [
                ...(shotById(video.shots, s.shotId)?.compositionRefs ?? []),
                ...shotAcceptTargets(manager, video, s).stemSources,
              ]),
            }
          : {}),
      })),
      // Stage-level timeline assets — recorded at the variant the reviewer saw, like the shots
      // above: a bed switched in the gallery, or a reroll that landed mid-review, must not make
      // the record name a variant nobody reviewed. Non-audio timeline assets (images, logos) are
      // accepted through the compositions that consume them; audio beds (BGM) are accepted via
      // `timelineStemDecision` on `timeline#stem`, and the overlay via `overlayDecision`.
      timeline: displayedByAsset(submit, plan.timelineResolvedVariants, (name) =>
        formatTimelineAddress(stage, name),
      ),
      timelineSources: displayedRefVariants(submit, timelineStemRefs(video)),
      ...((video as Partial<VideoDefinition>).thumbnail
        ? {
            thumbnailSources: displayedRefVariants(submit, [
              thumbnailCoverAddress((video as VideoDefinition).thumbnail!),
              ...((video as VideoDefinition).thumbnail!.compose?.compositionRefs ?? []),
            ]),
          }
        : {}),
      // `contentHashes` (the materialized-leaf baseline) is set after the accepts.
    },
    decisions: body.decisions ?? undefined,
    ...(body.timelineStemDecision ? { timelineStemDecision: body.timelineStemDecision } : {}),
    notes: body.notes,
    ...(body.overallComment ? { overallComment: body.overallComment } : {}),
    ...handoffRecordFields(submit.ctx.handoff),
  };
}

function collectShotVerdicts(submit: ReelSubmit, ledger: ReelSubmitLedger): ShotVerdicts {
  const { body, plan, stage, manager, video } = submit;
  const decisions = body.decisions ?? {};
  const verdicts: ShotVerdicts = { accept: new Set(), release: new Set() };
  for (const shot of plan.shots) {
    // Accept is a toggle: "accepted" accepts the shot's shown variants, "none"
    // un-accepts them. An undecided shot is left untouched — never silently
    // accepted — so a reroll's pending variant can't be locked out by
    // re-confirming the stale accepted one on submit.
    const decision = decisions[shot.shotId];
    if (decision === "accepted") verdicts.accept.add(shot.shotId);
    else if (decision === "none") verdicts.release.add(shot.shotId);
  }

  // A shot that stood in with its board has no verdict to land — it is display only. The UI closes
  // the toggle, so a decision arriving for one is a stale client: dropped either way round, never
  // accepted unseen. Taken from the CLIENT, never re-derived here — a build dependency that
  // finished between load and submit flips the answer, and re-deriving would then sign off a
  // composition the reviewer never watched.
  for (const id of body.displayedStandInShotIds) {
    verdicts.accept.delete(id);
    verdicts.release.delete(id);
  }

  for (const shot of plan.shots) {
    if (!verdicts.accept.has(shot.shotId)) continue;
    const address = formatShotAddress(stage, shot.shotId);
    const findings = submit.heldFor([
      address,
      ...shotAcceptTargets(manager, video, shot).stemSources,
    ]);
    if (findings.length === 0) continue;
    verdicts.accept.delete(shot.shotId);
    ledger.skippedDecisions.push({ shotId: shot.shotId, address, reason: heldReason(findings) });
  }
  return verdicts;
}

// The other shot stage's leaves this review settles, re-made for the shots it accepts: the board's
// stems before any video leaf is built over one, and the compositions whose picture this stage's
// hold once those have signed it off. One that cannot be made is reported with the review's other
// skips.
async function remakeSettledLeavesFor(
  submit: ReelSubmit,
  verdicts: ShotVerdicts,
  ledger: ReelSubmitLedger,
  include: "stems" | "compositions",
): Promise<void> {
  const { counterpart, stage } = submit;
  if (!counterpart || verdicts.accept.size === 0) return;
  if (include === "stems" && stage !== "video") return;
  const remade = await remakeSettledLeaves({
    videoRoot: submit.ctx.videoRoot,
    stage: counterpart,
    counterpart: submit.video,
    shotIds: verdicts.accept,
    include,
  });
  for (const { shotId, address } of remade.accepted) {
    ledger.acceptedAssets.push(address);
    ledger.cascadeAccepted.push({ address, via: formatShotAddress(stage, shotId) });
  }
  for (const { shotId, address, reason } of remade.failed) {
    ledger.skippedDecisions.push({ shotId, address, reason: `could not be re-made — ${reason}` });
  }
}

// Accept only the variant the reviewer saw (from `displayed`). An asset missing from the snapshot is
// skipped — never re-resolved to a fresh variant, so a reroll that finished mid-review can't be
// accepted unseen.
async function acceptShotPictures(
  submit: ReelSubmit,
  verdicts: ShotVerdicts,
  ledger: ReelSubmitLedger,
): Promise<void> {
  const { plan, manager, video, displayed, candidates } = submit;
  const toAccept: Array<{ address: string; variantId: string; dismiss: string[] }> = [];
  for (const shot of plan.shots) {
    if (!verdicts.accept.has(shot.shotId)) continue;
    for (const address of shotAcceptTargets(manager, video, shot).pictureAssets) {
      const variantId = displayed[address];
      if (!variantId) continue;
      toAccept.push({ address, variantId, dismiss: candidates[address] ?? [] });
    }
  }
  if (toAccept.length === 0) return;

  await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
    for (const { address, variantId, dismiss } of toAccept) {
      try {
        const previousAccepted = mgr.getAcceptedVariant(address);
        noteOverturned(mgr, address, variantId, ledger.overturned);
        // Always (re)accept: re-accepting the same variant is how the reviewer settles the rivals
        // they chose against. Cascade/report only when the accepted id actually changed.
        mgr.setAccepted(address, variantId, { dismiss });
        if (previousAccepted !== variantId) {
          ledger.acceptedAssets.push(address);
          const cascaded = await cascadeAcceptConsumedDeps(
            mgr,
            submit.jobManager,
            address,
            variantId,
            submit.cascade,
          );
          ledger.acceptedAssets.push(...cascaded);
        }
      } catch {
        // skip individual failures
      }
    }
  });
}

// The audio takes a shot's stems are mixed from, accepted before anything is materialized over
// them: an ANIMATIC composition's identity covers its audio, so a composition built first would
// fingerprint the take the reviewer replaced and read stale the moment the review saved.
//
// Returns the state as this lock left it — what the stems are mixed from, so a source accepted
// elsewhere after this lock is seen by the commit's identity check rather than mixed in unseen.
async function acceptShotStemSources(
  submit: ReelSubmit,
  acceptedShots: RenderPlan["shots"],
  ledger: ReelSubmitLedger,
): Promise<StateManager | null> {
  if (acceptedShots.length === 0) return null;
  const { video, stage } = submit;
  return StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
    for (const shot of acceptedShots) {
      for (const removedStem of removedShotStemAddresses(mgr.getState(), video, shot.shotId)) {
        const removedStemVariantId = mgr.getAcceptedVariant(removedStem);
        if (removedStemVariantId) {
          mgr.setUnaccepted(removedStem, removedStemVariantId);
          ledger.unacceptedAssets.push(removedStem);
        }
      }
      const targets = shotAcceptTargets(mgr, video, shot);
      if (targets.stemSources.length === 0) continue;
      const definition = shotById(video.shots, shot.shotId);
      const stems = definition ? listShotStems(stage, definition) : [];
      const via = (source: string): string =>
        stems.find((stem) => isHeardStemAddress(stem.address) && stem.refs.includes(source))
          ?.address ?? formatShotStemAddress(stage, shot.shotId);
      try {
        const sources = await acceptDisplayedStemSources(
          mgr,
          submit.jobManager,
          targets.stemSources,
          submit.displayed,
          submit.candidates,
          submit.cascade,
          ledger.overturned,
        );
        ledger.acceptedAssets.push(...sources);
        ledger.cascadeAccepted.push(...sources.map((address) => ({ address, via: via(address) })));
      } catch {
        // skip individual stem-source failures
      }
    }
    return mgr;
  });
}

// Fold the shot's audio into its accept: accepting a shot signs off its picture (composition) and
// its stems (`shot.<id>#stem`, the board's `#narrationStem` / `#offFrameStem`) in one gesture —
// each leaf is materialized over the sources settled before; on the board `#stem` is the mix the
// motion is driven by. The mixes run outside the state lock (ffmpeg, one per stem) from the takes
// those sources settled, and the commit under the lock re-checks that those takes still resolve —
// a source accepted elsewhere meanwhile is refused, not recorded. Every address comes from
// `shotAcceptTargets` — the same enumeration the read-back reads, so an accept and its check can
// never disagree about what a shot covers.
async function materializeShotStems(
  submit: ReelSubmit,
  acceptedShots: RenderPlan["shots"],
  settledSources: StateManager | null,
  ledger: ReelSubmitLedger,
): Promise<void> {
  if (!settledSources) return;
  const { video, stage } = submit;
  const stemLeaves = acceptedShots.flatMap((shot) =>
    shotAcceptTargets(settledSources, video, shot)
      .leaves.filter((leaf) => isStemAddress(leaf.address))
      .map((leaf) => ({ shotId: shot.shotId, address: leaf.address })),
  );
  if (stemLeaves.length === 0) return;

  const mixer = new Semaphore(STEM_MIX_CONCURRENCY);
  const prepared = new Map<string, PreparedShotStem>();
  try {
    await Promise.all(
      stemLeaves.map(({ address }) =>
        mixer.run(async () => {
          try {
            const p = await prepareShotStem({ manager: settledSources, video, address });
            if (p) prepared.set(address, p);
          } catch (err) {
            ledger.leafFailures.set(address, errorMessage(err));
          }
        }),
      ),
    );
    await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
      for (const { shotId, address: stemAddress } of stemLeaves) {
        const via = formatShotAddress(stage, shotId);
        const p = prepared.get(stemAddress);
        if (!p) continue;
        try {
          const variantId = await commitShotStem({
            manager: mgr,
            video,
            address: stemAddress,
            prepared: p,
          });
          if (!variantId) continue;
          mgr.setAccepted(stemAddress, variantId);
          ledger.acceptedAssets.push(stemAddress);
          // The stem is materialized and accepted by the shot accept, not reviewed on its own —
          // so it has no decision line. Record it (via the shot) so the recap names it; its audio
          // sources are recorded via the stem in turn.
          ledger.cascadeAccepted.push({ address: stemAddress, via });
          const cascaded = await cascadeAcceptConsumedDeps(
            mgr,
            submit.jobManager,
            stemAddress,
            variantId,
            submit.cascade,
          );
          ledger.acceptedAssets.push(...cascaded);
          ledger.cascadeAccepted.push(
            ...cascaded.map((address) => ({ address, via: stemAddress })),
          );
        } catch (err) {
          ledger.leafFailures.set(stemAddress, errorMessage(err));
        }
      }
    });
  } finally {
    // A mix the lock never reached (the lock itself failing) must not stay in the cache.
    for (const p of prepared.values()) await discardPreparedStem(p);
  }
}

// Accept the composition for each accepted shot that has one: render it against the just-accepted
// assets and accept that variant as the re-review baseline (UC1). Runs after the asset accepts so the
// composition's input fingerprints capture them.
async function materializeShotCompositions(
  submit: ReelSubmit,
  verdicts: ShotVerdicts,
  ledger: ReelSubmitLedger,
): Promise<void> {
  const { video, stage } = submit;
  const compositionShotIds = submit.plan.shots
    .filter((s) => verdicts.accept.has(s.shotId) && s.shotFn)
    .map((s) => s.shotId);
  if (compositionShotIds.length === 0) return;

  await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
    for (const shotId of compositionShotIds) {
      try {
        const variantId = await materializeCompositionVariant({ manager: mgr, video, shotId });
        if (variantId) {
          const compAddress = formatCompositionAddress(stage, shotId);
          mgr.setAccepted(compAddress, variantId);
          ledger.acceptedAssets.push(compAddress);
          // The composition is materialized and accepted by the shot accept, never as a
          // reviewable per-shot asset — so it has no decision line. Record it here so the
          // review recap names what the shot accept signed off.
          ledger.cascadeAccepted.push({
            address: compAddress,
            via: formatShotAddress(stage, shotId),
          });
          // Accept the assets the composition consumed — including timeline assets
          // used only in the shotFn (logos, overlays), which no per-shot
          // generation accept would otherwise reach.
          const cascaded = await cascadeAcceptConsumedDeps(
            mgr,
            submit.jobManager,
            compAddress,
            variantId,
            submit.cascade,
          );
          ledger.acceptedAssets.push(...cascaded);
        }
      } catch (err) {
        // One shot's failure must not sink the review; the read-back reports it.
        ledger.leafFailures.set(formatCompositionAddress(stage, shotId), errorMessage(err));
      }
    }
  });
}

async function releaseShots(
  submit: ReelSubmit,
  verdicts: ShotVerdicts,
  ledger: ReelSubmitLedger,
): Promise<void> {
  if (verdicts.release.size === 0) return;
  await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
    ledger.unacceptedAssets.push(
      ...unacceptReelShots(mgr, submit.video, submit.plan.shots, verdicts.release),
    );
  });
}

// Post-condition on every shot accept. Each accept phase swallows per-item failures by design — one
// unbuildable shot must not sink a whole review — and an accept can also decline to land for a
// legitimate reason (an animatic whose refs stopped resolving mid-review). So what landed is READ
// BACK from state rather than inferred from the code having run: this is the check that turns any
// silent skip, today's or a future one's, into something the reviewer and the record both see. It is
// deliberately independent of the accept path — assert the outcome, never trust the attempt.
//
// Runs before the direction cascade, so a shot that did not land does not settle direction parts on
// the strength of an accept it never made.
//
// Both verdicts are read back, not just the accept: `unacceptReelShots` swallows per-address failures
// the same way, so a "none" that did not take must not be recorded as a release either.
async function readBackShotVerdicts(
  submit: ReelSubmit,
  verdicts: ShotVerdicts,
  ledger: ReelSubmitLedger,
): Promise<void> {
  if (verdicts.accept.size === 0 && verdicts.release.size === 0) return;
  const { video } = submit;
  const postAccept = await StateManager.load(submit.ctx.videoRoot);
  for (const shot of submit.plan.shots) {
    const accepting = verdicts.accept.has(shot.shotId);
    if (!accepting && !verdicts.release.has(shot.shotId)) continue;
    // A shot with nothing to accept or release — undeveloped, or an aside on the stage that does
    // not board it — is not an outcome, so a verdict on one is dropped from both sets, the same
    // rule a deleted shot gets. The UI will not mint such a decision, but a source reload can turn
    // a shot the reviewer already judged into a pendingShot or an aside; left in, it would be
    // written down as settled and would cascade direction acceptance on the strength of an accept
    // that touched nothing. Not reported as a skip either: nothing failed, the thing judged simply
    // no longer exists.
    if (shot.pending || (shot.aside && !shot.shotFn)) {
      verdicts.accept.delete(shot.shotId);
      verdicts.release.delete(shot.shotId);
      continue;
    }
    const missed = accepting
      ? unlandedShotLeaves(postAccept, video, shot).map((leaf) => {
          const failure = ledger.leafFailures.get(leaf.address);
          return {
            address: leaf.address,
            reason: failure
              ? `${leaf.what} could not be materialized — ${failure}`
              : unlandedLeafReason(postAccept, video, leaf),
          };
        })
      : unreleasedShotLeaves(postAccept, video, shot).map(({ address, what }) => ({
          address,
          reason: `${what} is still accepted — the release did not take`,
        }));
    if (missed.length === 0) continue;
    for (const { address, reason } of missed) {
      ledger.skippedDecisions.push({ shotId: shot.shotId, address, reason });
    }
    verdicts.accept.delete(shot.shotId);
    verdicts.release.delete(shot.shotId);
  }
}

// Carry each accepted shot back into the direction, in one pass after every shot accept: a shot's
// picture, its stem and their consumed deps all settle the same direction parts, so running once
// records each part once — under the shot whose accept signed it.
async function cascadeDirectionParts(
  submit: ReelSubmit,
  verdicts: ShotVerdicts,
  ledger: ReelSubmitLedger,
): Promise<void> {
  if (verdicts.accept.size === 0) return;
  await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
    for (const shotId of verdicts.accept) {
      const via = formatShotAddress(submit.stage, shotId);
      const parts = cascadeDirectionShotAccepts(
        mgr,
        submit.ctx.direction,
        new Set([shotId]),
        submit.cascade.held,
        submit.cascade.waiverCoverage,
      );
      ledger.cascadeAccepted.push(...parts.map((address) => ({ address, via })));
    }
  });
}

// The timeline audio stem (soundtrack beds) is signed off in context here — accepting it
// materializes `timeline#stem` and cascades its bed sources (including a reference BGM), so the beds
// gain a baseline. Per-shot audio is handled via each shot's stem accept. "none" un-accepts. Runs
// independent of the render plan. Returns the verdict as read back from state.
async function applyTimelineStemDecision(
  submit: ReelSubmit,
  ledger: ReelSubmitLedger,
): Promise<"accepted" | "none" | undefined> {
  const { video, stage } = submit;
  const decision = submit.body.timelineStemDecision;
  const timelineStemAddress = formatTimelineStemAddress(stage);
  const held =
    decision === "accepted"
      ? submit.heldFor([timelineStemAddress, ...timelineStemRefs(video)])
      : [];
  if (held.length > 0) {
    ledger.skippedDecisions.push({ address: timelineStemAddress, reason: heldReason(held) });
    return undefined;
  }
  if (decision && (video.timelineSoundtracks?.length ?? 0) > 0) {
    await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
      try {
        if (decision === "accepted") {
          // Honor the bed take the reviewer selected: accept each soundtrack source's displayed
          // variant before materializing, so the stem fingerprints the chosen take.
          const sources = await acceptDisplayedStemSources(
            mgr,
            submit.jobManager,
            timelineStemRefs(video),
            submit.displayed,
            submit.candidates,
            submit.cascade,
            ledger.overturned,
          );
          ledger.acceptedAssets.push(...sources);
          ledger.cascadeAccepted.push(
            ...sources.map((address) => ({ address, via: timelineStemAddress })),
          );
          const variantId = await materializeTimelineStem({ manager: mgr, video });
          if (variantId) {
            const previous = mgr.getAcceptedVariant(timelineStemAddress);
            mgr.setAccepted(timelineStemAddress, variantId);
            if (previous !== variantId) {
              ledger.acceptedAssets.push(timelineStemAddress);
              const cascaded = await cascadeAcceptConsumedDeps(
                mgr,
                submit.jobManager,
                timelineStemAddress,
                variantId,
                submit.cascade,
              );
              ledger.acceptedAssets.push(...cascaded);
              ledger.cascadeAccepted.push(
                ...cascaded.map((address) => ({ address, via: timelineStemAddress })),
              );
            }
          }
        } else {
          const acceptedId = mgr.getAcceptedVariant(timelineStemAddress);
          if (acceptedId) {
            mgr.setUnaccepted(timelineStemAddress, acceptedId);
            ledger.unacceptedAssets.push(timelineStemAddress);
          }
        }
      } catch {
        // skip timeline-stem failure
      }
    });
  }

  // The beds' post-condition, the same read-back as the shots': the block above swallows its own
  // failure, so neither verdict may be written down without confirming it in state.
  const verdict = timelineStemVerdict(
    decision ? await StateManager.load(submit.ctx.videoRoot) : submit.manager,
    video,
    decision,
  );
  if (verdict.skipped) ledger.skippedDecisions.push(verdict.skipped);
  return verdict.landed;
}

// The overlay is signed off by the shot accepts under it: accepted with the review that leaves every
// shot accept standing, or on its own toggle, offered once they all do. Accepting materializes it
// and cascades onto what it shows; "none" releases it. Read back the same way as the beds.
async function applyOverlayDecision(
  submit: ReelSubmit,
  ledger: ReelSubmitLedger,
): Promise<"accepted" | "none" | undefined> {
  const { video, stage, body } = submit;
  const overlayAddress = formatTimelineOverlayAddress(stage);
  const overlayDecision =
    body.overlayDecision ??
    (Object.values(body.decisions ?? {}).includes("accepted") &&
    overlayAwaitsAccept(await StateManager.load(submit.ctx.videoRoot), video, submit.counterpart)
      ? "accepted"
      : undefined);
  const overlayHeld =
    overlayDecision === "accepted"
      ? submit.heldFor([overlayAddress, ...overlayTimelineRefs(video)])
      : [];
  if (overlayHeld.length > 0) {
    ledger.skippedDecisions.push({ address: overlayAddress, reason: heldReason(overlayHeld) });
    return undefined;
  }
  if (!video.overlay || !overlayDecision) return undefined;

  const overlayDef = video.overlay;
  const { displayed, candidates } = submit;
  // What the overlay shows from outside its timeline whose take moved since the page loaded: it is
  // not accepted here, so the overlay would be built over a picture nobody saw.
  const moved: string[] = [];
  await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
    try {
      if (overlayDecision === "accepted") {
        // The timeline takes the overlay was seen over, accepted first so it is built from them
        // rather than from a take that landed mid-review. What it shows from another stage is
        // reached by the cascade below, under the exclusions a shot's out-of-shot refs get.
        const refs = overlayDef.compositionRefs;
        const timelineRefs = overlayTimelineRefs(video);
        for (const ref of refs) {
          if (timelineRefs.includes(ref) || !displayed[ref]) continue;
          const now = resolveCompositionRef(mgr, ref, { includeStale: true })?.variantId;
          if (now !== displayed[ref]) moved.push(ref);
        }
        if (moved.length > 0) return;
        for (const ref of timelineRefs) {
          const sel = displayed[ref];
          if (!sel) continue;
          const previousRef = mgr.getAcceptedVariant(ref);
          noteOverturned(mgr, ref, sel, ledger.overturned);
          mgr.setAccepted(ref, sel, { dismiss: candidates[ref] ?? [] });
          if (previousRef === sel) continue;
          ledger.acceptedAssets.push(ref);
          const cascadedRef = await cascadeAcceptConsumedDeps(
            mgr,
            submit.jobManager,
            ref,
            sel,
            submit.cascade,
          );
          ledger.acceptedAssets.push(...cascadedRef);
          ledger.cascadeAccepted.push(
            ...[ref, ...cascadedRef].map((dep) => ({ address: dep, via: overlayAddress })),
          );
        }
        if (!leafReadyForReview(mgr, video, overlayAddress)) return;
        const variantId = await materializeOverlayVariant({ manager: mgr, video });
        if (!variantId) return;
        const previous = mgr.getAcceptedVariant(overlayAddress);
        mgr.setAccepted(overlayAddress, variantId);
        if (previous !== variantId) ledger.acceptedAssets.push(overlayAddress);
        const cascaded = await cascadeAcceptConsumedDeps(
          mgr,
          submit.jobManager,
          overlayAddress,
          variantId,
          submit.cascade,
        );
        ledger.acceptedAssets.push(...cascaded);
        ledger.cascadeAccepted.push(
          ...cascaded.map((dep) => ({ address: dep, via: overlayAddress })),
        );
      } else {
        const acceptedId = mgr.getAcceptedVariant(overlayAddress);
        if (acceptedId) {
          mgr.setUnaccepted(overlayAddress, acceptedId);
          ledger.unacceptedAssets.push(overlayAddress);
        }
      }
    } catch {
      // an overlay that will not render is reported by its read-back below
    }
  });
  if (moved.length > 0) {
    ledger.skippedDecisions.push({
      address: overlayAddress,
      reason:
        `the overlay shows ${moved.join(", ")}, whose take changed while the page was open — ` +
        "reload the review and accept it again",
    });
    return undefined;
  }
  const verdict = overlayVerdict(
    await StateManager.load(submit.ctx.videoRoot),
    video,
    overlayDecision,
  );
  if (verdict.skipped) ledger.skippedDecisions.push(verdict.skipped);
  return verdict.landed;
}

// The output hash of each of `refs` the cover was made from, however deep: each take's inputs
// lead to the takes they were made from in turn.
function thumbnailMadeFrom(
  mgr: StateManager,
  cover: { inputFingerprints: Record<string, string> },
  refs: readonly string[],
): Map<string, string> {
  const wanted = new Set(refs);
  const made = new Map<string, string>();
  const queue = [cover.inputFingerprints];
  while (queue.length > 0) {
    for (const [ref, hash] of Object.entries(queue.pop()!)) {
      if (!wanted.has(ref) || made.has(ref)) continue;
      made.set(ref, hash);
      const take = Object.values(mgr.tryGetAssetState(ref)?.variants ?? {}).find(
        (v) => v.outputHash === hash,
      );
      if (take) queue.push(take.inputFingerprints);
    }
  }
  return made;
}

// The thumbnail is signed off by its own accept: the cover the reviewer saw — its still, else its
// frame — with the takes of its own assets they picked. A pick the still was not made from, however
// deep, is accepted alone, and `generate` makes what is built on it again; a cover that went stale while the
// page was open refuses it. "none" releases it.
async function applyThumbnailDecision(
  submit: ReelSubmit,
  ledger: ReelSubmitLedger,
): Promise<"accepted" | "none" | undefined> {
  const { video, body, displayed, candidates } = submit;
  const decision = body.thumbnailDecision;
  const thumbnail = (video as Partial<VideoDefinition>).thumbnail;
  if (!thumbnail || !decision) return undefined;
  const address = thumbnailCoverAddress(thumbnail);
  const skip = (reason: string) => {
    ledger.skippedDecisions.push({ address, reason });
    return undefined;
  };
  const held = decision === "accepted" ? submit.heldFor([address]) : [];
  if (held.length > 0) return skip(heldReason(held));
  const videoRoot = submit.ctx.videoRoot;
  if (decision === "none") {
    await StateManager.withLock(videoRoot, async (mgr) => {
      const acceptedId = mgr.getAcceptedVariant(address);
      if (!acceptedId) return;
      mgr.setUnaccepted(address, acceptedId);
      ledger.unacceptedAssets.push(address);
    });
    const after = await StateManager.load(videoRoot);
    if (after.getAcceptedVariant(address) === null) return decision;
    return skip("the thumbnail is still accepted — the release did not take");
  }
  const shown = displayed[address];
  if (!shown) return skip("the review showed no cover of the thumbnail");
  const own = Object.keys(thumbnail.assets).map(formatThumbnailAddress);
  const outcome = await StateManager.withLock(videoRoot, async (mgr) => {
    const cover = mgr.tryGetAssetState(address)?.variants?.[shown];
    if (!cover?.file || cover.status === "dismissed") {
      return { refused: `${shown} was removed since the review — reload the review` };
    }
    const staleness = mgr.variantStaleness(address, shown);
    if (staleness?.inputStale || staleness?.definitionStale) {
      return {
        refused: `${shown} went stale since the review — \`konte generate video\` makes it again`,
      };
    }
    const madeFrom = thumbnailMadeFrom(mgr, cover, [...own, THUMBNAIL_FRAME_ADDRESS]);
    const picks = own.flatMap((ref) => (displayed[ref] ? [[ref, displayed[ref]] as const] : []));
    const switchedPicks = picks.filter(([ref, sel]) => {
      const made = madeFrom.get(ref);
      return made !== undefined && mgr.tryGetAssetState(ref)?.variants?.[sel]?.outputHash !== made;
    });
    const switched = switchedPicks.map(([ref, sel]) => `${ref} (${sel})`);
    for (const [ref, sel] of switched.length > 0 ? switchedPicks : picks) {
      const previous = mgr.getAcceptedVariant(ref);
      noteOverturned(mgr, ref, sel, ledger.overturned);
      mgr.setAccepted(ref, sel, { dismiss: candidates[ref] ?? [] });
      if (previous === sel) continue;
      ledger.acceptedAssets.push(ref);
      ledger.cascadeAccepted.push({ address: ref, via: address });
    }
    if (switched.length > 0) return { switched };
    if (address !== THUMBNAIL_FRAME_ADDRESS && thumbnail.frame) {
      const made = madeFrom.get(THUMBNAIL_FRAME_ADDRESS);
      const frame = Object.entries(
        mgr.tryGetAssetState(THUMBNAIL_FRAME_ADDRESS)?.variants ?? {},
      ).find(([, v]) => made !== undefined && v.outputHash === made)?.[0];
      if (frame && mgr.getAcceptedVariant(THUMBNAIL_FRAME_ADDRESS) !== frame) {
        mgr.setAccepted(THUMBNAIL_FRAME_ADDRESS, frame);
        ledger.acceptedAssets.push(THUMBNAIL_FRAME_ADDRESS);
        ledger.cascadeAccepted.push({ address: THUMBNAIL_FRAME_ADDRESS, via: address });
      }
    }
    const previous = mgr.getAcceptedVariant(address);
    mgr.setAccepted(address, shown, { dismiss: candidates[address] ?? [] });
    if (previous !== shown) ledger.acceptedAssets.push(address);
    const cascaded = await cascadeAcceptConsumedDeps(
      mgr,
      submit.jobManager,
      address,
      shown,
      submit.cascade,
    );
    ledger.acceptedAssets.push(...cascaded);
    ledger.cascadeAccepted.push(...cascaded.map((dep) => ({ address: dep, via: address })));
    return {};
  });
  if (outcome.refused) return skip(outcome.refused);
  if (outcome.switched) {
    return skip(
      `the still was made from another take than ${outcome.switched.join(", ")}, accepted here — ` +
        "`konte generate video` makes it again from that take",
    );
  }
  const after = await StateManager.load(videoRoot);
  if (after.getAcceptedVariant(address) === shown) return decision;
  return skip(`${shown} is not accepted — the accept did not take`);
}

// After every accept, so each take is kept against the upstream this review settled.
async function applyKeepAndRegenerate(
  submit: ReelSubmit,
): Promise<{ kept: string[]; regenerate: string[] }> {
  const { body } = submit;
  const kept: string[] = [];
  const regenerate: string[] = [];
  if ((body.keep ?? []).length > 0 || (body.regenerate ?? []).length > 0) {
    await StateManager.withLock(submit.ctx.videoRoot, async (mgr) => {
      kept.push(...applyKeepDecisions(mgr, body.keep ?? [], body.regenerate));
      regenerate.push(...applyRegenerateDecisions(mgr, body.regenerate));
    });
  }
  return { kept, regenerate };
}

async function saveReelFeedback(
  submit: ReelSubmit,
  record: ReviewRecord,
  reviewedAt: string,
): Promise<void> {
  const { body } = submit;
  if ((body.addedFeedback?.length ?? 0) === 0 && (body.feedbackPatches?.length ?? 0) === 0) return;
  let mutation: FeedbackMutationResult = { added: [] };
  // Stamp each shot-note with its shot-local offset from the timeline the reviewer saw, so the
  // stored comment carries the within-shot position, not just the timeline-global `time`.
  const added = withCommentSubjects(
    withShotLocalTime(body.addedFeedback ?? [], record.context.shots),
    submit.subjectOf,
    submit.video,
    submit.displayed,
    body.displayedDefinitionHashes ?? {},
  );
  await FeedbackManager.withLock(submit.ctx.videoRoot, submit.stage, async (mgr) => {
    mutation = applyFeedbackMutations(mgr, added, body.feedbackPatches ?? [], reviewedAt);
  });

  // added[i] <-> record.notes[i] — both derive from the same pending feedback in order. The two
  // arrive as separate fields and are validated apart, so check the correspondence rather than
  // trust it: a payload where they do not line up would stamp every id onto the wrong note, and
  // an unstamped note is the honest degradation.
  if ((record.notes?.length ?? 0) === mutation.added.length) {
    mutation.added.forEach((a, i) => {
      const note = record.notes![i]!;
      note.id = a.id;
      // The takes the note stands on, as the stream stored them — so the record names the take a
      // later reroll has already replaced, instead of only the comment's id.
      const displayedVariants = added[i]?.displayedVariants;
      if (displayedVariants && Object.keys(displayedVariants).length > 0) {
        note.displayedVariants = displayedVariants;
      }
    });
  }
}

// The materialized-leaf content baseline (each composition / stem) — the state this review concluded
// in, so a refused handoff note can name a later edit. Computed after the accepts, and from freshly
// loaded state: the handoff resolves inputs the same default way, so a take accepted in *this* review
// must fold into the baseline, else the next handoff would read it as a post-review change. (The
// submit's `manager` predates the accepts and would do exactly that.)
async function materializedLeafBaseline(submit: ReelSubmit): Promise<Record<string, string>> {
  const { video } = submit;
  const postAccept = await StateManager.load(submit.ctx.videoRoot);
  const contentHashes: Record<string, string> = {};
  for (const addr of [
    ...listCompositionAddresses(video),
    ...listStemAddresses(video),
    ...listOverlayAddresses(video),
  ]) {
    const hash = materializedLeafContentHash(postAccept, video, addr);
    if (hash != null) contentHashes[addr] = hash;
  }
  return contentHashes;
}
