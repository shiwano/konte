import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import { daemonProcessExists, liveDaemons } from "../../core/daemon-registry.js";
import { makeWorkspace } from "../../core/__tests__/helpers/workspace.js";
import { mcpLogPath } from "../mcp-log.js";
import { connection, daemonStatus } from "./server-fixtures.js";

it.each([
  { attached: false, immediate: false },
  { attached: true, immediate: false },
  { attached: false, immediate: true },
  { attached: true, immediate: true },
])(
  "exits on stdin EOF (attached: $attached, immediate: $immediate)",
  async ({ attached, immediate }) => {
    const ws = await makeWorkspace({ videos: ["main"] });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../cli/index.ts", import.meta.url)),
        "--cwd",
        ws.root,
        "mcp",
        "serve",
        ...(attached ? ["--attached"] : []),
      ],
      { cwd: ws.root, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    let exitCode: number | null | undefined;
    child.once("exit", (code) => {
      exitCode = code;
    });
    child.stdout.resume();
    child.stderr.resume();
    try {
      if (!immediate) {
        await expect
          .poll(async () => (await liveDaemons(ws.root)).length, { timeout: 5_000 })
          .toBe(1);
      }
      child.stdin.end();
      await expect.poll(() => exitCode, { timeout: 5_000 }).toBe(0);
      expect(await liveDaemons(ws.root)).toEqual([]);
      expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain('"signal":"stdin-closed"');
    } finally {
      child.kill();
      await ws.cleanup();
    }
  },
);

it("initializes over stdio and reports its status", async () => {
  const ws = await makeWorkspace({ videos: ["main"] });
  const { client, transport } = connection(ws.root);

  try {
    await client.connect(transport);
    expect(client.getServerCapabilities()).toEqual({
      logging: {},
      tools: { listChanged: true },
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["status"]);
    await expect.poll(async () => (await daemonStatus(client)).videos).toEqual(["main"]);
    const result = await client.callTool({ name: "status" });
    const [content] = result.content as { type: string; text: string }[];
    expect(JSON.parse(content?.text ?? "")).toEqual({
      version: pkg.version,
      instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      pid: expect.any(Number),
      startedAt: expect.any(String),
      workerPid: expect.any(Number),
      workerInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      videos: ["main"],
    });
    expect(await client.ping()).toEqual({});
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain('"event":"daemon_started"');
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

it("reports status and checks ownership while the initial scan is blocked", async () => {
  const ws = await makeWorkspace();
  const registryModule = new URL("../video-registry.ts", import.meta.url).href;
  const serverModule = new URL("../index.ts", import.meta.url).href;
  const { client, transport } = connection(ws.root, [
    "-e",
    `
    import { VideoRegistry } from ${JSON.stringify(registryModule)};
    import { startMcpServer } from ${JSON.stringify(serverModule)};
    VideoRegistry.prototype.start = async function () {
      await Bun.write("scan-started", "");
      await new Promise(() => {});
    };
    await startMcpServer(process.cwd());
  `,
  ]);
  try {
    await client.connect(transport);
    await expect
      .poll(() =>
        fs.access(`${ws.root}/scan-started`).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const result = await client.callTool({ name: "status" }, undefined, { timeout: 1_000 });
    const [content] = result.content as { text: string }[];
    const status = JSON.parse(content!.text);
    expect(status.workerPid).toBe(status.pid);
    expect(await client.ping()).toEqual({});
    await fs.unlink(`${ws.root}/.konte/daemons/${status.instanceId}.json`);
    await expect.poll(() => daemonProcessExists(status.pid), { timeout: 10_000 }).toBe(false);
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain(
      '"event":"worker_registration_lost"',
    );
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

it("reports status while worker selection is blocked", async () => {
  const ws = await makeWorkspace();
  await fs.mkdir(`${ws.root}/.konte/daemons`, { recursive: true });
  await fs.writeFile(`${ws.root}/.konte/daemons/worker.lock`, "held\nnonce\n");
  const { client, transport } = connection(ws.root);
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "status" }, undefined, { timeout: 1_000 });
    const [content] = result.content as { text: string }[];
    expect(JSON.parse(content!.text)).toMatchObject({ workerPid: null, videos: [] });
    expect(await client.ping()).toEqual({});
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

it("retries a failed initial worker selection without dropping the connection", async () => {
  const ws = await makeWorkspace({ videos: ["main"] });
  await fs.mkdir(`${ws.root}/.konte`, { recursive: true });
  await fs.writeFile(`${ws.root}/.konte/daemons`, "blocked");
  const { client, transport } = connection(ws.root);
  try {
    await client.connect(transport);
    await expect
      .poll(() => fs.readFile(mcpLogPath(ws.root), "utf-8"))
      .toContain('"event":"worker_check_failed"');
    expect((await daemonStatus(client)).workerPid).toBeNull();
    expect(await client.ping()).toEqual({});
    await fs.unlink(`${ws.root}/.konte/daemons`);
    await expect
      .poll(
        async () => {
          const status = await daemonStatus(client);
          return status.workerPid === status.pid && status.videos.includes("main");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
