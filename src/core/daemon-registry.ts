import { readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { writeFileAtomic } from "./atomic-write.js";

const DAEMONS_DIR = path.join(".konte", "daemons");

type DaemonRecord = {
  pid: number;
  startToken: string | null;
  startedAt: string;
};

function recordPath(workspaceRoot: string, pid: number): string {
  return path.join(workspaceRoot, DAEMONS_DIR, `${pid}.json`);
}

/**
 * What tells this pid's process apart from a later one reusing the number: the kernel's start time
 * on Linux, `ps`'s elsewhere. Null when neither can be read.
 */
export async function processStartToken(pid: number): Promise<string | null> {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The command name is parenthesized and may hold spaces; fields resume after the last `)`.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    // No procfs (macOS), or no such process.
  }
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], (err, stdout) => {
      const token = stdout?.trim();
      resolve(err || !token ? null : token);
    });
  });
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isAlive(record: DaemonRecord): Promise<boolean> {
  if (!pidExists(record.pid)) return false;
  if (record.startToken === null) return true;
  return (await processStartToken(record.pid)) === record.startToken;
}

/** Record this process as a live daemon of the workspace. */
export async function registerDaemon(workspaceRoot: string): Promise<void> {
  const record: DaemonRecord = {
    pid: process.pid,
    startToken: await processStartToken(process.pid),
    startedAt: new Date().toISOString(),
  };
  const file = recordPath(workspaceRoot, process.pid);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`);
}

/** Synchronous, for a signal handler that has milliseconds left. */
export function unregisterDaemonSync(workspaceRoot: string): void {
  rmSync(recordPath(workspaceRoot, process.pid), { force: true });
}

/** The workspace's daemons still running, other than this process. Dead records are removed. */
export async function liveDaemons(workspaceRoot: string): Promise<DaemonRecord[]> {
  const dir = path.join(workspaceRoot, DAEMONS_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const live: DaemonRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let record: DaemonRecord;
    try {
      record = JSON.parse(await fs.readFile(file, "utf-8")) as DaemonRecord;
    } catch {
      continue;
    }
    if (record.pid === process.pid) continue;
    if (await isAlive(record)) live.push(record);
    else await fs.rm(file, { force: true }).catch(() => {});
  }
  return live;
}
