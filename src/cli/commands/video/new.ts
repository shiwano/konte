import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import {
  loadVideoTemplate,
  VIDEO_BINARY_FILES,
  VIDEO_TEMPLATE_NAMES,
} from "../../../core/generated/template-assets.js";
import { VIDEO_NAME_PATTERN, VIDEOS_DIR, writeCurrentVideo } from "../../../core/roots.js";
import { StateManager } from "../../../core/state/index.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";
import { selectPrompt } from "../../select.js";
import { pathExists, writeTemplateFiles } from "../../template-files.js";

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  blank: "Minimal starter to build a video from scratch",
  "kitchen-sink": "Every DSL feature at once, for type-checking konte itself",
};

async function resolveTemplate(requested: string | undefined): Promise<string> {
  const available = [...VIDEO_TEMPLATE_NAMES].sort();

  if (requested !== undefined) {
    if (!available.includes(requested)) {
      throw new KonteError(
        "INVALID_TEMPLATE",
        `Unknown template "${requested}". Available: ${available.join(", ")}`,
      );
    }
    return requested;
  }

  if (!process.stdin.isTTY) {
    throw new KonteError(
      "TEMPLATE_REQUIRED",
      `No template specified. Re-run with --template <${available.join("|")}>.`,
    );
  }

  return selectPrompt(
    "Select a video template:",
    available.map((name) => ({
      value: name,
      label: name,
      description: TEMPLATE_DESCRIPTIONS[name],
    })),
  );
}

export function registerVideoNewCommand(video: Command): void {
  declareScope(
    video
      .command("new <name>")
      .description("Create a video in this workspace")
      .option(
        "--template <name>",
        `Video template to scaffold (${[...VIDEO_TEMPLATE_NAMES].sort().join(", ")})`,
      )
      .addHelpText(
        "after",
        `
Creates videos/<name>/ from a template and makes it the workspace's current video, so the
commands that follow act on it without any further selection.

Examples:
  konte video new opening --template blank    Scaffold an empty video`,
      )
      .action(async (name: string, options: { template?: string }) => {
        const workspaceRoot = requireWorkspaceRoot();

        // The name becomes a path segment written into the workspace.
        if (!VIDEO_NAME_PATTERN.test(name)) {
          throw new KonteError(
            "INVALID_VIDEO_NAME",
            `Invalid video name "${name}". Use lowercase letters, digits, ".", "_" and "-", starting with a letter or digit.`,
          );
        }

        const videoDir = path.join(workspaceRoot, VIDEOS_DIR, name);
        if (await pathExists(videoDir)) {
          throw new KonteError("VIDEO_ALREADY_EXISTS", `Video "${name}" already exists`);
        }

        const template = await resolveTemplate(options.template);
        const files = await loadVideoTemplate(template);
        if (!files) throw new KonteError("INVALID_TEMPLATE", `Unknown template "${template}"`);

        await fs.mkdir(videoDir, { recursive: true });
        await writeTemplateFiles(videoDir, files, VIDEO_BINARY_FILES);
        await StateManager.init(videoDir);
        await writeCurrentVideo(workspaceRoot, name);

        console.log(`Video "${name}" created from the "${template}" template, and is now current.`);
      }),
    { scope: "workspace" },
  );
}
