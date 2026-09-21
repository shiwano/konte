import type { Stage } from "../../core/address.js";
import {
  FeedbackManager,
  type FeedbackStaleness,
  feedbackStaleness,
} from "../../core/feedback/index.js";
import type { KonteState } from "../../core/types/index.js";
import { liveDefinitionHashes } from "./feedback/definition-hashes.js";
import type { StalenessCache } from "../../core/staleness.js";

// Feedback as `inspect` reports it. A stale comment no longer stands — its subject moved, or an
// accept was stamped over it — so it is counted but never quoted.
// with its flag, so a caller that wants the old text has it.

export interface FeedbackView {
  id: string;
  text: string;
  createdAt: string;
  staleness: FeedbackStaleness;
}

export type FeedbackReader = (address: string) => FeedbackView[];

// The reader for an asset stage. Live definition hashes carry the axes no variant does — a video
// leaf's definition, an animatic panel's movement — so they are loaded for both creative stages;
// `direction` builds its own reader, holding the part hashes already.
export async function assetFeedbackReader(
  videoRoot: string,
  stage: Stage,
  state: KonteState | null,
  // The caller's resolution memo: a comment's subject is the take its surface DISPLAYS, so it has
  // to be read by the same rule that surface resolved it with.
  cache?: StalenessCache,
): Promise<FeedbackReader> {
  const manager = await FeedbackManager.load(videoRoot, stage);
  const definitionHashes =
    stage === "video" || stage === "animatic" ? await liveDefinitionHashes(videoRoot) : undefined;
  return (address) =>
    manager.getFeedback(address).map((entry) => ({
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      staleness: state
        ? feedbackStaleness(entry, address, state, { definitionHashes, cache })
        : "unknown",
    }));
}

function feedbackSummary(feedback: readonly FeedbackView[]): string {
  const stale = feedback.filter((f) => f.staleness === "stale").length;
  const word = `${feedback.length} comment${feedback.length === 1 ? "" : "s"}`;
  return stale > 0 ? `${word}, ${stale} stale` : word;
}

// The trailing count on a listing line, absent when there is nothing to say.
export function feedbackTag(feedback: readonly FeedbackView[]): string {
  return feedback.length > 0 ? ` [${feedbackSummary(feedback)}]` : "";
}

// One comment as every listing quotes it.
export function feedbackLine(entry: FeedbackView): string {
  return `  [${entry.id}] ${entry.text.replace(/\s+/g, " ").trim()}`;
}

export function printFeedback(feedback: readonly FeedbackView[]): void {
  if (feedback.length === 0) return;
  console.log("");
  console.log(`Feedback: ${feedbackSummary(feedback)}`);
  for (const f of feedback) {
    if (f.staleness === "stale") continue;
    console.log(feedbackLine(f));
  }
}
