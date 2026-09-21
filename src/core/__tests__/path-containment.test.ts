import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWithinRoot,
  isWithinRootReal,
  requireFileWithinRoot,
  resolveWithinRoot,
} from "../path-containment.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

let ws: Workspace;
let videoRoot: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["opening"] });
  videoRoot = ws.videos.opening!.video;
  await fs.writeFile(
    path.join(ws.root, "konte.credentials.json"),
    JSON.stringify({ FAL_KEY: "super-secret" }),
  );
  await fs.mkdir(path.join(videoRoot, "assets", "files"), { recursive: true });
});

afterEach(async () => {
  await ws.cleanup();
});

describe("isWithinRoot", () => {
  it("accepts the root itself and anything under it, rejects a sibling and an escape", () => {
    expect(isWithinRoot("/a/b", "/a/b")).toBe(true);
    expect(isWithinRoot("/a/b/c/d.png", "/a/b")).toBe(true);
    expect(isWithinRoot("/a/b-evil/d.png", "/a/b")).toBe(false);
    expect(isWithinRoot("/a/b/../c/d.png", "/a/b")).toBe(false);
  });
});

describe("resolveWithinRoot", () => {
  it("resolves a normal file-asset path", async () => {
    const file = path.join(videoRoot, "assets", "files", "bgm.mp3");
    await fs.writeFile(file, "audio");
    await expect(resolveWithinRoot(videoRoot, "assets/files/bgm.mp3")).resolves.toBe(file);
  });

  it("rejects a `..` escape reaching the workspace's credentials", async () => {
    await expect(resolveWithinRoot(videoRoot, "../../konte.credentials.json")).resolves.toBeNull();
  });

  it("rejects an absolute path", async () => {
    await expect(
      resolveWithinRoot(videoRoot, path.join(ws.root, "konte.credentials.json")),
    ).resolves.toBeNull();
  });

  it("rejects a symlink that points out of the video", async () => {
    // Lexically inside assets/files/, but it reads the workspace's credentials.
    const link = path.join(videoRoot, "assets", "files", "innocent.png");
    await fs.symlink(path.join(ws.root, "konte.credentials.json"), link);

    expect(isWithinRoot(link, videoRoot)).toBe(true); // the lexical check is fooled
    await expect(resolveWithinRoot(videoRoot, "assets/files/innocent.png")).resolves.toBeNull();
    expect(isWithinRootReal(link, videoRoot)).toBe(false);
  });

  it("passes a missing file through, so the caller reports it as missing rather than forbidden", async () => {
    await expect(resolveWithinRoot(videoRoot, "assets/files/gone.png")).resolves.toBe(
      path.join(videoRoot, "assets", "files", "gone.png"),
    );
  });
});

describe("requireFileWithinRoot", () => {
  it("re-checks at use time, so a symlink swapped in after the asset was synced is caught", async () => {
    const rel = "assets/files/input.png";
    const file = path.join(videoRoot, rel);

    // What syncFileAssets saw: an ordinary file, hashed and recorded as an accepted variant.
    await fs.writeFile(file, "image");
    await expect(requireFileWithinRoot(videoRoot, rel)).resolves.toBe(file);

    // What the backend finds when it goes to upload it, minutes later.
    await fs.rm(file);
    await fs.symlink(path.join(ws.root, "konte.credentials.json"), file);

    await expect(requireFileWithinRoot(videoRoot, rel)).rejects.toMatchObject({
      code: "INVALID_REFERENCE",
    });
  });

  it("rejects an absolute path that leaves the video, and allows one that does not", async () => {
    const inside = path.join(videoRoot, "assets", "files", "ok.png");
    await fs.writeFile(inside, "image");

    await expect(requireFileWithinRoot(videoRoot, inside)).resolves.toBe(inside);
    await expect(
      requireFileWithinRoot(videoRoot, path.join(ws.root, "konte.credentials.json")),
    ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  });
});
