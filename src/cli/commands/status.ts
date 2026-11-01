import type { Command } from "commander";
import { buildProjectStatus } from "../../core/status-report.js";
import { printStatusReport } from "../print-status.js";
import { currentRoots, requireVideoRoots } from "../context.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show whole-project status")
    .addHelpText(
      "after",
      "\nThe single orientation point: every stage, in one whole-project view. To narrow to\n" +
        "one asset, use `konte inspect <address>`.\n" +
        "\nSections:\n" +
        "  Progress         The direction's acceptance, then per-stage counts\n" +
        "                   (the video stage is marked ready to export when all accepted)\n" +
        "  Findings         Every machine finding, grouped by the file it is fixed in, each by its\n" +
        "                   waiver key or code — and every waiver whose finding is gone\n" +
        "  Needs review     Anything awaiting a review and accept\n" +
        "  Problems         A dead variant, a failed job, or a declared file that is not on disk\n" +
        "  Needs regenerate Assets whose every take is stale and unaccepted — `generate` remakes them\n" +
        "  Stale            Accepted variants whose inputs or definition have changed, unless the accept stands\n" +
        "\nThe sections are `-v` only: every state they report, Next steps names a command or an\n" +
        "edit for. Progress, Next steps and Findings always print.\n" +
        "\nRunning, queued and pending jobs are not listed — `konte job list` reports them.",
    )
    .option("-v, --verbose", "Print the sections — every address behind the counts and steps above")
    .action(async (opts: { verbose?: boolean }) => {
      const roots = requireVideoRoots();
      const videoRoot = roots.video;
      const currentVideo = currentRoots()?.video;
      const videoName = currentVideo?.kind === "selected" ? currentVideo.name : null;
      const status = await buildProjectStatus(videoRoot);
      if (videoName) console.log(`Video: ${videoName}\n`);
      printStatusReport(status.report, status.suggestedActions, {
        videoRoot,
        verbose: opts.verbose,
        directionAcceptance: status.directionAcceptance,
        directionEmpty: status.directionEmpty,
        findings: status.findings,
        staleWaivers: status.staleWaivers,
      });
    });
}
