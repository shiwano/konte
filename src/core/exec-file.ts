import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceRootOrNull } from "./workspace-context.js";

interface ExecFileOptions {
  cwd?: string;
}

interface ExecFileError extends Error {
  code?: number | string;
  signal?: string | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
}

/**
 * Runs `file` to completion and returns what it wrote, rejecting on a non-zero exit with the
 * `code` / `signal` / `stdout` / `stderr` shape of Node's `execFile` error.
 *
 * The child writes to files, never a pipe: libuv's stdio pipes are named pipes whose default DACL
 * a write-restricted token (the Codex Windows sandbox) cannot open, so a piped spawn fails with
 * `EPERM`. Capture files live under the workspace, the one root such a sandbox leaves writable.
 */
export async function execFileAsync(
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }>;
export async function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: "buffer" },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding?: "buffer" } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const root = captureRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "exec-"));
  try {
    const outPath = path.join(dir, "stdout");
    const errPath = path.join(dir, "stderr");
    const outFd = fs.openSync(outPath, "w");
    const errFd = fs.openSync(errPath, "w");
    let exitCode: number | null;
    let signal: string | null;
    try {
      [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
        const child = spawn(file, args, { cwd: options.cwd, stdio: ["ignore", outFd, errFd] });
        child.once("error", (err) => reject(Object.assign(err, { stdout: "", stderr: "" })));
        child.once("close", (code, sig) => resolve([code, sig]));
      });
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }

    const read = (p: string) =>
      options.encoding === "buffer" ? fs.readFileSync(p) : fs.readFileSync(p, "utf-8");
    const stdout = read(outPath);
    const stderr = read(errPath);
    if (exitCode === 0) return { stdout, stderr };

    const cmd = [file, ...args].join(" ");
    const error = new Error(`Command failed: ${cmd}\n${String(stderr)}`) as ExecFileError;
    error.code = exitCode ?? undefined;
    error.signal = signal;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureRoot(): string {
  const workspace = workspaceRootOrNull();
  return workspace ? path.join(workspace, ".konte", "tmp") : os.tmpdir();
}
