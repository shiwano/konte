import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import {
  claimDaemon,
  daemonProcessExists,
  liveDaemons,
  registerDaemon,
  unregisterDaemonSync,
} from "../../core/daemon-registry.js";
import { closeJobDatabase, JobManager } from "../../core/job-manager.js";
import { makeWorkspace } from "../../core/__tests__/helpers/workspace.js";
import { mcpLogPath } from "../mcp-log.js";

function connection(workspaceRoot: string, args?: string[]) {
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

async function daemonStatus(client: Client): Promise<{
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

it.each(["SIGTERM", "stdin-closed"])("honors %s during a restart drain", async (reason) => {
  const ws = await makeWorkspace();
  const registryModule = new URL("../video-registry.ts", import.meta.url).href;
  const serverModule = new URL("../index.ts", import.meta.url).href;
  const drainModule = new URL("../../core/submission-drain.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    import { VideoRegistry } from ${JSON.stringify(registryModule)};
    import { startMcpServer } from ${JSON.stringify(serverModule)};
    import { trackSubmission, submittingStopped } from ${JSON.stringify(drainModule)};
    const submission = Promise.withResolvers();
    trackSubmission(submission.promise);
    const reason = ${JSON.stringify(reason)};
    process.stdin.once(reason === "SIGTERM" ? "data" : "end", () => {
      if (reason === "SIGTERM") process.emit("SIGTERM");
      void Bun.write("shutdown-started", "");
      const releasing = setInterval(async () => {
        if (await Bun.file("release-drain").exists()) {
          clearInterval(releasing);
          submission.resolve();
        }
      }, 10);
    });
    VideoRegistry.prototype.start = async function () {
      this.onStaleDefinitions("main", { kind: "generation" });
      while (!submittingStopped()) await Bun.sleep(1);
      await Bun.write("restart-started", "");
    };
    await startMcpServer(process.cwd());
  `,
    ],
    { cwd: ws.root, stdio: ["pipe", "pipe", "pipe"] },
  );
  let exitCode: number | null | undefined;
  child.once("exit", (code) => {
    exitCode = code;
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    await expect
      .poll(() =>
        fs.access(`${ws.root}/restart-started`).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    if (reason === "SIGTERM") child.stdin.write("stop");
    else child.stdin.end();
    await expect
      .poll(() =>
        fs.access(`${ws.root}/shutdown-started`).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const records = await liveDaemons(ws.root);
    expect(records.map((record) => record.pid)).toEqual([child.pid]);
    if (reason === "SIGTERM") {
      const file = `${ws.root}/.konte/daemons/${records[0]!.instanceId}.json`;
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(file, old, old);
      await expect
        .poll(async () => (await fs.stat(file)).mtimeMs, { timeout: 10_000 })
        .toBeGreaterThan(old.getTime());
    }
    expect((await claimDaemon(ws.root)).pid).toBe(child.pid);
    await fs.writeFile(`${ws.root}/release-drain`, "");
    await expect.poll(() => exitCode, { timeout: 5_000 }).toBe(0);
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain(`"signal":"${reason}"`);
  } finally {
    await fs.writeFile(`${ws.root}/release-drain`, "");
    child.kill();
    unregisterDaemonSync(ws.root);
    await ws.cleanup();
  }
});

it("stays connected when queued jobs log a startup failure", async () => {
  const ws = await makeWorkspace({ videos: ["main"] });
  const videoRoot = ws.videos.main!.video;
  const manager = new JobManager(videoRoot);
  const { client, transport } = connection(ws.root);
  try {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-startup",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    closeJobDatabase(videoRoot);
    await client.connect(transport);
    await expect
      .poll(() => fs.readFile(mcpLogPath(ws.root), "utf-8"), { timeout: 5_000 })
      .toContain('"event":"cascade_submit_failed"');
    expect((await daemonStatus(client)).videos).toEqual(["main"]);
    expect(await client.ping()).toEqual({});
  } finally {
    await client.close();
    closeJobDatabase(videoRoot);
    await ws.cleanup();
  }
});

it("waits for registry cleanup before starting a replacement", async () => {
  const ws = await makeWorkspace();
  const registryModule = new URL("../video-registry.ts", import.meta.url).href;
  const serverModule = new URL("../index.ts", import.meta.url).href;
  const { client, transport } = connection(ws.root, [
    "-e",
    `
    import { existsSync } from "node:fs";
    import { VideoRegistry } from ${JSON.stringify(registryModule)};
    import { startMcpServer } from ${JSON.stringify(serverModule)};
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 20 : ms, ...args);
    const start = VideoRegistry.prototype.start;
    const stop = VideoRegistry.prototype.stop;
    let starts = 0;
    VideoRegistry.prototype.start = async function () {
      this.startNumber = ++starts;
      await Bun.write("registry-starts", String(starts));
      if (starts === 1) throw new Error("initial scan failed");
      return start.call(this);
    };
    VideoRegistry.prototype.stop = function () {
      if (this.startNumber !== 1) return stop.call(this);
      return new Promise((resolve) => {
        const timer = interval(() => {
          if (existsSync("release-cleanup")) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
        setTimeout(() => { void Bun.write("cleanup-waited", ""); }, 100);
      });
    };
    await startMcpServer(process.cwd());
  `,
  ]);
  try {
    await client.connect(transport);
    await expect
      .poll(() =>
        fs.access(`${ws.root}/cleanup-waited`).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    expect(await fs.readFile(`${ws.root}/registry-starts`, "utf-8")).toBe("1");
    expect((await liveDaemons(ws.root)).map((record) => record.pid)).toEqual([
      (await daemonStatus(client)).pid,
    ]);
    await fs.writeFile(`${ws.root}/release-cleanup`, "");
    await expect.poll(() => fs.readFile(`${ws.root}/registry-starts`, "utf-8")).toBe("2");
    expect(await client.ping()).toEqual({});
  } finally {
    await fs.writeFile(`${ws.root}/release-cleanup`, "");
    await client.close();
    await ws.cleanup();
  }
});

it("keeps standby polling off the claim lock while the known worker lives", async () => {
  const ws = await makeWorkspace();
  await registerDaemon(ws.root);
  const registryModule = new URL("../../core/daemon-registry.ts", import.meta.url).href;
  const serverModule = new URL("../index.ts", import.meta.url).href;
  const { client, transport } = connection(ws.root, [
    "-e",
    `
    import { mock } from "bun:test";
    import * as registry from ${JSON.stringify(registryModule)};
    const actual = { ...registry };
    let claims = 0;
    mock.module(${JSON.stringify(registryModule)}, () => ({
      ...actual,
      claimDaemon: async (...args) => {
        await Bun.write("claims", String(++claims));
        return actual.claimDaemon(...args);
      },
    }));
    const interval = globalThis.setInterval;
    let checks = 0;
    globalThis.setInterval = (fn, ms, ...args) => interval(() => {
      fn(...args);
      if (ms === 5000 && ++checks === 5) void Bun.write("polls-complete", "");
    }, ms === 5000 ? 20 : ms);
    const { startMcpServer } = await import(${JSON.stringify(serverModule)});
    await startMcpServer(process.cwd());
  `,
  ]);
  try {
    await client.connect(transport);
    await expect
      .poll(() =>
        fs.access(`${ws.root}/polls-complete`).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    expect(await fs.readFile(`${ws.root}/claims`, "utf-8")).toBe("1");
    expect((await daemonStatus(client)).workerPid).toBe(process.pid);
  } finally {
    await client.close();
    unregisterDaemonSync(ws.root);
    await ws.cleanup();
  }
});

it("restarts a worker whose registration was removed", async () => {
  const ws = await makeWorkspace();
  const { client, transport } = connection(ws.root);
  try {
    await client.connect(transport);
    await expect.poll(async () => (await daemonStatus(client)).workerPid).not.toBeNull();
    const original = await daemonStatus(client);
    await fs.unlink(`${ws.root}/.konte/daemons/${original.instanceId}.json`);
    await expect
      .poll(
        async () => {
          const status = await daemonStatus(client);
          return status.pid !== original.pid && status.workerPid === status.pid;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain(
      '"event":"worker_registration_lost"',
    );
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

it("keeps a foreign namespace's matching pid on standby until its heartbeat expires", async () => {
  const ws = await makeWorkspace();
  const serverModule = new URL("../index.ts", import.meta.url).href;
  const { client, transport } = connection(ws.root, [
    "-e",
    `
    import { mkdir } from "node:fs/promises";
    import { startMcpServer } from ${JSON.stringify(serverModule)};
    await mkdir(".konte/daemons", { recursive: true });
    await Bun.write(".konte/daemons/foreign.json", JSON.stringify({
      instanceId: "foreign", namespace: "foreign-namespace", pid: process.pid,
      startToken: null, startedAt: new Date().toISOString(),
    }));
    await startMcpServer(process.cwd());
  `,
  ]);
  try {
    await client.connect(transport);
    await expect.poll(async () => (await daemonStatus(client)).workerInstanceId).toBe("foreign");
    const status = await daemonStatus(client);
    expect(status.workerPid).toBe(status.pid);
    expect(status.instanceId).not.toBe(status.workerInstanceId);
    expect(status.videos).toEqual([]);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${ws.root}/.konte/daemons/foreign.json`, old, old);
    await expect
      .poll(
        async () => {
          const current = await daemonStatus(client);
          return current.workerInstanceId === current.instanceId;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

it("elects one worker on concurrent startup and takes over when it dies", async () => {
  const ws = await makeWorkspace({ videos: ["main"] });
  const connections = [connection(ws.root), connection(ws.root), connection(ws.root)];
  try {
    await Promise.all(connections.map(({ client, transport }) => client.connect(transport)));
    await expect
      .poll(async () => {
        const statuses = await Promise.all(connections.map(({ client }) => daemonStatus(client)));
        const workers = statuses.filter((s) => s.pid === s.workerPid && s.videos.includes("main"));
        return workers.length === 1 && statuses.every((s) => s.workerPid === workers[0]!.pid);
      })
      .toBe(true);
    const statuses = await Promise.all(connections.map(({ client }) => daemonStatus(client)));
    const workers = statuses.filter((s) => s.pid === s.workerPid);
    expect(workers).toHaveLength(1);
    const worker = workers[0]!;
    expect(worker.videos).toEqual(["main"]);
    expect(statuses.every((s) => s.workerPid === worker.pid)).toBe(true);
    expect(statuses.filter((s) => s.pid !== worker.pid).map((s) => s.videos)).toEqual([[], []]);
    expect((await liveDaemons(ws.root)).map((r) => r.pid)).toEqual([worker.pid]);

    process.kill(worker.pid, "SIGKILL");
    const survivors = connections.filter((_, i) => statuses[i]!.pid !== worker.pid);
    await expect.poll(() => daemonProcessExists(worker.pid)).toBe(false);
    const immediate = await Promise.all(survivors.map(({ client }) => daemonStatus(client)));
    expect(immediate.every((status) => status.workerPid !== worker.pid)).toBe(true);
    await expect
      .poll(
        async () => {
          const next = await Promise.all(survivors.map(({ client }) => daemonStatus(client)));
          const workers = next.filter((s) => s.pid === s.workerPid && s.videos.includes("main"));
          return workers.length === 1 && next.every((s) => s.workerPid === workers[0]!.pid);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const next = await Promise.all(survivors.map(({ client }) => daemonStatus(client)));
    const [active] = await liveDaemons(ws.root);
    expect(active).toBeDefined();
    expect(next.every((s) => s.workerPid === active!.pid)).toBe(true);
    expect(next.filter((s) => s.pid !== active!.pid).map((s) => s.videos)).toEqual([[]]);
  } finally {
    await Promise.all(connections.map(({ client }) => client.close()));
    await ws.cleanup();
  }
});
