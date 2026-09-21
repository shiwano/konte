import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { makeWorkspace } from "../../core/__tests__/helpers/workspace.js";
import { mcpLogPath } from "../mcp-log.js";

it("initializes over stdio and returns empty discovery lists", async () => {
  const ws = await makeWorkspace();
  const client = new Client({ name: "konte-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "run",
      fileURLToPath(new URL("../../cli/index.ts", import.meta.url)),
      "--cwd",
      ws.root,
      "mcp",
      "serve",
    ],
    cwd: ws.root,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.listResources()).toEqual({ resources: [] });
    expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] });
    expect(await client.listPrompts()).toEqual({ prompts: [] });
    expect(client.getServerCapabilities()).toEqual({
      logging: {},
      tools: {},
      resources: {},
      prompts: {},
    });
    expect(await client.ping()).toEqual({});
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain('"event":"daemon_started"');
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
