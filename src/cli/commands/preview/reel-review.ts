import { remakeSettledLeaves } from "../../../core/board-leaves.js";
import { overlayLineTimer } from "../../../core/line-timing.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { shotById } from "../../../core/shot-index.js";
import {
  formatAddress,
  formatCompositionAddress,
  formatShotAddress,
  formatTimelineStemAddress,
  isStemAddress,
  formatTimelineOverlayAddress,
  parseAddress,
  assetNameOf,
  shownShotAssetNames,
  formatThumbnailAddress,
  thumbnailCoverAddress,
  THUMBNAIL_TARGET,
} from "../../../core/address.js";
import {
  buildFullCompositionHtml,
  buildShotClips,
  type CompositionClip,
} from "../../../core/composition-builder.js";
import { resolveCompositionRef } from "../../../core/composition-refs.js";
import {
  leafSettledAcross,
  compositionDefinitionHashForAddress,
  definitionHashForAddress,
  timelineStemRefs,
  materializedLeafReviewStatus,
  overlayAwaitsAccept,
  overlayTimelineRefs,
} from "../../../core/composition-resource.js";
import { variantMediaKind } from "../../../core/media-type.js";
import {
  applyVideoPreroll,
  ensurePrerollClips,
  injectPrerollWarmup,
  planVideoPreroll,
} from "../../../core/preview-preroll.js";
import { shotAcceptTargets, shotNeedsVerdict } from "../../../core/shot-accept-targets.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { parsePlaceholder } from "../../../core/dsl/shot-context.js";
import { KonteError, errorMessage } from "../../../core/errors.js";
import { errorResponse, htmlResponse, jsonResponse } from "../../page-host/http.js";
import type { Direction } from "../../../core/dsl/direction.js";
import type {
  ClipInfo,
  ShotMoveInfo,
  ShotWaiverInfo,
  VideoPreviewState,
} from "../../../pages/preview/types.js";
import { buildReelReviewPlan, reelShotAcceptability } from "../../../core/review-acceptability.js";
import { continuousFrameKeys, directionShotWaivers, panelRole } from "../../../core/direction.js";
import { shotWaiversAwaitingAccept } from "../../../core/direction-acceptance.js";
import { waiverCoverageIn } from "../../../core/board-analysis.js";
import type {
  AnimaticDefinition,
  Handoff,
  ReferenceDefinition,
  StageDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import { type RenderPlan, buildStageReviewPlan, shotSpans } from "../../../core/render-plan.js";
import { resolveSoundtrackSpan } from "../../../core/timeline-audio.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import { type HeardTake, shotLineMarks } from "../../../core/line-marks.js";
import {
  consumedVariantPreviewUrl,
  patchChainVariants,
  variantDefinitionSnapshot,
  buildVariantCandidates,
  shotFactsIndex,
  displayedVariantStatus,
  hasUndecidedBesideAccepted,
  variantMediaUrl,
  variantPreviewUrl,
  buildAddressFeedback,
  handoffNotesForShot,
  unroutedReelHandoffNotes,
} from "./review-shared.js";
import { createAssetInfoBuilder } from "./asset-info.js";
import { buildKeepGraph } from "./keep-graph.js";

interface AudioTrackAsset {
  address: string;
  assetName: string;
  kind: "sound" | "soundtrack";
  variantId: string | null;
  variantStatus: "none" | "accepted";
  hasUndecidedBesideAccepted: boolean;
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
    hasUndecidedBesideAccepted: boolean;
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
      hasUndecidedBesideAccepted: base.hasUndecidedBesideAccepted,
      ...(base.fileUrl ? { fileUrl: base.fileUrl } : {}),
      variants: base.variants,
      cues: group.cues.sort((a, b) => a.start - b.start),
    });
  }
  out.sort((a, b) => (a.cues[0]?.start ?? 0) - (b.cues[0]?.start ?? 0));
  return out;
}

// The board's declared movement per shot: every panel that carries one, in panel order, the cutin's
// after the shot's own, with the role that says what the panel's picture is judged as. A frame's
// landing keyframe declares none.
function shotMoveIndex(
  animatic: AnimaticDefinition | null,
  direction: Direction | null,
): Map<string, ShotMoveInfo[]> {
  const continuous = continuousFrameKeys(direction);
  const byId = new Map<string, ShotMoveInfo[]>();
  for (const shot of animatic?.shots ?? []) {
    const lane = (panels: typeof shot.panels, cutin: boolean) =>
      (panels ?? []).map((p, i, all) => ({
        ...p,
        cutin,
        role: panelRole(
          i + 1,
          all.length,
          continuous.has(`${shot.id}/${cutin ? "cutin" : "main"}`),
        ),
      }));
    const moves = [...lane(shot.panels, false), ...lane(shot.cutin?.panels, true)]
      .filter((p) => p.blocking != null || p.camera != null)
      .map((p) => ({
        panel: p.assetName,
        cutin: p.cutin,
        role: p.role,
        blocking: p.blocking ?? "",
        camera: p.camera ?? "",
      }));
    if (moves.length > 0) byId.set(shot.id, moves);
  }
  return byId;
}

function shotWaiverIndex(
  manager: StateManager,
  ctx: ReelReviewContext,
  video: VideoDefinition | null,
): Map<string, ShotWaiverInfo[]> {
  const byId = new Map<string, ShotWaiverInfo[]>();
  const { direction } = ctx;
  if (!direction) return byId;
  const awaiting = new Set(
    shotWaiversAwaitingAccept(
      direction,
      manager.getDirectionAcceptance(),
      waiverCoverageIn(
        ctx.videoRoot,
        direction,
        { reference: ctx.reference, animatic: ctx.animatic, video },
        manager,
      ),
    ).map((w) => w.address),
  );
  for (const waiver of directionShotWaivers(direction)) {
    const info = {
      code: waiver.code,
      subject: waiver.subject,
      reason: waiver.reason,
      needsReview: awaiting.has(waiver.address),
    };
    for (const shotId of waiver.shotIds) byId.set(shotId, [...(byId.get(shotId) ?? []), info]);
  }
  return byId;
}

// What a reel review session holds besides the reel itself, shared by its state and submit handlers.
export interface ReelReviewContext {
  videoRoot: string;
  handoff: Handoff | null;
  direction: Direction | null;
  // The board. On the animatic stage it IS the reel; on the video stage it is the upstream, standing
  // in for a shot whose picture is not made yet.
  animatic: AnimaticDefinition | null;
  // The shared pool. A reel plays `reference:` addresses too (a bed, a sheet a panel stands on), and
  // this is the only definition that answers for their declaration.
  reference: ReferenceDefinition | null;
  // The video, when the reel is the board.
  downstreamVideo: StageDefinition | null;
}

// What every part of one reel state response reads, loaded once.
interface ReelStateScope {
  ctx: ReelReviewContext;
  video: StageDefinition;
  stage: StageDefinition["stage"];
  counterpart: StageDefinition | null;
  manager: StateManager;
  feedbackMgr: FeedbackManager;
}

type ReelAsset = ReturnType<ReturnType<typeof reelAssetBuilder>>;

export async function handleGetReelState(
  ctx: ReelReviewContext,
  video: StageDefinition,
  assetBaseUrl: string,
): Promise<Response> {
  const { videoRoot, animatic, handoff } = ctx;
  const stage = video.stage;
  const counterpart = stage === "video" ? animatic : ctx.downstreamVideo;
  await remixTakenOverBoardStems(videoRoot, video, animatic);
  const manager = await StateManager.load(videoRoot);
  const scope: ReelStateScope = {
    ctx,
    video,
    stage,
    counterpart,
    manager,
    feedbackMgr: await FeedbackManager.load(videoRoot, stage),
  };
  const patchCatalog = await loadPatchCatalog(videoRoot, manager.getState());

  const plan = buildReelReviewPlan(manager, video, animatic);

  // Per-shot composited clips (time ranges, layers, audio) for the UI's track view.
  // Rendering is best-effort: a failure must not blank the state response.
  let clipsByShot: Map<string, CompositionClip[]>;
  try {
    clipsByShot = buildShotClips(plan, assetBaseUrl);
  } catch {
    clipsByShot = new Map();
  }

  // On the animatic stage `video` IS the board, so its prompts are listed twice — harmless, as an
  // input is read once per address.
  const assetInfo = createAssetInfoBuilder(
    [video, animatic, ctx.reference, ...patchCatalog.patches.values()].flatMap(
      (d) => d?.prompts ?? [],
    ),
    (addr, vid) => variantDefinitionSnapshot(manager, videoRoot, addr, vid),
    (addr, vid, ref) => consumedVariantPreviewUrl(manager, videoRoot, addr, vid, ref, assetBaseUrl),
    (addr, vid) => patchChainVariants(manager, addr, vid),
  );
  const buildAsset = reelAssetBuilder(
    manager,
    videoRoot,
    assetBaseUrl,
    patchHashesOf(patchCatalog),
    assetInfo,
  );

  // Audio assets declared on a shot belong to the audio track, not the shot (video) accept —
  // collected here so buildAudioAssets can reuse the resolved-variant info without re-resolving.
  const audioBuiltByAddress = new Map<string, ReelAsset>();
  const shots = await withHeardTakes(
    scope,
    reelShotStates(scope, plan, clipsByShot, buildAsset, audioBuiltByAddress),
    clipsByShot,
  );
  const totalDuration = shotSpans(plan.shots, plan.fps).total;

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

  const timelineStem = timelineStemState(scope);
  const overlay = overlayState(scope);
  const thumbnail = thumbnailState(scope, buildAsset);

  return jsonResponse({
    mode: stage === "animatic" ? "animatic-preview" : "video-preview",
    fps: plan.fps,
    shots,
    totalDuration,
    size: plan.size,
    audioAssets,
    compositionRefVariants: compositionRefVariantsOf(manager, video, animatic),
    ...(timelineStem ? { timelineStem } : {}),
    ...(overlay ? { overlay } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    keep: reelKeepGraph(manager, video, animatic, ctx.reference, ctx.downstreamVideo),
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
    unroutedHandoffNotes: unroutedReelHandoffNotes(
      handoff,
      stage,
      shots.map((s) => s.shotId),
    ),
  } satisfies VideoPreviewState);
}

// Each shot with where the reel is heard to say its lines. Best-effort, like the clips: a hearing
// that will not read leaves a shot without marks.
async function withHeardTakes<S extends { shotId: string; startTime: number }>(
  scope: ReelStateScope,
  shots: S[],
  clipsByShot: Map<string, CompositionClip[]>,
): Promise<(S & { heardTakes: HeardTake[] })[]> {
  const { ctx, video, manager } = scope;
  const definitions = {
    reference: ctx.reference,
    animatic: ctx.animatic,
    video: (video.stage === "video" ? video : ctx.downstreamVideo) as VideoDefinition | null,
  };
  return Promise.all(
    shots.map(async (shot) => {
      const heardTakes = await shotLineMarks({
        videoRoot: ctx.videoRoot,
        manager,
        definitions,
        direction: ctx.direction,
        animatic: ctx.animatic,
        lang: video.typography.lang,
        shotId: shot.shotId,
        shotStart: shot.startTime,
        clips: clipsByShot.get(shot.shotId) ?? [],
      }).catch((err: unknown) => {
        console.error(
          `Could not place the lines heard in shot ${shot.shotId}: ${errorMessage(err)}`,
        );
        return [];
      });
      return { ...shot, heardTakes };
    }),
  );
}

// The board stems the video has taken over, re-mixed so a shot that plays one can be drawn.
async function remixTakenOverBoardStems(
  videoRoot: string,
  video: StageDefinition,
  animatic: AnimaticDefinition | null,
): Promise<void> {
  if (video.stage !== "video" || !animatic) return;
  const { failed } = await remakeSettledLeaves({
    videoRoot,
    stage: animatic,
    counterpart: video,
    include: "stems",
  });
  for (const { address, reason } of failed) {
    console.error(`Could not re-mix ${address}: ${reason}`);
  }
}

function reelAssetBuilder(
  manager: StateManager,
  videoRoot: string,
  assetBaseUrl: string,
  patchHashes: ReturnType<typeof patchHashesOf>,
  assetInfo: ReturnType<typeof createAssetInfoBuilder>,
) {
  return (assetName: string, addr: string, resolvedVariantId: string | undefined) => {
    const acceptedId = manager.getAcceptedVariant(addr);
    // The take the plan resolved is the one the reel plays, so the card names it too.
    const variantId: string | null = resolvedVariantId ?? null;
    const variantStatus = displayedVariantStatus(manager, addr, variantId);
    // Routed to the stage that owns the address: a shot can play a shared `reference:` take, and
    // the reel's definition answers for none of those.
    const definitionHash = manager.registeredDefinitionHash(addr);
    return {
      assetName,
      address: addr,
      variantId,
      variantStatus,
      hasUndecidedBesideAccepted: hasUndecidedBesideAccepted(
        manager,
        addr,
        acceptedId,
        definitionHash,
        patchHashes,
      ),
      mediaKind: variantMediaKind(manager, addr, variantId),
      fileUrl: variantId ? variantMediaUrl(manager, addr, variantId, assetBaseUrl) : undefined,
      variants: buildVariantCandidates(
        manager,
        addr,
        acceptedId,
        definitionHash,
        (vid, v) => variantPreviewUrl(videoRoot, addr, vid, v, assetBaseUrl),
        (vid) => variantMediaUrl(manager, addr, vid, assetBaseUrl) ?? null,
        patchHashes,
        (vid) => assetInfo(addr, vid),
      ),
    };
  };
}

function reelShotStates(
  scope: ReelStateScope,
  plan: RenderPlan,
  clipsByShot: Map<string, CompositionClip[]>,
  buildAsset: ReturnType<typeof reelAssetBuilder>,
  audioBuiltByAddress: Map<string, ReelAsset>,
) {
  const { ctx, video, stage, manager } = scope;
  const directionShotById = shotFactsIndex(ctx.direction);
  const movesByShotId = shotMoveIndex(ctx.animatic, ctx.direction);
  const waiversByShotId = shotWaiverIndex(
    manager,
    ctx,
    (video.stage === "video" ? video : ctx.downstreamVideo) as VideoDefinition | null,
  );
  const acceptability = reelShotAcceptability(manager, video, plan);

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

  // Isolate per shot: one shot's resolution failing (e.g. a composition hash that
  // evaluates a shotFn referencing an ungenerated upstream) must not blank the whole
  // timeline. The shot still appears, just without its assets/feedback overlay.
  const timing = shotSpans(plan.shots, plan.fps);
  return plan.shots.map((s, shotIdx) => {
    const { start: startTime, duration } = timing.spans[shotIdx]!;
    const shot = shotById(video.shots, s.shotId);
    const { hasComposition, pending, aside, showingStandIn, notReady } = acceptability[shotIdx]!;
    const facts = directionShotById.get(s.shotId);
    const waivers = waiversByShotId.get(s.shotId) ?? [];
    const common = {
      shotId: s.shotId,
      startTime,
      duration,
      action: shot?.action ?? "",
      script: facts?.script ?? [],
      join: facts?.join ?? null,
      coverage: facts?.coverage ?? false,
      moves: movesByShotId.get(s.shotId) ?? [],
      waivers,
      clips: clipsFor(s.shotId),
      hasComposition,
      pending,
      aside,
      showingStandIn,
      notReady,
      handoffNotes: handoffNotesForShot(ctx.handoff, stage, s.shotId),
    };
    try {
      return {
        ...common,
        ...reelShotVerdictState(scope, s, shot, hasComposition, waivers, buildAsset, (addr, a) =>
          audioBuiltByAddress.set(addr, a),
        ),
      };
    } catch {
      return {
        ...common,
        assets: [] as ReelAsset[],
        feedback: [] as ReturnType<typeof buildAddressFeedback>,
        allAccepted: false,
        // Fails closed: this shot's plan or hashes would not compute, so nothing here says it is
        // settled — and a checked toggle on a shot Accept all then skips is the exact shape that
        // let a verdict go unasked.
        needsVerdict: true,
        verdictAddresses: [],
        compositionAddress: null,
        compositionVariantId: null,
        compositionDefinitionHash: null,
        compositionNeedsReview: false,
        stems: [],
      };
    }
  });
}

// One shot's assets, leaves and feedback, and what its verdict is still owed. Throws when the shot's
// plan or hashes will not compute.
function reelShotVerdictState(
  scope: ReelStateScope,
  s: RenderPlan["shots"][number],
  shot: StageDefinition["shots"][number] | undefined,
  hasComposition: boolean,
  waivers: readonly ShotWaiverInfo[],
  buildAsset: ReturnType<typeof reelAssetBuilder>,
  onAudioAsset: (address: string, asset: ReelAsset) => void,
) {
  const { video, stage, counterpart, manager } = scope;
  // Only the shot's video/image assets stay on the shot; audio splits off to its track,
  // so the shot (video) accept is fully independent of the per-asset audio accept.
  const assets: ReelAsset[] = [];
  const audioAddresses = new Set<string>();
  if (shot) {
    for (const assetName of shownShotAssetNames(stage, video.shots, shot)) {
      const addr = formatAddress(stage, s.shotId, assetName);
      const built = buildAsset(assetName, addr, s.resolvedVariants[assetName]);
      if (built.mediaKind === "audio") {
        audioAddresses.add(addr);
        onAudioAsset(addr, built);
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
  const feedbackAddress = formatShotAddress(stage, s.shotId);

  const compositionAddress = hasComposition ? formatCompositionAddress(stage, s.shotId) : null;
  const compositionDefinitionHash = compositionAddress
    ? compositionDefinitionHashForAddress(video, compositionAddress)
    : null;
  let compositionVariantId: string | null = null;
  let compositionNeedsReview = false;
  const compositionSuperseded =
    compositionAddress !== null &&
    leafSettledAcross(manager, video, counterpart, compositionAddress);
  if (compositionAddress) {
    // Unaccepted or stale both count as needing review (see materializedLeafReviewStatus).
    ({ variantId: compositionVariantId, needsReview: compositionNeedsReview } =
      materializedLeafReviewStatus(manager, compositionAddress, compositionDefinitionHash));
    if (compositionSuperseded) compositionNeedsReview = false;
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
      const status = materializedLeafReviewStatus(manager, address, definitionHash);
      return {
        address,
        definitionHash,
        ...status,
        needsReview: status.needsReview && !leafSettledAcross(manager, video, counterpart, address),
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
  const feedback = buildAddressFeedback(scope.feedbackMgr, manager.getState(), feedbackAddress, {
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
  // A waiver the accept would sign off holds the verdict open too.
  const needsVerdict =
    shotNeedsVerdict(manager, video, s, counterpart) || waivers.some((w) => w.needsReview);

  return {
    assets,
    feedback,
    allAccepted,
    needsVerdict,
    verdictAddresses,
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
  };
}

function leafFeedback(scope: ReelStateScope, address: string, definitionHash: string | null) {
  return buildAddressFeedback(scope.feedbackMgr, scope.manager.getState(), address, {
    cache: scope.manager.stalenessCache(),
    definitionHashes: definitionHash ? new Map([[address, definitionHash]]) : new Map(),
  });
}

// The timeline audio stem (soundtrack beds) status — the single in-context accept for the beds.
function timelineStemState(scope: ReelStateScope) {
  const { video, manager } = scope;
  if ((video.timelineSoundtracks?.length ?? 0) === 0) return null;
  const address = formatTimelineStemAddress(scope.stage);
  const definitionHash = definitionHashForAddress(video, address);
  // Unaccepted beds need review too (not just a stale accepted one).
  return {
    address,
    definitionHash,
    ...materializedLeafReviewStatus(manager, address, definitionHash),
    verdictAddresses: timelineStemRefs(video),
    feedback: leafFeedback(scope, address, definitionHash),
  };
}

// The overlay is signed off by the shot accepts under it; the page offers it on its own only once
// they all stand and it still needs review — an overlay changed after them.
function overlayState(scope: ReelStateScope) {
  const { video, manager } = scope;
  if (!video.overlay) return null;
  const address = formatTimelineOverlayAddress(scope.stage);
  const definitionHash = definitionHashForAddress(video, address);
  return {
    address,
    duration: video.overlay.duration,
    definitionHash,
    ...materializedLeafReviewStatus(manager, address, definitionHash),
    offered: overlayAwaitsAccept(manager, video, scope.counterpart),
    verdictAddresses: overlayTimelineRefs(video),
    feedback: leafFeedback(scope, address, definitionHash),
  };
}

// The video's thumbnail, once its cover has a current take: the cover — its still, else its frame —
// signed off by its own accept, where its frame is cut, and the takes of the assets it declared. A
// stale cover is one `generate` makes again.
function thumbnailState(scope: ReelStateScope, buildAsset: ReturnType<typeof reelAssetBuilder>) {
  const { video, manager } = scope;
  const thumbnail = (video as Partial<VideoDefinition>).thumbnail;
  if (!thumbnail) return null;
  const address = thumbnailCoverAddress(thumbnail);
  const shown = manager.resolveReference(address, { includeStale: false })?.variantId;
  if (!shown) return null;
  const cover = buildAsset(parseAddress(address).assetName, address, shown);
  const fingerprints =
    manager.tryGetAssetState(address)?.variants?.[shown]?.inputFingerprints ?? {};
  const sources: Record<string, string> = {};
  const assets = Object.keys(thumbnail.assets).map((name) => {
    const assetAddress = formatThumbnailAddress(name);
    const variants = Object.entries(manager.tryGetAssetState(assetAddress)?.variants ?? {});
    const made = variants.find(([, v]) => v.outputHash === fingerprints[assetAddress])?.[0];
    if (made) sources[assetAddress] = made;
    const resolved = manager.resolveReference(assetAddress, { includeStale: true })?.variantId;
    return buildAsset(name, assetAddress, made ?? resolved);
  });
  const { frame } = thumbnail;
  return {
    target: THUMBNAIL_TARGET,
    cover,
    frame: frame ? { at: frame.at, shotId: frame.shotId, shotTime: frame.shotTime } : null,
    imageUrl: cover.variants.find((v) => v.variantId === shown)?.imageUrl ?? null,
    sources,
    needsReview:
      cover.variantStatus !== "accepted" ||
      [cover, ...assets].some((a) => a.hasUndecidedBesideAccepted),
    assets,
    feedback: buildAddressFeedback(scope.feedbackMgr, manager.getState(), THUMBNAIL_TARGET, {
      cache: manager.stalenessCache(),
    }),
  };
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
    timeLines: overlayLineTimer(manager),
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
    timeLines: overlayLineTimer(manager),
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
    for (const ref of def.overlay?.compositionRefs ?? []) resolve(ref);
  }
  return out;
}
