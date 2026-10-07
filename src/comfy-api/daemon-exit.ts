import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { closeIdleDeployments } from "./deployment.js";
import { liveDaemons } from "../core/daemon-registry.js";

// Replaced by `true` when bun builds the standalone binary; absent under `bun run`.
declare const KONTE_COMPILED: boolean | undefined;

function hasOpenDeployment(workspaceRoot: string): boolean {
  try {
    const state = JSON.parse(
      readFileSync(path.join(workspaceRoot, ".konte", "comfyapi.json"), "utf-8"),
    ) as {
      deployments?: Record<
        string,
        { deploymentId?: string | null; stopped?: boolean; pendingCreate?: unknown }
      >;
    };
    // A create whose answer was lost may have made one; the close process looks it up.
    return Object.values(state.deployments ?? {}).some(
      (d) => (d.deploymentId && !d.stopped) || (d.pendingCreate && !d.deploymentId),
    );
  } catch {
    return false;
  }
}

/**
 * A daemon's last act on SIGINT / SIGTERM: hand closing the workspace's deployments to a process
 * of its own session. The agent host kills the daemon within half a second, and a DELETE cut off
 * before its answer does not take, so the daemon cannot close them itself. Synchronous — the
 * handler has no time to await anything.
 */
export function handOffDeploymentClose(workspaceRoot: string): void {
  if ((process.env.COMFY_API_KEY ?? "") === "" || !hasOpenDeployment(workspaceRoot)) return;
  const args = ["mcp", "close-deployments"];
  const [cmd, ...rest] =
    typeof KONTE_COMPILED !== "undefined" && KONTE_COMPILED
      ? [process.execPath, ...args]
      : [process.execPath, process.argv[1]!, ...args];
  try {
    const child = spawn(cmd!, rest, {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    // The idle close at the next daemon start is the fallback.
  }
}

/** What the handed-off process does: close every deployment unless another daemon is still here. */
export async function closeDeploymentsOnDaemonExit(
  workspaceRoot: string,
  log: (line: string) => void,
): Promise<string[]> {
  if ((await liveDaemons(workspaceRoot)).length > 0) return [];
  return closeIdleDeployments({ workspaceRoot, force: true, log });
}
