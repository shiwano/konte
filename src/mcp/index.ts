import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { DAEMON_INSTANCE_ID } from "../core/daemon-registry.js";
import { McpLog } from "./mcp-log.js";
import { startWorkerHost } from "./worker-host.js";

const INSTRUCTIONS = `Per-workspace daemon running every video's generation jobs in the background, so "konte generate" and "konte export" return immediately. "konte job wait" blocks until the queue drains.`;

/** The MCP server of one agent session. It never loads a definition (worker-host.ts). */
export async function startMcpServer(
  workspaceRoot: string,
  opts: { workerCommand?: readonly string[] } = {},
): Promise<void> {
  const startedAt = new Date().toISOString();
  const server = new McpServer(
    { name: "konte", version: pkg.version },
    {
      capabilities: { logging: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const log = new McpLog(workspaceRoot, { instanceId: DAEMON_INSTANCE_ID });
  log.write("info", { event: "daemon_started", version: pkg.version, workspace: workspaceRoot });

  let host: ReturnType<typeof startWorkerHost> | undefined;

  server.registerTool(
    "status",
    {
      description: "Daemon identity, worker identity and locally watched videos.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const worker = (await host?.status()) ?? {
        workerPid: null,
        workerInstanceId: null,
        videos: [],
      };
      const status = {
        version: pkg.version,
        instanceId: log.instanceId,
        pid: process.pid,
        startedAt,
        ...worker,
      };
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );

  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    void (host?.stop() ?? Promise.resolve())
      .then(() => {
        log.write("info", { event: "daemon_stopped", signal: reason });
        return log.flush();
      })
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => stop(signal));
  }
  process.stdin.once("end", () => stop("stdin-closed"));
  process.stdin.once("close", () => stop("stdin-closed"));

  await server.connect(new StdioServerTransport());
  if (stopping) return;
  host = startWorkerHost(workspaceRoot, {
    log,
    workerCommand: opts.workerCommand,
    notify: ({ level, data }) => {
      server.server.sendLoggingMessage({ level, logger: "konte", data }).catch(() => undefined);
    },
  });
}
