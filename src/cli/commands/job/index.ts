import type { Command } from "commander";
import { registerJobCancelCommand } from "./cancel.js";
import { registerJobListCommand } from "./list.js";
import { registerJobLogsCommand } from "./logs.js";
import { registerJobShowCommand } from "./show.js";
import { registerJobStatsCommand } from "./stats.js";
import { registerJobRunCommand } from "./run.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";

export function registerJobCommand(program: Command, pollIntervalMs?: number): void {
  const job = program.command("job").description("Manage jobs");
  registerJobListCommand(job);
  registerJobShowCommand(job);
  registerJobStatsCommand(job);
  registerJobRunCommand(job, pollIntervalMs);
  registerJobLogsCommand(job);
  registerJobCancelCommand(job);

  declareScope(
    job
      .command("worker", { hidden: true })
      .description("Run the workspace's jobs for the process that spawned this one over IPC")
      .action(async () => {
        const { runWorker } = await import("../../../worker/worker.js");
        await runWorker(requireWorkspaceRoot());
      }),
    { scope: "workspace", skipSyncCheck: true, skipTypeCheck: true },
  );
}
