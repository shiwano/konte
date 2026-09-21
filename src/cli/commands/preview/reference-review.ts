import { cascadeDirectionReferenceAccepts } from "../../../core/accept-cascade.js";
import { buildDependencyGraph } from "../../../core/graph.js";
import { buildKeepGraph } from "./keep-graph.js";
import {
  DIRECTION_NARRATOR_ADDRESS,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionPropAddress,
  formatReferenceAddress,
  listExposedReferenceAssetPaths,
  listReviewableAssetPaths,
} from "../../../core/address.js";
import { definitionHashForAddress } from "../../../core/composition-resource.js";
import { loadPatchCatalog, patchHashesOf } from "../../../core/patch.js";
import { errorResponse, jsonResponse } from "../../page-host/http.js";
import {
  directionAcceptanceView,
  directionCascadeReferenceIds,
} from "../../../core/direction-acceptance.js";
import type { Direction } from "../../../core/dsl/direction.js";
import type { DirectionRosterKind } from "../../../pages/preview/types.js";
import type {
  DirectionAcceptance,
  Handoff,
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "../../../core/types/index.js";
import { type ReviewRecord, saveReviewRecord } from "../../../core/review-record.js";
import { FeedbackManager } from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import type { VariantState } from "../../../core/types/index.js";
import { inferMediaType, variantMediaKind } from "../../../core/media-type.js";
import {
  consumedTakePreviewUrl,
  takeDefinitionSnapshot,
  variantFileUrl,
  variantPreviewUrl,
  variantMediaUrl,
  buildVariantCandidates,
  buildAddressFeedback,
  parseAddressReviewBody,
  addressReviewTouchesNothing,
  applyAddressReview,
  handoffRecordFields,
} from "./review-shared.js";
import { type ReportOutcome, emptyOutcome } from "./review-outcome.js";
import { createAssetInfoBuilder } from "./asset-info.js";

// Handoff note (AI -> reviewer) attached to a reference asset path (`reference:<name>`).
function handoffNoteForReference(handoff: Handoff | null, assetName: string): string | undefined {
  const path = `reference:${assetName}`;
  return (handoff?.notes ?? []).find((n) => n.address === path)?.text;
}

// The flat reference pool as review cards: each named asset with its variant gallery,
// feedback, accept state, and staleness. Reference has no shots/compositions, so this is a flat
// list — no shot timeline, no composition targets. Mirrors handleGetAnimaticState's per-asset
// shape, reusing buildVariantCandidates/buildAddressFeedback.
// The roster entry each reference asset id anchors, keyed by id. A `characters`/`props`/`locations`
// entry is prose about the very image the card shows, so the card prints it — that is what makes
// accepting the image a real read of `direction:<roster>.<id>`, and what the roster cascade on
// submit stands on. The three rosters share the id namespace, so an id resolves to one entry.
//
// `needsReview` is the part's own acceptance standing (stale or never signed off). The card needs it
// because the accept decision is otherwise keyed on the VARIANT: prose reworded against an unchanged,
// already-accepted image moves no variant, so without this the row would read "accepted", offer
// nothing to press, and the cascade would never fire — the exact loop this feature exists to close.
type ReferenceRosterEntry = {
  kind: DirectionRosterKind;
  name: string;
  description: string;
  needsReview: boolean;
};

function referenceRosterEntries(
  direction: Direction | null,
  acceptance: DirectionAcceptance | null,
): Map<string, ReferenceRosterEntry[]> {
  const out = new Map<string, ReferenceRosterEntry[]>();
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
  videoRoot: string,
  reference: ReferenceDefinition,
  assetBaseUrl: string,
  handoff: Handoff | null,
  direction: Direction | null,
  // The stages downstream of the pool, for the Keep-or-regenerate prompt. Either may be absent.
  animatic: AnimaticDefinition | null = null,
  video: VideoDefinition | null = null,
): Promise<Response> {
  const manager = await StateManager.load(videoRoot);
  const feedbackMgr = await FeedbackManager.load(videoRoot, "reference");
  const patchHashes = patchHashesOf(await loadPatchCatalog(videoRoot, manager.getState()));
  const rosterEntries = referenceRosterEntries(direction, manager.getDirectionAcceptance());
  const assetInfo = createAssetInfoBuilder(
    { reference },
    (addr, vid) => takeDefinitionSnapshot(manager, videoRoot, addr, vid),
    (addr, vid, ref) => consumedTakePreviewUrl(manager, videoRoot, addr, vid, ref, assetBaseUrl),
  );

  // Exposed assets only: an unreturned one is an intermediate another reference asset consumes, and
  // it is read through that asset — there is nothing to decide about it here.
  const assets = listExposedReferenceAssetPaths(reference).map((assetPath) => {
    const assetName = assetPath.slice("reference:".length);
    const addr = formatReferenceAddress(assetName);
    const acceptedId = manager.getAcceptedVariant(addr);

    // Displayed variant: accepted, else newest non-stale (stale only as a last resort so
    // the card is never empty) — the same take `konte ref` prints.
    const displayed = manager.selectVariant(addr, { includeStale: true });
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

    const defHash = definitionHashForAddress(reference, addr);
    const variants = buildVariantCandidates(
      manager,
      addr,
      acceptedId,
      defHash,
      previewUrl,
      playableUrl,
      patchHashes,
      (vid) => assetInfo(addr, vid),
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
        cache: manager.stalenessCache(),
      }),
      handoffNote: handoffNoteForReference(handoff, assetName),
      ...(rosterEntries.has(assetName) ? { directionRoster: rosterEntries.get(assetName) } : {}),
    };
  });

  return jsonResponse({
    mode: "reference-preview",
    assets,
    size: { width: 1920, height: 1080 },
    keep: referenceKeepGraph(manager, reference, animatic, video),
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
  });
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

// Reference review submit (`/api/reference/submit`). Flat analogue of
// handleAnimaticSubmit: accept/un-accept per address and apply feedback, but with no
// shots/compositions. The review record nests under `review/reference/records/` (project root).
export async function handleReferenceSubmit(
  videoRoot: string,
  handoff: Handoff | null,
  reference: ReferenceDefinition,
  direction: Direction | null,
  animatic: AnimaticDefinition | null,
  req: Request,
  reportOutcome?: ReportOutcome,
): Promise<Response> {
  // Stamped before anything is written, so every comment this review carries predates the
  // accepts it was submitted with (see applyFeedbackMutations).
  const reviewedAt = new Date().toISOString();
  const body = await parseAddressReviewBody(req);
  if (!body) return errorResponse("Invalid review payload", "INVALID_REQUEST", 400);
  if (addressReviewTouchesNothing(body)) {
    reportOutcome?.(emptyOutcome("reference"));
    return jsonResponse({ saved: false, filePath: null });
  }

  const outcome = await applyAddressReview(videoRoot, "reference", body, reviewedAt, {
    animatic,
    // No board movement baseline is stamped here: this review shows the media, never the panel
    // prose it may back.
    // Carry each accepted reference image back into the direction: the roster entry it anchors was
    // re-read on this page, beside the picture. Keyed on the DECISION, not on the variant
    // changing — a roster description reworded mid-review leaves the image untouched, and
    // re-confirming that same image is how the human signs off the rewording.
    cascadeDirection: (mgr, appliedAccepts) =>
      [...directionCascadeReferenceIds(appliedAccepts)].flatMap((id) => {
        const via = formatReferenceAddress(id);
        return cascadeDirectionReferenceAccepts(mgr, direction, new Set([id])).map((address) => ({
          address,
          via,
        }));
      }),
  });

  const manager = await StateManager.load(videoRoot);
  const timeline: Record<string, string> = {};
  for (const assetPath of listReviewableAssetPaths(reference, "reference")) {
    const assetName = assetPath.slice("reference:".length);
    const addr = formatReferenceAddress(assetName);
    const resolved = manager.selectVariant(addr, { includeStale: true });
    if (resolved) timeline[assetName] = resolved.variantId;
  }

  const record: ReviewRecord = {
    mode: "reference-preview",
    stage: "reference",
    createdAt: new Date().toISOString(),
    context: { shots: [], timeline },
    decisions: outcome.decisions,
    ...(outcome.cascadeAccepted.length > 0 ? { cascadeAccepted: outcome.cascadeAccepted } : {}),
    ...(outcome.kept.length > 0 ? { kept: outcome.kept } : {}),
    ...(outcome.regenerate.length > 0 ? { regenerate: outcome.regenerate } : {}),
    ...(outcome.skippedDecisions.length > 0 ? { skippedDecisions: outcome.skippedDecisions } : {}),
    ...(body.overallComment ? { overallComment: body.overallComment } : {}),
    ...handoffRecordFields(handoff),
  };

  const filePath = await saveReviewRecord(videoRoot, record);

  reportOutcome?.({
    stage: "reference",
    filePath,
    ...(outcome.regenerate.length > 0 ? { regenerate: outcome.regenerate } : {}),
  });

  return jsonResponse({
    saved: filePath !== null,
    filePath,
    acceptedAssets: outcome.acceptedAssets,
    skippedDecisions: outcome.skippedDecisions,
    kept: outcome.kept,
    regenerate: outcome.regenerate,
  });
}
