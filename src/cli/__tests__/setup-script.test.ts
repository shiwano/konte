import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = path.resolve(import.meta.dirname, "../../../setup.sh");
let root: string;
let workspace: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "konte-setup-test-"));
  workspace = path.join(root, "film with spaces 日本語");
  const mockBin = path.join(root, "mock-bin");
  await fs.mkdir(workspace);
  await fs.mkdir(mockBin);
  const binary =
    '#!/bin/sh\nprintf "%s\\n" "$@" > invoked\n[ "${FAIL_SETUP:-0}" = 0 ] || exit 9\nprintf "{}\\n" > konte.config.json\n';
  await fs.writeFile(path.join(root, "release"), binary);
  const hash = createHash("sha256").update(binary).digest("hex");
  await fs.writeFile(
    path.join(root, "sums"),
    `${hash}  konte-linux-x64\n${hash}  konte-darwin-arm64\n`,
  );
  await fs.writeFile(
    path.join(mockBin, "uname"),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo "${TEST_OS:-Linux}"; else echo "${TEST_ARCH:-x86_64}"; fi\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(mockBin, "curl"),
    '#!/bin/sh\nprintf "%s\\n" "$2" >> "$MOCK_ROOT/requests"\ncase "$2" in */SHA256SUMS) cp "$MOCK_ROOT/sums" "$4" ;; *) cp "$MOCK_ROOT/release" "$4" ;; esac\n',
    { mode: 0o755 },
  );
  env = {
    ...process.env,
    PATH: `${mockBin}:${process.env.PATH}`,
    HOME: root,
    MOCK_ROOT: root,
    KONTE_VERSION: "",
    TEST_OS: "Linux",
    TEST_ARCH: "x86_64",
    FAIL_SETUP: "0",
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function setup(extra: NodeJS.ProcessEnv = {}) {
  return exec("sh", [script], { cwd: workspace, env: { ...env, ...extra } });
}

describe("setup.sh", () => {
  it("installs locally and invokes workspace new without changing shell profiles", async () => {
    await fs.writeFile(path.join(root, ".zshrc"), "untouched\n");
    const { stdout } = await setup();
    expect(stdout.trim().split("\n").at(-1)).toBe(`KONTE_BIN=${workspace}/.konte/bin/konte`);
    expect(await fs.readFile(path.join(workspace, "invoked"), "utf8")).toBe("workspace\nnew\n");
    expect(await fs.readFile(path.join(root, ".zshrc"), "utf8")).toBe("untouched\n");
    await expect(fs.access(path.join(root, ".konte"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "requests"), "utf8")).toContain(
      "/releases/latest/download/konte-linux-x64",
    );
  });

  it("uses the committed version and setup for an existing workspace", async () => {
    await fs.writeFile(path.join(workspace, "konte.config.json"), "{}");
    await fs.writeFile(path.join(workspace, "konte.version"), "0.2.3\r\n");
    await setup();
    expect(await fs.readFile(path.join(root, "requests"), "utf8")).toContain(
      "/releases/download/v0.2.3/",
    );
    expect(await fs.readFile(path.join(workspace, "invoked"), "utf8")).toBe("workspace\nsetup\n");
  });

  it("honors an explicit upgrade and maps Apple Silicon to the matching asset", async () => {
    await fs.writeFile(path.join(workspace, "konte.version"), "0.2.3\n");
    await setup({ KONTE_VERSION: "latest", TEST_OS: "Darwin", TEST_ARCH: "arm64" });
    expect(await fs.readFile(path.join(root, "requests"), "utf8")).toContain(
      "/releases/latest/download/konte-darwin-arm64",
    );
  });

  it("keeps the installed binary when checksum verification fails", async () => {
    const dest = path.join(workspace, ".konte/bin/konte");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "existing");
    await fs.writeFile(path.join(root, "sums"), `${"0".repeat(64)}  konte-linux-x64\n`);
    await expect(setup()).rejects.toMatchObject({
      stderr: expect.stringContaining("checksum mismatch"),
    });
    expect(await fs.readFile(dest, "utf8")).toBe("existing");
    expect(await fs.readdir(path.dirname(dest))).toEqual(["konte"]);
    await expect(fs.access(path.join(workspace, "invoked"))).rejects.toThrow();
  });

  it("propagates workspace setup failure without emitting success", async () => {
    await expect(setup({ FAIL_SETUP: "1" })).rejects.toMatchObject({
      code: 9,
      stdout: expect.not.stringContaining("KONTE_BIN="),
    });
  });
});
