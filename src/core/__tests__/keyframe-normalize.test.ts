import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeKeyframesIfSparse, pixelFormatDegradeReason } from "../keyframe-normalize.js";

const execFileAsync = promisify(execFile);

function hasFfmpeg(): boolean {
  try {
    execFileSync("which", ["ffmpeg"]);
    execFileSync("which", ["ffprobe"]);
    return true;
  } catch {
    return false;
  }
}

async function maxKeyframeGap(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "csv=p=0",
    file,
  ]);
  const ts = stdout
    .split("\n")
    .map((l) => Number.parseFloat(l.trim()))
    .filter((t) => Number.isFinite(t));
  let max = 0;
  for (let i = 1; i < ts.length; i++) max = Math.max(max, (ts[i] ?? 0) - (ts[i - 1] ?? 0));
  return max;
}

async function keyframeCount(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "csv=p=0",
    file,
  ]);
  return stdout
    .split("\n")
    .map((l) => Number.parseFloat(l.trim()))
    .filter((t) => Number.isFinite(t)).length;
}

// gopFrames at 30fps: 90 => keyframe every 3s (sparse), 30 => every 1s (dense).
// A gop larger than the clip's frame count (e.g. 1000 for a 7s/30fps clip) yields a
// single keyframe at t=0.
async function makeClip(file: string, gopFrames: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=7:size=320x240:rate=30",
    "-c:v",
    "libx264",
    "-g",
    String(gopFrames),
    "-keyint_min",
    String(gopFrames),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
}

// Same dense clip, but muxed with an audio track that outruns the picture — as an audio-carrying
// generation model emits. The container then reports the audio's length, and measuring the tail
// gap against it turns a dense video into a "sparse" one.
async function makeClipWithLongAudio(file: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=7:size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
}

describe("pixelFormatDegradeReason", () => {
  it("flags alpha formats an 8-bit pass would flatten, incl. ya8/abgr", () => {
    for (const pixFmt of ["yuva420p", "ya8", "ya16le", "rgba", "argb", "abgr", "bgra", "gbrap"]) {
      expect(pixelFormatDegradeReason({ pixFmt, bitsPerRawSample: null })).toBe(
        "has alpha channel",
      );
    }
  });

  it("flags high bit depth via pix_fmt suffix, incl. 16le that the old check missed", () => {
    for (const pixFmt of ["yuv420p10le", "yuv420p16le", "yuv444p14le", "p010le", "p016le"]) {
      expect(pixelFormatDegradeReason({ pixFmt, bitsPerRawSample: null })).toBe(
        "high bit depth (HDR)",
      );
    }
  });

  it("flags high bit depth via bits_per_raw_sample even when the pix_fmt name has no suffix", () => {
    expect(pixelFormatDegradeReason({ pixFmt: "gbrp", bitsPerRawSample: 16 })).toBe(
      "high bit depth (HDR)",
    );
  });

  it("treats an unprobeable (empty) pixel format as a skip, not a green light", () => {
    expect(pixelFormatDegradeReason({ pixFmt: "", bitsPerRawSample: null })).toBe(
      "pixel format could not be probed",
    );
  });

  it("allows a plain 8-bit non-alpha source through", () => {
    expect(pixelFormatDegradeReason({ pixFmt: "yuv420p", bitsPerRawSample: 8 })).toBeNull();
    expect(pixelFormatDegradeReason({ pixFmt: "yuvj420p", bitsPerRawSample: null })).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg())("normalizeKeyframesIfSparse", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-kf-test-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-encodes a video with sparse keyframes and makes them dense", async () => {
    const file = path.join(dir, "sparse.mp4");
    await makeClip(file, 90);
    expect(await maxKeyframeGap(file)).toBeGreaterThan(2);

    const result = await normalizeKeyframesIfSparse(file);

    expect(result.normalized).toBe(true);
    expect(result.maxIntervalSeconds).toBeGreaterThan(2);
    expect(await maxKeyframeGap(file)).toBeLessThanOrEqual(2);
  }, 15000);

  it("re-encodes a clip whose only keyframe is at t=0", async () => {
    const file = path.join(dir, "single.mp4");
    await makeClip(file, 1000);
    expect(await keyframeCount(file)).toBe(1);

    const result = await normalizeKeyframesIfSparse(file);

    expect(result.normalized).toBe(true);
    expect(result.maxIntervalSeconds).toBeGreaterThan(2);
    expect(await keyframeCount(file)).toBeGreaterThan(1);
    expect(await maxKeyframeGap(file)).toBeLessThanOrEqual(2);
  }, 15000);

  it("leaves an already-dense video untouched", async () => {
    const file = path.join(dir, "dense.mp4");
    await makeClip(file, 30);
    const before = await fs.readFile(file);

    const result = await normalizeKeyframesIfSparse(file);

    expect(result.normalized).toBe(false);
    expect(result.maxIntervalSeconds).toBeLessThanOrEqual(2);
    expect(await fs.readFile(file)).toEqual(before);
  }, 15000);

  it("leaves a dense video alone when its audio track outruns the picture", async () => {
    const file = path.join(dir, "long-audio.mp4");
    await makeClipWithLongAudio(file);
    const before = await fs.readFile(file);

    const result = await normalizeKeyframesIfSparse(file);

    expect(result.normalized).toBe(false);
    expect(result.maxIntervalSeconds).toBeLessThanOrEqual(2);
    expect(await fs.readFile(file)).toEqual(before);
  }, 20000);

  it("skips non-video files", async () => {
    const file = path.join(dir, "note.txt");
    await fs.writeFile(file, "not a video");

    const result = await normalizeKeyframesIfSparse(file);

    expect(result).toEqual({ normalized: false, skipReason: "not a video" });
  });
});
