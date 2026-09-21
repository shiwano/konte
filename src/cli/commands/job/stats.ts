import type { Command } from "commander";
import { assertValidAddressScope } from "../../../core/address.js";
import { formatDuration } from "../../../core/format-duration.js";
import { formatRelativeTime } from "../../../core/format-timestamp.js";
import { JobManager } from "../../../core/job-manager.js";
import { computeJobStats } from "../../../core/job-stats.js";
import { renderTable } from "../../table.js";
import { matchesAddressScope } from "../../../core/address.js";
import { requireVideoRoot } from "../../context.js";

export function registerJobStatsCommand(program: Command): void {
  program
    .command("stats [address-scope]")
    .description("Show average job duration per adapter")
    .addHelpText(
      "after",
      "\nAggregates completed generation jobs by adapter so you — or an agent — can gauge\n" +
        "how long future generations will take. Durations are execution time\n" +
        "(running → done), excluding queue wait. When one adapter's runs cluster into two\n" +
        "well-separated groups (two distinct runtime regimes), the row splits into fast/slow\n" +
        "modes. Optionally scope to a stage/shot.\n" +
        "\nExamples:\n" +
        "  konte job stats                 All adapters\n" +
        "  konte job stats video           Video stage only\n" +
        "  konte job stats video:shot.01   A single shot",
    )
    .action(async (addressScope: string | undefined) => {
      const videoRoot = requireVideoRoot();
      const jobManager = new JobManager(videoRoot);

      if (addressScope) assertValidAddressScope(addressScope);

      const jobs = await jobManager.listJobs();
      const scoped = addressScope
        ? jobs.filter(
            (j) => j.kind === "generation" && matchesAddressScope(j.address, addressScope),
          )
        : jobs;

      const buckets = computeJobStats(scoped);

      if (buckets.length === 0) {
        console.log("No completed jobs with timing data yet.");
        return;
      }

      // A bucket that split into fast/slow modes emits one row per mode (its blended p50/p90
      // would describe neither); an unsplit bucket stays a single MODE=— row.
      const rows = buckets.flatMap((b) => {
        const cells = (
          mode: string,
          s: { count: number; p50Ms: number; p90Ms: number; meanMs: number; lastRunAt: string },
        ) => ({
          ADAPTER: `${b.backendKind}:${b.adapterKey}`,
          MODE: mode,
          COUNT: String(s.count),
          P50: formatDuration(s.p50Ms),
          P90: formatDuration(s.p90Ms),
          MEAN: formatDuration(s.meanMs),
          "LAST RUN": formatRelativeTime(s.lastRunAt),
        });
        return b.modes ? b.modes.map((m) => cells(m.label, m)) : [cells("—", b)];
      });

      console.log(renderTable(rows));
    });
}
