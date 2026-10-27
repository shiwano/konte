import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
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
import { connection, daemonStatus } from "./server-fixtures.js";

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
