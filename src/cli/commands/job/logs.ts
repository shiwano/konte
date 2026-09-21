import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { isJobTerminal, JobManager } from "../../../core/job-manager.js";
import { requireVideoRoot } from "../../context.js";

export function registerJobLogsCommand(program: Command): void {
  program
    .command("logs <jobId>")
    .description("Show logs for a job")
    .option("--follow", "Follow log output")
    .action(async (jobId: string, opts: { follow?: boolean }) => {
      const videoRoot = requireVideoRoot();
      const jobManager = new JobManager(videoRoot);

      // A job's terminal error lives on its record, not in its log — a backend can drop a job
      // (or fail it out of band) while its log holds nothing but the submit lines, so a reader
      // who only sees the log never learns why it ended. Emitted after the log so it reads as
      // the outcome of what precedes it.
      const printJobError = async (): Promise<boolean> => {
        const error = await jobManager
          .getJob(jobId)
          .then((job) => job.error)
          .catch(() => null);
        if (!error) return false;
        process.stderr.write(`${error}\n`);
        return true;
      };

      // Byte offset of what we have already written. Seeded from the initial dump's byte
      // length (not a fresh fs.stat) so any bytes appended between reading and following are
      // still emitted on the next drain rather than skipped by a stat/read race.
      let lastSize = 0;
      let hasLog = true;
      try {
        const log = await jobManager.readLog(jobId);
        process.stdout.write(log);
        lastSize = Buffer.byteLength(log, "utf-8");
      } catch (err) {
        if (err instanceof KonteError && err.code === "LOG_NOT_FOUND") {
          hasLog = false;
        } else {
          throw err;
        }
      }

      if (opts.follow) {
        const logPath = path.join(videoRoot, ".konte", "logs", `${jobId}.log`);

        const drain = async (): Promise<void> => {
          try {
            const stat = await fs.stat(logPath);
            if (stat.size > lastSize) {
              const fd = await fs.open(logPath, "r");
              const buf = Buffer.alloc(stat.size - lastSize);
              await fd.read(buf, 0, buf.length, lastSize);
              await fd.close();
              process.stdout.write(buf.toString("utf-8"));
              lastSize = stat.size;
            }
          } catch {
            // file not yet created, wait
          }
        };

        // Poll until the job reaches a terminal state, then drain once more and stop — a
        // non-TTY agent otherwise hangs forever on a finished job. SIGINT ends it early.
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearInterval(interval);
            resolve();
          };
          const interval = setInterval(async () => {
            await drain();
            // A gone job (JOB_NOT_FOUND) will never write again, so treat it as terminal too —
            // otherwise `job logs <missing> --follow` polls forever. Other read errors are
            // transient and keep polling.
            const terminal = await jobManager
              .getJob(jobId)
              .then((job) => isJobTerminal(job.status))
              .catch((err) => err instanceof KonteError && err.code === "JOB_NOT_FOUND");
            if (terminal) {
              await drain();
              stop();
            }
          }, 500);
          process.on("SIGINT", stop);
        });
      }

      const printedError = await printJobError();
      if (!hasLog && !printedError) console.log("No logs available for this job.");
    });
}
