import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ffmpegBin } from "../ffmpeg-binary.js";
import { extractFrameAt, extractKeyframes } from "../thumbnail.js";

const execFileAsync = promisify(execFile);

// Both of these turn on ffmpeg's real seek semantics — a request past the last frame exits 0 having
// written nothing — so they run the managed binary rather than mock it.

let dir: string;

// An audio track that outruns the picture, as an audio-carrying generation model emits: the
// container reports 12s while the video stream ends at 3s.
async function writeClip(name: string, audioSeconds: number): Promise<string> {
  const file = path.join(dir, name);
  await execFileAsync(await ffmpegBin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x64:rate=24:duration=3",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${audioSeconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  return file;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-frame-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("extractFrameAt", () => {
  // A seek into the stretch the audio track occupies alone: ffmpeg 8.1 exits non-zero here, so what
  // this pins is that the failure reaches the caller as an ffmpeg failure (it used to be reported as
  // FFPROBE_ERROR) and that no frame file is left behind for a caller to register.
  it("reports a seek past the last frame as an ffmpeg failure, leaving no frame behind", async () => {
    const clip = await writeClip("clip.mp4", 12);
    const out = path.join(dir, "frame.jpg");

    await expect(extractFrameAt(clip, 8, out)).rejects.toMatchObject({ code: "FFMPEG_ERROR" });
    await expect(fs.stat(out)).rejects.toThrow();
  }, 60_000);

  it("writes a frame inside the picture", async () => {
    const clip = await writeClip("clip.mp4", 12);
    const out = path.join(dir, "frame.jpg");

    await extractFrameAt(clip, 1.5, out);
    expect((await fs.stat(out)).size).toBeGreaterThan(0);
  }, 60_000);

  // Every caller treats the destination's existence as a cache, so the extraction stages through a
  // scratch name — which must not survive either outcome, or the cache dir fills with them.
  it("leaves no scratch file behind, on success or failure", async () => {
    const clip = await writeClip("clip.mp4", 12);
    const out = path.join(dir, "out", "frame.jpg");

    await extractFrameAt(clip, 1.5, out);
    await expect(extractFrameAt(clip, 8, out)).rejects.toThrow();

    expect(await fs.readdir(path.dirname(out))).toEqual(["frame.jpg"]);
  }, 60_000);

  it("keeps the frame already at the destination when a later extraction fails", async () => {
    const clip = await writeClip("clip.mp4", 12);
    const out = path.join(dir, "frame.jpg");

    await extractFrameAt(clip, 1.5, out);
    const before = await fs.readFile(out);
    await expect(extractFrameAt(clip, 8, out)).rejects.toThrow();

    expect(await fs.readFile(out)).toEqual(before);
  }, 60_000);
});

describe("extractKeyframes", () => {
  it("samples inside the picture when the audio track is longer", async () => {
    const clip = await writeClip("clip.mp4", 12);

    const frames = await extractKeyframes(clip, path.join(dir, "out"), { maxFrames: 8 });

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      // Past 3s there is no picture left to sample, whatever the container's duration says.
      expect(frame.timestamp).toBeLessThan(3);
      expect((await fs.stat(frame.file)).size).toBeGreaterThan(0);
    }
  }, 60_000);
});
