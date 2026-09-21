import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { FeedbackManager, findFeedback } from "../../../core/feedback/index.js";
import { requireVideoRoot } from "../../context.js";

export function registerFeedbackEditCommand(program: Command): void {
  program
    .command("edit <feedbackId>")
    .description("Edit feedback text")
    .requiredOption("--text <text>", "New feedback text")
    .action(async (feedbackId: string, opts: { text: string }) => {
      const videoRoot = requireVideoRoot();

      const found = await findFeedback(videoRoot, feedbackId);
      if (!found) {
        throw new KonteError("FEEDBACK_NOT_FOUND", `Feedback "${feedbackId}" not found`);
      }
      const { stage, address } = found;

      await FeedbackManager.withLock(videoRoot, stage, async (manager) => {
        const success = manager.updateFeedbackText(address, feedbackId, opts.text);
        if (!success) {
          throw new KonteError("FEEDBACK_NOT_FOUND", `Feedback "${feedbackId}" not found`);
        }

        console.log(`Updated feedback ${feedbackId} at ${address}`);
      });
    });
}
