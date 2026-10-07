import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { closeIdleDeployments } from "../comfy-api/deployment.js";
import { handOffDeploymentClose } from "../comfy-api/daemon-exit.js";
import { registerDaemon, unregisterDaemonSync } from "../core/daemon-registry.js";
import { RESTART_EXIT_CODE } from "../core/process-restart.js";
import { McpLog } from "./mcp-log.js";
import { VideoRegistry } from "./video-registry.js";

// How often the daemon judges whether a Comfy API deployment has sat idle long enough to close.
const IDLE_CLOSE_INTERVAL_MS = 60_000;

const INSTRUCTIONS = `Per-workspace daemon running every video's generation jobs in the background, so "konte generate" and "konte export" return immediately. "konte job wait" blocks until the queue drains.`;

/** One daemon per workspace, watching every video in it. */
export async function startMcpServer(workspaceRoot: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const server = new McpServer(
    { name: "konte", version: pkg.version },
    {
      capabilities: { logging: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const log = new McpLog(workspaceRoot);
  log.write("info", { event: "daemon_started", version: pkg.version, workspace: workspaceRoot });

  const registry = new VideoRegistry(server, workspaceRoot, {
    log,
    // A judge in this process found its loaded definitions older than the files on disk. It has
    // already handed the job back; nothing this process reads again is trusted, so it exits
    // asking the CLI entry to start a fresh daemon on the same stdio (see process-restart.ts).
    onStaleDefinitions: (video, info) => {
      registry.stop();
      log.write("info", { video, event: "stale_definitions_restart", ...info });
      server.server
        .sendLoggingMessage({
          level: "info",
          logger: "konte",
          data: { video, event: "stale_definitions_restart", pid: process.pid, ...info },
        })
        .catch(() => undefined)
        .then(() => log.flush())
        .finally(() => process.exit(RESTART_EXIT_CODE));
    },
  });

  server.registerTool(
    "status",
    {
      description: "Daemon version, instance id, pid, start time and watched videos.",
      annotations: { readOnlyHint: true },
    },
    () => {
      const status = {
        version: pkg.version,
        instanceId: log.instanceId,
        pid: process.pid,
        startedAt,
        videos: registry.videos(),
      };
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );

  // A deployment left up by a daemon that died without its exit handler is closed here, and
  // every idle one after that.
  await registerDaemon(workspaceRoot).catch(() => {});
  let closing = false;
  const closeIdle = (): void => {
    if (closing) return;
    closing = true;
    void closeIdleDeployments({
      workspaceRoot,
      log: (line) => log.write("info", { event: "comfy_api_close", line }),
    })
      .catch(() => [])
      .finally(() => {
        closing = false;
      });
  };
  closeIdle();
  const idleTimer = setInterval(closeIdle, IDLE_CLOSE_INTERVAL_MS);
  idleTimer.unref?.();

  const cleanup = () => {
    clearInterval(idleTimer);
    registry.stop();
    unregisterDaemonSync(workspaceRoot);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      handOffDeploymentClose(workspaceRoot);
      log.write("info", { event: "daemon_stopped", signal });
      void log.flush().finally(() => process.exit(0));
    });
  }
  process.on("exit", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await registry.start();
}
