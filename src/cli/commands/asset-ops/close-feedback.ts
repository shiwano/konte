import {
  FeedbackManager,
  feedbackStaleness,
  listAllFeedback,
  signedOffOver,
} from "../../../core/feedback/index.js";
import { loadFeedbackStaleContext } from "../feedback/stale-context.js";

// An accept from the CLI is never the one a comment's own review made, so it answers every standing
// comment it signed off over at once.
export async function closeSignedOffFeedback(videoRoot: string, since: number): Promise<void> {
  const { state, ctx } = await loadFeedbackStaleContext(videoRoot);
  const due = (await listAllFeedback(videoRoot)).filter(({ address, entry }) => {
    const at = signedOffOver(entry, address, state);
    return at !== null && at >= since && feedbackStaleness(entry, address, state, ctx) !== "stale";
  });
  const closedAt = new Date().toISOString();
  for (const stage of new Set(due.map((d) => d.stage))) {
    await FeedbackManager.withLock(videoRoot, stage, async (manager) => {
      for (const d of due) {
        if (d.stage === stage) manager.closeFeedback(d.address, d.entry.id, closedAt);
      }
    });
  }
  for (const { address, entry } of due) {
    console.log(`Closed: ${address} [${entry.id}] ${entry.text.replace(/\s*\n\s*/g, " ")}`);
  }
}
