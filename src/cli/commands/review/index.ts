import type { Command } from "commander";
import { registerFeedbackCommand } from "../feedback/index.js";
import { registerHandoffCommand } from "./handoff.js";
import { registerReviewListCommand } from "./list.js";
import { registerReviewShowCommand } from "./show.js";
import { registerReviewWaitCommand } from "./wait.js";

export function registerReviewCommand(program: Command): void {
  const review = program.command("review").description("Manage review sessions");
  registerReviewWaitCommand(review);
  const record = review.command("record").description("Inspect saved review records");
  registerReviewListCommand(record);
  registerReviewShowCommand(record);
  registerHandoffCommand(review);
  registerFeedbackCommand(review);
}
