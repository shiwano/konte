import { readFileSync, readlinkSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { writeFileAtomic } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";

const WORKERS_DIR = path.join(".konte", "workers");
export const WORKER_INSTANCE_ID = randomUUID();
const HEARTBEAT_TTL_MS = 30_000;
export const WORKER_NAMESPACE = processNamespace();

export type WorkerRecord = {
  instanceId: string;
  namespace: string;
  pid: number;
  startToken: string | null;
  startedAt: string;
};

function processNamespace(): string {
  const host = `${process.platform}:${hostname()}`;
  if (process.platform !== "linux") return host;
  try {
    return `${host}:${readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim()}:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return `${host}:${WORKER_INSTANCE_ID}`;
  }
}

function recordPath(workspaceRoot: string, instanceId: string): string {
  return path.join(workspaceRoot, WORKERS_DIR, `${instanceId}.json`);
}

/**
 * What tells this pid's process apart from a later one reusing the number: the kernel's start time
 * on Linux, StartTime on Windows, `ps`'s elsewhere. Null when it cannot be read.
 */
export async function processStartToken(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The command name is parenthesized and may hold spaces; fields resume after the last `)`.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    // No procfs (macOS), or no such process.
  }
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "powershell.exe" : "ps";
    const args =
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ]
        : ["-o", "lstart=", "-p", String(pid)];
    execFile(command, args, { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
      const token = stdout?.trim();
      resolve(err || !token ? null : token);
    });
  });
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function heartbeatIsFresh(workspaceRoot: string, record: WorkerRecord): Promise<boolean> {
  try {
    const stat = await fs.stat(recordPath(workspaceRoot, record.instanceId));
    return Date.now() - stat.mtimeMs < HEARTBEAT_TTL_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function workerIsAlive(
  workspaceRoot: string,
  record: WorkerRecord,
  verifyIdentity = false,
): Promise<boolean> {
  if (record.namespace !== WORKER_NAMESPACE) return heartbeatIsFresh(workspaceRoot, record);
  if (!processExists(record.pid)) return false;
  if (record.startToken === null) return heartbeatIsFresh(workspaceRoot, record);
  if (!verifyIdentity) return true;
  const token = await processStartToken(record.pid);
  return token === null ? heartbeatIsFresh(workspaceRoot, record) : token === record.startToken;
}

export async function ownsWorker(workspaceRoot: string): Promise<boolean> {
  try {
    const record = JSON.parse(
      await fs.readFile(recordPath(workspaceRoot, WORKER_INSTANCE_ID), "utf-8"),
    ) as WorkerRecord;
    return record.instanceId === WORKER_INSTANCE_ID;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return false;
    throw error;
  }
}

export async function heartbeatWorker(workspaceRoot: string): Promise<boolean> {
  if (!(await ownsWorker(workspaceRoot))) return false;
  const now = new Date();
  await fs.utimes(recordPath(workspaceRoot, WORKER_INSTANCE_ID), now, now);
  return true;
}

/** Record this process as a live worker of the workspace. */
export async function registerWorker(workspaceRoot: string): Promise<WorkerRecord> {
  const record: WorkerRecord = {
    instanceId: WORKER_INSTANCE_ID,
    namespace: WORKER_NAMESPACE,
    pid: process.pid,
    startToken: await processStartToken(process.pid),
    startedAt: new Date().toISOString(),
  };
  const file = recordPath(workspaceRoot, WORKER_INSTANCE_ID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`);
  return record;
}

export async function claimWorker(workspaceRoot: string): Promise<WorkerRecord> {
  const dir = path.join(workspaceRoot, WORKERS_DIR);
  await fs.mkdir(dir, { recursive: true });
  return withFileLock(path.join(dir, "worker.lock"), async () => {
    const [worker] = await liveWorkers(workspaceRoot);
    if (worker) return worker;
    return registerWorker(workspaceRoot);
  });
}

/** Synchronous, for a signal handler that has milliseconds left. */
export function unregisterWorkerSync(workspaceRoot: string): void {
  const file = recordPath(workspaceRoot, WORKER_INSTANCE_ID);
  try {
    if ((JSON.parse(readFileSync(file, "utf-8")) as WorkerRecord).instanceId !== WORKER_INSTANCE_ID)
      return;
    rmSync(file, { force: true });
  } catch {}
}

/** The workspace's workers still running, other than this process. Dead records are removed. */
export async function liveWorkers(workspaceRoot: string): Promise<WorkerRecord[]> {
  const dir = path.join(workspaceRoot, WORKERS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const live: WorkerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let record: WorkerRecord;
    try {
      record = JSON.parse(await fs.readFile(file, "utf-8")) as WorkerRecord;
    } catch {
      continue;
    }
    if (typeof record.instanceId !== "string" || typeof record.namespace !== "string") {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    if (record.instanceId === WORKER_INSTANCE_ID) continue;
    if (await workerIsAlive(workspaceRoot, record, true)) live.push(record);
    else await fs.rm(file, { force: true }).catch(() => {});
  }
  return live;
}
