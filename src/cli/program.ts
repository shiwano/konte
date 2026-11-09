import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { KonteError } from "../core/errors.js";
import { assertWorkspaceSynced } from "../core/template-sync.js";
import { typeCheckWorkspace } from "../core/tsc.js";
import { exitWithError } from "./error-output.js";
import { scopeOf } from "./scope.js";
import { applyCwdOption, enterScope } from "./startup.js";
import { registerAdapterCommand } from "./commands/adapter/index.js";
import { registerPatchCommand } from "./commands/patch/index.js";
import { registerCleanCommand } from "./commands/clean.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerWorkspaceCommand } from "./commands/workspace/index.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerLicensesCommand } from "./commands/licenses.js";
import { registerPathCommand } from "./commands/path.js";
import { registerJobCommand } from "./commands/job/index.js";
import { registerReviewCommand } from "./commands/review/index.js";
import { registerAcceptCommand } from "./commands/asset-ops/accept.js";
import { registerDismissCommand } from "./commands/asset-ops/dismiss.js";
import { registerVouchCommand } from "./commands/asset-ops/vouch.js";
import { registerRenameCommand } from "./commands/asset-ops/rename.js";
import { registerRerollCommand } from "./commands/asset-ops/reroll.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerExportCommand } from "./commands/export.js";
import { registerPreviewCommand } from "./commands/preview/command.js";
import { registerSettingsCommand } from "./commands/settings/command.js";
import { registerMcpCommand } from "./commands/mcp/index.js";
import { registerProbeCommand } from "./commands/probe/index.js";
import { registerVideoCommand } from "./commands/video/index.js";
import { registerSongCommand } from "./commands/song.js";
import { registerStudyCommand } from "./commands/study.js";
import { registerSourceCommand } from "./commands/source.js";

declare const KONTE_COMPILED: boolean | undefined;

interface BuildProgramOptions {
  // Skip the per-invocation workspace type-check and managed-file check in the
  // preAction hook. Off in production; the in-process test harness turns it on so
  // command tests don't pay tsc on every call (a few subprocess E2E tests
  // still exercise the full path). Root resolution always runs — it is what the
  // commands read their roots from.
  skipProjectChecks?: boolean;
  jobPollIntervalMs?: number;
}

export function buildProgram(opts: BuildProgramOptions = {}): Command {
  const program = new Command();
  program
    .name("konte")
    .description("AI video production tool")
    .version(pkg.version)
    .option(
      "--cwd <path>",
      "Run as if konte was started in <path> instead of the current working directory",
    );

  registerWorkspaceCommand(program);
  registerVideoCommand(program);
  registerStatusCommand(program);
  registerDoctorCommand(program);
  registerInspectCommand(program);
  registerPathCommand(program);
  registerCleanCommand(program);

  registerRerollCommand(program);
  registerGenerateCommand(program);
  registerPreviewCommand(program);
  registerExportCommand(program);
  registerAcceptCommand(program);
  registerDismissCommand(program);
  registerVouchCommand(program);
  registerRenameCommand(program);
  registerProbeCommand(program);
  registerSongCommand(program);
  registerStudyCommand(program);
  registerSourceCommand(program);

  registerJobCommand(program, opts.jobPollIntervalMs);
  registerReviewCommand(program);
  registerAdapterCommand(program);
  registerPatchCommand(program);

  registerSettingsCommand(program);
  registerMcpCommand(program);
  registerLicensesCommand(program);

  applyUniversalYesFlag(program);

  program.hook("preAction", (_thisCommand, actionCommand) => {
    refuseJoinedArguments(actionCommand);
  });

  program.hook("preAction", async (thisCommand) => {
    await applyCwdOption(thisCommand.opts<{ cwd?: string }>().cwd);
  });

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    const { scope, skipSyncCheck, skipTypeCheck } = scopeOf(actionCommand);
    const roots = await enterScope(scope);
    if (!roots) return;

    if (opts.skipProjectChecks) return;

    const workspaceRoot = roots.workspace;
    const videoRoot = roots.video.kind === "selected" ? roots.video.root : null;

    // A source run is konte's own development, whose template hash no released konte writes.
    if (!skipSyncCheck && typeof KONTE_COMPILED !== "undefined" && KONTE_COMPILED) {
      await assertWorkspaceSynced(workspaceRoot);
    }

    if (!skipTypeCheck) {
      try {
        await fs.access(path.join(workspaceRoot, "tsconfig.json"));
      } catch {
        return;
      }
      const result = await typeCheckWorkspace(workspaceRoot, videoRoot);
      if (result.otherVideos.length > 0) {
        const videos = [...new Set(result.otherVideos.map((d) => d.file))].join(", ");
        console.error(
          `konte: ${result.otherVideos.length} type error(s) in other videos (not blocking): ${videos}`,
        );
      }
      if (!result.success) {
        if (result.output) console.error(result.output);
        throw new KonteError("TYPE_CHECK_FAILED", `${result.errorCount} type error(s) found`);
      }
    }
  });

  return program;
}

// Every variadic list takes addresses, scopes or ids, none of which holds whitespace.
function refuseJoinedArguments(cmd: Command): void {
  const lists: { label: string; values: unknown }[] = [
    ...cmd.registeredArguments.flatMap((arg, i) =>
      arg.variadic ? [{ label: `<${arg.name()}...>`, values: cmd.processedArgs[i] }] : [],
    ),
    ...cmd.options.flatMap((opt) =>
      opt.variadic
        ? [{ label: opt.long ?? opt.flags, values: cmd.getOptionValue(opt.attributeName()) }]
        : [],
    ),
  ];
  for (const { label, values } of lists) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      const parts = value.trim().split(/\s+/);
      if (parts.length < 2) continue;
      throw new KonteError(
        "JOINED_ARGUMENTS",
        `${label} got one argument holding ${parts.length} whitespace-separated values: "${value}" — pass each as its own argument`,
      );
    }
  }
}

// Every leaf command accepts -y/--yes so an agent can pass it uniformly (it's
// the flag agents pre-emptively add); commands without a confirmation prompt
// just ignore it. --no is reactive — only meaningful where a prompt exists — so
// it stays on the commands that actually confirm.
function applyUniversalYesFlag(cmd: Command): void {
  for (const sub of cmd.commands) {
    if (sub.commands.length > 0) {
      applyUniversalYesFlag(sub);
      continue;
    }
    const confirms = sub.options.some((o) => o.long === "--no");
    sub.option(
      "-y, --yes",
      confirms
        ? "Skip the confirmation prompt"
        : "Skip confirmation prompt (ignored when the command has no prompt)",
    );
  }
}

export async function run(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    exitWithError(err);
  }
}
