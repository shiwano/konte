import type { Command } from "commander";
import { registerFeedbackCommand } from "../feedback/index.js";
import { registerReviewListCommand } from "./list.js";
import { registerReviewShowCommand } from "./show.js";

export function registerReviewCommand(program: Command): void {
  const review = program.command("review").description("Manage review sessions");
  const record = review.command("record").description("Inspect saved review records");
  registerReviewListCommand(record);
  registerReviewShowCommand(record);
  registerFeedbackCommand(review);
}
