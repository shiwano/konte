import {
  type ShotStage,
  formatAddress,
  formatCompositionAddress,
  formatShotAddress,
  formatTimelineAddress,
  formatTimelineOverlayAddress,
  THUMBNAIL_TARGET,
  isThumbnailAddress,
  formatTimelineStemAddress,
} from "./address.js";
import { formatSeconds, formatSecondsRange } from "./format-duration.js";
import type { ReviewDecisionEntry, ReviewRecord } from "./review-record.js";
import type { FeedbackAnnotation } from "./types/feedback.js";

// A record snapshots every comment on a touched address, including ones already stale when the
// review was submitted — the review UI hides those by default, so they are not that session's read,
// and reporting them beside the fresh notes invites acting on an instruction the current take
// already answered. They stay in the stored record.
//
// One added or edited in the session is kept even when stale: an accept that swaps the displayed
// variant can age a comment inside its own submit.
//
// `stale` here is what the reviewer SAW — the submit handler computes it before applying the
// session's own decisions — so a comment this review accepted over is still reported, beside the
// accept it was made against.
function isSessionFeedback(fb: ReviewDecisionEntry["feedback"][number]): boolean {
  return !fb.stale || Boolean(fb.added) || Boolean(fb.edited);
}

export function countReviewFeedback(record: ReviewRecord): number {
  switch (record.mode) {
    case "reference-preview":
    case "direction-preview": {
      const decisions = record.decisions as ReviewDecisionEntry[] | null;
      if (!Array.isArray(decisions)) return 0;
      return decisions.reduce((sum, d) => sum + d.feedback.filter(isSessionFeedback).length, 0);
    }
    case "animatic-preview":
    case "video-preview":
      return record.notes?.length ?? 0;
    default:
      return 0;
  }
}

export function countReviewAssets(record: ReviewRecord): number {
  const shotAssets = record.context.shots.reduce(
    (sum, s) => sum + Object.keys(s.variants).length,
    0,
  );
  return shotAssets + Object.keys(record.context.timeline ?? {}).length;
}

// Single renderer for a review's content, used by `review record show`. Every mode
// (video/animatic/reference/direction) funnels through here, so the recap reads the same
// wherever it comes from: what was accepted (directly or by cascade), what was un-accepted, and
// what was commented on.
export function formatReviewRecord(
  record: ReviewRecord,
  opts: {
    filePath?: string;
    showHandoff?: boolean;
    // Resolved frame per note id, from `resolveShotFeedbackFrames`. Absent for a note whose frame is not
    // on disk and could not be rendered — the listing then names no frame for it.
    noteFrames?: ReadonlyMap<string, string>;
    // `fields` is empty when no field-level diff is available.
    definitionDrift?: ReadonlyArray<{ address: string; variantId: string; fields: string[] }>;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`Review: ${record.mode} (${record.stage}) ${record.createdAt}`);
  if (opts.filePath) lines.push(`File: ${opts.filePath}`);

  if (record.overallComment) {
    lines.push("");
    lines.push("Overall:");
    for (const line of record.overallComment.split("\n")) lines.push(`  ${line}`);
  }

  // Outcome, not gesture, is the axis: accept / un-accept / comment. Reporting outcomes separately
  // keeps a feedback-only review from ever reading as a set of approvals. A reel review heads each
  // outcome with its decided shots on one line, then names each decided shot's own takes; the other
  // takes an accepted shot placed or mixed are listed apart, once each, with the shots that showed
  // them. A composition or stem an accept materialized is not listed.
  const { accepted, unaccepted, upstream, feedback } = collectReviewSections(
    record,
    opts.noteFrames,
  );

  const reelSummary = summarizeReelDecisions(record);
  lines.push("");
  if (reelSummary) {
    lines.push(
      reelSummary.accepted ? `Accepted: ${reelSummary.accepted}` : "Accepted: none submitted",
    );
    for (const line of accepted) lines.push(`  ${line}`);
    if (reelSummary.unaccepted) {
      lines.push(`Accept withdrawn: ${reelSummary.unaccepted}`);
      for (const line of unaccepted) lines.push(`  ${line}`);
    }
  } else {
    if (accepted.length > 0) {
      lines.push("Accepted:");
      for (const line of accepted) lines.push(`  ${line}`);
    } else {
      lines.push("Accepted: none submitted");
    }

    if (unaccepted.length > 0) {
      lines.push("");
      lines.push("Accept withdrawn:");
      for (const addr of unaccepted) lines.push(`  ${addr}`);
    }
  }

  if (upstream.length > 0) {
    lines.push("");
    lines.push("Upstream takes seen or heard:");
    for (const line of upstream) lines.push(`  ${line}`);
  }

  if ((record.overturned ?? []).length > 0) {
    lines.push("");
    lines.push("Overturned an earlier dismissal:");
    for (const { address, variantId, displaced } of record.overturned ?? []) {
      lines.push(`  ${address} ${variantId}${displaced ? ` (displacing ${displaced})` : ""}`);
    }
  }

  if ((opts.definitionDrift ?? []).length > 0) {
    lines.push("");
    lines.push("Accepted against a changed definition:");
    for (const { address, variantId, fields } of opts.definitionDrift ?? []) {
      const what = fields.length > 0 ? fields.join(", ") : "definition";
      lines.push(`  ${address} (${variantId}) — ${what} changed since this take`);
    }
    lines.push("  the definition each take was made from: konte inspect <variantId>");
  }

  if ((record.songLines ?? []).length > 0) {
    lines.push("");
    lines.push("Lyric lines placed:");
    for (const { address, variantId, key, span } of record.songLines ?? []) {
      const where = span ? formatSecondsRange(span.startSec, span.endSec, 2) : "cleared";
      lines.push(`  ${address} ${variantId} line ${key} ${where}`);
    }
  }

  if ((record.kept ?? []).length > 0) {
    lines.push("");
    lines.push("Kept against newer upstream:");
    for (const addr of record.kept ?? []) lines.push(`  ${addr}`);
  }

  if ((record.regenerate ?? []).length > 0) {
    lines.push("");
    lines.push("Sent back to regenerate:");
    for (const addr of record.regenerate ?? []) lines.push(`  ${addr}`);
  }

  const gate = record.directionGate;
  if (gate) {
    lines.push("");
    lines.push(
      gate.open
        ? "Gate at submit: open — the direction no longer blocks generation"
        : `Gate at submit: ${gate.blocking} of ${gate.total} parts still needed review`,
    );
  }

  // Reported beside the outcomes, never folded into them: the reviewer decided these and the
  // decision did not take, so the next review will ask again. Saying so here is what makes that
  // visible at the moment it happens instead of a review later. Covers a failed release as well as
  // a failed accept, so the heading names neither.
  if ((record.skippedDecisions ?? []).length > 0) {
    lines.push("");
    lines.push("Not settled:");
    for (const s of record.skippedDecisions ?? []) {
      // A reason may carry its own detail lines (which input held a leaf back, the command that
      // clears it); they are indented under the address rather than folded into one long line.
      const [head, ...detail] = s.reason.split("\n");
      lines.push(`  ${s.address} — ${head}`);
      for (const line of detail) lines.push(`    ${line}`);
    }
  }

  if (feedback.length > 0) {
    lines.push("");
    lines.push("Feedback:");
    for (const group of feedback) {
      lines.push(`  ${group.address}`);
      for (const item of group.items) lines.push(`    ${item}`);
    }
  }

  // The handoff is the AI's own note to the reviewer, not part of the decision
  // record — off by default so a review recap reads as the human's decisions, not
  // the agent's own words echoed back. Callers that need it (resuming mid-run) opt in.
  if (
    opts.showHandoff &&
    (record.handoffSummary || (record.handoffNotes && record.handoffNotes.length > 0))
  ) {
    lines.push("");
    lines.push("Handoff:");
    if (record.handoffSummary) {
      lines.push(`  summary: ${record.handoffSummary}`);
    }
    for (const note of record.handoffNotes ?? []) {
      lines.push(`  ${note.address}: ${note.text}`);
    }
  }

  return lines.join("\n");
}

// Every take the review accepted by variant id: a reel review's accepted shots' assets as the
// reviewer saw them, a reference review's accepted entries.
export function reviewAcceptedVariants(
  record: ReviewRecord,
): Array<{ address: string; variantId: string }> {
  const variants: Array<{ address: string; variantId: string }> = [];
  if (record.mode === "animatic-preview" || record.mode === "video-preview") {
    const stage = record.stage === "animatic" ? "animatic" : "video";
    const shotDecisions = (record.decisions as Record<string, "accepted" | "none"> | null) ?? {};
    for (const shot of record.context.shots) {
      if (shotDecisions[shot.shotId] !== "accepted") continue;
      for (const [assetName, variantId] of Object.entries(shot.variants)) {
        variants.push({ address: formatAddress(stage, shot.shotId, assetName), variantId });
      }
    }
    return variants;
  }
  for (const d of (record.decisions as ReviewDecisionEntry[] | null) ?? []) {
    if (d.status === "accepted" && d.variantId) {
      variants.push({ address: d.address, variantId: d.variantId });
    }
  }
  return variants;
}

// A reel review's decisions as one line per outcome: the decided shots, counted against the reel
// and named in timeline order with consecutive runs collapsed (`01–12, 14`), then the timeline's
// own leaves. Null for a stage whose decisions are not per shot.
function summarizeReelDecisions(
  record: ReviewRecord,
): { accepted: string | null; unaccepted: string | null } | null {
  if (record.mode !== "animatic-preview" && record.mode !== "video-preview") return null;
  const stage = record.stage === "animatic" ? "animatic" : "video";
  const shotDecisions = (record.decisions as Record<string, "accepted" | "none"> | null) ?? {};
  const order = reelShotOrder(record);
  const total = record.context.shots.length;

  const line = (status: "accepted" | "none"): string | null => {
    const parts: string[] = [];
    const runs: string[][] = [];
    let count = 0;
    let run: string[] = [];
    for (const shotId of order) {
      if (shotDecisions[shotId] === status) {
        run.push(shotId);
        count++;
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
    if (count > 0) {
      const ids = runs.map((r) => (r.length === 1 ? r[0]! : `${r[0]}–${r.at(-1)}`)).join(", ");
      const noun = total === 1 ? "shot" : "shots";
      parts.push(total > 0 ? `${count} of ${total} ${noun} (${ids})` : `${count} shot(s) (${ids})`);
    }
    if (record.timelineStemDecision === status) parts.push(formatTimelineStemAddress(stage));
    if (record.overlayDecision === status) parts.push(formatTimelineOverlayAddress(stage));
    if (record.thumbnailDecision === status) parts.push(THUMBNAIL_TARGET);
    return parts.length > 0 ? parts.join(", ") : null;
  };

  return { accepted: line("accepted"), unaccepted: line("none") };
}

// A reel review's decided shots in timeline order, any the record's context no longer holds after.
function reelShotOrder(record: ReviewRecord): string[] {
  const shotDecisions = (record.decisions as Record<string, "accepted" | "none"> | null) ?? {};
  const order = record.context.shots.map((s) => s.shotId);
  for (const shotId of Object.keys(shotDecisions)) {
    if (!order.includes(shotId)) order.push(shotId);
  }
  return order;
}

interface FeedbackGroup {
  address: string;
  items: string[];
}

// Splits a record into its accept / un-accept lines and address-grouped feedback. Every mode
// funnels through here so `review record show` describes the same three outcomes identically. Both
// an accept and an un-accept render the same line — the address plus its variant where it has one,
// dropping the redundant status word the section header already carries — differing only in which
// section they land under.
function collectReviewSections(
  record: ReviewRecord,
  noteFrames?: ReadonlyMap<string, string>,
): {
  accepted: string[];
  unaccepted: string[];
  upstream: string[];
  feedback: FeedbackGroup[];
} {
  const accepted: string[] = [];
  const unaccepted: string[] = [];
  const ownAccepted = new Set<string>();
  const upstreamByAddress = new Map<string, { variantId: string; shownIn: string[] }>();
  const pushUpstream = (address: string, variantId: string, shownIn: string) => {
    const entry = upstreamByAddress.get(address);
    if (entry) entry.shownIn.push(shownIn);
    else upstreamByAddress.set(address, { variantId, shownIn: [shownIn] });
  };
  const pushDecision = (status: "accepted" | "none", line: string) => {
    (status === "accepted" ? accepted : unaccepted).push(line);
  };
  const groups: FeedbackGroup[] = [];
  const groupByAddress = new Map<string, FeedbackGroup>();
  const pushFeedback = (address: string, item: string) => {
    let group = groupByAddress.get(address);
    if (!group) {
      group = { address, items: [] };
      groupByAddress.set(address, group);
      groups.push(group);
    }
    group.items.push(item);
  };

  if (record.mode === "reference-preview" || record.mode === "direction-preview") {
    // A direction acceptance covers a section of the page rather than one part, so it is reported
    // against the section itself instead of any single `direction:<part>` address.
    for (const [section, decision] of Object.entries(record.directionDecisions ?? {})) {
      const address = `direction:${section}`;
      pushDecision(decision, address);
    }
    for (const d of (record.decisions as ReviewDecisionEntry[] | null) ?? []) {
      // A bare comment leaves status unset; only an explicit accept/none is an outcome, so
      // feedback-only entries stay out of both lists.
      if (d.status) {
        const variant = d.variantId ? ` (${d.variantId})` : "";
        pushDecision(d.status, `${d.address}${variant}`);
      }
      for (const fb of d.feedback.filter(isSessionFeedback)) {
        pushFeedback(d.address, formatAnimaticFeedbackItem(fb, d.address));
      }
    }
  } else {
    // A reel stage's decisions are per-shot accepted/none; expand each, in timeline order, into
    // `<address> (<variantId>)` lines of the shot's own takes: an accept's as the reviewer saw or
    // heard them, an un-accept's as it released them. The rest of an accepted shot's takes are
    // upstream of it.
    const stage = record.stage === "animatic" ? "animatic" : "video";
    const shotDecisions = (record.decisions as Record<string, "accepted" | "none"> | null) ?? {};
    const shotsById = new Map(record.context.shots.map((s) => [s.shotId, s]));
    for (const shotId of reelShotOrder(record)) {
      const status = shotDecisions[shotId];
      if (!status) continue;
      const shot = shotsById.get(shotId);
      let variants: Array<[string, string]>;
      if (status === "accepted" && shot?.sources) {
        const ownPrefix = `${formatShotAddress(stage, shotId)}.`;
        variants = [];
        for (const [address, variantId] of Object.entries(shot.sources)) {
          if (address.startsWith(ownPrefix)) {
            variants.push([address, variantId]);
            ownAccepted.add(address);
          } else {
            pushUpstream(address, variantId, `shot.${shotId}`);
          }
        }
      } else {
        variants = Object.entries(shot?.variants ?? {}).map(([assetName, variantId]) => [
          formatAddress(stage, shotId, assetName),
          variantId,
        ]);
      }
      if (variants.length > 0) {
        for (const [address, variantId] of variants)
          pushDecision(status, `${address} (${variantId})`);
      } else {
        // A shot that generates nothing of its own (its picture is composed entirely from
        // animatic/reference takes) has no variant to name. Beside sibling lines that all carry
        // one, a bare address reads as a half-recorded accept — so say why it has none.
        pushDecision(
          status,
          `${formatShotAddress(stage, shotId)} (${shotVariantlessReason(record, stage, shotId)})`,
        );
      }
    }

    // Non-audio timeline assets (images, logos) are accepted through the compositions that
    // consume them — only when every shot is explicitly accepted, the exact rule submit applies.
    const allShotsOk = record.context.shots.every((s) => shotDecisions[s.shotId] === "accepted");
    const listed = new Set<string>();
    if (allShotsOk) {
      for (const [assetName, variantId] of Object.entries(record.context.timeline ?? {})) {
        const address = formatTimelineAddress(stage, assetName);
        listed.add(address);
        pushDecision("accepted", `${address} (${variantId})`);
      }
    }
    if (record.timelineStemDecision === "accepted") {
      const ownPrefix = `${stage}:timeline.`;
      for (const [address, variantId] of Object.entries(record.context.timelineSources ?? {})) {
        if (listed.has(address)) continue;
        if (address.startsWith(ownPrefix)) pushDecision("accepted", `${address} (${variantId})`);
        else pushUpstream(address, variantId, "timeline#stem");
      }
    }
    if (record.thumbnailDecision === "accepted") {
      for (const [address, variantId] of Object.entries(record.context.thumbnailSources ?? {})) {
        if (listed.has(address)) continue;
        if (isThumbnailAddress(address)) pushDecision("accepted", `${address} (${variantId})`);
        else pushUpstream(address, variantId, "thumbnail");
      }
    }

    const shotStartById = shotStarts(record);
    for (const note of record.notes ?? []) {
      const shotStart = note.shotId ? shotStartById.get(note.shotId) : undefined;
      const frame = note.id ? noteFrames?.get(note.id) : undefined;
      pushFeedback(note.address, formatVideoNoteItem(note, note.shotId, shotStart, frame));
    }
  }

  const cascadeVia = new Map((record.cascadeAccepted ?? []).map((c) => [c.address, c.via]));
  const upstream = [...upstreamByAddress]
    .filter(([address]) => !ownAccepted.has(address))
    .map(([address, { variantId, shownIn }]) => {
      const via = cascadeVia.get(address);
      return `${address} (${variantId}) — in ${shownIn.join(", ")}${via ? `, accepted via ${via}` : ""}`;
    });

  return { accepted, unaccepted, upstream, feedback: groups };
}

// Why a video shot's decision line names no variant. The record itself says which: a composition
// leaf it snapshotted (`contentHashes`) or accepted through the shot (`cascadeAccepted`) means the
// shot is composed, not generated; absent both, it is an undeveloped `pendingShot` — no leaf either.
function shotVariantlessReason(record: ReviewRecord, stage: ShotStage, shotId: string): string {
  const composition = formatCompositionAddress(stage, shotId);
  const hasComposition =
    record.context.contentHashes?.[composition] !== undefined ||
    (record.cascadeAccepted ?? []).some((c) => c.address === composition);
  return hasComposition ? "composition only" : "no generated assets";
}

// The take a comment was written against, from its snapshotted `displayedVariants` — what decides
// whether it still speaks about the take on screen. A comment on the address holding the variant
// names it bare; a subject spanning several addresses (a composition and its upstreams) names each.
function formatSawVariants(address: string, displayed?: Record<string, string>): string {
  const entries = Object.entries(displayed ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "";
  const body =
    entries.length === 1 && entries[0]![0] === address
      ? entries[0]![1]
      : entries.map(([addr, vid]) => `${addr}=${vid}`).join(", ");
  return ` [saw: ${body}]`;
}

function formatAnimaticFeedbackItem(
  fb: ReviewDecisionEntry["feedback"][number],
  address: string,
): string {
  const pin =
    fb.annotation?.kind === "pin"
      ? ` (pin: ${fb.annotation.x.toFixed(2)}, ${fb.annotation.y.toFixed(2)})`
      : "";
  const saw = formatSawVariants(address, fb.displayedVariants);
  const tags: string[] = [];
  if (fb.added) tags.push("added");
  if (fb.edited) tags.push("edited");
  if (fb.stale) tags.push("stale");
  const tagStr = tags.length > 0 ? ` [${tags.join("] [")}]` : "";
  return `[${fb.id}]${pin} ${fb.text}${saw}${tagStr}`;
}

type ReviewNote = NonNullable<ReviewRecord["notes"]>[number];

/**
 * Each shot's timeline start, from the record's own durations in timeline order. A note's global
 * `time` minus this is its within-shot position — what `<Audio start>` takes.
 */
function shotStarts(record: ReviewRecord): Map<string, number> {
  return new Map(record.context.shots.map((s) => [s.shotId, s.start]));
}

function formatVideoNoteItem(
  note: ReviewNote,
  shotId?: string,
  shotStart?: number,
  frame?: string,
): string {
  const id = note.id ? `[${note.id}] ` : "";
  const pin =
    note.x !== undefined && note.y !== undefined
      ? ` (pin: ${note.x.toFixed(2)}, ${note.y.toFixed(2)})`
      : "";
  const image = frame ? ` [image: ${frame}]` : "";
  const local =
    shotStart !== undefined ? ` (shot.${shotId} +${formatSeconds(note.time - shotStart)})` : "";
  const saw = formatSawVariants(note.address, note.displayedVariants);
  return `${id}${formatSeconds(note.time)}${local}${pin} ${note.text}${saw}${image}`;
}

/** What one note's frame needs to be rendered and captioned. */
interface ReviewNoteFrameTarget {
  /** The feedback id — a pinned note's frame is named after it, and it keys the caller's result. */
  id: string;
  shotId: string;
  /** Offset within the shot, which is what a composition capture takes. */
  localTime: number;
  annotation: FeedbackAnnotation | null;
  /**
   * What the contact-sheet cell is captioned with. ASCII only, and never the comment's own text:
   * drawtext renders with whatever font ffmpeg found, which will not cover the project's working
   * language.
   */
  label: string;
}

/**
 * The notes of a review that can carry a frame, in timeline order — the cells of its contact
 * sheet. Nothing is recorded about the frames themselves: the caller resolves them per shot through
 * `resolveShotFeedbackFrames` and drops what it cannot get.
 */
export function reviewNoteFrameTargets(record: ReviewRecord): ReviewNoteFrameTarget[] {
  const starts = shotStarts(record);
  const eligible = (record.notes ?? []).filter(
    (n): n is ReviewNote & { id: string; shotId: string } =>
      n.id !== undefined && n.shotId !== undefined,
  );
  // Timeline order, not the order the comments were typed in: a sheet is read as a pass over the
  // piece.
  const ordered = eligible
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.time - b.note.time || a.index - b.index);

  return ordered.map(({ note }) => {
    const start = starts.get(note.shotId) ?? 0;
    return {
      id: note.id,
      shotId: note.shotId,
      localTime: note.time - start,
      annotation:
        note.x !== undefined && note.y !== undefined
          ? { kind: "pin" as const, x: note.x, y: note.y }
          : null,
      label: `${note.id} shot.${note.shotId} +${formatSeconds(note.time - start)}`,
    };
  });
}
