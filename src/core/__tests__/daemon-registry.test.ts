import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasLiveDaemon,
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

async function writeRecord(
  pid: number,
  startToken: string | null,
  opts: { attached?: boolean } = {},
): Promise<string> {
  await fs.mkdir(daemonsDir(), { recursive: true });
  const file = path.join(daemonsDir(), `${pid}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ pid, startToken, startedAt: "2026-01-01T00:00:00Z", ...opts }),
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
  it("registers this process and unregisters it", async () => {
    await registerDaemon(ws.root);
    const file = path.join(daemonsDir(), `${process.pid}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      pid: process.pid,
      startToken: await processStartToken(process.pid),
    });

    unregisterDaemonSync(ws.root);
    expect(await exists(file)).toBe(false);
  });

  it("counts this process as a live daemon once registered, though it never lists it", async () => {
    expect(await hasLiveDaemon(ws.root)).toBe(false);

    await registerDaemon(ws.root);
    expect(await hasLiveDaemon(ws.root)).toBe(true);
    expect(await liveDaemons(ws.root)).toEqual([]);
  });

  it("lists another live daemon", async () => {
    await writeRecord(process.ppid, await processStartToken(process.ppid));
    expect((await liveDaemons(ws.root)).map((r) => r.pid)).toEqual([process.ppid]);
    expect(await hasLiveDaemon(ws.root)).toBe(true);
  });

  it("lists an attached daemon, but does not count it as outliving the wait", async () => {
    await writeRecord(process.ppid, await processStartToken(process.ppid), { attached: true });
    expect((await liveDaemons(ws.root)).map((r) => r.pid)).toEqual([process.ppid]);
    expect(await hasLiveDaemon(ws.root)).toBe(false);

    await registerDaemon(ws.root, { attached: true });
    expect(await hasLiveDaemon(ws.root)).toBe(false);
  });

  it("drops the record of a process that exited", async () => {
    const file = await writeRecord(await exitedPid(), null);
    expect(await liveDaemons(ws.root)).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("drops a record whose pid a later process reuses", async () => {
    const file = await writeRecord(process.ppid, "not-its-start-time");
    expect(await hasLiveDaemon(ws.root)).toBe(false);
    expect(await exists(file)).toBe(false);
  });
});
