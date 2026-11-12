import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { prepareAgentSettings } from "../../../core/agent-settings.js";
import { KonteError } from "../../../core/errors.js";
import {
  AGENT_SETTINGS_FILES,
  BUNDLED_ADAPTERS,
  loadWorkspaceTemplate,
  WORKSPACE_BINARY_FILES,
} from "../../../core/generated/template-assets.js";
import { findWorkspaceRoot, resolveRoots } from "../../../core/roots.js";
import { assertKonteCurrent, syncWorkspace } from "../../../core/template-sync.js";
import { setWorkspaceRoot } from "../../../core/workspace-context.js";
import { confirmAction, printAborted, NO_FLAG_DESCRIPTION } from "../../confirm.js";
import { declareScope } from "../../scope.js";
import { pathExists, writeTemplateFiles } from "../../template-files.js";
import { prefetchManagedRuntimes } from "./prefetch.js";
import { printNextSteps } from "../../next-steps.js";
import { retirementLines, updateLines } from "../../sync-report.js";
import pkg from "../../../../package.json" with { type: "json" };

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

// The template files a scaffold writes: every one on a new workspace bar an existing README.md,
// only the missing ones on an existing workspace.
async function scaffoldFiles(root: string, existing: boolean): Promise<Record<string, string>> {
  const template = await loadWorkspaceTemplate();
  const files: Record<string, string> = {};
  for (const [key, content] of Object.entries(template)) {
    if (AGENT_SETTINGS_FILES.has(key) || key === ".gitignore") continue;
    if (existing && key in BUNDLED_ADAPTERS) continue;
    if ((existing || key === "README.md") && (await pathExists(path.join(root, key)))) continue;
    files[key] = content;
  }
  return files;
}

// The files already in `root` that `workspace new` replaces.
async function overwrittenByNew(root: string): Promise<string[]> {
  const keys = [...Object.keys(await scaffoldFiles(root, false)), ".claude/settings.json"];
  const present = await Promise.all(keys.map((key) => pathExists(path.join(root, key))));
  return keys.filter((_, i) => present[i]).sort();
}

async function scaffold(root: string, existing: boolean): Promise<string | null> {
  // Ahead of any write: settings it cannot merge refuse the whole scaffold.
  await prepareAgentSettings(root);
  await writeTemplateFiles(root, await scaffoldFiles(root, existing), WORKSPACE_BINARY_FILES);
  const sync = await syncWorkspace(root);
  if (existing) for (const line of updateLines(sync)) console.error(line);
  for (const line of retirementLines(sync)) console.error(line);
  const unwritable = sync.unwritable;
  if (unwritable.length > 0) {
    throw new KonteError(
      "TEMPLATE_SYNC_FAILED",
      `${unwritable.length} managed file(s) not writable; grant write access and run konte workspace setup again`,
      unwritable,
    );
  }
  return sync.previousVersion;
}

async function finish(root: string, message: string, upgraded = false): Promise<void> {
  setWorkspaceRoot(root);
  await prefetchManagedRuntimes();
  console.log(message);
  printNextSteps([
    // Temporary: for users still on a plugin that ships konte:upgrade. Remove once they have moved.
    ...(upgraded
      ? [
          {
            command: null,
            label:
              "if the konte:upgrade plugin skill ran this, tell the user to update the konte plugin",
          },
        ]
      : []),
    {
      command: null,
      label: `start a new agent session in ${root}`,
      detail: "Agent settings load at session start",
    },
    { command: null, label: "run the konte-checkin skill" },
  ]);
}

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program.command("workspace").description("Create and set up workspaces");
  declareScope(
    workspace
      .command("new")
      .description("Create a workspace in the current directory")
      .option("--no", NO_FLAG_DESCRIPTION)
      .addHelpText(
        "after",
        `
Creates shared workspace files and agent settings, then fetches managed runtimes.
An existing workspace, here or enclosing, is an error. Other project files require
confirmation (-y), which names each file it overwrites.
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
        const enclosing = await findWorkspaceRoot(root);
        if (enclosing) {
          throw new KonteError(
            "WORKSPACE_ALREADY_EXISTS",
            `The current directory is inside the konte workspace ${enclosing}; run konte workspace setup there, or create the workspace outside it`,
          );
        }
        const foreign = await foreignEntries(root);
        const overwritten = await overwrittenByNew(root);
        const overwrites = overwritten.length > 0 ? `, overwriting ${overwritten.join(", ")}` : "";
        if (
          foreign.length &&
          !(await confirmAction(
            `The current directory already holds ${foreign.slice(0, 5).join(", ")}; the workspace will be created beside them${overwrites}.`,
            options,
          ))
        ) {
          printAborted();
          return;
        }
        await scaffold(root, false);
        await finish(root, "Workspace created in the current directory.");
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
        await assertKonteCurrent(root);
        const previousVersion = await scaffold(root, true);
        await finish(
          root,
          "Workspace setup complete.",
          previousVersion !== null && previousVersion !== pkg.version,
        );
      }),
    { scope: "none" },
  );
}
