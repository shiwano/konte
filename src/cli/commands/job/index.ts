import type { Command } from "commander";
import { registerJobCancelCommand } from "./cancel.js";
import { registerJobListCommand } from "./list.js";
import { registerJobLogsCommand } from "./logs.js";
import { registerJobShowCommand } from "./show.js";
import { registerJobStatsCommand } from "./stats.js";
import { registerJobWaitCommand } from "./wait.js";

export function registerJobCommand(program: Command): void {
  const job = program.command("job").description("Manage jobs");
  registerJobListCommand(job);
  registerJobShowCommand(job);
  registerJobStatsCommand(job);
  registerJobWaitCommand(job);
  registerJobLogsCommand(job);
  registerJobCancelCommand(job);
}
