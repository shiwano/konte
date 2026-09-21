import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "../../package.json" with { type: "json" };
import { RESTART_EXIT_CODE } from "../core/process-restart.js";
import { McpLog } from "./mcp-log.js";
import { VideoRegistry } from "./video-registry.js";

const INSTRUCTIONS = `The konte watcher daemon runs one process per workspace, driving every video's generation jobs in the background — which is why "konte generate" and "konte export" return immediately. It exposes nothing to call and pushes nothing at you: "konte job wait" blocks until the queue drains.`;

/** One daemon per workspace, watching every video in it. */
export async function startMcpServer(workspaceRoot: string): Promise<void> {
  const server = new McpServer(
    { name: "konte", version: pkg.version },
    {
      capabilities: {
        logging: {},
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));

  const log = new McpLog(workspaceRoot);
  log.write("info", { event: "daemon_started", version: pkg.version, workspace: workspaceRoot });

  // No tool, resource or prompt is registered — every outcome is learned through the CLI.
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

  const cleanup = () => registry.stop();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      log.write("info", { event: "daemon_stopped", signal });
      void log.flush().finally(() => process.exit(0));
    });
  }
  process.on("exit", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await registry.start();
}
