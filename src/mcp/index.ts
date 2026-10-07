import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { registerDaemon, unregisterDaemonSync } from "../core/daemon-registry.js";
import { RESTART_EXIT_CODE } from "../core/process-restart.js";
import { drainSubmissions } from "../core/submission-drain.js";
import { McpLog } from "./mcp-log.js";
import { VideoRegistry } from "./video-registry.js";

// How long a stopping daemon waits for a submit already sent to commit its backend job id.
export const SUBMIT_DRAIN_MS = 60_000;

const INSTRUCTIONS = `Per-workspace daemon running every video's generation jobs in the background, so "konte generate" and "konte export" return immediately. "konte job wait" blocks until the queue drains.`;

// An attached daemon leads a process group of its own (job-runner.ts). What it started — an
// ffmpeg mid-render — must not outlive it and race the worker that takes the job over.
function stopProcessGroup(): void {
  if (process.platform === "win32") return;
  try {
    process.kill(0, "SIGTERM");
  } catch {
    // Nothing left to signal.
  }
}

/**
 * One daemon per workspace, watching every video in it. An attached one is a `konte job wait`'s:
 * it exits when the wait closes its stdin.
 */
export async function startMcpServer(
  workspaceRoot: string,
  opts: { attached?: boolean } = {},
): Promise<void> {
  const attached = opts.attached === true;
  const startedAt = new Date().toISOString();
  const server = new McpServer(
    { name: "konte", version: pkg.version },
    {
      capabilities: { logging: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const log = new McpLog(workspaceRoot);
  log.write("info", {
    event: "daemon_started",
    version: pkg.version,
    workspace: workspaceRoot,
    ...(attached ? { attached } : {}),
  });

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
        .then(() => drainSubmissions(SUBMIT_DRAIN_MS))
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

  await registerDaemon(workspaceRoot).catch(() => {});

  const cleanup = () => {
    registry.stop();
    unregisterDaemonSync(workspaceRoot);
  };
  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    cleanup();
    void drainSubmissions(SUBMIT_DRAIN_MS)
      .then(() => {
        log.write("info", { event: "daemon_stopped", signal: reason });
        return log.flush();
      })
      .finally(() => {
        if (attached) stopProcessGroup();
        process.exit(0);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => stop(signal));
  }
  process.on("exit", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The stdio transport never ends on its own; a wait that died without stopping this daemon
  // closes the pipe all the same.
  if (attached) process.stdin.once("end", () => stop("stdin-closed"));

  await registry.start();
}
