import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DAEMON_INSTANCE_ID,
  daemonProcessExists,
  unregisterDaemonSync,
} from "../../core/daemon-registry.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { McpLog, mcpLogPath } from "../mcp-log.js";
import { startWorkerHost } from "../worker-host.js";
import { MODULES, scriptWorkerCommand } from "./server-fixtures.js";

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace();
});

afterEach(async () => {
  unregisterDaemonSync(ws.root);
  await ws.cleanup();
});

const record = () => `${ws.root}/.konte/daemons/${DAEMON_INSTANCE_ID}.json`;
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

it("releases a registration claimed while it was stopping", async () => {
  const host = startWorkerHost(ws.root, {
    log: new McpLog(ws.root, { instanceId: DAEMON_INSTANCE_ID }),
    workerCommand: scriptWorkerCommand("setInterval(() => {}, 1000)"),
  });
  await host.stop();
  expect(await host.exited).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await exists(record())).toBe(false);
});

it("releases a registration claimed past a check interval", async () => {
  const lock = `${ws.root}/.konte/daemons/worker.lock`;
  await fs.mkdir(`${ws.root}/.konte/daemons`, { recursive: true });
  await fs.writeFile(lock, "held\nnonce\n");
  const host = startWorkerHost(ws.root, {
    log: new McpLog(ws.root, { instanceId: DAEMON_INSTANCE_ID }),
    workerCommand: scriptWorkerCommand("setInterval(() => {}, 1000)"),
    checkIntervalMs: 50,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopped = host.stop();
  await fs.unlink(lock);
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await exists(record())).toBe(false);
});

it("stops on a failed worker when asked to, releasing the registration", async () => {
  const log = new McpLog(ws.root, { instanceId: DAEMON_INSTANCE_ID });
  const host = startWorkerHost(ws.root, {
    log,
    stopOnWorkerFailure: true,
    captureStderr: true,
    workerCommand: scriptWorkerCommand(`
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      throw new Error("initial scan failed");
    };
    await runMcpWorker(process.cwd());
  `),
  });
  expect(await host.exited).toBe(1);
  expect(host.stderrTail()).toContain("initial scan failed");
  expect(await exists(record())).toBe(false);
  await log.flush();
  expect(await fs.readFile(mcpLogPath(ws.root), "utf-8")).toContain('"event":"worker_exited"');
});

it.skipIf(process.platform === "win32")("ends what the worker started along with it", async () => {
  const log = new McpLog(ws.root, { instanceId: DAEMON_INSTANCE_ID });
  const host = startWorkerHost(ws.root, {
    log,
    workerCommand: scriptWorkerCommand(`
    import { spawn } from "node:child_process";
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      const render = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      await Bun.write("render-pid", String(render.pid));
    };
    await runMcpWorker(process.cwd());
  `),
  });
  try {
    await expect
      .poll(() => fs.readFile(`${ws.root}/render-pid`, "utf-8").catch(() => ""), {
        timeout: 5_000,
      })
      .not.toBe("");
    const renderPid = Number(await fs.readFile(`${ws.root}/render-pid`, "utf-8"));
    expect(daemonProcessExists(renderPid)).toBe(true);
    await host.stop();
    expect(await host.exited).toBe(0);
    await expect.poll(() => daemonProcessExists(renderPid), { timeout: 5_000 }).toBe(false);
    expect(await exists(record())).toBe(false);
  } finally {
    await host.stop();
  }
});

it.skipIf(process.platform === "win32")(
  "ends what the worker started when its host is killed",
  async () => {
    const worker = scriptWorkerCommand(`
    import { spawn } from "node:child_process";
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runMcpWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      const render = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      await Bun.write("render-pid", String(render.pid));
    };
    await runMcpWorker(process.cwd());
  `);
    const host = spawn(
      process.execPath,
      [
        "-e",
        `
    import { McpLog } from ${JSON.stringify(new URL("../mcp-log.ts", import.meta.url).href)};
    import { startWorkerHost } from ${JSON.stringify(new URL("../worker-host.ts", import.meta.url).href)};
    startWorkerHost(process.cwd(), {
      log: new McpLog(process.cwd()),
      workerCommand: ${JSON.stringify(worker)},
    });
  `,
      ],
      { cwd: ws.root, stdio: "ignore" },
    );
    try {
      await expect
        .poll(() => fs.readFile(`${ws.root}/render-pid`, "utf-8").catch(() => ""), {
          timeout: 5_000,
        })
        .not.toBe("");
      const renderPid = Number(await fs.readFile(`${ws.root}/render-pid`, "utf-8"));
      host.kill("SIGKILL");
      await expect.poll(() => daemonProcessExists(renderPid), { timeout: 5_000 }).toBe(false);
    } finally {
      host.kill("SIGKILL");
    }
  },
);
