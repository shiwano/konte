import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimWorker,
  WORKER_INSTANCE_ID,
  WORKER_NAMESPACE,
  heartbeatWorker,
  ownsWorker,
  liveWorkers,
  processStartToken,
  registerWorker,
  unregisterWorkerSync,
} from "../worker-registry.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace();
});

afterEach(async () => {
  unregisterWorkerSync(ws.root);
  await ws.cleanup();
});

const workersDir = () => path.join(ws.root, ".konte", "workers");

async function writeRecord(pid: number, startToken: string | null): Promise<string> {
  await fs.mkdir(workersDir(), { recursive: true });
  const instanceId = `other-${pid}`;
  const file = path.join(workersDir(), `${instanceId}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      instanceId,
      namespace: WORKER_NAMESPACE,
      pid,
      startToken,
      startedAt: "2026-01-01T00:00:00Z",
    }),
  );
  return file;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

describe("worker registry", () => {
  it.each([{}, { instanceId: "other" }, { namespace: WORKER_NAMESPACE }])(
    "removes records missing identity fields (%j)",
    async (identity) => {
      const valid = await writeRecord(process.ppid, await processStartToken(process.ppid));
      const old = path.join(workersDir(), `${process.pid}.json`);
      await fs.writeFile(
        old,
        JSON.stringify({
          pid: process.pid,
          startToken: null,
          startedAt: "2026-01-01",
          ...identity,
        }),
      );
      expect((await liveWorkers(ws.root)).map((record) => record.pid)).toEqual([process.ppid]);
      expect(await exists(old)).toBe(false);
      expect(await exists(valid)).toBe(true);
    },
  );

  it("claims the worker when no worker is alive", async () => {
    await writeRecord(await exitedPid(), null);
    expect((await claimWorker(ws.root)).pid).toBe(process.pid);
    expect(await exists(path.join(workersDir(), `${WORKER_INSTANCE_ID}.json`))).toBe(true);
  });

  it("leaves an existing worker in charge without registering this process", async () => {
    await writeRecord(process.ppid, await processStartToken(process.ppid));
    expect((await claimWorker(ws.root)).pid).toBe(process.ppid);
    expect(await exists(path.join(workersDir(), `${WORKER_INSTANCE_ID}.json`))).toBe(false);
  });

  it("registers this process and unregisters it", async () => {
    await registerWorker(ws.root);
    const file = path.join(workersDir(), `${WORKER_INSTANCE_ID}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      pid: process.pid,
      startToken: await processStartToken(process.pid),
    });

    unregisterWorkerSync(ws.root);
    expect(await exists(file)).toBe(false);
  });

  it("recognizes a lost or replaced registration without removing its replacement", async () => {
    await registerWorker(ws.root);
    expect(await ownsWorker(ws.root)).toBe(true);
    const file = path.join(workersDir(), `${WORKER_INSTANCE_ID}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf-8"));
    await fs.writeFile(file, JSON.stringify({ ...record, instanceId: "replacement" }));
    expect(await ownsWorker(ws.root)).toBe(false);
    unregisterWorkerSync(ws.root);
    expect(await exists(file)).toBe(true);
    await fs.unlink(file);
    expect(await ownsWorker(ws.root)).toBe(false);
  });

  it("never lists this process", async () => {
    await registerWorker(ws.root);
    expect(await liveWorkers(ws.root)).toEqual([]);
  });

  it("keeps a foreign namespace's worker even when its pid matches this process", async () => {
    const file = await writeRecord(process.pid, "foreign-start");
    const record = JSON.parse(await fs.readFile(file, "utf-8"));
    record.namespace = "foreign-namespace";
    await fs.writeFile(file, JSON.stringify(record));
    expect((await claimWorker(ws.root)).instanceId).toBe(record.instanceId);
    expect(await ownsWorker(ws.root)).toBe(false);
    expect(await exists(file)).toBe(true);
  });

  it("reclaims an expired foreign heartbeat despite a matching live pid", async () => {
    const file = await writeRecord(process.pid, "foreign-start");
    const record = JSON.parse(await fs.readFile(file, "utf-8"));
    await fs.writeFile(file, JSON.stringify({ ...record, namespace: "foreign-namespace" }));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect((await claimWorker(ws.root)).instanceId).toBe(WORKER_INSTANCE_ID);
    expect(await exists(file)).toBe(false);
  });

  it("refreshes its heartbeat without recreating a lost registration", async () => {
    await registerWorker(ws.root);
    const file = path.join(workersDir(), `${WORKER_INSTANCE_ID}.json`);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await heartbeatWorker(ws.root)).toBe(true);
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(old.getTime());
    await fs.unlink(file);
    expect(await heartbeatWorker(ws.root)).toBe(false);
    expect(await exists(file)).toBe(false);
  });

  it("expires a reused pid without a start token once its heartbeat stops", async () => {
    const file = await writeRecord(process.ppid, null);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await liveWorkers(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("lists another live worker", async () => {
    await writeRecord(process.ppid, await processStartToken(process.ppid));
    expect((await liveWorkers(ws.root)).map((r) => r.pid)).toEqual([process.ppid]);
  });

  it("drops the record of a process that exited", async () => {
    const file = await writeRecord(await exitedPid(), null);
    expect(await liveWorkers(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("drops a record whose pid a later process reuses", async () => {
    const file = await writeRecord(process.ppid, "not-its-start-time");
    expect(await liveWorkers(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });
});
