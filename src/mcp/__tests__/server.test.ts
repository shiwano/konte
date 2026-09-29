import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import { makeWorkspace } from "../../core/__tests__/helpers/workspace.js";
import { mcpLogPath } from "../mcp-log.js";

it("initializes over stdio and reports its status", async () => {
  const ws = await makeWorkspace({ videos: ["main"] });
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
    expect(client.getServerCapabilities()).toEqual({
      logging: {},
      tools: { listChanged: true },
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["status"]);
    const result = await client.callTool({ name: "status" });
    const [content] = result.content as { type: string; text: string }[];
    expect(JSON.parse(content?.text ?? "")).toEqual({
      version: pkg.version,
      instanceId: expect.stringMatching(/^[0-9a-f]{6}$/),
      pid: expect.any(Number),
      startedAt: expect.any(String),
      videos: ["main"],
    });
    expect(await client.ping()).toEqual({});
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain('"event":"daemon_started"');
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
