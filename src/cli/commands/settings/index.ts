import { requireWorkspaceRoot } from "../../context.js";
import { runPage } from "../../page-host/run.js";
import { parseNumberOption } from "../../parse-option.js";
import type { SettingsTab } from "../../../pages/settings/types.js";
import { createSettingsServer } from "./server.js";

// The same default as `konte preview`, with the same fallback.
const DEFAULT_SETTINGS_PORT = 4649;

export async function launchSettings(opts: { port?: string; tab: SettingsTab }): Promise<void> {
  const workspaceRoot = requireWorkspaceRoot();
  const requestedPort = parseNumberOption("--port", opts.port, {
    integer: true,
    min: 0,
    max: 65535,
  });

  await runPage({
    path: `/?tab=${opts.tab}`,
    startupLine: (url) => `Settings at ${url} — opening browser (Ctrl+C to stop)`,
    start: () =>
      createSettingsServer({
        workspaceRoot,
        port: requestedPort ?? DEFAULT_SETTINGS_PORT,
        allowPortFallback: requestedPort == null,
      }),
  });
}
