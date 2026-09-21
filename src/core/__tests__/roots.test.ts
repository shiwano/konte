import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listVideos, readCurrentVideo, resolveRoots, writeCurrentVideo } from "../roots.js";

let ws: string;

async function makeVideo(name: string): Promise<string> {
  const dir = path.join(ws, "videos", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "konte.state.json"), "{}");
  return dir;
}

beforeEach(async () => {
  // realpath: macOS hands out /var/… symlinks for tmpdir, which would break the path comparisons.
  ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-roots-")));
  await fs.writeFile(path.join(ws, "konte.config.json"), "{}");
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("resolveRoots", () => {
  it("finds the workspace from a nested directory", async () => {
    await makeVideo("opening");
    const nested = path.join(ws, "videos", "opening", "assets");
    await fs.mkdir(nested, { recursive: true });

    const roots = await resolveRoots(nested);
    expect(roots.workspace).toBe(ws);
    expect(roots.video).toEqual({
      kind: "selected",
      root: path.join(ws, "videos", "opening"),
      name: "opening",
    });
  });

  it("lets the enclosing video win over the current one", async () => {
    await makeVideo("opening");
    const ending = await makeVideo("ending");
    await writeCurrentVideo(ws, "opening");

    const roots = await resolveRoots(ending);
    expect(roots.video).toMatchObject({ kind: "selected", name: "ending" });
  });

  it("falls back to the current video outside any video directory", async () => {
    await makeVideo("opening");
    await writeCurrentVideo(ws, "opening");

    const roots = await resolveRoots(ws);
    expect(roots.video).toMatchObject({ kind: "selected", name: "opening" });
  });

  it("reports not-selected rather than auto-picking the only video", async () => {
    await makeVideo("opening");
    const roots = await resolveRoots(ws);
    expect(roots.video).toEqual({ kind: "not-selected" });
  });

  it("reports not-found when the current video is gone", async () => {
    await makeVideo("opening");
    await writeCurrentVideo(ws, "deleted");

    const roots = await resolveRoots(ws);
    expect(roots.video).toEqual({ kind: "not-found", name: "deleted" });
  });

  it("ignores a stray state file that is not a videos/<name> directory", async () => {
    await makeVideo("opening");
    await writeCurrentVideo(ws, "opening");

    // A pre-workspace project copied in, and the flat layout's own leftover at the root. Neither
    // is listable or selectable, so adopting either would give a video no command can name.
    const stray = path.join(ws, "archive", "old");
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(path.join(stray, "konte.state.json"), "{}");
    await fs.writeFile(path.join(ws, "konte.state.json"), "{}");

    await expect(resolveRoots(stray)).resolves.toMatchObject({
      video: { kind: "selected", name: "opening" },
    });
    await expect(resolveRoots(ws)).resolves.toMatchObject({
      video: { kind: "selected", name: "opening" },
    });
  });

  it("refuses a current-video that would escape the workspace", async () => {
    await makeVideo("opening");
    // The file is plain text a human can edit, and its content becomes a path segment.
    await fs.mkdir(path.join(ws, ".konte"), { recursive: true });
    await fs.writeFile(path.join(ws, ".konte", "current-video"), "../../etc\n");

    expect(await readCurrentVideo(ws)).toBeNull();
    await expect(resolveRoots(ws)).resolves.toMatchObject({ video: { kind: "not-selected" } });
  });

  it("refuses a symlinked video directory, which would move the containment boundary", async () => {
    await makeVideo("opening");
    await writeCurrentVideo(ws, "opening");

    // Aimed at the workspace root, this link would make `assets/files/../../konte.credentials.json` resolve
    // "inside" the video — every file-containment check compares resolved paths.
    const link = path.join(ws, "videos", "trojan");
    await fs.symlink(ws, link);

    expect(await listVideos(ws)).toEqual(["opening"]);
    // cwd inside the link resolves to the current video instead of adopting the link.
    await expect(resolveRoots(link)).resolves.toMatchObject({
      video: { kind: "selected", name: "opening" },
    });
  });

  it("throws outside a workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "konte-notws-"));
    try {
      await expect(resolveRoots(outside)).rejects.toMatchObject({
        code: "NOT_A_KONTE_WORKSPACE",
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("listVideos / current video", () => {
  it("lists only directories holding a konte.state.json, sorted", async () => {
    await makeVideo("ending");
    await makeVideo("opening");
    await fs.mkdir(path.join(ws, "videos", "scratch"), { recursive: true });

    expect(await listVideos(ws)).toEqual(["ending", "opening"]);
  });

  it("has no current video until one is written", async () => {
    expect(await readCurrentVideo(ws)).toBeNull();
    await writeCurrentVideo(ws, "opening");
    expect(await readCurrentVideo(ws)).toBe("opening");
  });
});
