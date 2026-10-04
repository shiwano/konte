import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dlopen } from "bun:ffi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { launchBrowser } from "../launch-browser.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("bun:ffi", () => ({ dlopen: vi.fn(), FFIType: {}, ptr: vi.fn() }));

const url = "http://127.0.0.1:4649/?tab=config";
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

function mockToken(restricted: boolean): void {
  vi.mocked(dlopen).mockReturnValue({
    symbols: {
      GetCurrentProcess: () => -1n,
      OpenProcessToken: () => true,
      IsTokenRestricted: () => restricted,
      CloseHandle: () => true,
    },
    close: () => {},
  } as unknown as ReturnType<typeof dlopen>);
}

beforeEach(() => {
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.mocked(readFileSync).mockReturnValue("Linux version 6.6.0-generic");
  mockToken(false);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(dlopen).mockReset();
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

it("prints the URL instead of starting a browser under a restricted Windows token", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  mockToken(true);
  try {
    launchBrowser(url);
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }

  expect(spawn).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Open ${url} to continue`));
});

it("opens the browser when the Windows token cannot be queried", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.mocked(dlopen).mockImplementation(() => {
    throw new Error("dlopen failed");
  });
  try {
    expect(() => launchBrowser(url)).not.toThrow();
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }

  expect(spawn).toHaveBeenCalledWith("cmd", ["/c", "start", "", url], {
    stdio: "ignore",
    detached: true,
  });
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
