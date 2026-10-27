import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function connection(workspaceRoot: string, args?: string[]) {
  const client = new Client({ name: "konte-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: args ?? [
      "run",
      fileURLToPath(new URL("../../cli/index.ts", import.meta.url)),
      "--cwd",
      workspaceRoot,
      "mcp",
      "serve",
    ],
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
