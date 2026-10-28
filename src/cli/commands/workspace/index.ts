import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { prepareAgentSettings } from "../../../core/agent-settings.js";
import { KonteError } from "../../../core/errors.js";
import {
  AGENT_SETTINGS_FILES,
  loadWorkspaceTemplate,
  WORKSPACE_BINARY_FILES,
} from "../../../core/generated/template-assets.js";
import { listVideos, resolveRoots } from "../../../core/roots.js";
import { syncWorkspace } from "../../../core/template-sync.js";
import { setWorkspaceRoot } from "../../../core/workspace-context.js";
import { confirmAction, printAborted } from "../../confirm.js";
import { declareScope } from "../../scope.js";
import { pathExists, writeTemplateFiles } from "../../template-files.js";
import { prefetchManagedRuntimes } from "./prefetch.js";

const FRESH_REPO_ENTRIES = new Set([
  ".git",
  ".gitattributes",
  ".gitignore",
  "readme",
  "readme.md",
  "license",
  "license.md",
  "license.txt",
]);

async function foreignEntries(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  const foreign = [];
  for (const entry of entries) {
    if (FRESH_REPO_ENTRIES.has(entry.toLowerCase())) continue;
    if (entry === ".konte") {
      const children = await fs.readdir(path.join(dir, entry));
      if (children.every((child) => child === "bin")) continue;
    }
    foreign.push(entry);
  }
  return foreign.sort();
}

async function scaffold(root: string, existing: boolean): Promise<void> {
  // Ahead of any write: settings it cannot merge refuse the whole scaffold.
  await prepareAgentSettings(root);
  const template = await loadWorkspaceTemplate();
  const files: Record<string, string> = {};
  for (const [key, content] of Object.entries(template)) {
    if (AGENT_SETTINGS_FILES.has(key) || key === ".gitignore") continue;
    if ((existing || key === "README.md") && (await pathExists(path.join(root, key)))) continue;
    files[key] = content;
  }
  await writeTemplateFiles(root, files, WORKSPACE_BINARY_FILES);
  const unwritable = (await syncWorkspace(root, { force: true }))?.unwritable ?? [];
  if (unwritable.length > 0) {
    throw new KonteError(
      "TEMPLATE_SYNC_FAILED",
      `${unwritable.length} managed file(s) not writable; grant write access and run konte workspace setup again`,
      unwritable,
    );
  }
}

async function finish(root: string, message: string, checkVideos: boolean): Promise<void> {
  setWorkspaceRoot(root);
  await prefetchManagedRuntimes();
  console.log(`${message}\n`);
  console.log("Next steps:");
  if (checkVideos && (await listVideos(root)).length > 0) {
    console.log("  Run `konte doctor --all-videos` to check every video against this konte.");
  }
  console.log(`  Restart your coding agent in ${root}; agent settings and MCP load at startup.`);
  console.log("  Run the konte-checkin skill.");
}

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program.command("workspace").description("Create and set up workspaces");
  declareScope(
    workspace
      .command("new")
      .description("Create a workspace in the current directory")
      .option("--no", "Abort without prompting")
      .addHelpText(
        "after",
        `
Creates shared workspace files and agent settings, then fetches managed runtimes.
An existing workspace is an error. Other project files require confirmation (-y).
The .konte/bin directory placed by setup.sh or setup.ps1 is allowed.
A konte installed elsewhere is linked into .konte/bin, which agent settings launch.

Examples:
  konte workspace new                Create in the current directory
  konte --cwd ./film workspace new   Create in an existing directory`,
      )
      .action(async (options: { yes?: boolean; no?: boolean }) => {
        const root = process.cwd();
        if (await pathExists(path.join(root, "konte.config.json"))) {
          throw new KonteError(
            "WORKSPACE_ALREADY_EXISTS",
            "The current directory is already a konte workspace; run konte workspace setup",
          );
        }
        const foreign = await foreignEntries(root);
        if (
          foreign.length &&
          !(await confirmAction(
            `The current directory already holds ${foreign.slice(0, 5).join(", ")}; the workspace will be created beside them.`,
            options,
          ))
        ) {
          printAborted();
          return;
        }
        await scaffold(root, false);
        await finish(root, "Workspace created in the current directory.", false);
      }),
    { scope: "none" },
  );

  declareScope(
    workspace
      .command("setup")
      .description("Set up an existing workspace for this environment")
      .addHelpText(
        "after",
        `
Run after cloning, moving or upgrading a workspace. Restores missing template files,
updates managed files and regenerates agent settings before fetching managed runtimes.
Overwrites .claude/settings.json; put Claude customizations in .claude/settings.local.json.
Preserves production files and other user settings; konte's launch paths are replaced.
A konte installed elsewhere is linked into .konte/bin, which agent settings launch.

Examples:
  konte workspace setup  Set up the enclosing workspace`,
      )
      .action(async () => {
        const { workspace: root } = await resolveRoots(process.cwd());
        await scaffold(root, true);
        await finish(root, "Workspace setup complete.", true);
      }),
    { scope: "none" },
  );
}
