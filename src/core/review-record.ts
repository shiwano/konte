import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { type Stage, DIRECTION_SECTIONS } from "./address.js";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError } from "./errors.js";
import { isWithinRootRealAsync } from "./path-containment.js";
import { NormalizedCoordSchema } from "./types/feedback.js";
import { REVIEW_MODES, REVIEW_STAGES } from "./review-mode.js";

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
  mode: z.enum(REVIEW_MODES),
  stage: z.enum(REVIEW_STAGES),
  // ISO 8601 (e.g. "2026-05-16T12:00:00.000Z"). The compact file id is derived
  // from this via `toReviewFileId`.
  createdAt: z.string(),
  context: z.object({
    shots: z.array(
      z.object({
        shotId: z.string(),
        // Where the shot stood on the timeline the reviewer played — frame-snapped, which a sum of
        // the durations is not.
        start: z.number(),
        duration: z.number(),
        variants: z.record(z.string(), z.string()),
        // The takes the shot's composition places and its stems mix (address -> variantId), as the
        // reviewer saw and heard them. Absent on a shot with no composition.
        sources: z.record(z.string(), z.string()).optional(),
      }),
    ),
    // Stage-level timeline assets (assetName -> variantId). Not shot-scoped, so
    // kept separate from `shots`.
    timeline: z.record(z.string(), z.string()).optional(),
    // The takes `timeline#stem` mixes (address -> variantId), as the reviewer heard them.
    timelineSources: z.record(z.string(), z.string()).optional(),
    // The takes the video's thumbnail draws (address -> variantId), as the reviewer saw them.
    thumbnailSources: z.record(z.string(), z.string()).optional(),
    // Direction reviews only: the part hash of every reviewable direction part at submit
    // (full `direction:<part>` address -> hash) — the baseline a refused handoff note diffs
    // against to name the changed parts, playing the role `shots`/`timeline` variant ids play
    // for the media stages.
    directionParts: z.record(z.string(), z.string()).optional(),
    // Video reviews only: the content hash of every materialized leaf shown — each composition
    // (`shot.<id>#composition`) and audio stem (`shot.<id>#stem`, `timeline#stem`) — at submit,
    // keyed by full address. A leaf has no reviewed variant id (it materializes only on accept), so
    // this hash of its (definitionHash, inputFingerprints) is its baseline, the role `directionParts`
    // plays for the direction: a refused handoff note diffs a leaf's live content against it to name
    // the leaf when a definition edit or an upstream take swap changed what the reviewer saw or heard.
    // Not a variant `outputHash` — see `materializedLeafContentHash`.
    contentHashes: z.record(z.string(), z.string()).optional(),
  }),
  decisions: ReviewDecisionsSchema,
  // The timeline audio stem (soundtrack beds) accept decision. Per-shot audio is folded into its
  // shot's decision above; the beds are signed off here via `timeline#stem`.
  timelineStemDecision: z.enum(["accepted", "none"]).optional(),
  // The overlay's accept decision at `<stage>:timeline#overlay`: signed off with the last shot
  // accept under it, or on its own once every shot accept stands.
  overlayDecision: z.enum(["accepted", "none"]).optional(),
  // The video's thumbnail accept decision, at `video:thumbnail#still`.
  thumbnailDecision: z.enum(["accepted", "none"]).optional(),
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
  // decision line of their own. Each entry names the address it was accepted through (`via`): a shot's
  // composition and audio stem via the shot (`video:shot.<id>`), and each audio source via its stem
  // (`shot.<id>#stem` / `timeline#stem`) — e.g. a BGM bed under `timeline#stem`.
  cascadeAccepted: z.array(z.object({ address: z.string(), via: z.string() })).optional(),
  // Takes this review accepted that an earlier accept or `konte dismiss` had dismissed, with the
  // accept each one displaced.
  overturned: z
    .array(
      z.object({ address: z.string(), variantId: z.string(), displaced: z.string().optional() }),
    )
    .optional(),
  // Reference only: the lyric lines this review placed on takes of the song, a null span cleared.
  songLines: z
    .array(
      z.object({
        address: z.string(),
        variantId: z.string(),
        key: z.string(),
        span: z.object({ startSec: z.number(), endSec: z.number() }).nullable(),
      }),
    )
    .optional(),
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
        // The feedback id the note was stored under. Absent when the submit could not pair the note
        // with the feedback it stored.
        id: z.string().optional(),
        time: z.number(),
        shotId: z.string().optional(),
        // The target address the note is attached to (e.g. video:shot.03#composition).
        address: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.string(),
        // The takes the note was written against — its subject's `displayedVariants`, as the
        // feedback stream stores them. Absent when its subject showed no take.
        displayedVariants: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  // The reviewer's word on the pass as a whole, written in the submit dialog. Also stored as feedback
  // on the bare stage.
  overallComment: z.string().optional(),
  // Handoff notes (AI -> reviewer) attached to this preview session.
  handoffId: z.string().optional(),
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
      return hasDecisionEntries(record) || (record.songLines?.length ?? 0) > 0;
    default:
      return false;
  }
}

// A stage's review stream lives under `review/<stage>/`, sharing that dir with
// `feedback.json`: submitted reviews nest in a `records/` subdir and the
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

// Whether a record in one stage's stream showed the handoff `handoffId`. Only a record submitted
// after the handoff was written can have, so older ones are never read.
export async function reviewShowedHandoff(
  videoRoot: string,
  stage: string,
  handoffId: string,
): Promise<boolean> {
  for (const { filePath } of await listReviewFiles(path.join(videoRoot, REVIEW_DIR, stage))) {
    if (path.basename(filePath, ".json") <= handoffId) return false;
    try {
      if (parseReviewRecord(await fs.readFile(filePath, "utf-8")).handoffId === handoffId) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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

export async function reviewTimes(videoRoot: string): Promise<Map<Stage, string[]>> {
  const out = new Map<Stage, string[]>();
  for (const stage of ["animatic", "video", "reference", "direction"] as const) {
    const times: string[] = [];
    for (const { filePath } of await listReviewFiles(path.join(videoRoot, REVIEW_DIR, stage))) {
      try {
        times.push(parseReviewRecord(await fs.readFile(filePath, "utf-8")).createdAt);
      } catch {
        continue;
      }
    }
    out.set(stage, times);
  }
  return out;
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

  const dir = reviewRecordsDir(videoRoot, validated.stage);
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
  const raw = JSON.parse(content);
  // SUNSET(0.6.0): brief sign-offs
  if (raw?.directionDecisions) delete raw.directionDecisions.brief;
  return ReviewRecordSchema.parse(raw);
}

export async function loadLatestReviewRecord(
  videoRoot: string,
  stage?: Stage,
): Promise<ReviewRecord | null> {
  const dir = path.join(videoRoot, REVIEW_DIR);

  for (const { filePath } of await listReviewFiles(dir)) {
    try {
      const record = parseReviewRecord(await fs.readFile(filePath, "utf-8"));
      if (stage !== undefined && record.stage !== stage) continue;
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
