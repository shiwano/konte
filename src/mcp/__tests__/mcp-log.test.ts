import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { McpLog, mcpLogPath } from "../mcp-log.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "konte-mcp-log-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("tags each daemon's lines with its own instance id in one shared file", async () => {
  const a = new McpLog(root);
  const b = new McpLog(root);
  a.write("info", { event: "daemon_started" });
  b.write("info", { event: "daemon_started" });
  await Promise.all([a.flush(), b.flush()]);

  const lines = (await fs.readFile(mcpLogPath(root), "utf-8")).trim().split("\n");
  expect(lines).toHaveLength(2);
  const ids = lines.map((line) => line.split(" ")[1]);
  expect(new Set(ids).size).toBe(2);
  expect(lines[0]).toMatch(/ pid=\d+ info \{"event":"daemon_started"\}$/);
});

it("leaves debug lines out of the file", async () => {
  const log = new McpLog(root);
  log.write("debug", { event: "job_progress" });
  log.write("info", { event: "job_completed" });
  await log.flush();

  const text = await fs.readFile(mcpLogPath(root), "utf-8");
  expect(text).toContain("job_completed");
  expect(text).not.toContain("job_progress");
});

it("strips a URL's query before it reaches disk", async () => {
  const log = new McpLog(root);
  log.write("error", { error: "fetch https://cdn.example/out.png?token=secret failed" });
  await log.flush();

  const text = await fs.readFile(mcpLogPath(root), "utf-8");
  expect(text).toContain("https://cdn.example/out.png failed");
  expect(text).not.toContain("secret");
});

it("moves a full log aside before appending", async () => {
  const log = new McpLog(root, { maxBytes: 10 });
  log.write("info", { event: "first" });
  log.write("info", { event: "second" });
  await log.flush();

  expect(await fs.readFile(`${mcpLogPath(root)}.1`, "utf-8")).toContain("first");
  const current = await fs.readFile(mcpLogPath(root), "utf-8");
  expect(current).toContain("second");
  expect(current).not.toContain("first");
});

it("rotates once when several daemons find the log full together", async () => {
  await fs.mkdir(path.dirname(mcpLogPath(root)), { recursive: true });
  await fs.writeFile(mcpLogPath(root), "ORIGINAL".repeat(1000));
  const logs = Array.from({ length: 8 }, () => new McpLog(root, { maxBytes: 7000 }));
  for (const log of logs) log.write("info", { event: "next" });
  await Promise.all(logs.map((log) => log.flush()));

  expect(await fs.readFile(`${mcpLogPath(root)}.1`, "utf-8")).toContain("ORIGINAL");
  const current = await fs.readFile(mcpLogPath(root), "utf-8");
  expect(current.trim().split("\n")).toHaveLength(8);
});
