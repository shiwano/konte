import { existsSync, readFileSync, utimesSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileAsync } from "../exec-file.js";
import { ffmpegBin } from "../ffmpeg-binary.js";
import {
  CLIP_STUDY,
  UNSNAPPED_NOTE,
  WINDOW_SEC,
  clipWindows,
  prepareClipSource,
  sourceClipFrameAt,
  windowFrameTimes,
} from "../source-study-clip.js";
import { readStudyIndex, refreshStudyIndex, studySource } from "../source-study.js";

describe("clipWindows", () => {
  it("is one window for a clip under a window and a half", () => {
    expect(clipWindows(250, null)).toEqual([{ startSec: 0, endSec: 250 }]);
  });

  it("cuts every three minutes off the length alone", () => {
    expect(clipWindows(600, null)).toEqual([
      { startSec: 0, endSec: 180 },
      { startSec: 180, endSec: 360 },
      { startSec: 360, endSec: 600 },
    ]);
  });

  it("moves each boundary to the nearest cut within a minute", () => {
    expect(clipWindows(600, [100, 170, 195, 300, 420])).toEqual([
      { startSec: 0, endSec: 170 },
      { startSec: 170, endSec: 300 },
      { startSec: 300, endSec: 420 },
      { startSec: 420, endSec: 600 },
    ]);
  });

  it("keeps a cut right on the three minutes", () => {
    expect(clipWindows(600, [180, 190, 360]).map((w) => w.endSec)).toEqual([180, 360, 600]);
  });

  it("keeps a boundary where no cut is near it", () => {
    expect(clipWindows(600, [20, 500]).map((w) => w.endSec)).toEqual([WINDOW_SEC, 360, 600]);
  });
});

describe("windowFrameTimes", () => {
  it("shows one frame per shot, and one every 5 s of a shot past 10 s", () => {
    expect(
      windowFrameTimes(
        [
          { startSec: 0, endSec: 4 },
          { startSec: 4, endSec: 16 },
        ],
        0,
        16,
      ),
    ).toEqual([2, 6.5, 11.5]);
  });

  it("clamps a shot to the window it straddles", () => {
    expect(windowFrameTimes([{ startSec: 0, endSec: 8 }], 6, 20)).toEqual([7]);
  });
});

describe("a source clip", () => {
  let root: string;
  const src = () => ({ dir: path.join(root, "videos", "main", "source"), file: "film.mp4" });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "konte-source-clip-"));
    await fs.mkdir(src().dir, { recursive: true });
    // Two colors, cut at 3 s.
    await execFileAsync(await ffmpegBin(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=3:r=24",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=3:r=24",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(src().dir, "film.mp4"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("counts its windows off the length alone before its cuts are read", async () => {
    const { index } = await refreshStudyIndex(src());
    expect(index.kind).toBe("clip");
    expect(index.chunks.map((c) => c.id)).toEqual(["w1"]);
    expect(index.notes).toEqual([UNSNAPPED_NOTE]);
  }, 60_000);

  it("is studied into windows of every shot once its cuts are read", async () => {
    await prepareClipSource(src(), () => {});
    expect(readStudyIndex(src())).toBeNull();
    const { index } = await studySource(src(), { progress: () => {} });
    expect(index.notes).toEqual([]);
    expect(index.summary).toBe("0:06 · 1 window · 2 shots");
    expect(index.chunks[0]).toMatchObject({ id: "w1", from: 0, size: "0:06 · 2 shots" });
    const md = readFileSync(path.join(src().dir, "chunks", "w01.md"), "utf-8");
    expect(md).toContain("Heard: nothing");
    expect(md).toContain("- w01-1.jpg  00:01.5-00:04.5  2 frame(s)");
    expect(existsSync(path.join(src().dir, "chunks", "w01-1.jpg"))).toBe(true);
    expect(CLIP_STUDY.chunkFiles(index, "w1", "w01")).toEqual(["w01.md"]);
  }, 120_000);

  it("writes the frame at a moment, and a replaced original's afresh", async () => {
    const frame = await sourceClipFrameAt(src(), 1);
    expect(path.basename(frame.path)).toMatch(/^frame-\w+-1000\.png$/);

    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(src().dir, src().file), later, later);
    const again = await sourceClipFrameAt(src(), 1);
    expect(again.path).not.toBe(frame.path);
  }, 60_000);
});
