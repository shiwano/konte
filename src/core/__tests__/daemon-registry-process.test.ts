import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { DAEMON_NAMESPACE, liveDaemons, processStartToken } from "../daemon-registry.js";
import { makeWorkspace } from "./helpers/workspace.js";

vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  readFileSync: vi.fn(() => {
    throw new Error("No procfs");
  }),
}));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
});

function commandResult(error: Error | null, token: string) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    callback(error, token);
    return {} as ReturnType<typeof execFile>;
  });
}

it("reads Windows process creation time without relying on ps", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  commandResult(null, "638000000000000000\r\n");
  expect(await processStartToken(123)).toBe("638000000000000000");
  expect(execFile).toHaveBeenCalledWith(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Process -Id 123 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
    ],
    { windowsHide: true, timeout: 5_000 },
    expect.any(Function),
  );
});

it("keeps a live registration when process identity temporarily cannot be read", async () => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  commandResult(new Error("ps unavailable"), "");
  const ws = await makeWorkspace();
  try {
    await fs.mkdir(`${ws.root}/.konte/daemons`, { recursive: true });
    const file = `${ws.root}/.konte/daemons/other.json`;
    await fs.writeFile(
      file,
      JSON.stringify({
        instanceId: "other",
        namespace: DAEMON_NAMESPACE,
        pid: process.ppid,
        startToken: "known",
        startedAt: "2026-01-01",
      }),
    );
    expect((await liveDaemons(ws.root)).map((record) => record.pid)).toEqual([process.ppid]);
    expect(await fs.stat(file)).toBeDefined();
  } finally {
    await ws.cleanup();
  }
});

it("rejects a reused Windows pid when its creation time changes", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  commandResult(null, "new-start-time");
  const ws = await makeWorkspace();
  try {
    await fs.mkdir(`${ws.root}/.konte/daemons`, { recursive: true });
    const file = `${ws.root}/.konte/daemons/other.json`;
    await fs.writeFile(
      file,
      JSON.stringify({
        instanceId: "other",
        namespace: DAEMON_NAMESPACE,
        pid: process.ppid,
        startToken: "old-start-time",
        startedAt: "2026-01-01",
      }),
    );
    expect(await liveDaemons(ws.root)).toEqual([]);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await ws.cleanup();
  }
});
