import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimDaemon,
  DAEMON_INSTANCE_ID,
  DAEMON_NAMESPACE,
  heartbeatDaemon,
  ownsDaemon,
  liveDaemons,
  processStartToken,
  registerDaemon,
  unregisterDaemonSync,
} from "../daemon-registry.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace();
});

afterEach(async () => {
  unregisterDaemonSync(ws.root);
  await ws.cleanup();
});

const daemonsDir = () => path.join(ws.root, ".konte", "daemons");

async function writeRecord(pid: number, startToken: string | null): Promise<string> {
  await fs.mkdir(daemonsDir(), { recursive: true });
  const instanceId = `other-${pid}`;
  const file = path.join(daemonsDir(), `${instanceId}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      instanceId,
      namespace: DAEMON_NAMESPACE,
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

describe("daemon registry", () => {
  it.each([{}, { instanceId: "other" }, { namespace: DAEMON_NAMESPACE }])(
    "removes records missing identity fields (%j)",
    async (identity) => {
      const valid = await writeRecord(process.ppid, await processStartToken(process.ppid));
      const old = path.join(daemonsDir(), `${process.pid}.json`);
      await fs.writeFile(
        old,
        JSON.stringify({
          pid: process.pid,
          startToken: null,
          startedAt: "2026-01-01",
          ...identity,
        }),
      );
      expect((await liveDaemons(ws.root)).map((record) => record.pid)).toEqual([process.ppid]);
      expect(await exists(old)).toBe(false);
      expect(await exists(valid)).toBe(true);
    },
  );

  it("claims the worker when no daemon is alive", async () => {
    await writeRecord(await exitedPid(), null);
    expect((await claimDaemon(ws.root)).pid).toBe(process.pid);
    expect(await exists(path.join(daemonsDir(), `${DAEMON_INSTANCE_ID}.json`))).toBe(true);
  });

  it("leaves an existing worker in charge without registering this process", async () => {
    await writeRecord(process.ppid, await processStartToken(process.ppid));
    expect((await claimDaemon(ws.root)).pid).toBe(process.ppid);
    expect(await exists(path.join(daemonsDir(), `${DAEMON_INSTANCE_ID}.json`))).toBe(false);
  });

  it("registers this process and unregisters it", async () => {
    await registerDaemon(ws.root);
    const file = path.join(daemonsDir(), `${DAEMON_INSTANCE_ID}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      pid: process.pid,
      startToken: await processStartToken(process.pid),
    });

    unregisterDaemonSync(ws.root);
    expect(await exists(file)).toBe(false);
  });

  it("recognizes a lost or replaced registration without removing its replacement", async () => {
    await registerDaemon(ws.root);
    expect(await ownsDaemon(ws.root)).toBe(true);
    const file = path.join(daemonsDir(), `${DAEMON_INSTANCE_ID}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf-8"));
    await fs.writeFile(file, JSON.stringify({ ...record, instanceId: "replacement" }));
    expect(await ownsDaemon(ws.root)).toBe(false);
    unregisterDaemonSync(ws.root);
    expect(await exists(file)).toBe(true);
    await fs.unlink(file);
    expect(await ownsDaemon(ws.root)).toBe(false);
  });

  it("never lists this process", async () => {
    await registerDaemon(ws.root);
    expect(await liveDaemons(ws.root)).toEqual([]);
  });

  it("keeps a foreign namespace's worker even when its pid matches this process", async () => {
    const file = await writeRecord(process.pid, "foreign-start");
    const record = JSON.parse(await fs.readFile(file, "utf-8"));
    record.namespace = "foreign-namespace";
    await fs.writeFile(file, JSON.stringify(record));
    expect((await claimDaemon(ws.root)).instanceId).toBe(record.instanceId);
    expect(await ownsDaemon(ws.root)).toBe(false);
    expect(await exists(file)).toBe(true);
  });

  it("reclaims an expired foreign heartbeat despite a matching live pid", async () => {
    const file = await writeRecord(process.pid, "foreign-start");
    const record = JSON.parse(await fs.readFile(file, "utf-8"));
    await fs.writeFile(file, JSON.stringify({ ...record, namespace: "foreign-namespace" }));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect((await claimDaemon(ws.root)).instanceId).toBe(DAEMON_INSTANCE_ID);
    expect(await exists(file)).toBe(false);
  });

  it("refreshes its heartbeat without recreating a lost registration", async () => {
    await registerDaemon(ws.root);
    const file = path.join(daemonsDir(), `${DAEMON_INSTANCE_ID}.json`);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await heartbeatDaemon(ws.root)).toBe(true);
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(old.getTime());
    await fs.unlink(file);
    expect(await heartbeatDaemon(ws.root)).toBe(false);
    expect(await exists(file)).toBe(false);
  });

  it("expires a reused pid without a start token once its heartbeat stops", async () => {
    const file = await writeRecord(process.ppid, null);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await liveDaemons(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("lists another live daemon", async () => {
    await writeRecord(process.ppid, await processStartToken(process.ppid));
    expect((await liveDaemons(ws.root)).map((r) => r.pid)).toEqual([process.ppid]);
  });

  it("drops the record of a process that exited", async () => {
    const file = await writeRecord(await exitedPid(), null);
    expect(await liveDaemons(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("drops a record whose pid a later process reuses", async () => {
    const file = await writeRecord(process.ppid, "not-its-start-time");
    expect(await liveDaemons(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });
});
