import * as fs from "node:fs/promises";
import { expect, it } from "vitest";
import { daemonProcessExists, liveDaemons } from "../../core/daemon-registry.js";
import { makeWorkspace } from "../../core/__tests__/helpers/workspace.js";
import { connection, daemonStatus } from "./server-fixtures.js";

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
