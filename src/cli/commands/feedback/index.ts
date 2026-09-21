import type { Command } from "commander";
import { registerFeedbackDeleteCommand } from "./delete.js";
import { registerFeedbackEditCommand } from "./edit.js";
import { registerFeedbackListCommand } from "./list.js";
import { registerFeedbackShowCommand } from "./show.js";

export function registerFeedbackCommand(review: Command): void {
  const feedback = review.command("feedback").description("Manage feedback");
  registerFeedbackListCommand(feedback);
  registerFeedbackShowCommand(feedback);
  registerFeedbackEditCommand(feedback);
  registerFeedbackDeleteCommand(feedback);
}
