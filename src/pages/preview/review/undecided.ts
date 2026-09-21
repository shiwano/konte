import type { FeedbackInfo } from "../types.js";
import type { ReviewSession } from "./use-review-session.js";

/**
 * Addresses carrying a live reason not to accept — a comment drafted this session, or a saved
 * one that still applies.
 *
 * A stale comment does not count: what it was written about has since changed, or the reviewer
 * accepted over it — either way it says nothing about the take on screen now. Nor does a comment
 * deleted this session.
 *
 * A reviewable target that is neither accepted nor in this set is **undecided**: the review
 * record would show it unaccepted with no reason, which is exactly what an agent (or the
 * reviewer, later) cannot tell apart from "never looked at it". The submit confirmation names
 * them; it never blocks (see ReviewShell) — a forced decision only buys a rubber-stamp accept,
 * and a false accept propagates downstream where a blank does not.
 */
export function commentedAddresses(
  saved: FeedbackInfo[],
  session: Pick<ReviewSession, "pendingFeedback" | "deletedFeedbackIds">,
): Set<string> {
  const out = new Set<string>();
  for (const f of saved) {
    if (f.stale || session.deletedFeedbackIds.has(f.id)) continue;
    out.add(f.address);
  }
  for (const [address, drafts] of Object.entries(session.pendingFeedback)) {
    if (drafts.length > 0) out.add(address);
  }
  return out;
}
