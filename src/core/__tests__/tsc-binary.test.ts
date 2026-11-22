import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadFile } from "../download.js";

vi.mock("../download.js", () => ({ downloadFile: vi.fn() }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
let dir: string;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(downloadFile).mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "konte-tsc-"));
  vi.stubEnv("KONTE_CACHE_DIR", path.join(dir, "cache"));
  vi.stubEnv("KONTE_TSC_PATH", "");
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  Object.defineProperty(process, "arch", archDescriptor);
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["win32", "tsc.exe"],
  ["linux", "tsc"],
  ["darwin", "tsc"],
] as const)("provisions and reuses the %s compiler", async (platform, binary) => {
  const lib = path.join(dir, "package", "lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, binary), "compiler fixture");
  const archive = path.join(dir, "fixture.tgz");
  execFileSync("tar", ["czf", archive, "-C", dir, "package"]);
  vi.mocked(downloadFile).mockImplementation(async (_url, dest) => {
    fs.copyFileSync(archive, dest);
  });
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: "x64" });

  const { ensureTsc, TSC_VERSION } = await import("../tsc-binary.js");
  const cacheDir = path.join(dir, "cache", `tsc-${TSC_VERSION}`);
  const expected = path.join(cacheDir, binary);
  expect(await ensureTsc()).toBe(expected);
  expect(fs.readFileSync(expected, "utf8")).toBe("compiler fixture");
  expect(fs.existsSync(path.join(cacheDir, ".konte-verified"))).toBe(true);
  expect(fs.existsSync(path.join(cacheDir, "package"))).toBe(false);
  expect(fs.existsSync(path.join(cacheDir, "tsc.tgz"))).toBe(false);
  expect(downloadFile).toHaveBeenCalledTimes(1);

  vi.resetModules();
  expect(await (await import("../tsc-binary.js")).ensureTsc()).toBe(expected);
  expect(downloadFile).toHaveBeenCalledTimes(1);

  fs.rmSync(expected);
  vi.resetModules();
  expect(await (await import("../tsc-binary.js")).ensureTsc()).toBe(expected);
  expect(fs.existsSync(expected)).toBe(true);
  expect(downloadFile).toHaveBeenCalledTimes(2);
});
