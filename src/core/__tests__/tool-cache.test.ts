import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "../tool-cache.js";

let dir: string;

function install(...names: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), "");
}

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "konte-tool-cache-")), "ffmpeg-1.0");
});
afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe("tool cache readiness", () => {
  it("rejects a directory that was never marked, however complete it looks", () => {
    // What an older konte that verified nothing leaves behind, and what a prepopulated cache is.
    install("ffmpeg", "ffprobe");
    expect(toolCacheReady(dir, "pin-a", ["ffmpeg", "ffprobe"])).toBe(false);
  });

  it("rejects a directory marked for a different pin", async () => {
    install("ffmpeg", "ffprobe");
    await markToolCacheReady(dir, "pin-a");
    expect(toolCacheReady(dir, "pin-a", ["ffmpeg", "ffprobe"])).toBe(true);
    // A tag-only bump leaves the directory name alone; the pin is what moves.
    expect(toolCacheReady(dir, "pin-b", ["ffmpeg", "ffprobe"])).toBe(false);
  });

  it("rejects a marked directory an expected file has gone missing from", async () => {
    // The mark records what was verified into the directory once, not what survives in it now.
    install("ffmpeg", "ffprobe");
    await markToolCacheReady(dir, "pin-a");
    fs.rmSync(path.join(dir, "ffprobe"));
    expect(toolCacheReady(dir, "pin-a", ["ffmpeg", "ffprobe"])).toBe(false);
  });

  it("looks for a file at its path inside the directory, not just its name", async () => {
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "chrome-headless-shell"), "");
    await markToolCacheReady(dir, "pin-a");
    expect(toolCacheReady(dir, "pin-a", ["nested/chrome-headless-shell"])).toBe(true);
    expect(toolCacheReady(dir, "pin-a", ["chrome-headless-shell"])).toBe(false);
  });

  it("rejects a directory that does not exist", () => {
    expect(toolCacheReady(dir, "pin-a", ["ffmpeg"])).toBe(false);
  });

  it("clears unverified leftovers before a provision runs", () => {
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "half-extracted.zip"), "");
    resetToolCacheDir(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("drops a stale mark along with the install it described", async () => {
    install("ffmpeg");
    await markToolCacheReady(dir, "pin-a");
    resetToolCacheDir(dir);
    expect(toolCacheReady(dir, "pin-a", ["ffmpeg"])).toBe(false);
  });
});

describe("provisioning lock", () => {
  it("serializes provisioners, so a reset never lands on another's half-finished work", async () => {
    const order: string[] = [];
    const provision = (name: string) =>
      withToolCacheLock(dir, async () => {
        order.push(`${name}:enter`);
        resetToolCacheDir(dir);
        await new Promise((resolve) => setTimeout(resolve, 20));
        fs.writeFileSync(path.join(dir, "ffmpeg"), name);
        order.push(`${name}:leave`);
      });

    await Promise.all([provision("a"), provision("b")]);

    // Interleaving would read a:enter, b:enter, … — and b's reset would have deleted a's work.
    expect(order).toEqual(
      order[0] === "a:enter"
        ? ["a:enter", "a:leave", "b:enter", "b:leave"]
        : ["b:enter", "b:leave", "a:enter", "a:leave"],
    );
    expect(fs.readFileSync(path.join(dir, "ffmpeg"), "utf-8")).toBe(order[2]!.split(":")[0]);
  });

  it("keeps its lock file outside the directory a reset empties", async () => {
    await withToolCacheLock(dir, async () => {
      resetToolCacheDir(dir);
      expect(fs.existsSync(`${dir}.lock`)).toBe(true);
    });
  });
});
