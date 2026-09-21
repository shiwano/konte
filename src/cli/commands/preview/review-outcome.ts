import * as fs from "node:fs/promises";
import { ReviewRecordSchema, findReviewRecordSince } from "../../../core/review-record.js";
import type { PreviewServerOptions } from "./server.js";

/**
 * Where one submitted review landed. Every submit handler reports one; the preview prints it once
 * on exit and nowhere else — a backgrounded run's only signal is the process ending, so that exit
 * has to answer "was a review submitted, and where is it".
 */
export interface ReviewOutcome {
  stage: "video" | "animatic" | "reference" | "direction";
  // null when the submit landed but settled nothing — an empty review is still a submit.
  filePath: string | null;
  // The submit never reported; the record was found on disk afterwards. Said out loud because the
  // reasons differ (a drain that timed out, a handler that died after writing) and only the record
  // itself says what landed.
  recovered?: true;
  // Accepted takes the reviewer decided to regenerate.
  regenerate?: string[];
}

// The steps a Regenerate decision leaves: its takes were dismissed, so `generate` makes them again,
// stage by stage in pipeline order.
function regenerateCommands(outcome: ReviewOutcome | null): string[] {
  const stages = new Set((outcome?.regenerate ?? []).map((address) => address.split(":")[0]));
  return ["reference", "animatic", "video"]
    .filter((stage) => stages.has(stage))
    .map((stage) => `konte generate ${stage}`);
}

export type ReportOutcome = (outcome: ReviewOutcome) => void;

function reviewTitle(mode: PreviewServerOptions["mode"]): string {
  return mode === "reference-preview"
    ? "Reference Review"
    : mode === "animatic-preview"
      ? "Animatic Review"
      : mode === "direction-preview"
        ? "Direction Review"
        : "Video Review";
}

// A submit that touched nothing. Still an outcome, and not the same as a close.
export function emptyOutcome(stage: ReviewOutcome["stage"]): ReviewOutcome {
  return { stage, filePath: null };
}

/**
 * Which of two outcomes the exit line reports. Later wins, except that an empty submit never
 * displaces a record: two submits can be in flight at once (a double-clicked button, a client
 * retry), and the record is the only thing the line can point at.
 */
export function mergeReviewOutcome(prev: ReviewOutcome | null, next: ReviewOutcome): ReviewOutcome {
  return next.filePath === null && prev?.filePath ? prev : next;
}

// The preview's whole report, printed once when it exits and nowhere else. Says how the session
// ended and where the record is; what the review decided is the record's alone.
export function printReviewOutcome(
  mode: PreviewServerOptions["mode"],
  outcome: ReviewOutcome | null,
  drainTimedOut = false,
): void {
  const title = reviewTitle(mode);
  // The one line that outranks the outcome: a submit the session gave up waiting for may have
  // written half of what it meant to, so what is reported below is a floor, not the whole of it.
  if (drainTimedOut) {
    console.log(`${title}: a submit was still running when the session ended`);
    console.log("  konte review record list");
  }
  if (!outcome) {
    if (!drainTimedOut) console.log(`${title}: not submitted (closed without submitting)`);
    return;
  }
  if (!outcome.filePath) {
    if (!drainTimedOut) console.log(`${title}: submitted, but nothing to record (no changes)`);
    return;
  }

  console.log(
    outcome.recovered
      ? `${title}: submitted (recovered — the submit did not report before exit)`
      : `${title}: submitted`,
  );
  console.log(`  konte review record show ${outcome.filePath}`);
  for (const command of regenerateCommands(outcome)) console.log(`  ${command}`);
}

/**
 * Last resort when a submit landed without reporting: a record written into this stage's stream
 * during the session is that submit's, since nothing but a submit writes one. Reported as recovered
 * rather than as a plain submit — the session cannot say what else the handler did or did not
 * finish, only that this record exists.
 */
export async function recoverOutcome(
  videoRoot: string,
  mode: PreviewServerOptions["mode"],
  sessionStart: string,
): Promise<ReviewOutcome | null> {
  const stage = stageOfMode(mode);
  try {
    const filePath = await findReviewRecordSince(videoRoot, stage, sessionStart);
    if (!filePath) return null;
    const record = ReviewRecordSchema.safeParse(JSON.parse(await fs.readFile(filePath, "utf-8")));
    const regenerate = record.success ? (record.data.regenerate ?? []) : [];
    return { stage, filePath, recovered: true, ...(regenerate.length > 0 ? { regenerate } : {}) };
  } catch {
    return null;
  }
}

function stageOfMode(mode: PreviewServerOptions["mode"]): ReviewOutcome["stage"] {
  return mode === "reference-preview"
    ? "reference"
    : mode === "animatic-preview"
      ? "animatic"
      : mode === "direction-preview"
        ? "direction"
        : "video";
}
