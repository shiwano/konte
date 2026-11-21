import { cascadeDirectionReferenceAccepts } from "../../../core/accept-cascade.js";
import { variantDefinitionSnapshot } from "../../../core/definition-snapshot.js";
import type { LevelKind } from "../../../core/audio-level.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { buildKeepGraph } from "./keep-graph.js";
import { referenceGroups } from "./reference-groups.js";
import {
  DIRECTION_NARRATOR_ADDRESS,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionPropAddress,
  formatReferenceAddress,
} from "../../../core/address.js";
import {
  listExposedReferenceAddresses,
  listReviewableAddresses,
} from "../../../core/definition-addresses.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { errorResponse, jsonResponse } from "../../page-host/http.js";
import {
  directionAcceptanceView,
  directionCascadeReferenceIds,
} from "../../../core/direction-acceptance.js";
import { type Direction } from "../../../core/dsl/direction.js";
import { placeDirectionLyrics } from "../../../core/dsl/direction-timeline.js";
import { lyricLines } from "../../../core/direction-structure.js";
import { songLinesRefusal } from "../../../core/direction.js";
import { KonteError } from "../../../core/errors.js";
import { songAnalysisOf } from "../../../core/song-reading.js";
import { setSongLines, songAddressOf } from "../../../core/song-variant.js";
import type {
  DirectionRosterEntryInfo,
  DirectionRosterKind,
  ReferencePreviewState,
  SongReadingInfo,
} from "../../../core/types/review-state.js";
import type {
  DirectionAcceptance,
  Handoff,
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import type { ReviewRecord } from "../../../core/review-record.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { displayedReferenceVariant } from "../../../core/review-acceptability.js";
import { StateManager } from "../../../core/state/index.js";
import type { VariantState } from "../../../core/types/index.js";
import { inferMediaType, variantMediaKind } from "../../../core/media-type.js";
import {
  consumedVariantPreviewUrl,
  patchChainVariants,
  variantFileUrl,
  variantPreviewUrl,
  variantMediaUrl,
  buildVariantCandidates,
} from "./variant-view.js";
import { buildAddressFeedback } from "./feedback-apply.js";
import {
  addressReviewTouchesNothing,
  applyAddressReview,
  handoffRecordFields,
  persistReview,
} from "./review-shared.js";
import type {
  AddressReviewSubmitBody,
  AddressReviewSubmitResponse,
  SongLineBody,
} from "../../../core/types/review-submit.js";
import { reviewModeOf } from "../../../core/review-mode.js";
import { emptyOutcome } from "./review-outcome.js";
import type { ReviewContext } from "./submit.js";
import { loadCheckContext } from "../../../core/check-context.js";
import { collectFindings } from "../../../core/checks.js";
import { createAssetInfoBuilder } from "./asset-info.js";

// Handoff note (AI -> reviewer) attached to a reference address (`reference:<name>`).
function handoffNoteForReference(handoff: Handoff | null, assetName: string): string | undefined {
  const path = `reference:${assetName}`;
  return (handoff?.notes ?? []).find((n) => n.address === path)?.text;
}

// The flat reference pool as review cards: each named asset with its variant gallery,
// feedback, accept state, and staleness. Reference has no shots/compositions, so this is a flat
// list — no shot timeline, no composition targets. Mirrors handleGetAnimaticState's per-asset
// shape, reusing buildVariantCandidates/buildAddressFeedback.
function voiceLevelKind(entries: DirectionRosterEntryInfo[] | undefined): LevelKind | undefined {
  if (entries?.some((e) => e.kind === "character-voice")) return "voice";
  if (entries?.some((e) => e.kind === "narrator-voice")) return "narration";
  return undefined;
}

// The roster entry each reference asset id anchors, keyed by id. A `characters`/`props`/`locations`
// entry is prose about the very image the card shows, so the card prints it — that is what makes
// accepting the image a real read of `direction:<roster>.<id>`, and what the roster cascade on
// submit stands on. The three rosters share the id namespace, so an id resolves to one entry.
function referenceRosterEntries(
  direction: Direction | null,
  acceptance: DirectionAcceptance | null,
): Map<string, DirectionRosterEntryInfo[]> {
  const out = new Map<string, DirectionRosterEntryInfo[]>();
  if (!direction) return out;
  const parts = directionAcceptanceView(direction, acceptance).parts;
  const add = (
    id: string,
    kind: DirectionRosterKind,
    name: string,
    description: string,
    address: string,
  ) => {
    const entry = { kind, name, description, needsReview: parts.get(address) !== "accepted" };
    const existing = out.get(id);
    if (existing) existing.push(entry);
    else out.set(id, [entry]);
  };
  for (const [id, c] of Object.entries(direction.characters ?? {})) {
    add(id, "character", c.name, c.description, formatDirectionCharacterAddress(id));
    // A cast voice anchors its own part, so the sample's card carries the voice brief — not the
    // character's visual one, which describes an image this asset is not.
    if (c.voice) {
      add(
        c.voice.id,
        "character-voice",
        c.name,
        c.voice.description,
        formatDirectionCharacterVoiceAddress(id),
      );
    }
  }
  if (direction.narrator) {
    add(
      direction.narrator.id,
      "narrator-voice",
      "the narrator",
      direction.narrator.description,
      DIRECTION_NARRATOR_ADDRESS,
    );
  }
  for (const [id, p] of Object.entries(direction.props ?? {})) {
    add(id, "prop", p.name, p.description, formatDirectionPropAddress(id));
  }
  for (const [id, l] of Object.entries(direction.locations ?? {})) {
    add(id, "location", l.name, l.description, formatDirectionLocationAddress(id));
  }
  return out;
}

export async function handleGetReferenceState(
  ctx: ReviewContext,
  reference: ReferenceDefinition,
  assetBaseUrl: string,
): Promise<Response> {
  // The stages downstream of the pool are for the Keep-or-regenerate prompt. Either may be absent.
  const { videoRoot, handoff, direction, animatic, video } = ctx;
  const manager = await StateManager.load(videoRoot);
  const feedbackMgr = await FeedbackManager.load(videoRoot, "reference");
  const patchCatalog = await loadPatchCatalog(videoRoot, manager.getState());
  const view = manager.stalenessView({ patchHashes: patchHashesOf(patchCatalog) });
  const rosterEntries = referenceRosterEntries(direction, manager.getDirectionAcceptance());
  const assetInfo = createAssetInfoBuilder(
    [reference, ...patchCatalog.patches.values()].flatMap((d) => d.prompts ?? []),
    (addr, vid) => variantDefinitionSnapshot(manager, videoRoot, addr, vid),
    (addr, vid, ref) => consumedVariantPreviewUrl(manager, videoRoot, addr, vid, ref, assetBaseUrl),
    (addr, vid) => patchChainVariants(manager, addr, vid),
  );

  // Exposed assets only: an unreturned one is an intermediate another reference asset consumes, and
  // it is read through that asset — there is nothing to decide about it here.
  const exposed = listExposedReferenceAddresses(reference);
  const assets = exposed.map((address) => {
    const assetName = address.slice("reference:".length);
    const addr = formatReferenceAddress(assetName);
    const acceptedId = manager.getAcceptedVariant(addr);

    const displayed = displayedReferenceVariant(manager, addr);
    const variantId: string | null = displayed?.variantId ?? null;
    const variantStatus: "none" | "accepted" = displayed?.isAccepted ? "accepted" : "none";
    const mediaKind = variantMediaKind(manager, addr, variantId);

    const previewUrl = (vid: string, v: VariantState): string | null =>
      variantPreviewUrl(videoRoot, addr, vid, v, assetBaseUrl);
    const playableUrl = (vid: string, v: VariantState): string | null => {
      if (!v.file) return null;
      return inferMediaType(v.file) === "image"
        ? variantFileUrl(addr, vid, v.file, assetBaseUrl)
        : (variantMediaUrl(manager, addr, vid, assetBaseUrl) ?? null);
    };

    const variants = buildVariantCandidates(
      manager,
      addr,
      acceptedId,
      previewUrl,
      playableUrl,
      (vid) => assetInfo(addr, vid),
      (vid) => songReading(manager, direction, addr, vid),
      voiceLevelKind(rosterEntries.get(assetName)),
      view,
    );
    const chosen = variantId ? manager.tryGetAssetState(addr)?.variants?.[variantId] : undefined;

    return {
      assetName,
      address: addr,
      variantId,
      variantStatus,
      mediaKind,
      imageUrl: variantId && chosen ? previewUrl(variantId, chosen) : null,
      fileUrl: variantId && chosen ? (playableUrl(variantId, chosen) ?? undefined) : undefined,
      variants,
      feedback: buildAddressFeedback(feedbackMgr, manager.getState(), addr, {
        view: manager.stalenessView(),
      }),
      handoffNote: handoffNoteForReference(handoff, assetName),
      ...(rosterEntries.has(assetName) ? { directionRoster: rosterEntries.get(assetName) } : {}),
    };
  });

  return jsonResponse({
    mode: "reference-preview",
    assets,
    groups: referenceGroups(
      direction,
      exposed.map((address) => address.slice("reference:".length)),
    ),
    size: { width: 1920, height: 1080 },
    keep: referenceKeepGraph(manager, reference, animatic, video),
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
  } satisfies ReferencePreviewState);
}

// Best-effort: a downstream stage that will not build leaves the prompt nothing to ask about it.
function referenceKeepGraph(
  manager: StateManager,
  reference: ReferenceDefinition,
  animatic: AnimaticDefinition | null,
  video: VideoDefinition | null,
): ReturnType<typeof buildKeepGraph> {
  const hasVideo = video !== null && (video as { stage?: string }).stage === "video";
  try {
    const board = animatic ?? null;
    const graph = hasVideo
      ? buildDependencyGraph(video, board, reference)
      : board
        ? buildDependencyGraph(board, board, reference)
        : null;
    if (!graph) return { addresses: {}, units: {} };
    return buildKeepGraph({
      manager,
      graph,
      stages: [
        { stage: "reference", definition: reference },
        { stage: "animatic", definition: board },
        { stage: "video", definition: hasVideo ? video : null },
      ],
    });
  } catch {
    return { addresses: {}, units: {} };
  }
}

// Reference review submit: accept/un-accept per address and apply feedback, with no
// shots/compositions. The review record nests under `review/reference/records/` (project root).
export async function handleReferenceSubmit(
  ctx: ReviewContext,
  reference: ReferenceDefinition,
  body: AddressReviewSubmitBody,
): Promise<Response> {
  const { videoRoot, handoff, direction, animatic, reportOutcome } = ctx;
  // Stamped before anything is written, so every comment this review carries predates the
  // accepts it was submitted with (see applyFeedbackMutations). The record carries it too: a
  // comment's own review is the one submitted at its createdAt.
  const reviewedAt = new Date().toISOString();
  const exposed = new Set(listExposedReferenceAddresses(reference));
  const unknownTargets = body.addedFeedback
    .map((fb) => fb.address)
    .filter((address) => !exposed.has(address));
  if (unknownTargets.length > 0) {
    return errorResponse(
      `This stage holds no target for ${unknownTargets.join(", ")} — no part of this review was applied.`,
      "INVALID_ADDRESS",
      400,
    );
  }
  if (addressReviewTouchesNothing(body)) {
    reportOutcome?.(emptyOutcome("reference"));
    return jsonResponse({ saved: false, filePath: null } satisfies AddressReviewSubmitResponse);
  }

  const outcome = await applyAddressReview(videoRoot, "reference", body, reviewedAt, {
    animatic,
    findings: async (mgr) =>
      collectFindings(
        await loadCheckContext({
          cueTakes: "played",
          videoRoot,
          definitions: { reference, animatic, video: null },
          direction,
          manager: mgr,
        }),
        (t) => t.holds.accept === true,
      ),
    placeSongLines: (mgr) => placeSongLines(mgr, direction, body.songLines ?? []),
    refuseAccept: (address, variantId, mgr) =>
      songLinesRefusal(mgr.videoRoot, direction, mgr.getState(), address, variantId),
    // No board movement baseline is stamped here: this review shows the media, never the panel
    // prose it may back.
    // Carry each accepted reference image back into the direction: the roster entry it anchors was
    // re-read on this page, beside the picture. Keyed on the DECISION, not on the variant
    // changing — a roster description reworded mid-review leaves the image untouched, and
    // re-confirming that same image is how the human signs off the rewording.
    cascadeDirection: (mgr, appliedAccepts, held) =>
      [...directionCascadeReferenceIds(appliedAccepts)].flatMap((id) => {
        const via = formatReferenceAddress(id);
        return cascadeDirectionReferenceAccepts(mgr, direction, new Set([id]), held).map(
          (address) => ({
            address,
            via,
          }),
        );
      }),
  });

  const manager = await StateManager.load(videoRoot);
  const timeline: Record<string, string> = {};
  for (const address of listReviewableAddresses(reference, "reference")) {
    const assetName = address.slice("reference:".length);
    const addr = formatReferenceAddress(assetName);
    const resolved = manager.selectVariant(addr, { includeStale: true });
    if (resolved) timeline[assetName] = resolved.variantId;
  }

  const record: ReviewRecord = {
    mode: reviewModeOf("reference"),
    stage: "reference",
    createdAt: reviewedAt,
    context: { shots: [], timeline },
    decisions: outcome.decisions,
    ...(outcome.songLines.length > 0 ? { songLines: outcome.songLines } : {}),
    ...(outcome.cascadeAccepted.length > 0 ? { cascadeAccepted: outcome.cascadeAccepted } : {}),
    ...(outcome.overturned.length > 0 ? { overturned: outcome.overturned } : {}),
    ...(outcome.kept.length > 0 ? { kept: outcome.kept } : {}),
    ...(outcome.regenerate.length > 0 ? { regenerate: outcome.regenerate } : {}),
    ...(outcome.skippedDecisions.length > 0 ? { skippedDecisions: outcome.skippedDecisions } : {}),
    ...(body.overallComment ? { overallComment: body.overallComment } : {}),
    ...handoffRecordFields(handoff),
  };

  const filePath = await persistReview(ctx, record, outcome.skippedDecisions.length > 0);

  return jsonResponse({
    saved: filePath !== null,
    filePath,
    acceptedAssets: outcome.acceptedAssets,
    skippedDecisions: outcome.skippedDecisions,
    kept: outcome.kept,
    regenerate: outcome.regenerate,
  } satisfies AddressReviewSubmitResponse);
}

// The beats and lyric places a take of the song was read as, on the take's own clock — what its
// review lays over playback. Absent on any other asset, and on a take not read yet.
function songReading(
  manager: StateManager,
  direction: Direction | null,
  address: string,
  variantId: string,
): SongReadingInfo | undefined {
  if (!direction || songAddressOf(direction) !== address) return undefined;
  const variant = manager.getState().assets[address]?.variants?.[variantId];
  const analysis = songAnalysisOf(manager.videoRoot, address, variantId, variant?.song);
  if (!variant || !analysis) return undefined;
  return {
    variantId,
    durationSec: variant.media && variant.media.kind !== "image" ? variant.media.durationSec : null,
    beats: analysis.beats,
    firstBeat: analysis.firstBeat,
    beatsPerBar: analysis.beatsPerBar,
    firstBeatSet: analysis.firstBeatSet ?? null,
    phrases: analysis.phrases,
    lines: placeDirectionLyrics(direction, { address, variantId, analysis }).map((line) => ({
      key: line.key,
      text: line.text,
      singer: [...line.singer],
      startSec: line.start,
      endSec: line.end,
      set: line.set,
    })),
  };
}

// The lyric lines the reviewer placed on takes of the song, each take's together, as `konte song
// set --line` writes them; a take whose lines cannot all be placed is reported, and none written.
function placeSongLines(
  mgr: StateManager,
  direction: Direction | null,
  songLines: readonly SongLineBody[],
): {
  placed: NonNullable<ReviewRecord["songLines"]>;
  skipped: Array<{ address: string; reason: string }>;
} {
  if (songLines.length === 0) return { placed: [], skipped: [] };
  const songAddress = songAddressOf(direction);
  if (!direction || !songAddress) {
    return {
      placed: [],
      skipped: [
        { address: "direction", reason: "direction.ts declares no song to place lines on" },
      ],
    };
  }
  const lines = lyricLines(direction);
  const placed: NonNullable<ReviewRecord["songLines"]> = [];
  const skipped: Array<{ address: string; reason: string }> = [];
  const byVariant = Map.groupBy(songLines, (edit) => edit.variantId);
  for (const [variantId, edits] of byVariant) {
    const variant = mgr.tryGetAssetState(songAddress)?.variants?.[variantId];
    try {
      if (!variant?.song || !songAnalysisOf(mgr.videoRoot, songAddress, variantId, variant.song)) {
        throw new KonteError("VALIDATION_FAILED", `${variantId} has not been read as the song yet`);
      }
      const durationSec =
        variant.media && variant.media.kind !== "image" ? variant.media.durationSec : Infinity;
      variant.song = setSongLines(variant.song, lines, edits, durationSec);
      placed.push(
        ...edits.map(({ key, span }) => ({ address: songAddress, variantId, key, span })),
      );
    } catch (err) {
      skipped.push({
        address: songAddress,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { placed, skipped };
}
