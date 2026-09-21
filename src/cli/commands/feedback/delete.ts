import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { FeedbackManager, findFeedback } from "../../../core/feedback/index.js";
import { confirmAction, printAborted } from "../../confirm.js";
import { requireVideoRoot } from "../../context.js";

export function registerFeedbackDeleteCommand(program: Command): void {
  program
    .command("delete <feedbackId>")
    .description("Delete a feedback entry")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--no", "Abort without prompting (treat confirmation as 'no')")
    .action(async (feedbackId: string, opts: { yes?: boolean; no?: boolean }) => {
      const videoRoot = requireVideoRoot();

      const found = await findFeedback(videoRoot, feedbackId);
      if (!found) {
        throw new KonteError("FEEDBACK_NOT_FOUND", `Feedback "${feedbackId}" not found`);
      }
      const { stage, address } = found;

      const confirmed = await confirmAction(
        `Feedback "${feedbackId}" on ${address} will be deleted. Continue?`,
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
