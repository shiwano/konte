import type { Command } from "commander";
import { jobElapsed } from "../../../core/format-duration.js";
import { formatRelativeTime } from "../../../core/format-timestamp.js";
import { comfyQueueAhead, jobStatusFlags } from "../../../core/job-diagnosis.js";
import { JobManager } from "../../../core/job-manager.js";
import { indexJobStats, statsForJob } from "../../../core/job-stats.js";
import { ERROR_GLIMPSE_WIDTH, truncateSingleLine } from "../../../core/truncate.js";
import type { JobRecord } from "../../../core/types/index.js";
import {
  addListLimitOptions,
  applyListLimit,
  type ListLimitOptions,
  listMoreLine,
} from "../../format-list.js";
import { renderTable } from "../../table.js";
import { requireVideoRoot } from "../../context.js";

// Terminal, low-signal statuses hidden by default so a listing leads with what is
// active or broken; revealed by --verbose or an explicit --status.
const HIDDEN_BY_DEFAULT: readonly JobRecord["status"][] = ["completed", "cancelled"];

// The human-facing "what does this job act on" label, by kind.
export function jobTarget(job: JobRecord): string {
  switch (job.kind) {
    case "generation":
      return job.address;
    case "comfy-model-download":
      return job.model.filename;
    case "comfy-node-install":
      return `node ${job.node.id}`;
    case "comfy-node-activate":
      return `node reboot (${job.cnrIds.length})`;
    case "export":
      return "video";
  }
}

export function registerJobListCommand(program: Command): void {
  addListLimitOptions(
    program
      .command("list")
      .description("List jobs (newest first; hides completed/cancelled by default)"),
    "jobs",
  )
    .addHelpText(
      "after",
      "\nLists jobs newest-first. By default only active jobs (pending, queued, running)\n" +
        "and failures are shown; completed and cancelled jobs are hidden. Pass --verbose to\n" +
        "include them, or --status <status> to show exactly one status.\n" +
        "\nA ⚠ beside a status marks a job that is not progressing: unconfirmed (the backend\n" +
        "stopped answering), unwatched (no worker holds its run lease), stranded (its submit\n" +
        "died mid-transaction). Run `konte job show <id>` for the full diagnosis.\n" +
        "\nComfyUI runs one prompt at a time, so a submitted comfy job waits its turn before it\n" +
        "executes. PROGRESS reports that wait as `N ahead` (or `next`) instead of a percent.\n" +
        "\nExamples:\n" +
        "  konte job list                     Active + failed jobs (completed/cancelled hidden)\n" +
        "  konte job list --verbose           Every job, all statuses\n" +
        "  konte job list --status completed  Only completed jobs\n" +
        "  konte job list --all               Ignore the row limit",
    )
    .option("--status <status>", "Filter by status")
    .option("-v, --verbose", "Include completed and cancelled jobs")
    .action(
      async (
        opts: ListLimitOptions & {
          status?: JobRecord["status"];
          verbose?: boolean;
        },
      ) => {
        const videoRoot = requireVideoRoot();
        const jobManager = new JobManager(videoRoot);
        const now = Date.now();

        // Listed unfiltered so the per-adapter stats the flags judge against span every run, not
        // just the rows shown; --status then filters in memory. listJobs sorts oldest-first;
        // reverse so the newest jobs lead.
        const allJobs = await jobManager.listJobs();
        const stats = indexJobStats(allJobs);
        const fetched = [...allJobs]
          .filter((job) => !opts.status || job.status === opts.status)
          .reverse();

        // An explicit --status or --verbose opts out of the default terminal-status filter.
        const selected =
          opts.status || opts.verbose
            ? fetched
            : fetched.filter((job) => !HIDDEN_BY_DEFAULT.includes(job.status));
        const hiddenByStatus = fetched.length - selected.length;

        const { shown: jobs, hidden } = applyListLimit(selected, opts);

        const flagsOf = (job: JobRecord): string[] =>
          jobStatusFlags({ job, stats: statsForJob(job, stats), now });

        // Judged against every job, not the rows shown, so a --status or --limit view still counts
        // the whole queue ahead of a prompt.
        const queueAheadOf = (job: JobRecord): number | null => comfyQueueAhead(job, allJobs);

        // What a comfy prompt still waiting its turn puts in PROGRESS: the reason it has no
        // percent and no execution time yet.
        const progressCell = (job: JobRecord): string => {
          if (job.progress !== null) return `${job.progress}%`;
          const ahead = queueAheadOf(job);
          if (ahead === null) return "-";
          return ahead === 0 ? "next" : `${ahead} ahead`;
        };

        if (selected.length === 0) {
          console.log(
            hiddenByStatus > 0
              ? `No active jobs (${hiddenByStatus} completed/cancelled hidden, --verbose for all).`
              : "No jobs found.",
          );
          return;
        }

        // Only show the ERROR column when something actually failed, so a healthy
        // listing isn't widened by a column of dashes.
        const anyError = jobs.some((job) => job.error);
        const rows = jobs.map((job) => {
          // Without these a job nothing is driving any more — its worker died, or its submit
          // died mid-transaction — reads as plain "running" here, and only `job show` or
          // `doctor` knows otherwise.
          const flags = flagsOf(job);
          return {
            ID: job.id,
            KIND: job.kind,
            TARGET: jobTarget(job),
            BACKEND: job.backendKind,
            STATUS: flags.length > 0 ? `${job.status} ⚠ ${flags.join(", ")}` : job.status,
            PROGRESS: progressCell(job),
            ELAPSED: jobElapsed(job, now),
            CREATED: formatRelativeTime(job.createdAt),
            ...(anyError
              ? { ERROR: job.error ? truncateSingleLine(job.error, ERROR_GLIMPSE_WIDTH) : "-" }
              : {}),
          };
        });

        console.log(renderTable(rows));

        const footer: string[] = [];
        if (hidden > 0) footer.push(listMoreLine(hidden));
        if (hiddenByStatus > 0) {
          footer.push(`... and ${hiddenByStatus} completed/cancelled hidden (--verbose for all)`);
        }
        if (footer.length > 0) {
          console.log(`\n${footer.join("\n")}`);
        }
      },
    );
}
