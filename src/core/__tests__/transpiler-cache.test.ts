import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSPILER_CACHE_DISABLED, resolveTranspilerCachePath } from "../transpiler-cache.js";

let ws: string;
let base: string;

beforeEach(async () => {
  // realpath: macOS hands out /var/… symlinks for tmpdir, which would break the path comparisons.
  ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-tcache-")));
  await fs.writeFile(path.join(ws, "konte.config.json"), "{}");
  base = path.join(ws, ".konte", "transpiler-cache");
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

async function pile(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "cached");
  return file;
}

describe("resolveTranspilerCachePath", () => {
  it("gives the workspace a cache directory of its own, stamped with the root it belongs to", async () => {
    const dir = resolveTranspilerCachePath(["--cwd", ws]);

    expect(dir.startsWith(base + path.sep)).toBe(true);
    expect(await fs.readFile(path.join(dir, ".root"), "utf-8")).toBe(ws);
  });

  it("finds the workspace from a nested directory", async () => {
    const nested = path.join(ws, "videos", "opening");
    await fs.mkdir(nested, { recursive: true });

    expect(resolveTranspilerCachePath(["doctor", `--cwd=${nested}`])).toBe(
      resolveTranspilerCachePath(["--cwd", ws]),
    );
  });

  it("keeps the piles while the workspace stays put", async () => {
    const kept = await pile(resolveTranspilerCachePath(["--cwd", ws]), "a.pile");

    resolveTranspilerCachePath(["--cwd", ws]);
    await fs.access(kept);
  });

  it("never reads a moved workspace's piles", async () => {
    const before = resolveTranspilerCachePath(["--cwd", ws]);
    await pile(before, "a.pile");

    const moved = path.join(path.dirname(ws), path.basename(ws) + "-moved");
    await fs.rename(ws, moved);
    try {
      const after = resolveTranspilerCachePath(["--cwd", moved]);
      expect(after).not.toBe(before.replace(ws, moved));
      await expect(fs.access(path.join(after, "a.pile"))).rejects.toThrow();
    } finally {
      await fs.rename(moved, ws);
    }
  });

  it("leaves the generation a move left behind, rather than deleting a path it does not own", async () => {
    const before = resolveTranspilerCachePath(["--cwd", ws]);
    await pile(before, "a.pile");

    const moved = path.join(path.dirname(ws), path.basename(ws) + "-moved");
    await fs.rename(ws, moved);
    try {
      resolveTranspilerCachePath(["--cwd", moved]);
      expect(await fs.readdir(path.join(moved, ".konte", "transpiler-cache"))).toHaveLength(2);
    } finally {
      await fs.rename(moved, ws);
    }
  });

  // `.konte` and the cache base are paths konte does not control. Following one would put a
  // workspace's piles outside it, which is what this whole mechanism exists to stop.
  it.skipIf(process.platform === "win32")(
    "refuses a cache base that resolves outside the workspace",
    async () => {
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-out-")));
      try {
        await fs.mkdir(path.dirname(base), { recursive: true });
        await fs.symlink(outside, base, "dir");

        expect(resolveTranspilerCachePath(["--cwd", ws])).toBe(TRANSPILER_CACHE_DISABLED);
        expect(await fs.readdir(outside)).toEqual([]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "deletes nothing through a cache base aimed back into the workspace",
    async () => {
      await fs.mkdir(path.join(ws, "videos", "main"), { recursive: true });
      await fs.writeFile(path.join(ws, "videos", "main", "direction.ts"), "work");
      await fs.mkdir(path.dirname(base), { recursive: true });
      await fs.symlink(path.join(ws, "videos"), base, "dir");

      resolveTranspilerCachePath(["--cwd", ws]);
      await fs.access(path.join(ws, "videos", "main", "direction.ts"));
      await fs.access(path.join(ws, "konte.config.json"));
    },
  );

  it("ignores a --cwd whose value is another option, as commander would", async () => {
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-other-")));
    await fs.writeFile(path.join(other, "konte.config.json"), "{}");
    try {
      expect(resolveTranspilerCachePath(["--cwd", `--cwd=${other}`, "status"])).not.toBe(
        resolveTranspilerCachePath(["--cwd", other]),
      );
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("reads the last --cwd, like commander, and stops at a -- terminator", async () => {
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-other-")));
    try {
      expect(resolveTranspilerCachePath(["--cwd", other, "--cwd", ws])).toBe(
        resolveTranspilerCachePath(["--cwd", ws]),
      );
      expect(resolveTranspilerCachePath(["--cwd", ws, "--", "--cwd", other])).toBe(
        resolveTranspilerCachePath(["--cwd", ws]),
      );
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("disables the cache outside a workspace, rather than falling back to the machine-wide one", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "konte-nows-")));
    try {
      expect(resolveTranspilerCachePath(["workspace", "new", "--cwd", outside])).toBe(
        TRANSPILER_CACHE_DISABLED,
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  // chmod does not make a directory unwritable on Windows.
  it.skipIf(process.platform === "win32")(
    "disables the cache rather than writing into a directory it cannot write",
    async () => {
      const dir = resolveTranspilerCachePath(["--cwd", ws]);
      await fs.chmod(dir, 0o500);
      try {
        expect(resolveTranspilerCachePath(["--cwd", ws])).toBe(TRANSPILER_CACHE_DISABLED);
      } finally {
        await fs.chmod(dir, 0o700);
      }
    },
  );
});
