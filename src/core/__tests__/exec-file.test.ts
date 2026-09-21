import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileAsync } from "../exec-file.js";
import { setWorkspaceRoot } from "../workspace-context.js";

describe("execFileAsync", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "konte-exec-"));
    setWorkspaceRoot(workspace);
  });

  afterEach(() => {
    setWorkspaceRoot(null);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("returns stdout and stderr and leaves no capture files behind", async () => {
    const res = await execFileAsync("sh", ["-c", "printf out; printf err >&2"]);
    expect(res).toEqual({ stdout: "out", stderr: "err" });
    expect(fs.readdirSync(path.join(workspace, ".konte", "tmp"))).toEqual([]);
  });

  it("returns buffers with encoding buffer", async () => {
    const res = await execFileAsync("sh", ["-c", "printf '\\001\\002'"], { encoding: "buffer" });
    expect(res.stdout).toEqual(Buffer.from([1, 2]));
  });

  it("runs in cwd", async () => {
    const res = await execFileAsync("pwd", [], { cwd: workspace });
    expect(fs.realpathSync(res.stdout.trim())).toBe(fs.realpathSync(workspace));
  });

  it("rejects a non-zero exit with the code, output and stderr in the message", async () => {
    const err = await execFileAsync("sh", ["-c", "printf partial; printf boom >&2; exit 3"]).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 3, stdout: "partial", stderr: "boom" });
    expect((err as Error).message).toContain("boom");
  });

  it("rejects a spawn failure with empty output", async () => {
    const err = await execFileAsync(path.join(workspace, "missing"), []).catch((e: unknown) => e);
    expect(err).toMatchObject({ stdout: "", stderr: "" });
    expect(fs.readdirSync(path.join(workspace, ".konte", "tmp"))).toEqual([]);
  });
});
