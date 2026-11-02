import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { FeedbackManager, findFeedback } from "../../../core/feedback/index.js";
import { confirmAction, printAborted, NO_FLAG_DESCRIPTION } from "../../confirm.js";
import { requireVideoRoot } from "../../context.js";

export function registerFeedbackDeleteCommand(program: Command): void {
  program
    .command("delete <feedbackId>")
    .description("Delete a feedback entry")
    .option("--no", NO_FLAG_DESCRIPTION)
    .action(async (feedbackId: string, opts: { yes?: boolean; no?: boolean }) => {
      const videoRoot = requireVideoRoot();

      const found = await findFeedback(videoRoot, feedbackId);
      if (!found) {
        throw new KonteError("FEEDBACK_NOT_FOUND", `Feedback "${feedbackId}" not found`);
      }
      const { stage, address } = found;

      const confirmed = await confirmAction(
        `Feedback "${feedbackId}" on ${address} will be deleted.`,
        { yes: opts.yes, no: opts.no },
      );
      if (!confirmed) {
        printAborted();
        return;
      }

      await FeedbackManager.withLock(videoRoot, stage, async (manager) => {
        const success = manager.removeFeedback(address, feedbackId);
        if (!success) {
          throw new KonteError("FEEDBACK_NOT_FOUND", `Feedback "${feedbackId}" not found`);
        }

        console.log(`Deleted feedback ${feedbackId} from ${address}`);
      });
    });
}
