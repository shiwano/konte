import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ffmpegBin, ffprobeBin } from "../ffmpeg-binary.js";
import {
  compositionStripTimes,
  type MotionWaveform,
  renderMotionStrip,
} from "../motion-inspect.js";

const execFileAsync = promisify(execFile);

// renderMotionStrip's whole job is seeking a real container, and the bug it was written against —
// a sample landing between the last frame and the container's end — only exists against ffmpeg's
// actual seek semantics. So these run the managed binary rather than mock it.

let videoRoot: string;

const NATIVE_FPS = 24;
const CLIP = "clip.mp4";

// 73 frames at 24fps: the last is presented at 3.000s and the container runs 3.041667s. A sample at
// `duration - one frame` lands at 3.0000003 — past every frame there is, where ffmpeg writes nothing
// and then dies opening the encoder on an empty stream.
async function writeClip(): Promise<number> {
  const file = path.join(videoRoot, CLIP);
  await execFileAsync(await ffmpegBin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=64x64:rate=${NATIVE_FPS}`,
    "-t",
    "3.0417",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  const { stdout } = await execFileAsync(await ffprobeBin(), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=duration",
    "-of",
    "default=nw=1:nk=1",
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

function waveform(durationSec: number): MotionWaveform {
  return {
    variantId: "v-strip001",
    address: "video:shot.01.motion",
    file: CLIP,
    status: "ready",
    isVideo: true,
    outputHash: "deadbeef",
    durationSec,
    fps: NATIVE_FPS,
    nativeFps: NATIVE_FPS,
    samples: 0,
    mean: 0,
    peak: { time: 1.5, value: 0.1 },
    magnitude: { time: 1.5, value: 0.1 },
    displacementWindowSec: 1,
    raw: [],
    coherent: [],
    local: [],
    flickerScore: [],
    segments: [],
    warnings: [],
  };
}

async function tileCount(strip: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(await ffprobeBin(), [
    "-v",
    "error",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    strip,
  ]);
  const [width, height] = stdout.trim().split(",").map(Number);
  return { width: width!, height: height! };
}

beforeEach(async () => {
  videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "konte-strip-test-"));
});

afterEach(async () => {
  await fs.rm(videoRoot, { recursive: true, force: true });
});

describe("renderMotionStrip", () => {
  it("tiles every requested frame including the clip's last one", async () => {
    const duration = await writeClip();
    const strip = await renderMotionStrip({
      videoRoot,
      waveform: waveform(duration),
      spec: { full: true, frames: 16 },
    });

    expect(strip.timestamps).toHaveLength(16);
    const { size } = await fs.stat(strip.path);
    expect(size).toBeGreaterThan(0);
    // 16 tiles land as 4x4; a dropped final tile would leave the sheet a row short.
    const { width, height } = await tileCount(strip.path);
    expect(width).toBeGreaterThan(height * 0.9);
    expect(width).toBeLessThan(height * 1.1);
  }, 60_000);

  it("samples up to the last frame without overshooting it", async () => {
    const duration = await writeClip();
    const strip = await renderMotionStrip({
      videoRoot,
      waveform: waveform(duration),
      spec: { full: true, frames: 16 },
    });

    const last = strip.timestamps[strip.timestamps.length - 1]!;
    expect(last).toBeLessThanOrEqual(3.0);
    expect(last).toBeGreaterThan(3.0 - 1 / NATIVE_FPS);
  }, 60_000);

  it("reports the same timestamps on a cache hit as on the render that filled it", async () => {
    const duration = await writeClip();
    const spec = { full: true, frames: 16 };
    const cold = await renderMotionStrip({ videoRoot, waveform: waveform(duration), spec });
    const warm = await renderMotionStrip({ videoRoot, waveform: waveform(duration), spec });

    expect(warm.path).toBe(cold.path);
    expect(warm.timestamps).toEqual(cold.timestamps);
    expect(warm.window).toEqual(cold.window);
  }, 60_000);

  it("re-renders over a truncated strip rather than serving it", async () => {
    const duration = await writeClip();
    const spec = { full: true, frames: 4 };
    const first = await renderMotionStrip({ videoRoot, waveform: waveform(duration), spec });
    await fs.writeFile(first.path, "");

    const second = await renderMotionStrip({ videoRoot, waveform: waveform(duration), spec });
    expect(second.path).toBe(first.path);
    expect((await fs.stat(second.path)).size).toBeGreaterThan(0);
  }, 60_000);

  it("leaves no scratch file beside the strip it wrote", async () => {
    const duration = await writeClip();
    const strip = await renderMotionStrip({
      videoRoot,
      waveform: waveform(duration),
      spec: { full: true, frames: 4 },
    });

    const entries = await fs.readdir(path.dirname(strip.path));
    expect(entries).toEqual([path.basename(strip.path)]);
  }, 60_000);

  it("windows to the clip's end without asking for a frame past it", async () => {
    const duration = await writeClip();
    const strip = await renderMotionStrip({
      videoRoot,
      waveform: waveform(duration),
      spec: { at: 3.0, window: 0.6, frames: 6 },
    });

    expect(strip.timestamps).toHaveLength(6);
    expect(Math.max(...strip.timestamps)).toBeLessThanOrEqual(3.0);
    expect((await fs.stat(strip.path)).size).toBeGreaterThan(0);
  }, 60_000);
});

describe("compositionStripTimes", () => {
  it("spans a full shot from its first frame to its last", () => {
    expect(compositionStripTimes(5, 30, { full: true, frames: 2 }).timestamps).toEqual([
      0, 4.966667,
    ]);
  });

  it("clamps a window running past the shot onto its last frame", () => {
    const { timestamps, end } = compositionStripTimes(5, 30, { at: 4.9, window: 1, frames: 3 });
    expect(end).toBeCloseTo(4.966667);
    expect(timestamps).toEqual([4.4, 4.7, 4.966667]);
  });

  it("drops a sample that lands on the frame before it", () => {
    const { timestamps, frames } = compositionStripTimes(5, 10, { at: 1, window: 0.2, frames: 4 });
    expect(timestamps).toEqual([0.9, 1, 1.1]);
    // What the strip is keyed by, so another count deduping to three frames never shares it.
    expect(frames).toBe(4);
  });

  it("refuses a window with no center", () => {
    expect(() => compositionStripTimes(5, 30, { window: 1 })).toThrow("needs --at");
  });
});
