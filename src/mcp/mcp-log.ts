import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../core/file-lock.js";
import { redactUrls } from "../core/redact-url.js";

export type McpLogLevel = "debug" | "info" | "warning" | "error";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function mcpLogPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".konte", "logs", "mcp.log");
}

/**
 * The workspace's MCP log, shared by every daemon the workspace's sessions start. A line names
 * its daemon by a random instance id: sandboxed clients run daemons in separate pid namespaces,
 * so the pid alone can collide.
 */
export class McpLog {
  readonly instanceId = crypto.randomBytes(3).toString("hex");
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly prefix: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, options: { maxBytes?: number } = {}) {
    this.logPath = mcpLogPath(workspaceRoot);
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.prefix = `${this.instanceId} pid=${process.pid}`;
  }

  write(level: McpLogLevel, data: object): void {
    if (level === "debug") return;
    const entry = redactUrls(
      `[${new Date().toISOString()}] ${this.prefix} ${level} ${JSON.stringify(data)}\n`,
    );
    this.queue = this.queue
      .then(async () => {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
        await this.rotateIfFull().catch(() => {});
        // Opened per line, so a rotation by another daemon never strands this one's writes.
        await fs.appendFile(this.logPath, entry, "utf-8");
      })
      .catch(() => {});
  }

  // Resolves once every line written so far is on disk — for a process about to exit.
  flush(): Promise<void> {
    return this.queue;
  }

  private async rotateIfFull(): Promise<void> {
    if (!(await this.isFull())) return;
    // Re-checked under the lock: a daemon that saw the same full file must not rotate the fresh
    // one another daemon just started, which would overwrite the backup.
    await withFileLock(`${this.logPath}.lock`, async () => {
      if (await this.isFull()) await fs.rename(this.logPath, `${this.logPath}.1`);
    });
  }

  private async isFull(): Promise<boolean> {
    try {
      return (await fs.stat(this.logPath)).size >= this.maxBytes;
    } catch {
      return false;
    }
  }
}

export interface McpLogEntry {
  level: McpLogLevel;
  data: Record<string, unknown>;
}

const LINE = /^\[[^\]]*\] \S+ pid=\d+ (\w+) (.*)$/;

/** Where a read of the log from now on starts. */
export async function mcpLogEnd(workspaceRoot: string): Promise<number> {
  return fs.stat(mcpLogPath(workspaceRoot)).then(
    (s) => s.size,
    () => 0,
  );
}

/**
 * The whole lines written past `offset`, and the offset the next read starts at. A log shorter
 * than `offset` was rotated, and is read from its start.
 */
export async function readMcpLogSince(
  workspaceRoot: string,
  offset: number,
): Promise<{ entries: McpLogEntry[]; offset: number }> {
  let text: Buffer;
  try {
    text = await fs.readFile(mcpLogPath(workspaceRoot));
  } catch {
    return { entries: [], offset: 0 };
  }
  const start = text.length < offset ? 0 : offset;
  const end = text.lastIndexOf(0x0a) + 1;
  if (end <= start) return { entries: [], offset: start };
  const entries: McpLogEntry[] = [];
  for (const line of text.subarray(start, end).toString("utf-8").split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    try {
      entries.push({ level: m[1] as McpLogLevel, data: JSON.parse(m[2]!) });
    } catch {
      // A line cut by a concurrent rotation.
    }
  }
  return { entries, offset: end };
}
