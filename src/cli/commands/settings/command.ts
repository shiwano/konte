import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { SETTINGS_TABS, type SettingsTab } from "../../../pages/settings/types.js";
import { declareScope } from "../../scope.js";
import { launchSettings } from "./index.js";

export function registerSettingsCommand(program: Command): void {
  declareScope(
    program
      .command("settings")
      .description("Edit this workspace's config and API credentials in the browser")
      .option("--tab <name>", `Tab to open (${SETTINGS_TABS.join(", ")})`, "config")
      .option("--port <port>", "Server port (default: 4649, or a free port if it is taken)")
      .addHelpText(
        "after",
        `
Opens one page with two tabs, each saving to its own file. Config writes konte.config.json —
the ComfyUI connection, the local ffmpeg paths, preview network access.
Credentials writes konte.credentials.json — the API keys, which konte loads into the
environment on every run. A stored credential's value is never shown, only whether it is set;
a real environment variable of the same name always wins over the file.

Both files belong to the workspace, so the command needs no video.

Examples:
  konte settings                      Open on the Config tab
  konte settings --tab credentials    Open on the Credentials tab`,
      )
      .action(async (options: { tab: string; port?: string }) => {
        if (!(SETTINGS_TABS as readonly string[]).includes(options.tab)) {
          throw new KonteError(
            "INVALID_OPTION",
            `Unknown --tab "${options.tab}". Use one of: ${SETTINGS_TABS.join(", ")}`,
          );
        }
        await launchSettings({
          port: options.port,
          tab: options.tab as SettingsTab,
        });
      }),
    { scope: "workspace" },
  );
}
