import * as path from "node:path";
import { isWithinRoot } from "../../../core/path-containment.js";
import {
  cascadeAcceptConsumedDeps,
  holdsHumanVerdict,
  keepAcceptedInputs,
} from "../../../core/accept-cascade.js";
import {
  DIRECTION_SECTIONS,
  addressToUrlPath,
  formatAddress,
  tryParseAddress,
} from "../../../core/address.js";
import {
  isVariantStale,
  keptViaMarker,
  parseKeptVia,
  undecidedTakeBesideAccepted,
  type PatchHashes,
} from "../../../core/staleness.js";
import { isReviewLeaf } from "../../../core/variant-lineage.js";
import { errorMessage } from "../../../core/errors.js";
import { parseJsonBody } from "../../page-host/http.js";
import { resolveLens } from "../../../core/direction.js";
import { BEAT_FUNCTION_LABEL } from "../../../core/lenses.js";
import type { Direction, DirectionNode, Framing } from "../../../core/dsl/direction.js";
import { isAsideShot, isGraphicShot } from "../../../core/dsl/direction.js";
import type { AssetInfo, ScriptLineView, ShotInfo } from "../../../pages/preview/types.js";
import { scriptLinesToView } from "../../../core/types/script.js";
import type { Handoff, AnimaticDefinition } from "../../../core/types/index.js";
import { z } from "zod";
import {
  ReviewAcceptDecisionSchema,
  type ReviewDecisionEntry,
  type ReviewRecord,
  ReviewRecordSchema,
  VideoReviewDecisionsSchema,
} from "../../../core/review-record.js";
import {
  feedbackStaleness,
  FeedbackManager,
  type FeedbackStaleContext,
  generateFeedbackId,
  getFeedbackWithStaleness,
} from "../../../core/feedback/index.js";
import { StateManager } from "../../../core/state/index.js";
import { JobManager } from "../../../core/job-manager.js";
import {
  assertPrerequisitesMet,
  findAllUnmetPrerequisites,
} from "../../../core/review-prerequisites.js";
import { clampUnit } from "../../../core/types/index.js";
import type {
  AssetDefinition,
  FeedbackAnnotation,
  KonteState,
  VariantState,
} from "../../../core/types/index.js";
import { readDefinitionSnapshot } from "../../../core/definition-snapshot.js";
import { applyTurboInputs } from "../../../core/turbo.js";
import { readVariantThumbnails } from "../../../core/thumbnail.js";
import { inferMediaType } from "../../../core/media-type.js";

// The preview server only ever serves a video's own media, so containment is checked against the
// video root — not the workspace. That puts the workspace's credentials structurally out of reach.
// A handler that serves a file's *contents* uses the symlink-aware `isWithinRootReal` instead:
// a link under assets/ is lexically inside the video and still reads whatever it points at.
export function isWithinVideoRoot(filePath: string, videoRoot: string): boolean {
  return isWithinRoot(filePath, videoRoot);
}

// A patch inherits its source's turbo mark.
function isTurboLineage(variants: Record<string, VariantState>, variantId: string): boolean {
  for (let v = variants[variantId]; v; v = v.derivedFrom ? variants[v.derivedFrom] : undefined) {
    if (v.turbo) return true;
  }
  return false;
}

type VariantCandidate = {
  variantId: string;
  variantStatus: "none" | "accepted";
  stale: boolean;
  // An undecided, non-stale variant standing beside an accepted one (a reroll or a patch output
  // nobody has settled). Lets the gallery badge "New" so it is findable beside the accepted take.
  isNew: boolean;
  // The reviewer decided against this take. Kept in the gallery — a decision can be revisited by
  // selecting it and accepting — but sorted after the live candidates.
  dismissed: boolean;
  // Generated on its adapter's turbo inputs — the address's first take, or a patch of it.
  turbo: boolean;
  createdAt: string;
  imageUrl: string | null;
  fileUrl: string | null;
  // The take this one corrects, when it came from a patch — the "before" of a before/after
  // comparison. The ancestor is not a candidate of its own (see buildVariantCandidates), so this
  // is the only place it is reachable in the gallery.
  before: {
    variantId: string;
    variantStatus: "none" | "accepted";
    imageUrl: string | null;
    fileUrl: string | null;
  } | null;
  info?: AssetInfo;
};

export type AddressFeedback = {
  id: string;
  address: string;
  displayedVariants: Record<string, string>;
  annotation: { kind: "pin"; x: number; y: number } | null;
  text: string;
  time?: number;
  imageUrl?: string;
  createdAt: string;
  createdBy: string;
  stale: boolean;
};

/**
 * Switchable variant candidates for an address: recommended (non-stale) first in
 * newest-first order, then de-emphasized (stale).
 * `buildVariantUrl` returns the tile's preview still (see `variantPreviewUrl`).
 *
 * Only lineage leaves are candidates. A take that has been patched is not an alternative to its
 * correction — it is the "before" of it — so it is attached to its descendant's `before` instead
 * of standing beside it, and the gallery shows one tile per decision rather than filling up with
 * pre-fix images.
 */
export function buildVariantCandidates(
  manager: StateManager,
  addr: string,
  acceptedId: string | null,
  defHash: string | null,
  buildVariantUrl: (variantId: string, variant: VariantState) => string | null,
  buildFileUrl?: (variantId: string, variant: VariantState) => string | null,
  patchHashes?: PatchHashes,
  buildInfo?: (variantId: string) => AssetInfo | undefined,
): VariantCandidate[] {
  const variants: VariantCandidate[] = [];
  try {
    const target = manager.getAssetState(addr);
    const staleState = manager.getState();
    // The memo the page's own resolution uses, or the gallery calls current what it is not showing.
    const cache = manager.stalenessCache();
    const hasAccepted = acceptedId != null && target.variants?.[acceptedId] != null;
    const entries = Object.entries(target.variants ?? {})
      .filter(([vid, v]) => v?.file && isReviewLeaf(staleState, addr, vid))
      .map(([vid, v]) => {
        const stale = isVariantStale(staleState, addr, v, defHash, patchHashes, cache);
        const source = v.derivedFrom ? target.variants?.[v.derivedFrom] : null;
        const info = buildInfo?.(vid);
        return {
          variantId: vid,
          variantStatus: (vid === acceptedId ? "accepted" : "none") as "none" | "accepted",
          stale,
          isNew: hasAccepted && vid !== acceptedId && !stale && v.status === "none",
          dismissed: v.status === "dismissed",
          turbo: isTurboLineage(target.variants ?? {}, vid),
          createdAt: v.createdAt,
          imageUrl: buildVariantUrl(vid, v),
          fileUrl: buildFileUrl ? buildFileUrl(vid, v) : null,
          before:
            v.derivedFrom && source?.file
              ? {
                  variantId: v.derivedFrom,
                  variantStatus: (v.derivedFrom === acceptedId ? "accepted" : "none") as
                    | "none"
                    | "accepted",
                  imageUrl: buildVariantUrl(v.derivedFrom, source),
                  fileUrl: buildFileUrl ? buildFileUrl(v.derivedFrom, source) : null,
                }
              : null,
          ...(info ? { info } : {}),
        };
      })
      .reverse();
    const isRecommended = (e: VariantCandidate) => !e.stale && !e.dismissed;
    variants.push(...entries.filter(isRecommended), ...entries.filter((e) => !isRecommended(e)));
  } catch {
    // no state
  }
  return variants;
}

/**
 * The status of the take a surface is showing. `accepted` only when resolution itself says so: an
 * accept konte made itself keeps that status on disk after it goes stale, while resolution stops
 * honouring it.
 */
export function displayedVariantStatus(
  manager: StateManager,
  addr: string,
  variantId: string | null,
): "none" | "accepted" {
  if (variantId === null) return "none";
  const resolved = manager.selectVariant(addr, { includeStale: true });
  return resolved?.variantId === variantId && resolved.isAccepted ? "accepted" : "none";
}

/**
 * True when a ready, non-stale take stands undecided beside the accepted one — a reroll or a patch
 * output sitting in the gallery with no verdict. The accepted variant otherwise stays the
 * resolved/shown one and hides it, so the UI surfaces this to prompt a decision: accept the rival,
 * or re-accept the shown take, which dismisses it.
 */
export function hasNewerReadyVariant(
  manager: StateManager,
  addr: string,
  acceptedId: string | null,
  defHash: string | null,
  patchHashes?: PatchHashes,
): boolean {
  if (!acceptedId) return false;
  try {
    return (
      undecidedTakeBesideAccepted(
        manager.getState(),
        addr,
        defHash,
        undefined,
        patchHashes,
        manager.stalenessCache(),
      ) !== null
    );
  } catch {
    return false;
  }
}

// What each submit handler takes from the preview client and then persists. Validated at the door,
// before any mutation: feedback written unvalidated lands in the stream, whose next load parses it —
// so one bad entry fails that load and takes every comment with it — and a malformed decision or
// shown-variant map would only surface at saveReviewRecord, after the accepts and the feedback were
// already committed. One schema per mode, since each handler's required fields differ.
const CommentFieldsSchema = z.object({
  address: z.string(),
  text: z.string(),
  annotation: z
    .object({ kind: z.literal("pin"), x: z.number(), y: z.number() })
    .nullable()
    .optional(),
  time: z.number().optional(),
  shotTime: z.number().optional(),
});

const AddedFeedbackSchema = z.array(
  CommentFieldsSchema.extend({
    displayedVariants: z.record(z.string(), z.string()).optional(),
    displayedDefinitionHashes: z.record(z.string(), z.string()).optional(),
    subjectHash: z.string().optional(),
  }),
);

// The reel's comments carry WHERE they were written and nothing about what they were written
// against: which addresses a target perceives is a question about the definition, and the handler
// answers it (see `commentSubjectAddresses`). A client cannot narrow the subject it does not send —
// which is what a page reading it off one of its own asset arrays did, dropping every audio take.
const ReelAddedFeedbackSchema = z.array(CommentFieldsSchema);

const FeedbackPatchesSchema = z.array(
  z.object({
    op: z.enum(["edit", "delete"]),
    id: z.string(),
    address: z.string(),
    text: z.string().optional(),
  }),
);

// The variant the reviewer saw per address — recorded, and what an accept accepts.
const DisplayedVariantsSchema = z.record(z.string(), z.string());

// Every take the reviewer had in front of them per address — the gallery as the page rendered it.
// An accept dismisses the ones it did not choose (see `StateManager.setAccepted`), so this cannot
// be re-derived at submit time: a reroll that landed mid-review is in state but was never on
// screen.
const DisplayedCandidatesSchema = z.record(z.string(), z.array(z.string()));

// The reviewer's word on the pass as a whole, from the submit dialog. Carried by every stage's
// payload and persisted on the record — it is what a submit that settled nothing still says.
const OverallCommentSchema = z.string();

// The Keep-or-regenerate answers, expanded on the page: each take a Keep names with the upstream it
// was kept against, and each take a Regenerate names.
const KeepSchema = z.array(
  z.object({
    address: z.string(),
    variantId: z.string(),
    inputs: z.record(z.string(), z.string()),
  }),
);
const RegenerateSchema = z.array(z.object({ address: z.string(), variantId: z.string() }));

export type KeepEntryBody = z.infer<typeof KeepSchema>[number];
export type RegenerateEntryBody = z.infer<typeof RegenerateSchema>[number];

export const ReelSubmitSchema = z.object({
  decisions: VideoReviewDecisionsSchema.nullish(),
  timelineStemDecision: ReviewAcceptDecisionSchema.optional(),
  notes: ReviewRecordSchema.shape.notes,
  addedFeedback: ReelAddedFeedbackSchema.optional(),
  feedbackPatches: FeedbackPatchesSchema.optional(),
  displayedVariants: DisplayedVariantsSchema.optional(),
  // The live definition hash the page was served per materialized leaf (each shot's composition and
  // stem, the timeline stem). A leaf renders from its definition and mints no variant until
  // accepted, so a definition edit is invisible to the takes above; this is the axis that catches
  // it. Whole-page, like `displayedVariants` — the handler selects the leaves each comment stands
  // on.
  displayedDefinitionHashes: DisplayedVariantsSchema.optional(),
  displayedCandidates: DisplayedCandidatesSchema.optional(),
  // The shot ids that stood in with the board instead of a picture that is not made yet, from the
  // client. Same discipline as `displayedVariants`: what a shot showed cannot be re-derived at
  // submit time, because a build dependency finishing mid-review flips the answer — and the verdict
  // would then land on a composition nobody watched. Their verdicts are dropped: a stand-in carries
  // nothing to sign off. REQUIRED, so a caller that cannot say what it displayed is rejected rather
  // than silently falling back to a re-derivation with that exact bug.
  displayedStandInShotIds: z.array(z.string()),
  overallComment: OverallCommentSchema.optional(),
  keep: KeepSchema.optional(),
  regenerate: RegenerateSchema.optional(),
});

// The reference stage's shape: one decision entry per address, feedback always sent.
const StageSubmitSchema = z.object({
  addedFeedback: AddedFeedbackSchema,
  feedbackPatches: FeedbackPatchesSchema,
  decisions: z
    .array(
      z.object({
        address: z.string(),
        variantId: z.string(),
        status: ReviewAcceptDecisionSchema,
        // The other takes this decision was made among — see DisplayedCandidatesSchema.
        candidateVariantIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  overallComment: OverallCommentSchema.optional(),
  keep: KeepSchema.optional(),
  regenerate: RegenerateSchema.optional(),
});

// The review page accepts per SECTION (the boxes it renders), while state records per part — one
// box's verdict fans out to every part it holds. A section the reviewer never touched is absent
// rather than false, so a feedback-only submit revokes nothing.
const DirectionSubmitSchema = z.object({
  addedFeedback: AddedFeedbackSchema,
  feedbackPatches: FeedbackPatchesSchema,
  sectionDecisions: z.record(z.enum(DIRECTION_SECTIONS), z.boolean()).optional(),
  reviewedHash: z.string().optional(),
  overallComment: OverallCommentSchema.optional(),
});

export function isValidSubmitPayload(
  mode: "video" | "stage" | "direction",
  body: unknown,
): boolean {
  const schema =
    mode === "video"
      ? ReelSubmitSchema
      : mode === "stage"
        ? StageSubmitSchema
        : DirectionSubmitSchema;
  return schema.safeParse(body).success;
}

// The stale flag as the reviewer SAW it, per comment id — snapshotted before the session's own
// decisions land. An accept stamped over a standing comment ages it, and a record computed after
// would then hide the very comment its accept was made against.
export function staleFlagsBeforeDecisions(
  fbMgr: FeedbackManager,
  state: KonteState,
  ctx?: FeedbackStaleContext,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const { address, entry } of fbMgr.list()) {
    // The record keeps a plain flag: it is a historical note on what the reviewer saw, not a
    // routing input, and "unknown" there would mean the same as "still standing".
    out.set(entry.id, feedbackStaleness(entry, address, state, ctx) === "stale");
  }
  return out;
}

// The feedback lines a review record carries for one address: every comment standing on it, with
// the stale flag the reviewer saw and whether this review added or edited it.
export function recordFeedbackFor(
  fbMgr: FeedbackManager,
  address: string,
  staleBefore: Map<string, boolean>,
  addedFeedbackIds: Set<string>,
  editedFeedbackIds: Set<string>,
): ReviewDecisionEntry["feedback"] {
  return fbMgr.getFeedback(address).map((f) => {
    const entry: ReviewDecisionEntry["feedback"][number] = {
      id: f.id,
      annotation:
        f.annotation?.kind === "pin" ? { kind: "pin", x: f.annotation.x, y: f.annotation.y } : null,
      text: f.text,
      stale: staleBefore.get(f.id) ?? false,
    };
    if (Object.keys(f.displayedVariants ?? {}).length > 0) {
      entry.displayedVariants = f.displayedVariants;
    }
    if (addedFeedbackIds.has(f.id)) entry.added = true;
    if (editedFeedbackIds.has(f.id)) entry.edited = true;
    return entry;
  });
}

// The handoff (AI -> reviewer) a review record was made against.
export function handoffRecordFields(
  handoff: Handoff | null,
): Pick<ReviewRecord, "handoffSummary" | "handoffNotes"> {
  return {
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
    ...(handoff && handoff.notes.length > 0 ? { handoffNotes: handoff.notes } : {}),
  };
}

/** Persisted feedback for an address, with stale flags computed. */
export function buildAddressFeedback(
  feedbackMgr: FeedbackManager,
  state: KonteState,
  addr: string,
  ctx?: FeedbackStaleContext,
): AddressFeedback[] {
  const withStaleness = getFeedbackWithStaleness(feedbackMgr.getFeedback(addr), addr, state, ctx);
  return withStaleness.map((fb) => ({
    id: fb.id,
    address: addr,
    displayedVariants: fb.displayedVariants,
    annotation:
      fb.annotation?.kind === "pin"
        ? { kind: "pin" as const, x: fb.annotation.x, y: fb.annotation.y }
        : null,
    text: fb.text,
    time: fb.time,
    createdAt: fb.createdAt,
    createdBy: fb.createdBy,
    // Only a verdict of "stale" hides a comment on the page; "unknown" leaves it standing,
    // which is the safe reading of a subject the reader could not check.
    stale: fb.staleness === "stale",
  }));
}

export interface FeedbackMutationResult {
  /** Newly added feedback in input order — lets callers correlate with notes/captures. */
  added: Array<{
    id: string;
    address: string;
    time?: number;
    /** Clamped as stored — the capture burns it into the frame. */
    annotation: FeedbackAnnotation | null;
  }>;
}

/** Apply feedback add/edit/delete inside an existing lock; returns what was added. */
export function applyFeedbackMutations(
  mgr: FeedbackManager,
  addedFeedback: Array<{
    address: string;
    text: string;
    annotation: { kind: "pin"; x: number; y: number } | null;
    time?: number;
    shotTime?: number;
    displayedVariants?: Record<string, string>;
    displayedDefinitionHashes?: Record<string, string | null>;
    subjectHash?: string;
  }>,
  feedbackPatches: Array<{ op: "edit" | "delete"; id: string; address: string; text?: string }>,
  // The review's own timestamp, stamped on every comment it carries. Taken from the handler rather
  // than read here so it precedes the accepts of the same submit whatever order they are written
  // in — see `acceptedOver`.
  createdAt: string = new Date().toISOString(),
): FeedbackMutationResult {
  const added: FeedbackMutationResult["added"] = [];
  const now = createdAt;
  for (const fb of addedFeedback) {
    // Clamp what the client sent: a pin dragged a hair past the frame edge still means "here",
    // and the stored coordinate is contracted to be 0-1 (FeedbackAnnotationSchema).
    const annotation: FeedbackAnnotation | null = fb.annotation
      ? { kind: "pin", x: clampUnit(fb.annotation.x), y: clampUnit(fb.annotation.y) }
      : null;
    const id = generateFeedbackId();
    added.push({ id, address: fb.address, time: fb.time, annotation });
    mgr.addFeedback(fb.address, {
      id,
      displayedVariants: fb.displayedVariants ?? {},
      ...(fb.displayedDefinitionHashes && Object.keys(fb.displayedDefinitionHashes).length > 0
        ? { displayedDefinitionHashes: fb.displayedDefinitionHashes }
        : {}),
      ...(fb.subjectHash !== undefined ? { subjectHash: fb.subjectHash } : {}),
      annotation,
      text: fb.text,
      ...(fb.time !== undefined ? { time: fb.time } : {}),
      ...(fb.shotTime !== undefined ? { shotTime: fb.shotTime } : {}),
      createdAt: now,
      createdBy: "local",
    });
  }
  for (const patch of feedbackPatches) {
    if (patch.op === "edit" && patch.text != null) {
      mgr.updateFeedbackText(patch.address, patch.id, patch.text);
    } else if (patch.op === "delete") {
      mgr.removeFeedback(patch.address, patch.id);
    }
  }
  return { added };
}

/**
 * Stamp each added video shot-note with its shot-local offset (`shotTime = time - shotStart`),
 * so a comment carries the position within its shot — what `<Audio start>` and friends take —
 * beside the timeline-global `time`, and the reader never re-derives it. Notes that don't map to a
 * shot (timeline beds, timeless notes, non-video addresses) pass through unchanged.
 */
export function withShotLocalTime<T extends { address: string; time?: number }>(
  added: T[],
  shots: Array<{ shotId: string; duration: number }>,
): Array<T & { shotTime?: number }> {
  const startTime = new Map<string, number>();
  let acc = 0;
  for (const s of shots) {
    startTime.set(s.shotId, acc);
    acc += s.duration;
  }
  return added.map((fb) => {
    if (fb.time === undefined) return fb;
    const shotId = [...startTime.keys()].find((id) => fb.address === `video:shot.${id}`);
    if (shotId === undefined) return fb;
    return { ...fb, shotTime: fb.time - startTime.get(shotId)! };
  });
}

/** Video variant preview image: the variant's first cached thumbnail, or null. */
export function videoVariantThumbUrl(
  videoRoot: string,
  address: string,
  variantId: string,
  variant: VariantState,
): string | null {
  const thumbs = readVariantThumbnails(
    videoRoot,
    address,
    variantId,
    variant.outputHash,
    variant.file,
  );
  if (thumbs.length === 0) return null;
  return `/api/thumbnail-assets/${encodeURIComponent(thumbs[0]!.file)}`;
}

/** Served URL for a variant's own file. */
export function variantFileUrl(
  address: string,
  variantId: string,
  file: string,
  assetBaseUrl: string,
): string {
  return `${assetBaseUrl}/${addressToUrlPath(address)}/${encodeURIComponent(variantId)}/${encodeURIComponent(path.basename(file))}`;
}

/**
 * The still a variant shows on a card or a gallery tile: the file itself for an image, the first
 * cached thumbnail for a video, null for audio. An image goes through `/api/assets` — its own file
 * is not in the thumbnail cache the thumbnail endpoint is confined to.
 */
export function variantPreviewUrl(
  videoRoot: string,
  address: string,
  variantId: string,
  variant: VariantState,
  assetBaseUrl: string,
): string | null {
  if (!variant.file) return null;
  const kind = inferMediaType(variant.file);
  if (kind === "image") return variantFileUrl(address, variantId, variant.file, assetBaseUrl);
  if (kind === "video") return videoVariantThumbUrl(videoRoot, address, variantId, variant);
  return null;
}

// The take a patch lineage was generated from: a patched take is generated from nothing of its own,
// and its fingerprints are merged (see `patchInputFingerprints`), not what anything consumed.
function generatedOrigin(manager: StateManager, address: string, variantId: string): string {
  const variants = manager.tryGetAssetState(address)?.variants ?? {};
  let origin = variantId;
  const seen = new Set<string>();
  for (let from = variants[origin]?.derivedFrom; from && !seen.has(from); ) {
    seen.add(from);
    origin = from;
    from = variants[origin]?.derivedFrom;
  }
  return origin;
}

/**
 * The definition a take's lineage was submitted with — its `definition.json`, with the turbo inputs
 * over it for a turbo take — or null when it is gone.
 */
export function takeDefinitionSnapshot(
  manager: StateManager,
  videoRoot: string,
  address: string,
  variantId: string,
): AssetDefinition | null {
  const origin = generatedOrigin(manager, address, variantId);
  const snapshot = readDefinitionSnapshot(videoRoot, address, origin);
  if (!snapshot) return null;
  const turbo = manager.getState().assets[address]?.variants?.[origin]?.turbo === true;
  return turbo ? applyTurboInputs(snapshot) : snapshot;
}

/**
 * A still for the take at `ref` that a take's lineage consumed when it was generated — matched by
 * the output hash its `inputFingerprints` recorded. Null when no take left in state carries those
 * bytes. What the asset info panel draws beside a consumed address.
 */
export function consumedTakePreviewUrl(
  manager: StateManager,
  videoRoot: string,
  address: string,
  variantId: string,
  ref: string,
  assetBaseUrl: string,
): string | null {
  const origin = generatedOrigin(manager, address, variantId);
  const hash = manager.tryGetAssetState(address)?.variants?.[origin]?.inputFingerprints?.[ref];
  if (!hash) return null;
  const match = Object.entries(manager.tryGetAssetState(ref)?.variants ?? {}).find(
    ([, v]) => v.file && v.outputHash === hash,
  );
  return match ? variantPreviewUrl(videoRoot, ref, match[0], match[1], assetBaseUrl) : null;
}

/** Served URL for a variant's playable media (video or audio) file, or undefined otherwise. */
export function variantMediaUrl(
  manager: StateManager,
  addr: string,
  variantId: string,
  assetBaseUrl: string,
): string | undefined {
  try {
    const file = manager.getAssetState(addr).variants?.[variantId]?.file;
    if (!file) return undefined;
    const mediaType = inferMediaType(file);
    if (mediaType !== "video" && mediaType !== "audio") return undefined;
    return variantFileUrl(addr, variantId, file, assetBaseUrl);
  } catch {
    return undefined;
  }
}

/** Media kind an asset's variants render as, inferred from the chosen variant's file. */

// Handoff notes (AI -> reviewer guidance) attach to an asset path and are shown
// inline next to each shot in the review UI, independent of change detection —
// they must surface on the first review (no prior record) too, not only when a
// variant changed since the last review.
export function handoffNotesForShot(
  handoff: Handoff | null,
  stage: "video" | "animatic",
  shotId: string,
): Array<{ assetName: string; text: string }> {
  return (handoff?.notes ?? []).flatMap((n) => {
    const parsed = tryParseAddress(n.address);
    if (parsed?.kind !== "shot" || parsed.stage !== stage || parsed.shotId !== shotId) return [];
    return [{ assetName: parsed.assetName, text: n.text }];
  });
}

// The direction facts the animatic's shot band prints beside each shot's action: its dramatic
// function, framing, and the NAME of its location. The raw `role` is deliberately left behind —
// see handleGetDirectionState for why the reviewer is shown the function instead. `script` is the
// shot's lines, which an undeveloped shot's tile prints in place of the panel-placed ones it has
// none of; `telop` is the unspoken text laid over the same shot. Empty when the video has no
// direction.ts, which the band then simply omits.
interface ShotFacts {
  beatFunctionLabel: string | null;
  // Both read through the shot's setup, so both are null when it is not a declared one — and on an
  // aside, which is taken from no camera and set in no place, so are the rest.
  framing: Framing | null;
  location: string | null;
  script: ScriptLineView[];
  telop: string[];
  // What an aside's span is, for the views that print a shot's line. Null on a narrative shot, whose
  // prose is its `action` and reaches the view another way.
  asideLabel: string | null;
  // The boundary into this shot. Null on an ordinary cut, a graphic shot and an aside.
  join: ShotInfo["join"];
}

// A shot reaches its size and its place through its setup, so every view that shows either resolves
// it here. Both are shown by the roster's own word — the location's `name` for continuity, the
// setup's for the frame — with the raw id as the fallback a `setup-unknown` direction reads like.
export function shotFrameResolver(direction: Direction): (setupId: string) => {
  framing: Framing | null;
  location: string | null;
  setupName: string;
} {
  const locationNameById = new Map(
    Object.entries(direction.locations ?? {}).map(([id, l]) => [id, l.name]),
  );
  return (setupId: string) => {
    const setup = direction.setups?.[setupId];
    return {
      framing: setup?.framing ?? null,
      location: setup ? (locationNameById.get(setup.location) ?? setup.location) : null,
      setupName: setup?.name ?? setupId,
    };
  };
}

export function shotFactsIndex(direction: Direction | null): Map<string, ShotFacts> {
  const byId = new Map<string, ShotFacts>();
  if (!direction) return byId;
  const characterNameById = new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
  );
  const frameOf = shotFrameResolver(direction);
  const walk = (node: DirectionNode): void => {
    for (const shot of node.shots ?? []) {
      if (isAsideShot(shot)) {
        byId.set(shot.id, {
          beatFunctionLabel: null,
          framing: null,
          location: null,
          script: [],
          telop: [...(shot.telop ?? [])],
          asideLabel: shot.label,
          join: null,
        });
        continue;
      }
      const fn = resolveLens(node.lens, direction.lenses)?.beats.find(
        (b) => b.role === shot.role,
      )?.fn;
      const own = isGraphicShot(shot) ? null : shot;
      const frame = own ? frameOf(own.setup) : null;
      byId.set(shot.id, {
        beatFunctionLabel: fn ? BEAT_FUNCTION_LABEL[fn] : null,
        framing: frame?.framing ?? null,
        location: frame?.location ?? null,
        script: scriptLinesToView(shot.script, characterNameById),
        telop: [...(shot.telop ?? [])],
        asideLabel: null,
        join: own?.join ?? null,
      });
    }
    for (const child of node.sequences ?? []) walk(child);
  };
  walk(direction.sequence);
  return byId;
}

// The submit payload of an address-keyed review (animatic / reference): comments and per-address
// accept decisions.
type AddressReviewBody = {
  addedFeedback: Array<{
    address: string;
    text: string;
    annotation: { kind: "pin"; x: number; y: number } | null;
    displayedVariants?: Record<string, string>;
  }>;
  feedbackPatches: Array<{ op: "edit" | "delete"; id: string; address: string; text?: string }>;
  decisions?: Array<{
    address: string;
    variantId: string;
    status: "accepted" | "none";
    candidateVariantIds?: string[];
  }>;
  overallComment?: string;
  keep?: KeepEntryBody[];
  regenerate?: RegenerateEntryBody[];
};

// What lands and what does not, for an address-keyed review, before the stage builds its record.
type AddressReviewOutcome = {
  acceptedAssets: string[];
  // Upstream deps signed off as a side effect of an accept, tagged with the address they rode in
  // on — persisted so `review record show` names them.
  cascadeAccepted: Array<{ address: string; via: string }>;
  // The verdicts that did NOT land, reported back so the page holds itself open instead of closing
  // on a success that state does not back.
  skippedDecisions: NonNullable<ReviewRecord["skippedDecisions"]>;
  decisions: ReviewDecisionEntry[];
  kept: string[];
  regenerate: string[];
};

// Apply an address-keyed review under the state and feedback locks: write the comments, land each
// accept/un-accept, cascade into the direction, and read back the record's decision lines. The two
// stages differ only in the hooks: which accepts are refused here, what an accept stamps, and which
// direction parts an applied accept re-signs.
export async function applyAddressReview(
  videoRoot: string,
  stage: "animatic" | "reference",
  body: AddressReviewBody,
  reviewedAt: string,
  hooks: {
    // The prerequisite/cascade context: the animatic whose panels are (or back) the targets.
    animatic: AnimaticDefinition | null;
    // Definition hashes the comments' stale flags are read against.
    staleDefinitionHashes?: ReadonlyMap<string, string>;
    // A reason to refuse an accept made on this page, or null to let it through.
    refuseAccept?: (address: string) => string | null;
    // The direction parts an applied accept re-signs, tagged with the accept's address.
    cascadeDirection: (
      mgr: StateManager,
      appliedAccepts: ReadonlySet<string>,
    ) => Array<{ address: string; via: string }>;
  },
): Promise<AddressReviewOutcome> {
  const acceptedAssets: string[] = [];
  const cascadeAccepted: AddressReviewOutcome["cascadeAccepted"] = [];
  const skippedDecisions: AddressReviewOutcome["skippedDecisions"] = [];
  // The accepts that actually landed. A decision the loop below drops — a made-up address, a
  // variant pruned since the page loaded, a target whose review prerequisites are unwritten —
  // signed nothing off, so neither the direction cascade nor the record may read it as an accept.
  const appliedAccepts = new Set<string>();
  const kept: string[] = [];
  const regenerate: string[] = [];
  const jobManager = new JobManager(videoRoot);

  const addedFeedbackIds = new Set<string>();
  const editedFeedbackIds = new Set<string>(
    body.feedbackPatches.filter((p) => p.op === "edit").map((p) => p.id),
  );
  const statusOverrideByAddress = new Map(
    (body.decisions ?? []).map((d) => [
      d.address,
      { variantId: d.variantId, status: d.status } as const,
    ]),
  );
  const touchedAddresses = new Set<string>();
  for (const d of body.decisions ?? []) touchedAddresses.add(d.address);
  for (const fb of body.addedFeedback) touchedAddresses.add(fb.address);
  for (const p of body.feedbackPatches) touchedAddresses.add(p.address);

  let decisions: ReviewDecisionEntry[] = [];

  await StateManager.withLock(videoRoot, async (mgr) => {
    await FeedbackManager.withLock(videoRoot, stage, async (fbMgr) => {
      for (const { id } of applyFeedbackMutations(
        fbMgr,
        body.addedFeedback,
        body.feedbackPatches,
        reviewedAt,
      ).added) {
        addedFeedbackIds.add(id);
      }
      // Read before the decisions below land — see staleFlagsBeforeDecisions. With the same
      // definition hashes the page evaluated its comments against, or the record would call a
      // comment standing that the reviewer saw struck through.
      const staleBefore = staleFlagsBeforeDecisions(fbMgr, mgr.getState(), {
        cache: mgr.stalenessCache(),
        ...(hooks.staleDefinitionHashes ? { definitionHashes: hooks.staleDefinitionHashes } : {}),
      });

      for (const override of body.decisions ?? []) {
        try {
          const refusal = hooks.refuseAccept?.(override.address) ?? null;
          if (refusal !== null) {
            skippedDecisions.push({ address: override.address, reason: refusal });
            continue;
          }
          if (override.status === "accepted") {
            // A target whose review prerequisites are unwritten cannot be signed off. Thrown, not
            // skipped inline: the decision loop's catch is what drops this one accept while the
            // feedback written above it — and every other decision — still commits.
            assertPrerequisitesMet(
              findAllUnmetPrerequisites(
                { animatic: hooks.animatic },
                mgr.getState(),
                new Set([override.address]),
              ),
              `Cannot accept ${override.address}`,
            );
            const previousAccepted = mgr.getAcceptedVariant(override.address);
            // Always (re)accept: it settles the rivals the reviewer chose against; cascade/report
            // only when the accepted id actually changed.
            mgr.setAccepted(override.address, override.variantId, {
              dismiss: override.candidateVariantIds ?? [],
            });
            // Only past `setAccepted`: a decision that threw accepted nothing.
            appliedAccepts.add(override.address);
            if (previousAccepted !== override.variantId) {
              acceptedAssets.push(override.address);
              const cascaded = await cascadeAcceptConsumedDeps(
                mgr,
                jobManager,
                override.address,
                override.variantId,
                { animatic: hooks.animatic },
              );
              acceptedAssets.push(...cascaded);
              cascadeAccepted.push(
                ...cascaded.map((address) => ({ address, via: override.address })),
              );
            }
          } else if (override.status === "none") {
            // Only an accept is cleared. A stale page can name a variant that is no longer the
            // accepted one — ignored, never turned back into a candidate.
            const variants = mgr.tryGetAssetState(override.address)?.variants;
            if (variants?.[override.variantId]?.status === "accepted") {
              mgr.setUnaccepted(override.address, override.variantId);
            }
          }
        } catch (err) {
          // Drop just this decision: an address the client made up, a variant pruned since the
          // page loaded, or a target whose review prerequisites are unwritten. Named rather than
          // swallowed — but only where the verdict really did not land: the cascade runs after the
          // accept is written, and a cascade that throws leaves an accept the record reports as
          // made. Reporting it skipped as well would contradict the record it ships with.
          if (!appliedAccepts.has(override.address)) {
            skippedDecisions.push({ address: override.address, reason: errorMessage(err) });
          }
        }
      }

      cascadeAccepted.push(...hooks.cascadeDirection(mgr, appliedAccepts));
      kept.push(...applyKeepDecisions(mgr, body.keep ?? [], body.regenerate));
      regenerate.push(...applyRegenerateDecisions(mgr, body.regenerate));

      decisions = [...touchedAddresses].map((address) => {
        const override = statusOverrideByAddress.get(address);
        const entry: ReviewDecisionEntry = {
          address,
          feedback: recordFeedbackFor(
            fbMgr,
            address,
            staleBefore,
            addedFeedbackIds,
            editedFeedbackIds,
          ),
        };
        // An accept the loop above dropped is not what happened, so the record must not read it
        // back as one — the human is told the decisions that landed, not the ones submitted.
        if (override && (override.status !== "accepted" || appliedAccepts.has(address))) {
          entry.variantId = override.variantId;
          entry.status = override.status;
        }
        return entry;
      });
    });
  });

  return { acceptedAssets, cascadeAccepted, skippedDecisions, decisions, kept, regenerate };
}

/**
 * Keeps each take a Keep named, bar the ones a Regenerate names — only while it is still the
 * accepted take, and only against the upstream the page kept it against. Returns the addresses kept.
 * Run under the state lock, after every accept of the review.
 */
export function applyKeepDecisions(
  mgr: StateManager,
  entries: readonly KeepEntryBody[],
  regenerate: readonly RegenerateEntryBody[] = [],
): string[] {
  const skip = new Set(regenerate.map((r) => r.address));
  const kept: string[] = [];
  for (const entry of entries) {
    if (skip.has(entry.address) || !acceptedVerdict(mgr, entry)) continue;
    const direct = keepAcceptedInputs(
      mgr,
      entry.address,
      entry.variantId,
      (input) => input.current === entry.inputs[input.assetPath],
    );
    const viaKept = keepVia(mgr, entry);
    if (direct.length > 0 || viaKept) kept.push(entry.address);
  }
  return kept;
}

// An input konte re-makes is kept against the upstream takes it is to be made from, while each is
// still what its address resolves to.
function keepVia(mgr: StateManager, entry: KeepEntryBody): boolean {
  const variant = mgr.getAssetState(entry.address).variants![entry.variantId]!;
  let wrote = false;
  for (const [dep, seen] of Object.entries(entry.inputs)) {
    const upstreams = parseKeptVia(seen);
    if (!upstreams || !(dep in (variant.inputFingerprints ?? {}))) continue;
    const standing = Object.entries(upstreams).every(
      ([upstream, hash]) =>
        mgr.tryGetAssetState(upstream) !== undefined &&
        mgr.resolveReference(upstream)?.outputHash === hash,
    );
    if (!standing) continue;
    const prior = parseKeptVia(variant.keptInputs?.[dep] ?? "") ?? {};
    variant.keptInputs = {
      ...variant.keptInputs,
      [dep]: keptViaMarker({ ...prior, ...upstreams }),
    };
    wrote = true;
  }
  return wrote;
}

function acceptedVerdict(mgr: StateManager, take: { address: string; variantId: string }): boolean {
  return (
    mgr.tryGetAssetState(take.address) !== undefined &&
    mgr.getAcceptedVariant(take.address) === take.variantId &&
    holdsHumanVerdict(mgr, take.address)
  );
}

/**
 * Takes each take a Regenerate named off its accept and dismisses it, while it is still the accepted
 * take: an address holding only dismissed takes is what `generate` makes again. Returns the
 * addresses. Run under the state lock.
 */
export function applyRegenerateDecisions(
  mgr: StateManager,
  entries: readonly RegenerateEntryBody[] = [],
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!acceptedVerdict(mgr, entry)) continue;
    mgr.setUnaccepted(entry.address, entry.variantId);
    try {
      mgr.setDismissed(entry.address, entry.variantId, true);
    } catch {
      // A take a patch was made from cannot be dismissed; unaccepted, it is still regenerated.
    }
    out.push(entry.address);
  }
  return out;
}

// Parse and validate an address-keyed submit body; null when it is not one.
export async function parseAddressReviewBody(req: Request): Promise<AddressReviewBody | null> {
  const body = await parseJsonBody<AddressReviewBody>(req);
  return body && isValidSubmitPayload("stage", body) ? body : null;
}

export function addressReviewTouchesNothing(body: AddressReviewBody): boolean {
  return (
    (body.decisions ?? []).length === 0 &&
    body.addedFeedback.length === 0 &&
    body.feedbackPatches.length === 0 &&
    (body.keep ?? []).length === 0 &&
    (body.regenerate ?? []).length === 0 &&
    !body.overallComment
  );
}

export function buildAnimaticReviewContext(
  animatic: AnimaticDefinition,
  manager: StateManager,
): Array<{ shotId: string; duration: number; variants: Record<string, string> }> {
  return animatic.shots.map((shot) => {
    const variants: Record<string, string> = {};
    for (const assetName of Object.keys(shot.assets)) {
      const addr = formatAddress("animatic", shot.id, assetName);
      const displayed = manager.selectVariant(addr, { includeStale: true });
      if (displayed) {
        variants[assetName] = displayed.variantId;
      }
    }
    return { shotId: shot.id, duration: shot.duration, variants };
  });
}
