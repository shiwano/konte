import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import {
  claimDaemon,
  liveDaemons,
  registerDaemon,
  unregisterDaemonSync,
} from "../../core/daemon-registry.js";
import { closeJobDatabase, JobManager } from "../../core/job-manager.js";
import { makeWorkspace } from "../../core/__tests__/helpers/workspace.js";
import { mcpLogPath } from "../mcp-log.js";
import { connection, daemonStatus, MODULES, scriptWorkerCommand } from "./server-fixtures.js";

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

it.each(["SIGTERM", "stdin-closed"])(
  "keeps its registration while the worker drains on %s",
  async (reason) => {
    const ws = await makeWorkspace();
    const worker = scriptWorkerCommand(`
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    import { trackSubmission } from ${JSON.stringify(MODULES.drain)};
    const submission = Promise.withResolvers();
    trackSubmission(submission.promise);
    process.once("disconnect", () => {
      void Bun.write("shutdown-started", "");
      const releasing = setInterval(async () => {
        if (await Bun.file("release-drain").exists()) {
          clearInterval(releasing);
          submission.resolve();
        }
      }, 10);
    });
    VideoRegistry.prototype.start = async function () {
      await Bun.write("worker-started", "");
    };
    await runMcpWorker(process.cwd());
  `);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    import { startMcpServer } from ${JSON.stringify(MODULES.server)};
    await startMcpServer(process.cwd(), { workerCommand: ${JSON.stringify(worker)} });
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
      await expect.poll(() => exists(`${ws.root}/worker-started`), { timeout: 5_000 }).toBe(true);
      if (reason === "SIGTERM") child.kill("SIGTERM");
      else child.stdin.end();
      await expect.poll(() => exists(`${ws.root}/shutdown-started`), { timeout: 5_000 }).toBe(true);
      const records = await liveDaemons(ws.root);
      expect(records.map((record) => record.pid)).toEqual([child.pid]);
      const file = `${ws.root}/.konte/daemons/${records[0]!.instanceId}.json`;
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(file, old, old);
      await expect
        .poll(async () => (await fs.stat(file)).mtimeMs, { timeout: 10_000 })
        .toBeGreaterThan(old.getTime());
      expect((await claimDaemon(ws.root)).pid).toBe(child.pid);
      expect(exitCode).toBeUndefined();
      await fs.writeFile(`${ws.root}/release-drain`, "");
      await expect.poll(() => exitCode, { timeout: 5_000 }).toBe(0);
      expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain(`"signal":"${reason}"`);
    } finally {
      await fs.writeFile(`${ws.root}/release-drain`, "");
      child.kill();
      unregisterDaemonSync(ws.root);
      await ws.cleanup();
    }
  },
);

it("restarts only the worker when its definitions are stale", async () => {
  const ws = await makeWorkspace();
  const worker = scriptWorkerCommand(`
    import { appendFile, readFile } from "node:fs/promises";
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      await appendFile("worker-pids", process.pid + "\\n");
      const starts = (await readFile("worker-pids", "utf-8")).trim().split("\\n").length;
      if (starts === 1) this.onStaleDefinitions("main", { kind: "generation" });
    };
    await runMcpWorker(process.cwd());
  `);
  const { client, transport } = connection(ws.root, [
    "-e",
    `
    import { startMcpServer } from ${JSON.stringify(MODULES.server)};
    await startMcpServer(process.cwd(), { workerCommand: ${JSON.stringify(worker)} });
  `,
  ]);
  const events: unknown[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    events.push(notification.params.data);
  });
  try {
    await client.connect(transport);
    const before = await daemonStatus(client);
    const workerPids = async () =>
      (await fs.readFile(`${ws.root}/worker-pids`, "utf-8").catch(() => "")).trim().split("\n");
    await expect.poll(async () => new Set(await workerPids()).size, { timeout: 5_000 }).toBe(2);
    const after = await daemonStatus(client);
    expect(after.pid).toBe(before.pid);
    expect(after.workerPid).toBe(after.pid);
    expect((await liveDaemons(ws.root)).map((record) => record.pid)).toEqual([after.pid]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "stale_definitions_restart", video: "main" }),
    );
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain(
      '"event":"stale_definitions_restart"',
    );
  } finally {
    await client.close();
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

it("waits for a failed worker's cleanup before starting a replacement", async () => {
  const ws = await makeWorkspace();
  const worker = scriptWorkerCommand(`
    import { existsSync } from "node:fs";
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    const starts = Number(await Bun.file("registry-starts").text().catch(() => "0")) + 1;
    await Bun.write("registry-starts", String(starts));
    if (starts === 1) {
      VideoRegistry.prototype.start = async function () {
        throw new Error("initial scan failed");
      };
      VideoRegistry.prototype.stop = function () {
        return new Promise((resolve) => {
          const timer = setInterval(() => {
            if (existsSync("release-cleanup")) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
          setTimeout(() => { void Bun.write("cleanup-waited", ""); }, 100);
        });
      };
    }
    await runMcpWorker(process.cwd());
  `);
  const { client, transport } = connection(ws.root, [
    "-e",
    `
    import { startMcpServer } from ${JSON.stringify(MODULES.server)};
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 20 : ms, ...args);
    await startMcpServer(process.cwd(), { workerCommand: ${JSON.stringify(worker)} });
  `,
  ]);
  try {
    await client.connect(transport);
    await expect.poll(() => exists(`${ws.root}/cleanup-waited`), { timeout: 5_000 }).toBe(true);
    expect(await fs.readFile(`${ws.root}/registry-starts`, "utf-8")).toBe("1");
    expect((await liveDaemons(ws.root)).map((record) => record.pid)).toEqual([
      (await daemonStatus(client)).pid,
    ]);
    await fs.writeFile(`${ws.root}/release-cleanup`, "");
    await expect
      .poll(() => fs.readFile(`${ws.root}/registry-starts`, "utf-8"), { timeout: 5_000 })
      .toBe("2");
    const log = await fs.readFile(mcpLogPath(ws.root), "utf-8");
    expect(log).toContain('"event":"worker_start_failed"');
    expect(log).toContain('"event":"worker_exited"');
    expect(await client.ping()).toEqual({});
  } finally {
    await fs.writeFile(`${ws.root}/release-cleanup`, "");
    await client.close();
    await ws.cleanup();
  }
});

it("exits an attached daemon whose worker fails", async () => {
  const ws = await makeWorkspace();
  const worker = scriptWorkerCommand(`
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      throw new Error("initial scan failed");
    };
    await runMcpWorker(process.cwd());
  `);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    import { startMcpServer } from ${JSON.stringify(MODULES.server)};
    await startMcpServer(process.cwd(), {
      attached: true,
      workerCommand: ${JSON.stringify(worker)},
    });
  `,
    ],
    { cwd: ws.root, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  let exitCode: number | null | undefined;
  child.once("exit", (code) => {
    exitCode = code;
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  try {
    await expect.poll(() => exitCode, { timeout: 5_000 }).toBe(1);
    expect(stderr).toContain("initial scan failed");
    expect(await liveDaemons(ws.root)).toEqual([]);
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain('"signal":"worker-exited"');
  } finally {
    child.kill();
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
      .poll(
        () =>
          fs.access(`${ws.root}/polls-complete`).then(
            () => true,
            () => false,
          ),
        { timeout: 5_000 },
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

it("replaces its worker when its registration was removed", async () => {
  const ws = await makeWorkspace({ videos: ["main"] });
  const { client, transport } = connection(ws.root);
  try {
    await client.connect(transport);
    await expect
      .poll(async () => (await daemonStatus(client)).videos, { timeout: 5_000 })
      .toEqual(["main"]);
    const original = await daemonStatus(client);
    const record = `${ws.root}/.konte/daemons/${original.instanceId}.json`;
    await fs.unlink(record);
    await expect
      .poll(
        async () =>
          (await fs.readFile(mcpLogPath(ws.root), "utf-8")).split('"event":"worker_started"')
            .length - 1,
        { timeout: 15_000 },
      )
      .toBe(2);
    expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain(
      '"event":"worker_registration_lost"',
    );
    expect(await exists(record)).toBe(true);
    await expect
      .poll(async () => (await daemonStatus(client)).videos, { timeout: 5_000 })
      .toEqual(["main"]);
    const status = await daemonStatus(client);
    expect(status.pid).toBe(original.pid);
    expect(status.workerPid).toBe(original.pid);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
