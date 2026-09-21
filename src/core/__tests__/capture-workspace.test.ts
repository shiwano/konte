import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCaptureWorkspace } from "../hyperframes.js";

let videoRoot: string;

beforeEach(async () => {
  videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-capture-ws-"));
});

afterEach(async () => {
  await fs.rm(videoRoot, { recursive: true, force: true });
});

describe("makeCaptureWorkspace", () => {
  it("creates the workspace under the video's capture cache", async () => {
    const workspace = await makeCaptureWorkspace(videoRoot, "capture-");

    expect(path.dirname(workspace)).toBe(path.join(videoRoot, ".konte", "cache", "capture"));
    expect(path.basename(workspace)).toMatch(/^capture-/);
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  });

  // A killed process never reaches its own cleanup; a capture still running is left alone.
  it("sweeps a workspace a killed capture left behind, keeping a recent one", async () => {
    const stale = await makeCaptureWorkspace(videoRoot, "render-");
    const recent = await makeCaptureWorkspace(videoRoot, "still-");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, twoDaysAgo, twoDaysAgo);

    await makeCaptureWorkspace(videoRoot, "capture-");

    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(recent)).isDirectory()).toBe(true);
  });
});
