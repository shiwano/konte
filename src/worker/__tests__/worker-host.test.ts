import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  WORKER_INSTANCE_ID,
  processExists,
  unregisterWorkerSync,
} from "../../core/worker-registry.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { WorkerLog, workerLogPath } from "../worker-log.js";
import { startWorkerHost } from "../worker-host.js";

const MODULES = {
  worker: new URL("../worker.ts", import.meta.url).href,
  registry: new URL("../video-registry.ts", import.meta.url).href,
};

// A worker whose script patches VideoRegistry, then calls runWorker.
function scriptWorkerCommand(script: string): string[] {
  return [process.execPath, "-e", script];
}

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace();
});

afterEach(async () => {
  unregisterWorkerSync(ws.root);
  await ws.cleanup();
});

const record = () => `${ws.root}/.konte/workers/${WORKER_INSTANCE_ID}.json`;
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

it("releases a registration claimed while it was stopping", async () => {
  const host = startWorkerHost(ws.root, {
    log: new WorkerLog(ws.root, { instanceId: WORKER_INSTANCE_ID }),
    workerCommand: scriptWorkerCommand("setInterval(() => {}, 1000)"),
  });
  await host.stop();
  expect(await host.exited).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await exists(record())).toBe(false);
});

it("releases a registration claimed past a check interval", async () => {
  const lock = `${ws.root}/.konte/workers/worker.lock`;
  await fs.mkdir(`${ws.root}/.konte/workers`, { recursive: true });
  await fs.writeFile(lock, "held\nnonce\n");
  const host = startWorkerHost(ws.root, {
    log: new WorkerLog(ws.root, { instanceId: WORKER_INSTANCE_ID }),
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

it("restarts only the worker when its definitions are stale", async () => {
  const log = new WorkerLog(ws.root, { instanceId: WORKER_INSTANCE_ID });
  const host = startWorkerHost(ws.root, {
    log,
    workerCommand: scriptWorkerCommand(`
    import { appendFile, readFile } from "node:fs/promises";
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      await appendFile("worker-pids", process.pid + "\\n");
      const starts = (await readFile("worker-pids", "utf-8")).trim().split("\\n").length;
      if (starts === 1) this.onStaleDefinitions("main", { kind: "generation" });
    };
    await runWorker(process.cwd());
  `),
  });
  try {
    const workerPids = async () =>
      (await fs.readFile(`${ws.root}/worker-pids`, "utf-8").catch(() => "")).trim().split("\n");
    await expect.poll(async () => new Set(await workerPids()).size, { timeout: 5_000 }).toBe(2);
    expect(await exists(record())).toBe(true);
    expect(await fs.readFile(workerLogPath(ws.root), "utf-8")).toContain(
      '"event":"stale_definitions_restart"',
    );
  } finally {
    await host.stop();
  }
});

it("stops on a failed worker, releasing the registration", async () => {
  const log = new WorkerLog(ws.root, { instanceId: WORKER_INSTANCE_ID });
  const host = startWorkerHost(ws.root, {
    log,
    captureStderr: true,
    workerCommand: scriptWorkerCommand(`
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      throw new Error("initial scan failed");
    };
    await runWorker(process.cwd());
  `),
  });
  expect(await host.exited).toBe(1);
  expect(host.stderrTail()).toContain("initial scan failed");
  expect(await exists(record())).toBe(false);
  await log.flush();
  expect(await fs.readFile(workerLogPath(ws.root), "utf-8")).toContain('"event":"worker_exited"');
});

it.skipIf(process.platform === "win32")("ends what the worker started along with it", async () => {
  const log = new WorkerLog(ws.root, { instanceId: WORKER_INSTANCE_ID });
  const host = startWorkerHost(ws.root, {
    log,
    workerCommand: scriptWorkerCommand(`
    import { spawn } from "node:child_process";
    import { VideoRegistry } from ${JSON.stringify(MODULES.registry)};
    import { runWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      const render = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      await Bun.write("render-pid", String(render.pid));
    };
    await runWorker(process.cwd());
  `),
  });
  try {
    await expect
      .poll(() => fs.readFile(`${ws.root}/render-pid`, "utf-8").catch(() => ""), {
        timeout: 5_000,
      })
      .not.toBe("");
    const renderPid = Number(await fs.readFile(`${ws.root}/render-pid`, "utf-8"));
    expect(processExists(renderPid)).toBe(true);
    await host.stop();
    expect(await host.exited).toBe(0);
    await expect.poll(() => processExists(renderPid), { timeout: 5_000 }).toBe(false);
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
    import { runWorker } from ${JSON.stringify(MODULES.worker)};
    VideoRegistry.prototype.start = async function () {
      const render = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      await Bun.write("render-pid", String(render.pid));
    };
    await runWorker(process.cwd());
  `);
    const host = spawn(
      process.execPath,
      [
        "-e",
        `
    import { WorkerLog } from ${JSON.stringify(new URL("../worker-log.ts", import.meta.url).href)};
    import { startWorkerHost } from ${JSON.stringify(new URL("../worker-host.ts", import.meta.url).href)};
    startWorkerHost(process.cwd(), {
      log: new WorkerLog(process.cwd()),
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
      await expect.poll(() => processExists(renderPid), { timeout: 5_000 }).toBe(false);
    } finally {
      host.kill("SIGKILL");
    }
  },
);
