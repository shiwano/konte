import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  type ShotStage,
  DIRECTION_SECTIONS,
  formatAddress,
  formatCompositionAddress,
  formatTimelineAddress,
  formatTimelineStemAddress,
} from "./address.js";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError } from "./errors.js";
import { isWithinRootRealAsync } from "./path-containment.js";
import { type FeedbackAnnotation, NormalizedCoordSchema } from "./types/feedback.js";

const ReviewDecisionEntrySchema = z.object({
  address: z.string(),
  variantId: z.string().optional(),
  status: z.enum(["accepted", "none"]).optional(),
  feedback: z.array(
    z.object({
      id: z.string(),
      // x/y are normalized to the frame (0-1 from its top-left), as in FeedbackAnnotationSchema.
      annotation: z
        .object({
          kind: z.literal("pin"),
          x: NormalizedCoordSchema,
          y: NormalizedCoordSchema,
        })
        .nullable(),
      text: z.string(),
      // The take the comment was written against, as `FeedbackEntry.displayedVariants` holds it
      // (address -> variantId at authoring time). Copied into the record so a reread names the take
      // without resolving the live feedback stream, which a later reroll has already moved on from.
      displayedVariants: z.record(z.string(), z.string()).optional(),
      stale: z.boolean(),
      added: z.literal(true).optional(),
      edited: z.literal(true).optional(),
    }),
  ),
});

export type ReviewDecisionEntry = z.infer<typeof ReviewDecisionEntrySchema>;

// The video stage's `decisions`: shotId -> accept toggle. Exported so the preview submit handler
// validates the client payload with the same schema the record is read back through — an unvalidated
// map would persist and then be silently skipped on read, losing the whole review.
export const VideoReviewDecisionsSchema = z.record(z.string(), z.enum(["accepted", "none"]));
export const ReviewAcceptDecisionSchema = z.enum(["accepted", "none"]);

// `decisions` is mode-shaped: animatic/reference/direction store an entry array,
// video stores a per-shot accept map. Validate both so a malformed decision surfaces
// as a corrupt record (skip) instead of an untyped TypeError in a consumer.
const ReviewDecisionsSchema = z
  .union([z.array(ReviewDecisionEntrySchema), VideoReviewDecisionsSchema])
  .nullish();

export const ReviewRecordSchema = z.object({
  mode: z.enum(["video-preview", "animatic-preview", "reference-preview", "direction-preview"]),
  stage: z.enum(["animatic", "video", "reference", "direction"]).optional(),
  // ISO 8601 (e.g. "2026-05-16T12:00:00.000Z"). The compact file id is derived
  // from this via `toReviewFileId`.
  createdAt: z.string(),
  context: z.object({
    shots: z.array(
      z.object({
        shotId: z.string(),
        duration: z.number(),
        variants: z.record(z.string(), z.string()),
      }),
    ),
    // Stage-level timeline assets (assetName -> variantId). Not shot-scoped, so
    // kept separate from `shots`.
    timeline: z.record(z.string(), z.string()).optional(),
    // Direction reviews only: the part hash of every reviewable direction part at submit
    // (full `direction:<part>` address -> hash) — the baseline `review handoff new
    // direction` diffs against, playing the role `shots`/`timeline` variant ids play for
    // the media stages.
    directionParts: z.record(z.string(), z.string()).optional(),
    // Video reviews only: the content hash of every materialized leaf shown — each composition
    // (`shot.<id>#composition`) and audio stem (`shot.<id>#stem`, `timeline#stem`) — at submit,
    // keyed by full address. A leaf has no reviewed variant id (it materializes only on accept), so
    // this hash of its (definitionHash, inputFingerprints) is its baseline, the role `directionParts`
    // plays for the direction: `review handoff new` diffs a leaf's live content against it to seed a
    // note when a definition edit or an upstream take swap changed what the reviewer saw or heard.
    // Not a variant `outputHash` — see `materializedLeafContentHash`.
    contentHashes: z.record(z.string(), z.string()).optional(),
  }),
  decisions: ReviewDecisionsSchema,
  // The timeline audio stem (soundtrack beds) accept decision. Per-shot audio is folded into its
  // shot's decision above; the beds are signed off here via `timeline#stem`.
  timelineStemDecision: z.enum(["accepted", "none"]).optional(),
  // The direction's accept decisions, one per section of the review page the reviewer
  // settled ("none" is an explicit revoke). The direction is variant-less, so unlike every other
  // stage's acceptance these have no `decisions` entry to ride on and are carried here instead. A
  // section the review left untouched is absent, so the record says what was decided, not what the
  // resulting state was. Absent entirely when the review settled nothing (feedback-only).
  directionDecisions: z.record(z.enum(DIRECTION_SECTIONS), z.enum(["accepted", "none"])).optional(),
  // Direction only: where the acceptance gate stood once this review's decisions landed. A
  // snapshot, like `directionParts` — a later edit re-blocks parts this record shows settled, and
  // `konte status` owns the live gate.
  directionGate: z
    .object({ open: z.boolean(), blocking: z.number(), total: z.number() })
    .optional(),
  // Targets signed off implicitly, as a side effect of another accept, rather than through a
  // decision line of their own — so `review record show` reflects the acceptance `status` computes
  // instead of hiding it. Each entry names the address it was accepted through (`via`): a shot's
  // composition and audio stem via the shot (`video:shot.<id>`), and each audio source via its stem
  // (`shot.<id>#stem` / `timeline#stem`) — e.g. a BGM bed under `timeline#stem`.
  cascadeAccepted: z.array(z.object({ address: z.string(), via: z.string() })).optional(),
  // Accepted takes this review kept against a newer upstream (`keptInputs`).
  kept: z.array(z.string()).optional(),
  // Accepted takes the reviewer decided to regenerate against a newer upstream.
  regenerate: z.array(z.string()).optional(),
  // Video only: targets the reviewer decided on whose verdict did NOT land in state — checked
  // against state after the fact rather than inferred from the submit path having run. `decisions`
  // above therefore names outcomes, not requests, exactly as the other stages' entries do. A verdict
  // can legitimately not land (an animatic whose refs stopped resolving mid-review), and a review
  // that quietly recorded it as accepted anyway is how a whole review went missing once.
  // One shot decision covers several leaves, so it can appear here more than once, under each leaf
  // it promised. `shotId` is absent for the timeline beds, which are nobody's shot.
  skippedDecisions: z
    .array(z.object({ shotId: z.string().optional(), address: z.string(), reason: z.string() }))
    .optional(),
  notes: z
    .array(
      z.object({
        // The feedback id the note was stored under. Present on records written by current clients.
        id: z.string().optional(),
        time: z.number(),
        shotId: z.string().optional(),
        // The target address the note is attached to (e.g. video:shot.03#composition).
        // Present on records written by current clients; older records derive it from shotId.
        address: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.string(),
        // The takes the note was written against — its subject's `displayedVariants`, as the
        // feedback stream stores them. Present on records written by current clients.
        displayedVariants: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  // The reviewer's word on the pass as a whole, written in the submit dialog. Not feedback: it
  // hangs off no address, so nothing goes stale against it and no accept re-signs it.
  overallComment: z.string().optional(),
  // Handoff notes (AI -> reviewer) attached to this preview session.
  handoffSummary: z.string().optional(),
  handoffNotes: z.array(z.object({ address: z.string(), text: z.string() })).optional(),
});

export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

// Compact, filename-safe, lexically-sortable timestamp in UTC
// (YYYYMMDDTHHmmssSSS). The single source of truth for all filename timestamps.
function formatCompactTimestamp(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    pad(d.getUTCMilliseconds(), 3)
  );
}

export function buildTimestamp(): string {
  return formatCompactTimestamp(new Date());
}

// A review's file id is its ISO `createdAt` rendered as a compact string, so the
// id and the data timestamp always describe the same instant.
export function toReviewFileId(createdAt: string): string {
  return formatCompactTimestamp(new Date(createdAt));
}

function hasDecisionEntries(record: ReviewRecord): boolean {
  const decisions = record.decisions as Array<unknown> | null;
  return Array.isArray(decisions) && decisions.length > 0;
}

export function hasFeedback(record: ReviewRecord): boolean {
  // The overall comment is a review on its own — it is what a reviewer who accepted nothing and
  // annotated nothing still has to say, and the submit dialog offers it for exactly that.
  if (record.overallComment) return true;
  if ((record.kept?.length ?? 0) > 0 || (record.regenerate?.length ?? 0) > 0) return true;
  switch (record.mode) {
    case "animatic-preview":
    case "video-preview":
      // Accept/un-accept decisions are real outcomes, but the submit handler persists those via the
      // `force` flag; on its own a reel review is only worth saving when it carries notes.
      return (record.notes?.length ?? 0) > 0;
    case "direction-preview":
      // A direction accept carries no `decisions` entry (it is variant-less), so an accept-only
      // review would otherwise save nothing — losing both the record and the watcher's
      // review-submitted notification.
      return Object.keys(record.directionDecisions ?? {}).length > 0 || hasDecisionEntries(record);
    case "reference-preview":
      return hasDecisionEntries(record);
    default:
      return false;
  }
}

// A stage's review stream lives under `review/<stage>/`, sharing that dir with
// `feedback.json`: submitted reviews nest in a `records/` subdir and the scaffolded
// handoffs in a `handoffs/` subdir.
export const REVIEW_DIR = "review";

// Reviews live under REVIEW_DIR/<stage>/records/.
function reviewRecordsDir(videoRoot: string, stage: string): string {
  return path.join(videoRoot, REVIEW_DIR, stage, "records");
}

// A record file is `<stage>/records/<ts>.json`; the sibling `feedback.json`
// and `handoffs/*.json` are not records, so only `records/`-parented `.json` counts.
function isReviewRecordRel(rel: string): boolean {
  return rel.endsWith(".json") && rel.split(path.sep).at(-2) === "records";
}

// Strips the `records/` segment so a record's public id stays stream-qualified
// (e.g. "video/20260516T120000000") rather than leaking the on-disk subdir.
function relToReviewId(rel: string): string {
  const segs = rel.slice(0, -".json".length).split(path.sep);
  if (segs.length >= 2 && segs[segs.length - 2] === "records") {
    segs.splice(segs.length - 2, 1);
  }
  return segs.join("/");
}

// A review stream is keyed per stage, so records nest under <stage>/records/. The file
// id is the stream-qualified relative path (records/ segment elided) without the extension
// (e.g. "video/20260516T120000000"), which `review record show` resolves back to a record.
async function listReviewFiles(dir: string): Promise<Array<{ id: string; filePath: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch {
    return [];
  }

  return (
    entries
      .filter(isReviewRecordRel)
      .map((rel) => ({
        id: relToReviewId(rel),
        filePath: path.join(dir, rel),
        base: path.basename(rel),
      }))
      // Newest-first across all streams: the basename is the sortable timestamp;
      // id breaks ties so the order is deterministic when two streams share an instant.
      .sort((a, b) => (a.base !== b.base ? (a.base < b.base ? 1 : -1) : a.id < b.id ? 1 : -1))
      .map(({ id, filePath }) => ({ id, filePath }))
  );
}

// The newest record in one stage's stream, if it was written at or after `sinceIso`. The preview's
// exit report falls back to this when a submit landed without reporting itself, so the record is
// named rather than left to be hunted for. The file id is the sortable compact form of createdAt,
// so this is a filename comparison and reads no record.
export async function findReviewRecordSince(
  videoRoot: string,
  stage: string,
  sinceIso: string,
): Promise<string | null> {
  const [newest] = await listReviewFiles(path.join(videoRoot, REVIEW_DIR, stage));
  if (!newest) return null;
  return path.basename(newest.filePath, ".json") >= toReviewFileId(sinceIso)
    ? newest.filePath
    : null;
}

export async function saveReviewRecord(
  videoRoot: string,
  record: ReviewRecord,
  { force = false }: { force?: boolean } = {},
): Promise<string | null> {
  if (!force && !hasFeedback(record)) return null;

  // Validate against the same schema the read path parses with: a record parts of which came from
  // a preview client would otherwise persist unvalidated and then be silently skipped on read —
  // the review would vanish. Writing the parsed value also strips unknown keys.
  const validated = ReviewRecordSchema.parse(record);

  const dir = reviewRecordsDir(videoRoot, reviewStage(validated));
  await fs.mkdir(dir, { recursive: true });

  const filename = `${toReviewFileId(validated.createdAt)}.json`;
  const filePath = path.join(dir, filename);
  await writeFileAtomic(filePath, JSON.stringify(validated, null, 2));
  return filePath;
}

// Reads persist untrusted JSON; validate it against the schema instead of a bare
// cast so a truncated/hand-edited record surfaces as a skip (or REVIEW_NOT_FOUND)
// rather than an untyped TypeError deep in a consumer. Every read path goes through this.
function parseReviewRecord(content: string): ReviewRecord {
  return ReviewRecordSchema.parse(JSON.parse(content));
}

export async function loadLatestReviewRecord(
  videoRoot: string,
  mode?: string,
): Promise<ReviewRecord | null> {
  const dir = path.join(videoRoot, REVIEW_DIR);

  for (const { filePath } of await listReviewFiles(dir)) {
    try {
      const record = parseReviewRecord(await fs.readFile(filePath, "utf-8"));
      if (mode !== undefined && record.mode !== mode) continue;
      return record;
    } catch {
      continue;
    }
  }

  return null;
}

export async function loadAllReviewRecords(
  videoRoot: string,
): Promise<Array<{ file: string; record: ReviewRecord }>> {
  const dir = path.join(videoRoot, REVIEW_DIR);

  const results: Array<{ file: string; record: ReviewRecord }> = [];
  for (const { id, filePath } of await listReviewFiles(dir)) {
    try {
      const record = parseReviewRecord(await fs.readFile(filePath, "utf-8"));
      results.push({ file: id, record });
    } catch {
      continue;
    }
  }

  return results;
}

export async function loadReviewRecordFile(videoRoot: string, file: string): Promise<ReviewRecord> {
  const withExt = file.endsWith(".json") ? file : `${file}.json`;
  // A stream-qualified id (<stage>/<ts>) elides the records/ subdir, so re-insert it to
  // hit the file directly; the raw candidates cover an on-disk path or an
  // already-records-qualified id.
  const segs = withExt.split("/");
  const qualified =
    segs.length >= 2 && segs[segs.length - 2] !== "records"
      ? [...segs.slice(0, -1), "records", segs[segs.length - 1]].join("/")
      : withExt;
  // The videoRoot-relative readings come first so they keep winning; the cwd reading catches a
  // path copied from a shell that sits elsewhere (a workspace-root `videos/<name>/review/…`).
  const candidates = [
    path.resolve(videoRoot, REVIEW_DIR, qualified),
    path.resolve(videoRoot, REVIEW_DIR, withExt),
    path.resolve(videoRoot, withExt),
    path.resolve(withExt),
  ];
  // The argument is typed by hand, so it can be a `..` escape or an absolute path elsewhere; a
  // record only ever lives under the video, so a candidate outside it is not one.
  for (const candidate of candidates) {
    if (!(await isWithinRootRealAsync(candidate, videoRoot))) continue;
    try {
      return parseReviewRecord(await fs.readFile(candidate, "utf-8"));
    } catch {
      continue;
    }
  }

  // A bare timestamp (no stream prefix) still resolves: locate it under the
  // nested layout by matching either the full id or its basename. Both sides are
  // reduced to a basename so a path rooted at neither videoRoot nor cwd lands too.
  const wanted = file.replace(/\.json$/, "");
  const wantedBase = path.basename(wanted);
  for (const { id, filePath } of await listReviewFiles(path.join(videoRoot, REVIEW_DIR))) {
    if (id === wanted || path.basename(id) === wanted || path.basename(id) === wantedBase) {
      if (!(await isWithinRootRealAsync(filePath, videoRoot))) continue;
      try {
        return parseReviewRecord(await fs.readFile(filePath, "utf-8"));
      } catch {
        continue;
      }
    }
  }

  throw new KonteError("REVIEW_NOT_FOUND", `Review file not found: ${file}`);
}

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

export function reviewStage(
  record: ReviewRecord,
): "animatic" | "video" | "reference" | "direction" {
  if (record.stage) return record.stage;
  if (record.mode === "animatic-preview") return "animatic";
  if (record.mode === "reference-preview") return "reference";
  if (record.mode === "direction-preview") return "direction";
  return "video";
}

// The stage prefix of an address (`video:shot.05` -> `video`); the whole string when it carries no
// prefix. Used to decide whether a cascade's provenance is worth showing.
function addressStage(address: string): string {
  const i = address.indexOf(":");
  return i === -1 ? address : address.slice(0, i);
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
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`Review: ${record.mode} (${reviewStage(record)}) ${record.createdAt}`);
  if (opts.filePath) lines.push(`File: ${opts.filePath}`);

  if (record.overallComment) {
    lines.push("");
    lines.push("Overall:");
    for (const line of record.overallComment.split("\n")) lines.push(`  ${line}`);
  }

  // Outcome, not gesture, is the axis: accept / un-accept / comment. A directly-judged accept and
  // one that rode in on another (a shot's composition/stem, an audio source under a stem) are the
  // same outcome, so they share one `Accepted` section — the cascade ones ordered after, tagged
  // with their driver only when it sits in another stage (within a stage the address already says
  // whose it is). Reporting outcomes separately keeps a feedback-only review from ever reading as a
  // set of approvals.
  const { accepted, acceptedAddresses, unaccepted, feedback } = collectReviewSections(
    record,
    opts.noteFrames,
  );

  const seen = new Set<string>();
  const cascadeLines: string[] = [];
  for (const { address, via } of record.cascadeAccepted ?? []) {
    // A cascade whose target already carries its own accept line is not repeated.
    if (acceptedAddresses.has(address) || seen.has(address)) continue;
    seen.add(address);
    cascadeLines.push(
      addressStage(address) === addressStage(via) ? address : `${address} (via ${via})`,
    );
  }
  const acceptedLines = [...accepted, ...cascadeLines];

  lines.push("");
  if (acceptedLines.length > 0) {
    lines.push("Accepted:");
    for (const line of acceptedLines) lines.push(`  ${line}`);
  } else {
    lines.push("Accepted: none submitted");
  }

  if (unaccepted.length > 0) {
    lines.push("");
    lines.push("Unaccepted:");
    for (const addr of unaccepted) lines.push(`  ${addr}`);
  }

  if ((record.kept ?? []).length > 0) {
    lines.push("");
    lines.push("Kept against newer upstream:");
    for (const addr of record.kept ?? []) lines.push(`  ${addr}`);
  }

  if ((record.regenerate ?? []).length > 0) {
    lines.push("");
    lines.push("Regenerate:");
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
  acceptedAddresses: Set<string>;
  unaccepted: string[];
  feedback: FeedbackGroup[];
} {
  const accepted: string[] = [];
  const acceptedAddresses = new Set<string>();
  const unaccepted: string[] = [];
  const pushDecision = (address: string, status: "accepted" | "none", line: string) => {
    if (status === "accepted") {
      accepted.push(line);
      acceptedAddresses.add(address);
    } else {
      unaccepted.push(line);
    }
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
      pushDecision(address, decision, address);
    }
    for (const d of (record.decisions as ReviewDecisionEntry[] | null) ?? []) {
      // A bare comment leaves status unset; only an explicit accept/none is an outcome, so
      // feedback-only entries stay out of both lists.
      if (d.status) {
        const variant = d.variantId ? ` (${d.variantId})` : "";
        pushDecision(d.address, d.status, `${d.address}${variant}`);
      }
      for (const fb of d.feedback.filter(isSessionFeedback)) {
        pushFeedback(d.address, formatAnimaticFeedbackItem(fb, d.address));
      }
    }
  } else {
    // A reel stage's decisions are per-shot accepted/none; expand each into per-asset lines with
    // variant IDs so the output names addresses (`<address> (<variantId>)`) instead of the
    // ambiguous bare `01`.
    const stage = reviewStage(record) === "animatic" ? "animatic" : "video";
    const shotDecisions = (record.decisions as Record<string, "accepted" | "none"> | null) ?? {};
    const shotsById = new Map(record.context.shots.map((s) => [s.shotId, s]));
    // A shot decision covers the shot's picture AND its audio (via its stem, cascaded), so every
    // resolved asset is listed under the shot.
    for (const [shotId, status] of Object.entries(shotDecisions)) {
      const variants = Object.entries(shotsById.get(shotId)?.variants ?? {});
      if (variants.length > 0) {
        for (const [assetName, variantId] of variants) {
          const address = formatAddress(stage, shotId, assetName);
          pushDecision(address, status, `${address} (${variantId})`);
        }
      } else {
        // A shot that generates nothing of its own (its picture is composed entirely from
        // animatic/reference takes) has no variant to name. Beside sibling lines that all carry
        // one, a bare address reads as a half-recorded accept — so say why it has none.
        const address = `${stage}:shot.${shotId}`;
        pushDecision(
          address,
          status,
          `${address} (${shotVariantlessReason(record, stage, shotId)})`,
        );
      }
    }

    // The timeline audio stem (soundtrack beds), signed off in context.
    if (record.timelineStemDecision) {
      const address = formatTimelineStemAddress(stage);
      pushDecision(address, record.timelineStemDecision, address);
    }

    // Non-audio timeline assets (overlays/logos) are accepted through the compositions that
    // consume them — only when every shot is explicitly accepted, the exact rule submit applies.
    const timeline = Object.entries(record.context.timeline ?? {});
    if (timeline.length > 0) {
      const allShotsOk = record.context.shots.every((s) => shotDecisions[s.shotId] === "accepted");
      if (allShotsOk) {
        for (const [assetName, variantId] of timeline) {
          const address = formatTimelineAddress("video", assetName);
          pushDecision(address, "accepted", `${address} (${variantId})`);
        }
      }
    }

    const shotStartById = shotStarts(record);
    for (const note of record.notes ?? []) {
      const address = note.address ?? (note.shotId ? `video:shot.${note.shotId}` : `video`);
      const shotStart = note.shotId ? shotStartById.get(note.shotId) : undefined;
      const frame = note.id ? noteFrames?.get(note.id) : undefined;
      pushFeedback(address, formatVideoNoteItem(note, note.shotId, shotStart, frame));
    }
  }

  return { accepted, acceptedAddresses, unaccepted, feedback: groups };
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
  const starts = new Map<string, number>();
  let acc = 0;
  for (const s of record.context.shots) {
    starts.set(s.shotId, acc);
    acc += s.duration;
  }
  return starts;
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
    shotStart !== undefined ? ` (shot.${shotId} +${(note.time - shotStart).toFixed(1)}s)` : "";
  const saw = formatSawVariants(
    note.address ?? (shotId ? `video:shot.${shotId}` : "video"),
    note.displayedVariants,
  );
  return `${id}${note.time.toFixed(1)}s${local}${pin} ${note.text}${saw}${image}`;
}

/** What one note's frame needs to be rendered and captioned. */
export interface ReviewNoteFrameTarget {
  /** The feedback id — a pinned note's frame is named after it, and it keys the caller's result. */
  id: string;
  address: string;
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
 * The notes of a video review that can carry a frame, in timeline order — the cells of its contact
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
      address: note.address ?? `video:shot.${note.shotId}`,
      shotId: note.shotId,
      localTime: note.time - start,
      annotation:
        note.x !== undefined && note.y !== undefined
          ? { kind: "pin" as const, x: note.x, y: note.y }
          : null,
      label: `${note.id} shot.${note.shotId} +${(note.time - start).toFixed(1)}s`,
    };
  });
}
