import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { applyCredentials } from "../core/credentials.js";
import { KonteError } from "../core/errors.js";
import { resolveRoots } from "../core/roots.js";
import { syncManagedTemplates } from "../core/template-sync.js";
import { typeCheckWorkspace } from "../core/tsc.js";
import { setWorkspaceRoot } from "../core/workspace-context.js";
import { requireVideoRoots, setRoots } from "./context.js";
import { scopeOf } from "./scope.js";
import { registerAdapterCommand } from "./commands/adapter/index.js";
import { registerPatchCommand } from "./commands/patch/index.js";
import { registerCleanCommand } from "./commands/clean.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerWorkspaceCommand } from "./commands/workspace/index.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerLicensesCommand } from "./commands/licenses.js";
import { registerLspCommand } from "./commands/lsp.js";
import { registerPruneCommand } from "./commands/prune.js";
import { registerRefCommand } from "./commands/ref.js";
import { registerJobCommand } from "./commands/job/index.js";
import { registerReviewCommand } from "./commands/review/index.js";
import { registerAcceptCommand } from "./commands/asset-ops/accept.js";
import { registerDismissCommand } from "./commands/asset-ops/dismiss.js";
import { registerRerollCommand } from "./commands/asset-ops/reroll.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerExportCommand } from "./commands/export.js";
import { registerPreviewCommand } from "./commands/preview/command.js";
import { registerSettingsCommand } from "./commands/settings/command.js";
import { registerMcpCommand } from "./commands/mcp/index.js";
import { registerProbeCommand } from "./commands/probe/index.js";
import { registerVideoCommand } from "./commands/video.js";

interface BuildProgramOptions {
  // Skip the per-invocation workspace type-check and managed-template sync in the
  // preAction hook. Off in production; the in-process test harness turns it on so
  // command tests don't pay tsc/sync on every call (a few subprocess E2E tests
  // still exercise the full path). Root resolution always runs — it is what the
  // commands read their roots from.
  skipProjectChecks?: boolean;
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
  registerRefCommand(program);
  registerCleanCommand(program);
  registerPruneCommand(program);

  registerRerollCommand(program);
  registerGenerateCommand(program);
  registerPreviewCommand(program);
  registerExportCommand(program);
  registerAcceptCommand(program);
  registerDismissCommand(program);
  registerProbeCommand(program);

  registerJobCommand(program);
  registerReviewCommand(program);
  registerAdapterCommand(program);
  registerPatchCommand(program);

  registerSettingsCommand(program);
  registerMcpCommand(program);
  registerLspCommand(program);
  registerLicensesCommand(program);

  applyUniversalYesFlag(program);

  program.hook("preAction", async (thisCommand) => {
    const cwd = thisCommand.opts<{ cwd?: string }>().cwd;
    if (!cwd) return;
    const target = path.resolve(cwd);
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        throw new KonteError("INVALID_CWD", `--cwd path is not a directory: ${cwd}`);
      }
    } catch (err) {
      if (err instanceof KonteError) throw err;
      throw new KonteError("INVALID_CWD", `--cwd path does not exist: ${cwd}`);
    }
    process.chdir(target);
  });

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    const { scope, skipSync, skipTypeCheck } = scopeOf(actionCommand);

    if (scope === "none") {
      setRoots(null);
      setWorkspaceRoot(null);
      return;
    }

    const roots = await resolveRoots(process.cwd());
    setRoots(roots);
    // Before anything can provision a managed runtime (they land in <workspace>/.konte/tools/)
    // or read process.env (the workspace's konte.credentials.json holds the backend credentials).
    setWorkspaceRoot(roots.workspace);
    await applyCredentials(roots.workspace);

    // A command that needs a video says so, and finds out here rather than halfway through.
    if (scope === "video") requireVideoRoots();

    if (opts.skipProjectChecks) return;

    const workspaceRoot = roots.workspace;
    const videoRoot = roots.video.kind === "selected" ? roots.video.root : null;

    if (!skipSync) {
      const sync = await syncManagedTemplates(workspaceRoot);
      if (sync) {
        const changed = sync.created.length + sync.updated.length;
        if (changed > 0) {
          console.error(`konte: synced ${changed} file(s) to v${pkg.version}`);
        }
        if (sync.skipped.length > 0) {
          console.error(
            `konte: kept ${sync.skipped.length} locally-modified file(s): ${sync.skipped.join(", ")}`,
          );
        }
      }
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
    if (!sub.options.some((o) => o.short === "-y" || o.long === "--yes")) {
      sub.option("-y, --yes", "Skip confirmation prompt (ignored when the command has no prompt)");
    }
  }
}

export async function run(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    if (err instanceof KonteError) {
      console.error(`Error [${err.code}]: ${err.message}`);
    } else {
      // A non-KonteError is an unexpected bug: print its stack (not a rethrow, which would
      // surface as an unhandled rejection with no exit code) and exit non-zero.
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      console.error("\nThis is a bug in konte. The konte-feedback skill drafts the report.");
    }
    process.exit(1);
  }
}
