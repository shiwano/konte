import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ffmpegBin } from "../ffmpeg-binary.js";
import {
  compositionSampleTimes,
  extractFrameAt,
  extractKeyframes,
  generateUniformTimestamps,
  lastSeekableTime,
  panelSampleTime,
  parseShowInfoTimestamps,
  subsampleTimestamps,
  subtitleSampleTimes,
} from "../frame-extract.js";

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

describe("lastSeekableTime", () => {
  // 73 frames at 24fps: the last one is presented at 3.0s, and ffprobe reports the stream as
  // 3.041667s (rounded to 3.042 on the container). `duration - one frame` gives 3.000333 — past the
  // last frame, where ffmpeg writes nothing and then dies opening the encoder on a 0x0 stream.
  it("stays at or before the last frame's timestamp on a duration rounded up", () => {
    expect(lastSeekableTime(3.042, 24)).toBeLessThanOrEqual(3.0);
  });

  it("still reaches the last frame rather than skipping it", () => {
    expect(lastSeekableTime(3.042, 24)).toBeGreaterThan(3.0 - 1 / 24);
  });

  it("never goes negative on a clip shorter than one frame", () => {
    expect(lastSeekableTime(0.02, 24)).toBe(0);
  });

  // A sub-1fps clip is a legitimate source, not a nonsense rate: 2 frames at 0.2fps sit at 0s and
  // 5s in a 10s clip, so clamping the rate to 1 would put the last sample at 8.5s — past every
  // frame there is, and beyond what the bounded step-back can walk back to.
  it("reaches the last frame of a sub-1fps clip", () => {
    expect(lastSeekableTime(10, 0.2)).toBeLessThanOrEqual(5);
    expect(lastSeekableTime(10, 0.2)).toBeGreaterThan(0);
  });

  it("falls back to the default rate when the source declares a nonsense one", () => {
    for (const bad of [0, -24, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lastSeekableTime(10, bad)).toBe(9.95);
    }
  });
});

describe("panelSampleTime", () => {
  it("opens the shot on its first frame", () => {
    expect(panelSampleTime(0, 2, 24)).toBe(0);
  });

  // A start already on the grid is the frame that shows it — the float error in `start * fps` must
  // not push it to the next one.
  it("keeps a start that already sits on the grid", () => {
    expect(panelSampleTime(1, 2, 24)).toBeCloseTo(1, 9);
    expect(panelSampleTime(5 / 24, 1, 24)).toBeCloseTo(5 / 24, 9);
    expect(panelSampleTime(1 / 3, 1, 30)).toBeCloseTo(1 / 3, 9);
  });

  // A capture rounds its timestamp DOWN onto the grid, so an off-grid start must snap UP or the
  // frame that comes back is the OUTGOING panel's.
  it("snaps an off-grid start up to the frame that shows it", () => {
    expect(panelSampleTime(0.5, 1, 24)).toBeCloseTo(12 / 24, 9);
    expect(panelSampleTime(0.51, 1, 24)).toBeCloseTo(13 / 24, 9);
  });

  // A shot whose panels are pinned a hair apart: the middle one holds for less than a frame, so no
  // frame ever shows it. Tiling its neighbour's frame under its name would be a lie.
  it("returns null when the window holds no frame of the grid", () => {
    expect(panelSampleTime(0.02, 0.02, 24)).toBeNull();
    expect(panelSampleTime(2, 0, 24)).toBeNull();
    expect(panelSampleTime(2, -1, 24)).toBeNull();
    expect(panelSampleTime(2, 1, 0)).toBeNull();
  });

  it("lands on the grid and inside the window at every rate and length", () => {
    for (const fps of [12, 24, 30, 60]) {
      for (const windowSec of [0.001, 0.01, 1 / fps, 0.5, 5]) {
        const t = panelSampleTime(2, windowSec, fps);
        if (t === null) {
          // Only ever because the window is too short to contain one.
          expect(windowSec).toBeLessThan(1 / fps);
          continue;
        }
        expect(t).toBeGreaterThanOrEqual(2);
        expect(t).toBeLessThan(2 + windowSec);
        expect(t * fps).toBeCloseTo(Math.round(t * fps), 9);
      }
    }
  });
});

describe("subtitleSampleTimes", () => {
  const line = (start: number, duration: number, text = "x") =>
    `<div class="konte-clip konte-subtitle flex" data-start="${start}" data-duration="${duration}" data-track-index="10">${text}</div>`;

  it("samples each line at the grid frame nearest its middle", () => {
    const html = `<div id="stage">${line(1, 2)}${line(3.5, 1)}</div>`;
    expect(subtitleSampleTimes(html, 6, 24)).toEqual([2, 4]);
  });

  it("samples only the part of a line the shot holds", () => {
    expect(subtitleSampleTimes(line(-2, 4), 4, 25)).toEqual([1]);
    expect(subtitleSampleTimes(line(3, 4), 4, 24)).toEqual([3.5]);
  });

  it("samples a line on screen for a single frame on that frame", () => {
    expect(subtitleSampleTimes(line(1, 0.04), 4, 25)).toEqual([1]);
    expect(subtitleSampleTimes(line(3.9, 1), 3.94, 25)).toEqual([expect.closeTo(3.92, 9)]);
  });

  it("skips a line outside the shot or holding no grid frame of it", () => {
    expect(subtitleSampleTimes(line(5, 0.001), 4, 24)).toEqual([]);
    expect(subtitleSampleTimes(line(1.01, 0.01), 4, 24)).toEqual([]);
  });

  it("ignores timed elements that are not subtitle lines", () => {
    const html = `<img class="konte-clip" data-start="1" data-duration="2" />`;
    expect(subtitleSampleTimes(html, 4, 24)).toEqual([]);
  });
});

describe("compositionSampleTimes", () => {
  it("puts the in frame on the shot's first frame", () => {
    expect(compositionSampleTimes(3, 24, 2)[0]).toBe(0);
  });

  it("holds the out frame three frames short of the shot's end", () => {
    const [, out] = compositionSampleTimes(3, 24, 2);
    expect(out).toBeCloseTo(3 - 3 / 24, 6);
  });

  it("clears the shot's last frame at every rate and length, short shots included", () => {
    for (const fps of [12, 24, 30, 60]) {
      for (const duration of [0.25, 0.5, 1, 3, 20]) {
        const [, out] = compositionSampleTimes(duration, fps, 2);
        const lastFrameStart = duration - 1 / fps;
        expect(out).toBeLessThan(lastFrameStart);
      }
    }
  });

  it("measures the margin in frames, not seconds or a share of the shot", () => {
    for (const fps of [24, 30, 60]) {
      for (const duration of [2, 5, 20]) {
        const [, out] = compositionSampleTimes(duration, fps, 2);
        expect(duration - out!).toBeCloseTo(3 / fps, 6);
      }
    }
  });

  it("caps the skip at a tenth of a short shot rather than eating its whole tail", () => {
    // 12 frames at 24fps: skipping the full two would cut a quarter of it, so one frame goes.
    const [, out] = compositionSampleTimes(0.5, 24, 2);
    expect(out).toBeCloseTo(0.5 - 2 / 24, 6);
  });

  it("never goes negative on a shot shorter than one frame", () => {
    expect(compositionSampleTimes(0.02, 24, 2).every((t) => t >= 0)).toBe(true);
  });

  it("samples the first frame alone when one is asked for", () => {
    expect(compositionSampleTimes(3, 24, 1)).toEqual([0]);
  });

  it("spaces extra samples evenly and inclusive of both ends", () => {
    const times = compositionSampleTimes(4, 25, 3);
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(0);
    expect(times[2]).toBeCloseTo(4 - 3 / 25, 6);
    // Within half a frame of the ideal midpoint — the snap onto the frame grid is the difference.
    expect(Math.abs(times[1]! - times[2]! / 2)).toBeLessThanOrEqual(1 / 25 / 2 + 1e-9);
  });

  // The capture floors a request onto the frame grid, so an unsnapped midpoint would be labelled
  // with a moment up to a frame away from the one the cell actually shows.
  it("lands every sample on the shot's own frame grid", () => {
    for (const fps of [24, 25, 30]) {
      for (const count of [2, 3, 5, 7]) {
        for (const t of compositionSampleTimes(4, fps, count)) {
          expect(t * fps).toBeCloseTo(Math.round(t * fps), 6);
        }
      }
    }
  });

  it("is strictly increasing, so no two cells of a shot show one frame", () => {
    for (const count of [2, 3, 5, 12]) {
      const times = compositionSampleTimes(6, 30, count);
      for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it("falls back to the default rate when the canvas declares a nonsense one", () => {
    const [, out] = compositionSampleTimes(10, 0, 2);
    expect(out).toBeCloseTo(10 - 3 / 30, 6);
  });
});

describe("parseShowInfoTimestamps", () => {
  it("extracts pts_time values from showinfo output", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x1234] n:   0 pts:  15000 pts_time:0.5 ...",
      "[Parsed_showinfo_1 @ 0x1234] n:   1 pts:  60000 pts_time:2.0 ...",
      "[Parsed_showinfo_1 @ 0x1234] n:   2 pts: 120000 pts_time:4.0 ...",
    ].join("\n");

    const timestamps = parseShowInfoTimestamps(stderr, 0.5);
    expect(timestamps).toEqual([0.5, 2.0, 4.0]);
  });

  it("filters timestamps within minInterval", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x1234] n:0 pts_time:1.0 ...",
      "[Parsed_showinfo_1 @ 0x1234] n:1 pts_time:1.3 ...",
      "[Parsed_showinfo_1 @ 0x1234] n:2 pts_time:1.4 ...",
      "[Parsed_showinfo_1 @ 0x1234] n:3 pts_time:2.5 ...",
    ].join("\n");

    const timestamps = parseShowInfoTimestamps(stderr, 0.5);
    expect(timestamps).toEqual([1.0, 2.5]);
  });

  it("returns empty array for no matches", () => {
    const timestamps = parseShowInfoTimestamps("no relevant output", 0.5);
    expect(timestamps).toEqual([]);
  });

  it("respects minInterval of 0", () => {
    const stderr = [
      "[showinfo] pts_time:0.1 ...",
      "[showinfo] pts_time:0.2 ...",
      "[showinfo] pts_time:0.3 ...",
    ].join("\n");

    const timestamps = parseShowInfoTimestamps(stderr, 0);
    expect(timestamps).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("generateUniformTimestamps", () => {
  it("generates evenly spaced timestamps", () => {
    const result = generateUniformTimestamps(10, 4, []);
    expect(result).toEqual([2, 4, 6, 8]);
  });

  it("excludes timestamps near existing ones", () => {
    const existing = [2.0, 6.0];
    const result = generateUniformTimestamps(10, 4, existing);
    expect(result).toEqual([4, 8]);
  });

  it("returns empty for zero duration", () => {
    const result = generateUniformTimestamps(0, 5, []);
    expect(result).toEqual([]);
  });

  it("returns empty for zero count", () => {
    const result = generateUniformTimestamps(10, 0, []);
    expect(result).toEqual([]);
  });
});

describe("subsampleTimestamps", () => {
  it("returns all timestamps when under maxFrames", () => {
    const timestamps = [1, 2, 3, 4, 5];
    expect(subsampleTimestamps(timestamps, 8)).toEqual(timestamps);
  });

  it("subsamples to maxFrames evenly", () => {
    const timestamps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = subsampleTimestamps(timestamps, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0);
    expect(result[result.length - 1]).toBe(9);
  });

  it("handles single frame", () => {
    const timestamps = [0, 1, 2, 3, 4];
    const result = subsampleTimestamps(timestamps, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(0);
  });

  it("handles exact match", () => {
    const timestamps = [1, 2, 3];
    expect(subsampleTimestamps(timestamps, 3)).toEqual([1, 2, 3]);
  });
});
