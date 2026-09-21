import {
  cascadeAcceptConsumedDeps,
  cascadeDirectionShotAccepts,
} from "../../../core/accept-cascade.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { shotById } from "../../../core/shot-index.js";
import {
  formatAddress,
  formatCompositionAddress,
  formatNarrationStemAddress,
  formatShotAddress,
  formatShotStemAddress,
  formatTimelineAddress,
  formatTimelineStemAddress,
  isStemAddress,
  listCompositionAddresses,
  listStemAddresses,
  parseAddress,
  parseAddressStream,
  parseShotAddress,
  assetNameOf,
  shotStemAssetNames,
  type ShotStage,
} from "../../../core/address.js";
import {
  buildFullCompositionHtml,
  buildShotClips,
  buildShotCompositionHtml,
  type CompositionClip,
} from "../../../core/composition-builder.js";
import { resolveCompositionRef } from "../../../core/composition-refs.js";
import {
  compositionDefinitionHashForAddress,
  definitionHashForAddress,
  timelineStemRefs,
  removedShotStemAddresses,
  leafReadyForReview,
  unresolvedLeafRefs,
  type UnresolvedLeafRef,
  materializeCompositionVariant,
  materializedLeafContentHash,
  commitShotStem,
  discardPreparedStem,
  materializeTimelineStem,
  prepareShotStem,
  type PreparedShotStem,
} from "../../../core/composition-resource.js";
import { variantMediaKind } from "../../../core/media-type.js";
import {
  applyVideoPreroll,
  ensurePrerollClips,
  injectPrerollWarmup,
  planVideoPreroll,
} from "../../../core/preview-preroll.js";
import { shotAcceptTargets, shotNeedsVerdict } from "../../../core/shot-accept-targets.js";
import { Semaphore } from "../../../core/semaphore.js";
import {
  computeAcceptedStaleness,
  formatStaleCause,
  isAcceptedStale,
} from "../../../core/staleness.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { parsePlaceholder } from "../../../core/dsl/shot-context.js";
import { KonteError, errorMessage } from "../../../core/errors.js";
import { errorResponse, htmlResponse, jsonResponse, parseJsonBody } from "../../page-host/http.js";
import type { Direction } from "../../../core/dsl/direction.js";
import type { ClipInfo, ShotMoveInfo } from "../../../pages/preview/types.js";
import type {
  AnimaticDefinition,
  Handoff,
  ReferenceDefinition,
  ShotDefinition,
  StageDefinition,
} from "../../../core/types/index.js";
import {
  type RenderPlan,
  type ShotRenderPlan,
  buildStageReviewPlan,
} from "../../../core/render-plan.js";
import { resolveSoundtrackSpan } from "../../../core/timeline-audio.js";
import { type ReviewRecord, saveReviewRecord } from "../../../core/review-record.js";
import {
  type CommentSubjectAddresses,
  FeedbackManager,
  commentSubjectAddresses,
} from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  consumedTakePreviewUrl,
  takeDefinitionSnapshot,
  buildVariantCandidates,
  shotFactsIndex,
  displayedVariantStatus,
  hasNewerReadyVariant,
  variantMediaUrl,
  variantPreviewUrl,
  buildAddressFeedback,
  handoffNotesForShot,
  ReelSubmitSchema,
  applyKeepDecisions,
  applyRegenerateDecisions,
  handoffRecordFields,
  type FeedbackMutationResult,
  withShotLocalTime,
  applyFeedbackMutations,
} from "./review-shared.js";
import type { ReportOutcome } from "./review-outcome.js";
import { createAssetInfoBuilder } from "./asset-info.js";
import { buildKeepGraph } from "./keep-graph.js";

// ffmpeg mixes run per accepted shot; a whole-reel Accept all must not spawn one per shot at once.
const STEM_MIX_CONCURRENCY = 4;

// The review status of a materialized leaf (composition / stem): its accepted variant (null when
// none) and whether it needs review. An UNaccepted leaf needs review — it was never signed off in
// context — as does a stale accepted one. Shared by the shot-composition, shot-stem and
// timeline-stem status so "never accepted" and "accepted-then-stale" are treated alike.
export function materializedLeafReviewStatus(
  manager: StateManager,
  address: string,
  defHash: string | null,
): { variantId: string | null; needsReview: boolean } {
  const variantId = manager.getAcceptedVariant(address);
  return {
    variantId,
    needsReview: variantId === null || isAcceptedStale(manager, address, defHash),
  };
}

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
    ({ address }) => !leafLanded(manager, video, address),
  );
}

/**
 * Why one leaf did not land, as the reviewer needs it: the cause, one line per input that held it
 * back, and the command that clears it. Reported instead of "check that every asset it references
 * resolves", which named nothing and sent the reader to `status -v` to find out what.
 *
 * Both halves of `leafLanded` are covered, because they send the reader to different places: refs
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
      ? leafLanded(manager, video, address)
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

// Whether a materialized leaf is signed off as of right now — see unlandedShotLeaves for why both
// halves are required. Shared with the timeline stem's own read-back.
function leafLanded(manager: StateManager, video: StageDefinition, address: string): boolean {
  if (!leafReadyForReview(manager, video, address)) return false;
  return !materializedLeafReviewStatus(manager, address, definitionHashForAddress(video, address))
    .needsReview;
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
  opts: { video: StageDefinition; animatic?: AnimaticDefinition | null },
): Promise<string[]> {
  const accepted: string[] = [];
  for (const depPath of sourcePaths) {
    // A dep path is the upstream asset's address directly.
    const srcAddr = depPath;
    const sel = displayed[srcAddr];
    if (!sel) continue;
    if (manager.getAcceptedVariant(srcAddr) === sel) {
      manager.dismissTakes(srcAddr, candidates[srcAddr] ?? [], sel);
      continue;
    }
    {
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

interface AudioTrackAsset {
  address: string;
  assetName: string;
  kind: "sound" | "soundtrack";
  variantId: string | null;
  variantStatus: "none" | "accepted";
  hasNewerVariant: boolean;
  fileUrl?: string;
  variants: ReturnType<typeof buildVariantCandidates>;
  // Each cue carries the shot that placed it (absent for a timeline bed), so accept and focus
  // route per cue — an asset reused across shots has no single owner, but every cue does.
  cues: Array<{
    start: number;
    end: number;
    cueId: string | null;
    volume: number | null;
    shotId?: string;
  }>;
}

// Collect every audio placement on the timeline into per-asset rows for the audio track.
// Per-shot `<Audio>`/`<Sound>` cues come from the already-harvested per-shot clips (lifted
// from shot-local to absolute time); timeline `<Soundtrack>` beds come from the definition,
// their spans resolved from shot anchors. Placements that resolve to the same asset (a
// reused SFX, or a bed placed twice) merge into one row — accept is per asset.
export function buildAudioAssets<
  A extends {
    assetName: string;
    address: string;
    variantId: string | null;
    variantStatus: "none" | "accepted";
    hasNewerVariant: boolean;
    fileUrl?: string;
    variants: ReturnType<typeof buildVariantCandidates>;
  },
>(opts: {
  manager: StateManager;
  video: StageDefinition;
  clipsByShot: Map<string, CompositionClip[]>;
  totalDuration: number;
  shotOffsets: Array<{ shotId: string; startTime: number; duration: number }>;
  // Audio shot assets already built by handleGetVideoState, reused so a per-shot cue's
  // accept/variant info matches what the render plan resolved (no second resolution).
  preBuilt: Map<string, A>;
  buildAsset: (assetName: string, addr: string, resolvedVariantId: string | undefined) => A;
}): AudioTrackAsset[] {
  const { manager, video, clipsByShot, totalDuration, shotOffsets, preBuilt, buildAsset } = opts;

  type RawCue = {
    address: string;
    kind: "sound" | "soundtrack";
    cue: {
      start: number;
      end: number;
      cueId: string | null;
      volume: number | null;
      // The shot whose composition placed this cue. Always known for a per-shot cue —
      // it is the shot the placement was lifted from — and absent for a timeline bed.
      shotId?: string;
    };
  };
  const raw: RawCue[] = [];

  for (const s of shotOffsets) {
    for (const clip of clipsByShot.get(s.shotId) ?? []) {
      if (clip.mediaType !== "audio" || !clip.address) continue;
      raw.push({
        address: clip.address,
        kind: "sound",
        cue: {
          start: s.startTime + clip.start,
          end: s.startTime + clip.end,
          cueId: clip.cueId,
          volume: clip.volume,
          shotId: s.shotId,
        },
      });
    }
  }

  const offsets = new Map(shotOffsets.map((s) => [s.shotId, s.startTime] as const));
  const durations = new Map(shotOffsets.map((s) => [s.shotId, s.duration] as const));
  for (const st of video.timelineSoundtracks ?? []) {
    const depPath = parsePlaceholder(st.src.src);
    if (!depPath) continue; // a plain file, not a konte asset — nothing to review/accept
    // A dep path is the upstream asset's address directly.
    const address = depPath;
    const { start, end } = resolveSoundtrackSpan(
      { from: st.options.from, until: st.options.until },
      offsets,
      durations,
      totalDuration,
    );
    if (end <= start) continue;
    raw.push({
      address,
      kind: "soundtrack",
      cue: { start, end, cueId: st.id, volume: st.options.volume ?? null },
    });
  }

  const byAddress = new Map<string, { kind: "sound" | "soundtrack"; cues: RawCue["cue"][] }>();
  for (const r of raw) {
    const group = byAddress.get(r.address) ?? { kind: r.kind, cues: [] };
    group.cues.push(r.cue);
    byAddress.set(r.address, group);
  }

  const out: AudioTrackAsset[] = [];
  for (const [address, group] of byAddress) {
    let base = preBuilt.get(address);
    if (!base) {
      try {
        const assetName = assetNameOf(parseAddress(address));
        const resolved = manager.resolveReference(address, { includeStale: true });
        base = buildAsset(assetName, address, resolved?.variantId);
      } catch {
        continue; // an unresolvable soundtrack asset just drops off the track
      }
    }
    out.push({
      address,
      assetName: base.assetName,
      kind: group.kind,
      variantId: base.variantId,
      variantStatus: base.variantStatus,
      hasNewerVariant: base.hasNewerVariant,
      ...(base.fileUrl ? { fileUrl: base.fileUrl } : {}),
      variants: base.variants,
      cues: group.cues.sort((a, b) => a.start - b.start),
    });
  }
  out.sort((a, b) => (a.cues[0]?.start ?? 0) - (b.cues[0]?.start ?? 0));
  return out;
}

// The board's declared movement per shot: every panel that carries one, in panel order, the cutin's
// after the shot's own. A frame's landing keyframe declares none.
function shotMoveIndex(animatic: AnimaticDefinition | null): Map<string, ShotMoveInfo[]> {
  const byId = new Map<string, ShotMoveInfo[]>();
  for (const shot of animatic?.shots ?? []) {
    const moves = [
      ...(shot.panels ?? []).map((p) => ({ ...p, cutin: false })),
      ...(shot.cutin?.panels ?? []).map((p) => ({ ...p, cutin: true })),
    ]
      .filter((p) => p.blocking != null || p.camera != null)
      .map((p) => ({
        panel: p.assetName,
        cutin: p.cutin,
        blocking: p.blocking ?? "",
        camera: p.camera ?? "",
      }));
    if (moves.length > 0) byId.set(shot.id, moves);
  }
  return byId;
}

/**
 * Whether a shot carries a track with no take yet — the timeline's dashed "Not ready" clip. The
 * shot's accept toggle is closed on it: a verdict there signs off a composition drawn over a
 * placeholder. Read off the definition rather than the harvested clips, which a render failure
 * leaves empty. A stem is not a track: the page mixes the cues live, and the accept materializes
 * the stem from the takes it signs off.
 */
function shotNotReady(
  manager: StateManager,
  stage: ShotStage,
  plan: ShotRenderPlan,
  shot: ShotDefinition | undefined,
): boolean {
  if (plan.pending || !shot) return false;
  const ownNames = Object.keys(shot.assets);
  if (ownNames.some((name) => plan.resolvedVariants[name] === undefined)) return true;
  const ownPaths = new Set(ownNames.map((name) => formatAddress(stage, shot.id, name)));
  return (shot.compositionRefs ?? []).some(
    (ref) => !ownPaths.has(ref) && manager.resolveReference(ref, { includeStale: true }) === null,
  );
}

export async function handleGetReelState(
  videoRoot: string,
  video: StageDefinition,
  assetBaseUrl: string,
  handoff: Handoff | null,
  direction: Direction | null,
  // The board. On the animatic stage it IS `video`; on the video stage it is the upstream, standing
  // in for a shot whose picture is not made yet.
  animatic: AnimaticDefinition | null,
  // The shared pool. A reel plays `reference:` addresses too (a bed, a sheet a panel stands on), and
  // this is the only definition that answers for their declaration.
  reference: ReferenceDefinition | null = null,
  // The video, when the reel is the board.
  downstreamVideo: StageDefinition | null = null,
): Promise<Response> {
  const stage = video.stage;
  const manager = await StateManager.load(videoRoot);
  const feedbackMgr = await FeedbackManager.load(videoRoot, stage);
  const patchHashes = patchHashesOf(await loadPatchCatalog(videoRoot, manager.getState()));
  const directionShotById = shotFactsIndex(direction);
  const movesByShotId = shotMoveIndex(animatic);

  const plan = buildStageReviewPlan(
    video,
    manager,
    stage === "video" && animatic ? buildStageReviewPlan(animatic, manager) : null,
  );

  // Per-shot composited clips (time ranges, layers, audio) for the UI's track view.
  // Rendering is best-effort: a failure must not blank the state response.
  let clipsByShot: Map<string, CompositionClip[]>;
  try {
    clipsByShot = buildShotClips(plan, assetBaseUrl);
  } catch {
    clipsByShot = new Map();
  }

  // A clip may name an address outside the shot's own pool — a board frame an animatic stands on,
  // a reference asset pulled in by closure — so readiness is resolved here rather than looked up
  // among the shot's assets, where such an address is absent and would read as missing.
  const clipsFor = (shotId: string): ClipInfo[] =>
    (clipsByShot.get(shotId) ?? []).map((clip) => ({
      ...clip,
      notReady:
        clip.address !== null &&
        manager.resolveReference(clip.address, { includeStale: true }) === null,
    }));

  // On the animatic stage `video` IS the board, so the two keys name the same definition.
  const assetInfo = createAssetInfoBuilder(
    { [stage]: video, animatic, reference },
    (addr, vid) => takeDefinitionSnapshot(manager, videoRoot, addr, vid),
    (addr, vid, ref) => consumedTakePreviewUrl(manager, videoRoot, addr, vid, ref, assetBaseUrl),
  );

  const buildAsset = (assetName: string, addr: string, resolvedVariantId: string | undefined) => {
    const acceptedId = manager.getAcceptedVariant(addr);
    // The take the plan resolved is the one the reel plays, so the card names it too.
    const variantId: string | null = resolvedVariantId ?? null;
    const variantStatus = displayedVariantStatus(manager, addr, variantId);
    return {
      assetName,
      address: addr,
      variantId,
      variantStatus,
      hasNewerVariant: hasNewerReadyVariant(
        manager,
        addr,
        acceptedId,
        // Routed to the stage that owns the address: a shot can play a shared `reference:` take,
        // and this definition answers for none of those.
        manager.registeredDefinitionHash(addr),
        patchHashes,
      ),
      mediaKind: variantMediaKind(manager, addr, variantId),
      fileUrl: variantId ? variantMediaUrl(manager, addr, variantId, assetBaseUrl) : undefined,
      variants: buildVariantCandidates(
        manager,
        addr,
        acceptedId,
        // Routed to the stage that owns the address: a shot can play a shared `reference:` take,
        // and this definition answers for none of those.
        manager.registeredDefinitionHash(addr),
        (vid, v) => variantPreviewUrl(videoRoot, addr, vid, v, assetBaseUrl),
        (vid) => variantMediaUrl(manager, addr, vid, assetBaseUrl) ?? null,
        patchHashes,
        (vid) => assetInfo(addr, vid),
      ),
    };
  };

  // Audio assets declared on a shot belong to the audio track, not the shot (video) accept —
  // collected here so buildAudioAssets can reuse the resolved-variant info without re-resolving.
  const audioBuiltByAddress = new Map<string, ReturnType<typeof buildAsset>>();

  // Isolate per shot: one shot's resolution failing (e.g. a composition hash that
  // evaluates a shotFn referencing an ungenerated upstream) must not blank the whole
  // timeline. The shot still appears, just without its assets/feedback overlay.
  let nextStartTime = 0;
  const shots = plan.shots.map((s) => {
    const startTime = nextStartTime;
    nextStartTime += s.duration;
    const shot = shotById(video.shots, s.shotId);
    const notReady = shotNotReady(manager, stage, s, shot);
    try {
      // Only the shot's video/image assets stay on the shot; audio splits off to its track,
      // so the shot (video) accept is fully independent of the per-asset audio accept.
      const assets: ReturnType<typeof buildAsset>[] = [];
      const audioAddresses = new Set<string>();
      if (shot) {
        for (const assetName of Object.keys(shot.assets)) {
          const addr = formatAddress(stage, s.shotId, assetName);
          const built = buildAsset(assetName, addr, s.resolvedVariants[assetName]);
          if (built.mediaKind === "audio") {
            audioAddresses.add(addr);
            audioBuiltByAddress.set(addr, built);
          } else {
            assets.push(built);
          }
        }
      }

      // Feedback/pins on the composited frame attach to the bare shot target — a
      // feedback-only target with no variant — so a comment reads as an observation
      // on the shot, not a "reroll the composition" instruction. Staleness still
      // tracks the composition through the variant snapshot taken when the comment
      // is saved (see video-preview's snapshot of compositionAddress).
      const hasComposition = s.shotFn !== null;
      const feedbackAddress = formatShotAddress(stage, s.shotId);

      const compositionAddress = hasComposition ? formatCompositionAddress(stage, s.shotId) : null;
      const compositionDefinitionHash = compositionAddress
        ? compositionDefinitionHashForAddress(video, compositionAddress)
        : null;
      let compositionVariantId: string | null = null;
      let compositionNeedsReview = false;
      if (compositionAddress) {
        // Unaccepted or stale both count as needing review (see materializedLeafReviewStatus).
        ({ variantId: compositionVariantId, needsReview: compositionNeedsReview } =
          materializedLeafReviewStatus(manager, compositionAddress, compositionDefinitionHash));
      }

      // The shot's audio stems (its <Audio>/<Video hasAudio> cues, the board's narration apart),
      // accepted with the shot. A stale/unaccepted stem re-opens the shot for review just like a
      // stale/unaccepted composition: a shot whose picture sources were accepted out-of-band must
      // not read done with unreviewed audio.
      const verdictTargets = shotAcceptTargets(manager, video, s);
      const stems = verdictTargets.leaves
        .filter((leaf) => isStemAddress(leaf.address))
        .map(({ address }) => {
          const definitionHash = definitionHashForAddress(video, address);
          return {
            address,
            definitionHash,
            ...materializedLeafReviewStatus(manager, address, definitionHash),
          };
        });

      // A shot comment attaches to the bare shot target but snapshots its composition/stem live
      // definition hash (video-preview's handleSubmit); feed the current values so a definition
      // edit — a transition, an audio retime — that mints no variant still ages the comment out.
      const leafDefinitionHashes = new Map<string, string>();
      if (compositionAddress && compositionDefinitionHash) {
        leafDefinitionHashes.set(compositionAddress, compositionDefinitionHash);
      }
      for (const stem of stems) {
        if (stem.definitionHash) leafDefinitionHashes.set(stem.address, stem.definitionHash);
      }
      const feedback = buildAddressFeedback(feedbackMgr, manager.getState(), feedbackAddress, {
        cache: manager.stalenessCache(),
        definitionHashes: leafDefinitionHashes,
      });

      // Video shot acceptance ignores audio: an unaccepted audio cue must not keep the shot
      // reading as unaccepted (audio carries its own accept on the audio track).
      const nonAudioUnaccepted = s.unacceptedAssets.filter((a) => !audioAddresses.has(a));
      const nonAudioResolved = Object.keys(s.resolvedVariants).filter(
        (name) => !audioAddresses.has(formatAddress(stage, s.shotId, name)),
      );
      // Something has to have been signed off — an accept over nothing is vacuous. A shot whose
      // picture is built purely from another stage's takes (animatic refs, no `asset()` of its
      // own) resolves no video-stage variant, so its accepted composition IS that something.
      const allAccepted =
        nonAudioUnaccepted.length === 0 &&
        (nonAudioResolved.length > 0 || compositionVariantId !== null);

      // The gallery-backed addresses this shot's verdict lands on. The page reads them to tell an
      // audition apart from what the address resolves to.
      const verdictAddresses = [
        ...new Set([...verdictTargets.pictureAssets, ...verdictTargets.stemSources]),
      ];

      // The page's one answer to "is this shot done", over the half it is showing. The client's
      // accept toggle starts checked on its negation, and Accept all skips a shot it reads as
      // settled, so anything this misses is a verdict a reviewer is never offered while `status`
      // goes on asking for it.
      const needsVerdict = shotNeedsVerdict(
        manager,
        video,
        s,
        (address) =>
          !materializedLeafReviewStatus(manager, address, definitionHashForAddress(video, address))
            .needsReview,
      );

      return {
        shotId: s.shotId,
        startTime,
        duration: s.duration,
        action: shot?.action ?? "",
        script: directionShotById.get(s.shotId)?.script ?? [],
        join: directionShotById.get(s.shotId)?.join ?? null,
        moves: movesByShotId.get(s.shotId) ?? [],
        assets,
        clips: clipsFor(s.shotId),
        feedback,
        allAccepted,
        needsVerdict,
        verdictAddresses,
        hasComposition,
        pending: s.pending,
        aside: s.aside,
        compositionAddress,
        compositionVariantId,
        compositionDefinitionHash,
        compositionNeedsReview,
        stems: stems.map(({ address, variantId, definitionHash, needsReview }) => ({
          address,
          variantId,
          definitionHash,
          needsReview,
        })),
        showingStandIn: s.showStandIn,
        notReady,
        handoffNotes: handoffNotesForShot(handoff, stage, s.shotId),
      };
    } catch {
      return {
        shotId: s.shotId,
        startTime,
        duration: s.duration,
        action: shot?.action ?? "",
        script: directionShotById.get(s.shotId)?.script ?? [],
        join: directionShotById.get(s.shotId)?.join ?? null,
        moves: movesByShotId.get(s.shotId) ?? [],
        assets: [] as ReturnType<typeof buildAsset>[],
        clips: clipsFor(s.shotId),
        feedback: [] as ReturnType<typeof buildAddressFeedback>,
        allAccepted: false,
        // Fails closed: this shot's plan or hashes would not compute, so nothing here says it is
        // settled — and a checked toggle on a shot Accept all then skips is the exact shape that
        // let a verdict go unasked.
        needsVerdict: true,
        verdictAddresses: [],
        hasComposition: s.shotFn !== null,
        pending: s.pending,
        aside: s.aside,
        compositionAddress: null,
        compositionVariantId: null,
        compositionDefinitionHash: null,
        compositionNeedsReview: false,
        stems: [],
        showingStandIn: s.showStandIn,
        notReady,
        handoffNotes: handoffNotesForShot(handoff, stage, s.shotId),
      };
    }
  });

  const totalDuration = plan.shots.reduce((acc, s) => acc + s.duration, 0);

  // The audio track: every audio placement on the timeline, in absolute seconds, grouped by
  // the asset that owns it. Per-shot `<Audio>`/`<Sound>` cues come from the already-built
  // per-shot clips (lifted from shot-local to absolute time); timeline `<Soundtrack>` beds
  // (BGM) come from the definition, their spans resolved from shot anchors. Accept is per
  // asset — separate from the video (shot) accept.
  const audioAssets = buildAudioAssets({
    manager,
    video,
    clipsByShot,
    totalDuration,
    shotOffsets: shots.map((s) => ({
      shotId: s.shotId,
      startTime: s.startTime,
      duration: s.duration,
    })),
    preBuilt: audioBuiltByAddress,
    buildAsset,
  });

  // The timeline audio stem (soundtrack beds) status — the single in-context accept for the beds.
  const timelineStem =
    (video.timelineSoundtracks?.length ?? 0) > 0
      ? (() => {
          const address = formatTimelineStemAddress(stage);
          const definitionHash = definitionHashForAddress(video, address);
          // Unaccepted beds need review too (not just a stale accepted one).
          return {
            address,
            definitionHash,
            ...materializedLeafReviewStatus(manager, address, definitionHash),
            feedback: buildAddressFeedback(feedbackMgr, manager.getState(), address, {
              cache: manager.stalenessCache(),
              definitionHashes: definitionHash ? new Map([[address, definitionHash]]) : new Map(),
            }),
          };
        })()
      : null;

  return jsonResponse({
    mode: stage === "animatic" ? "animatic-preview" : "video-preview",
    fps: plan.fps,
    shots,
    totalDuration,
    size: plan.size,
    audioAssets,
    compositionRefVariants: compositionRefVariantsOf(manager, video, animatic),
    ...(timelineStem ? { timelineStem } : {}),
    keep: reelKeepGraph(manager, video, animatic, reference, downstreamVideo),
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
  });
}

// Best-effort like the clips: a graph that will not build leaves the prompt nothing to ask.
function reelKeepGraph(
  manager: StateManager,
  reel: StageDefinition,
  animatic: AnimaticDefinition | null,
  reference: ReferenceDefinition | null,
  downstreamVideo: StageDefinition | null,
): ReturnType<typeof buildKeepGraph> {
  try {
    if (reel.stage === "video") {
      return buildKeepGraph({
        manager,
        graph: buildDependencyGraph(reel, animatic, reference),
        stages: [{ stage: "video", definition: reel }],
      });
    }
    return buildKeepGraph({
      manager,
      graph: buildDependencyGraph(downstreamVideo ?? reel, reel as AnimaticDefinition, reference),
      stages: [
        { stage: "animatic", definition: reel },
        { stage: "video", definition: downstreamVideo },
      ],
    });
  } catch {
    return { addresses: {}, units: {} };
  }
}

async function prerolledReelHtml(
  video: StageDefinition,
  videoRoot: string,
  assetBaseUrl: string,
  variantOverrides?: Array<{ address: string; variantId: string }>,
  animatic?: AnimaticDefinition | null,
  standInShotIds?: readonly string[],
): Promise<string> {
  const manager = await StateManager.load(videoRoot);
  const result = await buildFullCompositionHtml({
    video,
    manager,
    assetBaseUrl,
    variantOverrides,
    allowNotReady: true,
    // Must match handleGetReelState's plan, or the reel and the shot list would disagree about
    // what a shot is showing — and the accept toggle targets what is shown.
    standIn: video.stage === "video" && animatic ? buildStageReviewPlan(animatic, manager) : null,
    ...(standInShotIds ? { pinnedStandInShotIds: new Set(standInShotIds) } : {}),
  });
  const clips = planVideoPreroll(result.html, assetBaseUrl, manager);
  const ready = await ensurePrerollClips(videoRoot, clips);
  return injectPrerollWarmup(applyVideoPreroll(result.html, ready));
}

// Refuses before the page opens: a reel shot the builder would refuse is never the reviewer's to find.
// Called once the server has registered its definitions, so it resolves every shot as the page does.
export async function assertReelBuilds(
  video: StageDefinition,
  videoRoot: string,
  animatic: AnimaticDefinition,
): Promise<void> {
  const manager = await StateManager.load(videoRoot);
  await buildFullCompositionHtml({
    video,
    manager,
    assetBaseUrl: "",
    allowNotReady: true,
    standIn: video.stage === "video" ? buildStageReviewPlan(animatic, manager) : null,
  });
}

/**
 * Encode the reel's padded copies before the page asks for them.
 *
 * The same pass the first `/api/compositions/full` would run, started while the browser is still
 * launching. The HTML it builds is thrown away — only the cache matters, and whatever is missing
 * when the request lands, the request builds.
 */
export async function warmReelPreroll(
  video: StageDefinition,
  videoRoot: string,
  assetBaseUrl: string,
  animatic?: AnimaticDefinition | null,
): Promise<void> {
  try {
    await prerolledReelHtml(video, videoRoot, assetBaseUrl, undefined, animatic, undefined);
  } catch (err) {
    console.error(`[preview] preroll warm-up skipped: ${errorMessage(err)}`);
  }
}

export async function handleGetFullComposition(
  video: StageDefinition,
  videoRoot: string,
  assetBaseUrl: string,
  variantOverrides?: Array<{ address: string; variantId: string }>,
  // The board, for the shots whose delivered picture is not made yet (video stage only).
  animatic?: AnimaticDefinition | null,
  // The shots the PAGE was told are standing in. Taken from the client for the same reason submit
  // takes `displayedStandInShotIds` from it: this request loads state of its own, so a take landing
  // between the state response and this one would otherwise flip a shot here and nowhere else.
  standInShotIds?: readonly string[],
): Promise<Response> {
  try {
    return htmlResponse(
      await prerolledReelHtml(
        video,
        videoRoot,
        assetBaseUrl,
        variantOverrides,
        animatic,
        standInShotIds,
      ),
    );
  } catch (err) {
    if (err instanceof KonteError) {
      console.error(`[preview] GET /api/compositions/full → ${err.code}: ${err.message}`);
      return errorResponse(err.message, err.code, 400);
    }
    throw err;
  }
}

export async function handleGetShotComposition(
  video: StageDefinition,
  videoRoot: string,
  shotId: string,
  assetBaseUrl: string,
  variantOverride?: { assetName: string; variantId: string },
): Promise<Response> {
  const manager = await StateManager.load(videoRoot);

  try {
    const result = await buildShotCompositionHtml({
      video,
      manager,
      shotId,
      assetBaseUrl,
      variantOverride,
      allowNotReady: true,
    });
    return htmlResponse(result.html);
  } catch (err) {
    if (err instanceof KonteError) {
      console.error(`[preview] GET shot composition (${shotId}) → ${err.code}: ${err.message}`);
      return errorResponse(err.message, err.code, 400);
    }
    throw err;
  }
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

// The take every address a composition CONSUMES was rendered from, keyed by address — resolved the
// way every read surface resolves, so it names what the page actually drew.
//
// The page cannot answer this for itself: an `animatic:` panel, a `reference:` sheet or another
// shot's frame is on screen inside the composite and in none of the page's own asset arrays, so a
// comment's subject silently lost it. The page carries the map back at submit, where a gallery pick
// overrides it — which is the one part of "what was displayed" only the browser knows.
function compositionRefVariantsOf(
  manager: StateManager,
  video: StageDefinition,
  // The board, whose shot is what a standing-in video shot actually draws — so its refs are on
  // screen too, and a comment there stands against them.
  animatic: AnimaticDefinition | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  // `seen`, not `out`: an unresolvable ref sets nothing, and without this every appearance of one
  // re-walks its dependency graph.
  const seen = new Set<string>();
  const resolve = (ref: string) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const hit = resolveCompositionRef(manager, ref, { includeStale: true });
    if (hit) out[ref] = hit.variantId;
  };
  for (const def of [video, animatic]) {
    if (!def) continue;
    for (const shot of def.shots) for (const ref of shot.compositionRefs ?? []) resolve(ref);
    for (const ref of timelineStemRefs(def)) resolve(ref);
  }
  return out;
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
      // when the audio changed and someone had reason to comment.
      if (!isStemAddress(address)) {
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

// Handles a reel review's submit (`/api/animatic/submit`, `/api/video/submit`). Both composition
// stages are reviewed the same way — one verdict per shot over a playing reel — so one handler
// serves both, told which by the definition it is handed.
export async function handleReelSubmit(
  videoRoot: string,
  reload: () => Promise<StageDefinition>,
  handoff: Handoff | null,
  direction: Direction | null,
  animatic: AnimaticDefinition | null,
  req: Request,
  reportOutcome?: ReportOutcome,
): Promise<Response> {
  // Stamped before anything is written, so every comment this review carries predates the
  // accepts it was submitted with (see applyFeedbackMutations).
  const reviewedAt = new Date().toISOString();
  const body = await parseJsonBody<{
    decisions: unknown;
    // The timeline audio stem (soundtrack beds) accept decision. Per-shot audio rides its shot's
    // accept (which finalizes that shot's stem); the beds — spanning the whole video — are signed
    // off here, via `timeline#stem`.
    timelineStemDecision?: unknown;
    notes?: ReviewRecord["notes"];
    addedFeedback?: Array<{
      address: string;
      text: string;
      annotation: { kind: "pin"; x: number; y: number } | null;
      time?: number;
    }>;
    feedbackPatches?: Array<{ op: "edit" | "delete"; id: string; address: string; text?: string }>;
    // The variant the reviewer actually saw for every reviewable asset (keyed by
    // address). Submit accepts exactly these — never a variant re-resolved at
    // submit time, which could be a reroll that completed mid-review.
    displayedVariants?: Record<string, string>;
    // The live definition hash the page was served per materialized leaf (see ReelSubmitSchema).
    displayedDefinitionHashes?: Record<string, string>;
    // Every take the gallery offered per address (see DisplayedCandidatesSchema) — what an accept
    // here dismisses the unchosen of.
    displayedCandidates?: Record<string, string[]>;
    // The shots the reviewer saw standing in (see ReelSubmitSchema).
    displayedStandInShotIds?: string[];
  }>(req);
  if (!body) {
    return errorResponse("Invalid request body", "INVALID_REQUEST", 400);
  }
  const payload = ReelSubmitSchema.safeParse(body);
  if (!payload.success) {
    return errorResponse("Invalid review payload", "INVALID_REQUEST", 400);
  }
  // Both go straight onto the persisted record, so take them from the validated payload rather than
  // the raw body — a malformed one is rejected here, not written and then silently skipped by the
  // read path (which would drop the whole review).
  const submittedDecisions = payload.data.decisions ?? undefined;
  const timelineStemDecision = payload.data.timelineStemDecision;

  const manager = await StateManager.load(videoRoot);
  const video = await reload();
  const stage = video.stage;

  // The same plan handleGetReelState renders under (one builder, no options here).
  //
  // A plan this submit cannot build is a review it cannot apply, so it fails the whole request —
  // ahead of every accept, feedback write and record below, so nothing lands half-applied. It must
  // never fall through with a null plan: that skipped the entire accept block while still writing a
  // record full of "accepted" and answering 200.
  let plan: RenderPlan;
  try {
    plan = buildStageReviewPlan(
      video,
      manager,
      stage === "video" && animatic ? buildStageReviewPlan(animatic, manager) : null,
    );
  } catch (error) {
    return errorResponse(
      `Failed to build the review plan — no part of this review was applied: ${errorMessage(
        error,
      )}`,
      "RENDER_PLAN_FAILED",
      500,
    );
  }

  const subjectOf = reelSubjectResolver(video, animatic, body.displayedStandInShotIds ?? []);
  const unknownTargets = assertCommentTargets(subjectOf, body.addedFeedback ?? []);
  if (unknownTargets.length > 0) {
    return errorResponse(
      `This stage holds no target for ${unknownTargets.join(", ")} — no part of this review was applied.`,
      "INVALID_REQUEST",
      400,
    );
  }

  // What the reviewer saw, keyed by address. The record and the accepts below both
  // read from this snapshot — not the freshly re-resolved plan — so "recorded ==
  // shown == accepted" even when a reroll completed during review.
  const displayed = body.displayedVariants ?? {};
  const candidates = body.displayedCandidates ?? {};
  const displayedByAsset = (
    resolved: Record<string, string>,
    addressOf: (assetName: string) => string,
  ): Record<string, string> =>
    Object.fromEntries(
      Object.keys(resolved).map((assetName) => [
        assetName,
        displayed[addressOf(assetName)] ?? resolved[assetName]!,
      ]),
    );

  const record: ReviewRecord = {
    mode: stage === "animatic" ? "animatic-preview" : "video-preview",
    stage,
    createdAt: new Date().toISOString(),
    context: {
      shots: plan.shots.map((s) => ({
        shotId: s.shotId,
        duration: s.duration,
        variants: displayedByAsset(s.resolvedVariants, (name) =>
          formatAddress(stage, s.shotId, name),
        ),
      })),
      // Stage-level timeline assets — recorded at the variant the reviewer saw, like the shots
      // above: a bed switched in the gallery, or a reroll that landed mid-review, must not make
      // the record name a variant nobody reviewed. Non-audio beds/overlays are accepted through
      // the compositions that consume them; audio beds (BGM) are accepted via
      // `timelineStemDecision` on `timeline#stem`.
      timeline: displayedByAsset(plan.timelineResolvedVariants, (name) =>
        formatTimelineAddress(stage, name),
      ),
      // `contentHashes` (the materialized-leaf baseline) is set below, after the accepts —
      // see the note there.
    },
    decisions: submittedDecisions,
    ...(timelineStemDecision ? { timelineStemDecision } : {}),
    notes: body.notes,
    ...(payload.data.overallComment ? { overallComment: payload.data.overallComment } : {}),
    ...handoffRecordFields(handoff),
  };

  // Saved after feedback capture below, so note images can be mirrored into the record.
  let filePath: string | null = null;

  const acceptedAssets: string[] = [];
  // Why a leaf's materialization threw, by address. Each accept block below swallows its failures so
  // one shot cannot sink the review, but the message is the diagnosis — a mix refusing on a cue
  // names the cue — so it is kept for the read-back's reason rather than replaced by a guess.
  const leafFailures = new Map<string, string>();
  // Audio sources accepted only as a side effect of a stem accept, tagged with the stem they were
  // signed off through — persisted on the record so `review record show` can surface them.
  const cascadeAccepted: Array<{ address: string; via: string }> = [];
  const unacceptedAssets: string[] = [];
  const jobManager = new JobManager(videoRoot);

  const decisions = submittedDecisions ?? {};

  const okShotIds = new Set<string>();
  const unacceptShotIds = new Set<string>();
  for (const shot of plan.shots) {
    // Accept is a toggle: "accepted" accepts the shot's shown variants, "none"
    // un-accepts them. An undecided shot is left untouched — never silently
    // accepted — so a reroll's pending variant can't be locked out by
    // re-confirming the stale accepted one on submit.
    const decision = decisions[shot.shotId];
    if (decision === "accepted") okShotIds.add(shot.shotId);
    else if (decision === "none") unacceptShotIds.add(shot.shotId);
  }

  // A shot that stood in with its board has no verdict to land — it is display only. The UI closes
  // the toggle, so a decision arriving for one is a stale client: dropped either way round, never
  // accepted unseen. Taken from the CLIENT, never re-derived here — a build dependency that
  // finished between load and submit flips the answer, and re-deriving would then sign off a
  // composition the reviewer never watched.
  for (const id of payload.data.displayedStandInShotIds) {
    okShotIds.delete(id);
    unacceptShotIds.delete(id);
  }

  const toAccept: Array<{ address: string; variantId: string; dismiss: string[] }> = [];

  // Accept only the variant the reviewer saw (from `displayed`). An asset
  // missing from the snapshot is skipped — never re-resolved to a fresh variant,
  // so a reroll that finished mid-review can't be accepted unseen.
  for (const shot of plan.shots) {
    if (!okShotIds.has(shot.shotId)) continue;
    for (const address of shotAcceptTargets(manager, video, shot).pictureAssets) {
      const variantId = displayed[address];
      if (!variantId) continue;
      toAccept.push({ address, variantId, dismiss: candidates[address] ?? [] });
    }
  }

  if (toAccept.length > 0) {
    await StateManager.withLock(videoRoot, async (mgr) => {
      for (const { address, variantId, dismiss } of toAccept) {
        try {
          const previousAccepted = mgr.getAcceptedVariant(address);
          // Always (re)accept: re-accepting the same variant is how the reviewer settles the rivals
          // they chose against. Cascade/report only when the accepted id actually changed.
          mgr.setAccepted(address, variantId, { dismiss });
          if (previousAccepted !== variantId) {
            acceptedAssets.push(address);
            const cascaded = await cascadeAcceptConsumedDeps(mgr, jobManager, address, variantId, {
              video,
              animatic,
            });
            acceptedAssets.push(...cascaded);
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
  const acceptedShots = plan.shots.filter((s) => okShotIds.has(s.shotId));
  // The state as lock A left it — what the stems are mixed from, so a source accepted elsewhere
  // after this lock is seen by the commit's identity check rather than mixed in unseen.
  let settledSources: StateManager | null = null;
  if (acceptedShots.length > 0) {
    settledSources = await StateManager.withLock(videoRoot, async (mgr) => {
      for (const shot of acceptedShots) {
        for (const removedStem of removedShotStemAddresses(mgr.getState(), video, shot.shotId)) {
          const removedStemVariantId = mgr.getAcceptedVariant(removedStem);
          if (removedStemVariantId) {
            mgr.setUnaccepted(removedStem, removedStemVariantId);
            unacceptedAssets.push(removedStem);
          }
        }
        const targets = shotAcceptTargets(mgr, video, shot);
        if (targets.stemSources.length === 0) continue;
        const narration = shotById(video.shots, shot.shotId)?.narrationStemRefs ?? [];
        const via = (source: string): string =>
          narration.includes(source)
            ? formatNarrationStemAddress(shot.shotId)
            : formatShotStemAddress(stage, shot.shotId);
        try {
          const sources = await acceptDisplayedStemSources(
            mgr,
            jobManager,
            targets.stemSources,
            displayed,
            candidates,
            { video, animatic },
          );
          acceptedAssets.push(...sources);
          cascadeAccepted.push(...sources.map((address) => ({ address, via: via(address) })));
        } catch {
          // skip individual stem-source failures
        }
      }
      return mgr;
    });
  }

  // Fold the shot's audio into its accept: accepting a shot signs off its picture (composition,
  // below) and its stems (`shot.<id>#stem`, the board's `#narrationStem`) in one gesture — each
  // leaf is materialized over the sources settled above; on the board `#stem` is the mix the motion
  // is driven by. The mixes run outside the state lock (ffmpeg, one per stem) from the takes lock A
  // settled, and the commit
  // under lock B re-checks that those takes still resolve — a source accepted elsewhere meanwhile
  // is refused, not recorded. Every address comes from `shotAcceptTargets` — the same enumeration
  // the post-condition below reads back, so an accept and its check can never disagree about what
  // a shot covers.
  const stemLeaves = settledSources
    ? acceptedShots.flatMap((shot) =>
        shotAcceptTargets(settledSources, video, shot)
          .leaves.filter((leaf) => isStemAddress(leaf.address))
          .map((leaf) => ({ shotId: shot.shotId, address: leaf.address })),
      )
    : [];
  if (settledSources && stemLeaves.length > 0) {
    const snapshot = settledSources;
    const mixer = new Semaphore(STEM_MIX_CONCURRENCY);
    const prepared = new Map<string, PreparedShotStem>();
    try {
      await Promise.all(
        stemLeaves.map(({ address }) =>
          mixer.run(async () => {
            try {
              const p = await prepareShotStem({ manager: snapshot, video, address });
              if (p) prepared.set(address, p);
            } catch (err) {
              leafFailures.set(address, errorMessage(err));
            }
          }),
        ),
      );
      await StateManager.withLock(videoRoot, async (mgr) => {
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
            acceptedAssets.push(stemAddress);
            // The stem is materialized and accepted by the shot accept, not reviewed on its own —
            // so it has no decision line. Record it (via the shot) so the recap names it; its audio
            // sources are recorded via the stem in turn.
            cascadeAccepted.push({ address: stemAddress, via });
            const cascaded = await cascadeAcceptConsumedDeps(
              mgr,
              jobManager,
              stemAddress,
              variantId,
              { video, animatic },
            );
            acceptedAssets.push(...cascaded);
            cascadeAccepted.push(...cascaded.map((address) => ({ address, via: stemAddress })));
          } catch (err) {
            leafFailures.set(stemAddress, errorMessage(err));
          }
        }
      });
    } finally {
      // A mix the lock never reached (the lock itself failing) must not stay in the cache.
      for (const p of prepared.values()) await discardPreparedStem(p);
    }
  }

  // Accept the composition for each ok shot that has one: render it against the
  // just-accepted assets and accept that variant as the re-review baseline (UC1).
  // Runs after asset accepts so the composition's input fingerprints capture them.
  const compositionShotIds = plan.shots
    .filter((s) => okShotIds.has(s.shotId) && s.shotFn)
    .map((s) => s.shotId);
  if (compositionShotIds.length > 0) {
    await StateManager.withLock(videoRoot, async (mgr) => {
      for (const shotId of compositionShotIds) {
        try {
          const variantId = await materializeCompositionVariant({
            manager: mgr,
            video,
            shotId,
          });
          if (variantId) {
            const compAddress = formatCompositionAddress(stage, shotId);
            mgr.setAccepted(compAddress, variantId);
            acceptedAssets.push(compAddress);
            // The composition is materialized and accepted by the shot accept, never as a
            // reviewable per-shot asset — so it has no decision line. Record it here so the
            // review recap names what the shot accept signed off.
            cascadeAccepted.push({
              address: compAddress,
              via: formatShotAddress(stage, shotId),
            });
            // Accept the assets the composition consumed — including timeline assets
            // used only in the shotFn (logos, overlays), which no per-shot
            // generation accept would otherwise reach.
            const cascaded = await cascadeAcceptConsumedDeps(
              mgr,
              jobManager,
              compAddress,
              variantId,
              { video, animatic },
            );
            acceptedAssets.push(...cascaded);
          }
        } catch (err) {
          // One shot's failure must not sink the review; the read-back below reports it.
          leafFailures.set(formatCompositionAddress(stage, shotId), errorMessage(err));
        }
      }
    });
  }

  if (unacceptShotIds.size > 0) {
    await StateManager.withLock(videoRoot, async (mgr) => {
      unacceptedAssets.push(...unacceptReelShots(mgr, video, plan.shots, unacceptShotIds));
    });
  }

  // Post-condition on every shot accept above. Each of those blocks swallows per-item failures by
  // design — one unbuildable shot must not sink a whole review — and an accept can also decline to
  // land for a legitimate reason (an animatic whose refs stopped resolving mid-review). So what
  // landed is READ BACK from state rather than inferred from the code above having run: this is the
  // check that turns any silent skip, today's or a future one's, into something the reviewer and the
  // record both see. It is deliberately independent of the accept path — assert the outcome, never
  // trust the attempt.
  //
  // Runs before the direction cascade below, so a shot that did not land does not settle direction
  // parts on the strength of an accept it never made.
  //
  // Both verdicts are read back, not just the accept: `unacceptReelShots` swallows per-address
  // failures the same way, so a "none" that did not take must not be recorded as a release either.
  const skippedDecisions: NonNullable<ReviewRecord["skippedDecisions"]> = [];
  if (okShotIds.size > 0 || unacceptShotIds.size > 0) {
    const postAccept = await StateManager.load(videoRoot);
    for (const shot of plan.shots) {
      const accepting = okShotIds.has(shot.shotId);
      if (!accepting && !unacceptShotIds.has(shot.shotId)) continue;
      // A shot with nothing to accept or release — undeveloped, or an aside on the stage that does
      // not board it — is not an outcome, so a verdict on one is dropped from both sets, the same
      // rule a deleted shot gets. The UI will not mint such a decision, but a source reload can turn
      // a shot the reviewer already judged into a pendingShot or an aside; left in, it would be
      // written down as settled and would cascade direction acceptance on the strength of an accept
      // that touched nothing. Not reported as a skip either: nothing failed, the thing judged simply
      // no longer exists.
      if (shot.pending || (shot.aside && !shot.shotFn)) {
        okShotIds.delete(shot.shotId);
        unacceptShotIds.delete(shot.shotId);
        continue;
      }
      const missed = accepting
        ? unlandedShotLeaves(postAccept, video, shot).map((leaf) => {
            const failure = leafFailures.get(leaf.address);
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
        skippedDecisions.push({ shotId: shot.shotId, address, reason });
      }
      okShotIds.delete(shot.shotId);
      unacceptShotIds.delete(shot.shotId);
    }
  }

  // The timeline beds get the same treatment: their block below is wrapped in its own catch, so a
  // failed materialization would otherwise leave the record claiming a decision state does not back.
  // Checked after that block runs — see the note there.

  // Carry each accepted shot back into the direction, in one pass after every accept above: a
  // shot's picture, its stem and their consumed deps all settle the same direction parts, so
  // running once records each part once — under the shot whose accept signed it.
  if (okShotIds.size > 0) {
    await StateManager.withLock(videoRoot, async (mgr) => {
      for (const shotId of okShotIds) {
        const via = formatShotAddress(stage, shotId);
        const parts = cascadeDirectionShotAccepts(mgr, direction, new Set([shotId]));
        cascadeAccepted.push(...parts.map((address) => ({ address, via })));
      }
    });
  }

  // The timeline audio stem (soundtrack beds) is signed off in context here — accepting it
  // materializes `timeline#stem` and cascades its bed sources (including a reference BGM), so the
  // beds gain a baseline. Per-shot audio is handled via each shot's stem accept above. "none"
  // un-accepts. Runs independent of the render plan.
  if (timelineStemDecision && (video.timelineSoundtracks?.length ?? 0) > 0) {
    const timelineStemAddress = formatTimelineStemAddress(stage);
    await StateManager.withLock(videoRoot, async (mgr) => {
      try {
        if (timelineStemDecision === "accepted") {
          // Honor the bed take the reviewer selected: accept each soundtrack source's displayed
          // variant before materializing, so the stem fingerprints the chosen take.
          const sources = await acceptDisplayedStemSources(
            mgr,
            jobManager,
            (video.timelineSoundtracks ?? [])
              .map((st) => parsePlaceholder(st.src.src))
              .filter((p): p is string => p !== null),
            displayed,
            candidates,
            { video, animatic },
          );
          acceptedAssets.push(...sources);
          cascadeAccepted.push(
            ...sources.map((address) => ({ address, via: timelineStemAddress })),
          );
          const variantId = await materializeTimelineStem({
            manager: mgr,
            video,
          });
          if (variantId) {
            const previous = mgr.getAcceptedVariant(timelineStemAddress);
            mgr.setAccepted(timelineStemAddress, variantId);
            if (previous !== variantId) {
              acceptedAssets.push(timelineStemAddress);
              const cascaded = await cascadeAcceptConsumedDeps(
                mgr,
                jobManager,
                timelineStemAddress,
                variantId,
                { video, animatic },
              );
              acceptedAssets.push(...cascaded);
              cascadeAccepted.push(
                ...cascaded.map((address) => ({ address, via: timelineStemAddress })),
              );
            }
          }
        } else {
          const acceptedId = mgr.getAcceptedVariant(timelineStemAddress);
          if (acceptedId) {
            mgr.setUnaccepted(timelineStemAddress, acceptedId);
            unacceptedAssets.push(timelineStemAddress);
          }
        }
      } catch {
        // skip timeline-stem failure
      }
    });
  }

  // The beds' post-condition, the same read-back as the shots': the block above swallows its own
  // failure, so neither verdict may be written down without confirming it in state.
  const timelineVerdict = timelineStemVerdict(
    timelineStemDecision ? await StateManager.load(videoRoot) : manager,
    video,
    timelineStemDecision,
  );
  if (timelineVerdict.skipped) skippedDecisions.push(timelineVerdict.skipped);

  // After every accept above, so each take is kept against the upstream this review settled.
  const kept: string[] = [];
  const regenerate: string[] = [];
  if ((payload.data.keep ?? []).length > 0 || (payload.data.regenerate ?? []).length > 0) {
    await StateManager.withLock(videoRoot, async (mgr) => {
      kept.push(...applyKeepDecisions(mgr, payload.data.keep ?? [], payload.data.regenerate));
      regenerate.push(...applyRegenerateDecisions(mgr, payload.data.regenerate));
    });
  }
  if (kept.length > 0) record.kept = kept;
  if (regenerate.length > 0) record.regenerate = regenerate;

  // The record's decisions are rebuilt from what was APPLIED, never from what was submitted. A
  // decision naming a shot this plan does not have (renamed or deleted mid-review), one dropped
  // because its animatic disappeared, a pendingShot's no-op, and anything the post-condition above
  // caught are all absent from these two sets — so none of them can be written down as an outcome.
  record.decisions = {
    ...Object.fromEntries([...okShotIds].map((shotId) => [shotId, "accepted" as const])),
    ...Object.fromEntries([...unacceptShotIds].map((shotId) => [shotId, "none" as const])),
  };
  if (timelineVerdict.landed) record.timelineStemDecision = timelineVerdict.landed;
  else delete record.timelineStemDecision;
  if (skippedDecisions.length > 0) record.skippedDecisions = skippedDecisions;

  if ((body.addedFeedback?.length ?? 0) > 0 || (body.feedbackPatches?.length ?? 0) > 0) {
    let mutation: FeedbackMutationResult = { added: [] };
    // Stamp each shot-note with its shot-local offset from the timeline the reviewer saw, so the
    // stored comment carries the within-shot position, not just the timeline-global `time`.
    const added = withCommentSubjects(
      withShotLocalTime(body.addedFeedback ?? [], plan.shots),
      subjectOf,
      video,
      displayed,
      body.displayedDefinitionHashes ?? {},
    );
    await FeedbackManager.withLock(videoRoot, stage, async (mgr) => {
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

  if (cascadeAccepted.length > 0) record.cascadeAccepted = cascadeAccepted;

  // The materialized-leaf content baseline (each composition / stem) — the state this review
  // concluded in, so `review handoff new` can diff a later edit against it. Computed here, after
  // the accepts, and from freshly loaded state: `handoff` resolves inputs the same default way, so
  // a take accepted in *this* review must fold into the baseline, else the next handoff would read
  // it as a post-review change. (The `manager` above predates the accepts and would do exactly
  // that.)
  {
    const postAccept = await StateManager.load(videoRoot);
    const contentHashes: Record<string, string> = {};
    for (const addr of [...listCompositionAddresses(video), ...listStemAddresses(video)]) {
      const hash = materializedLeafContentHash(postAccept, video, addr);
      if (hash != null) contentHashes[addr] = hash;
    }
    if (Object.keys(contentHashes).length > 0) record.context.contentHashes = contentHashes;
  }

  // Accept-only reviews carry no feedback, but the accept is a real review outcome —
  // persist the record so `review record show` reflects it.
  filePath = await saveReviewRecord(videoRoot, record, {
    // A review that only skipped is still a review worth keeping — it is the record of accepts the
    // reviewer made and did not get. Without this, a submit whose every accept failed writes no
    // file at all and `skippedDecisions` is reported to a terminal and then lost.
    force: acceptedAssets.length > 0 || unacceptedAssets.length > 0 || skippedDecisions.length > 0,
  });

  reportOutcome?.({ stage, filePath, ...(regenerate.length > 0 ? { regenerate } : {}) });

  return jsonResponse({
    saved: filePath !== null,
    filePath,
    acceptedAssets,
    unacceptedAssets,
    skippedDecisions,
    kept,
    regenerate,
  });
}
