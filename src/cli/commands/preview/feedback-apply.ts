import { formatShotAddress } from "../../../core/address.js";
import type { FeedbackInfo } from "../../../core/types/review-state.js";
import type { FeedbackPatchBody } from "../../../core/types/review-submit.js";
import type { ReviewDecisionEntry } from "../../../core/review-record.js";
import {
  feedbackStaleness,
  type FeedbackManager,
  type FeedbackStaleContext,
  generateFeedbackId,
  getFeedbackWithStaleness,
} from "../../../core/feedback/index.js";
import { clampUnit } from "../../../core/types/index.js";
import type { FeedbackAnnotation, KonteState } from "../../../core/types/index.js";

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
    out.set(
      entry.id,
      feedbackStaleness(entry, address, state, { ...ctx, reviewerView: true }) === "stale",
    );
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

/** Persisted feedback for an address, with stale flags as the reviewer's page reads them. */
export function buildAddressFeedback(
  feedbackMgr: FeedbackManager,
  state: KonteState,
  addr: string,
  ctx?: FeedbackStaleContext,
): FeedbackInfo[] {
  const withStaleness = getFeedbackWithStaleness(feedbackMgr.getFeedback(addr), addr, state, {
    ...ctx,
    reviewerView: true,
  });
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
    annotation?: { kind: "pin"; x: number; y: number } | null;
    time?: number;
    shotTime?: number;
    displayedVariants?: Record<string, string>;
    displayedDefinitionHashes?: Record<string, string | null>;
    subjectHash?: string;
  }>,
  feedbackPatches: readonly FeedbackPatchBody[],
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
  shots: Array<{ shotId: string; start: number }>,
): Array<T & { shotTime?: number }> {
  const startTime = new Map(shots.map((s) => [s.shotId, s.start]));
  return added.map((fb) => {
    if (fb.time === undefined) return fb;
    const shotId = [...startTime.keys()].find(
      (id) => fb.address === formatShotAddress("video", id),
    );
    if (shotId === undefined) return fb;
    return { ...fb, shotTime: fb.time - startTime.get(shotId)! };
  });
}
