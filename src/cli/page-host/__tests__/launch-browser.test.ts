import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { launchBrowser } from "../launch-browser.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

const url = "http://127.0.0.1:4649/?tab=config";
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

beforeEach(() => {
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.mocked(readFileSync).mockReturnValue("Linux version 6.6.0-generic");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.mocked(readFileSync).mockReset();
});

it.runIf(process.platform === "linux")("opens the Windows default browser under WSL", () => {
  vi.mocked(readFileSync).mockReturnValue("Linux version 6.6.87.2-microsoft-standard-WSL2");

  launchBrowser("http://127.0.0.1:4649/?q='a'&b=1");

  expect(spawn).toHaveBeenCalledWith(
    "powershell.exe",
    ["-NoProfile", "-Command", "Start-Process 'http://127.0.0.1:4649/?q=''a''&b=1'"],
    { stdio: "ignore", detached: true },
  );
});

it("opens the URL through the OS without a shell or browser flags", () => {
  launchBrowser(url);

  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  expect(spawn).toHaveBeenCalledWith(command, args, { stdio: "ignore", detached: true });
  expect(child.unref).toHaveBeenCalled();
  child.emit("exit", 0);
  expect(console.log).not.toHaveBeenCalled();
});

it("keeps launch errors from escaping and prints a manual URL", () => {
  launchBrowser(url);

  expect(() => child.emit("error", new Error("spawn EPERM"))).not.toThrow();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Open ${url} to continue`));
  child.emit("exit", 1);
  expect(console.log).toHaveBeenCalledTimes(1);
});

it.each([1, null])("reports an opener that exits unsuccessfully (%s)", (code) => {
  launchBrowser(url);

  child.emit("exit", code);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(url));
});

it("survives a synchronous spawn failure", () => {
  vi.mocked(spawn).mockImplementation(() => {
    throw new Error("spawn blocked");
  });

  expect(() => launchBrowser(url)).not.toThrow();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(url));
});
