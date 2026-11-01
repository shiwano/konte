import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI_ENTRY = fileURLToPath(new URL("../../cli/index.ts", import.meta.url));

// A daemon started with `-e` has no CLI entry in its argv to spawn its worker from.
export function cliWorkerCommand(workspaceRoot: string): string[] {
  return [process.execPath, "run", CLI_ENTRY, "--cwd", workspaceRoot, "mcp", "worker"];
}

// A worker whose script patches VideoRegistry, then calls runMcpWorker.
export function scriptWorkerCommand(script: string): string[] {
  return [process.execPath, "-e", script];
}

export const MODULES = {
  server: new URL("../index.ts", import.meta.url).href,
  worker: new URL("../worker.ts", import.meta.url).href,
  registry: new URL("../video-registry.ts", import.meta.url).href,
  drain: new URL("../../core/submission-drain.ts", import.meta.url).href,
};

export function connection(workspaceRoot: string, args?: string[]) {
  const client = new Client({ name: "konte-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: args ?? ["run", CLI_ENTRY, "--cwd", workspaceRoot, "mcp", "serve"],
    cwd: workspaceRoot,
    stderr: "pipe",
  });
  return { client, transport };
}

export async function daemonStatus(client: Client): Promise<{
  pid: number;
  instanceId: string;
  workerPid: number | null;
  workerInstanceId: string | null;
  videos: string[];
}> {
  const result = await client.callTool({ name: "status" });
  const [content] = result.content as { text: string }[];
  return JSON.parse(content!.text);
}
