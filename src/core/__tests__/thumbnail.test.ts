import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressToCacheSegments } from "../address.js";
import { KonteError } from "../errors.js";
import {
  compositionSampleTimes,
  panelSampleTime,
  generateUniformTimestamps,
  harvestCompositionVideos,
  lastSeekableTime,
  parseProbeOutput,
  parseShowInfoTimestamps,
  readVariantThumbnails,
  subsampleTimestamps,
  withVideoElementIds,
} from "../thumbnail.js";

describe("parseProbeOutput", () => {
  it("parses video stream metadata", () => {
    const output = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
          r_frame_rate: "30/1",
          duration: "5.0",
        },
      ],
      format: {
        duration: "5.0",
      },
    });

    const result = parseProbeOutput(output);
    expect(result).toEqual({
      duration: 5.0,
      videoDuration: 5.0,
      width: 1920,
      height: 1080,
      fps: 30,
    });
  });

  it("reports the video stream's own duration separately from the container's", () => {
    const output = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 768,
          height: 1344,
          r_frame_rate: "24/1",
          duration: "3.041667",
        },
        { codec_type: "audio", duration: "3.042" },
      ],
      format: { duration: "3.042" },
    });

    const result = parseProbeOutput(output);
    expect(result.duration).toBe(3.042);
    expect(result.videoDuration).toBe(3.041667);
  });

  it("falls back to the container duration when the video stream declares none", () => {
    const output = JSON.stringify({
      streams: [{ codec_type: "video", width: 640, height: 480, r_frame_rate: "25/1" }],
      format: { duration: "4.5" },
    });

    expect(parseProbeOutput(output).videoDuration).toBe(4.5);
  });

  it("reads an unknown duration as 0 rather than NaN", () => {
    const output = JSON.stringify({
      streams: [
        { codec_type: "video", width: 640, height: 480, r_frame_rate: "25/1", duration: "N/A" },
      ],
      format: { duration: "N/A" },
    });

    const result = parseProbeOutput(output);
    expect(result.duration).toBe(0);
    expect(result.videoDuration).toBe(0);
  });

  it("handles fractional fps", () => {
    const output = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 1280,
          height: 720,
          r_frame_rate: "24000/1001",
        },
      ],
      format: { duration: "10.5" },
    });

    const result = parseProbeOutput(output);
    expect(result.fps).toBeCloseTo(23.976, 2);
  });

  it("uses format duration over stream duration", () => {
    const output = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 640,
          height: 480,
          r_frame_rate: "25/1",
          duration: "3.0",
        },
      ],
      format: { duration: "4.5" },
    });

    const result = parseProbeOutput(output);
    expect(result.duration).toBe(4.5);
  });

  it("falls back to stream duration when format duration is missing", () => {
    const output = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 640,
          height: 480,
          r_frame_rate: "25/1",
          duration: "3.0",
        },
      ],
      format: {},
    });

    const result = parseProbeOutput(output);
    expect(result.duration).toBe(3.0);
  });

  it("throws when no video stream is found", () => {
    const output = JSON.stringify({
      streams: [{ codec_type: "audio" }],
      format: { duration: "5.0" },
    });

    expect(() => parseProbeOutput(output)).toThrow(KonteError);
  });

  it("handles missing r_frame_rate gracefully", () => {
    const output = JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
        },
      ],
      format: { duration: "2.0" },
    });

    const result = parseProbeOutput(output);
    expect(result.fps).toBe(30);
  });
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

describe("readVariantThumbnails", () => {
  const address = "video:shot.01.motion";
  const variantId = "v-abc123";
  const outputHash = "deadbeef";
  let videoRoot: string;

  beforeEach(() => {
    videoRoot = mkdtempSync(path.join(tmpdir(), "konte-thumb-"));
  });
  afterEach(() => {
    rmSync(videoRoot, { recursive: true, force: true });
  });

  function writeManifest(hash: string, frames: { file: string; timestamp: number }[]): void {
    const dir = path.join(
      videoRoot,
      ".konte",
      "cache",
      "thumbnails",
      ...addressToCacheSegments(address),
      variantId,
      hash,
    );
    mkdirSync(dir, { recursive: true });
    for (const f of frames) {
      const abs = path.join(videoRoot, f.file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "x");
    }
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(frames));
  }

  it("reads the manifest keyed by outputHash", () => {
    const frames = [{ file: "frame.jpg", timestamp: 0 }];
    writeManifest(outputHash, frames);
    expect(readVariantThumbnails(videoRoot, address, variantId, outputHash, "v.mp4")).toEqual(
      frames,
    );
  });

  it("misses when the outputHash differs (bytes changed)", () => {
    writeManifest(outputHash, [{ file: "frame.jpg", timestamp: 0 }]);
    expect(readVariantThumbnails(videoRoot, address, variantId, "newhash", "v.mp4")).toEqual([]);
  });

  it("bypasses the cache when outputHash is null", () => {
    writeManifest(outputHash, [{ file: "frame.jpg", timestamp: 0 }]);
    expect(readVariantThumbnails(videoRoot, address, variantId, null, "v.mp4")).toEqual([]);
  });

  it("returns the file itself for images, ignoring outputHash", () => {
    expect(readVariantThumbnails(videoRoot, address, variantId, null, "still.png")).toEqual([
      { file: "still.png", timestamp: 0 },
    ]);
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

describe("withVideoElementIds", () => {
  it("mints an id for every <video> the author did not name", () => {
    const html = withVideoElementIds(
      `<div id="stage"><video src="/a.mp4" data-start="0"></video><video src="/b.mp4"></video></div>`,
    );
    expect(html).toContain(`<video id="konte-video-0" src="/a.mp4" data-start="0">`);
    expect(html).toContain(`<video id="konte-video-1" src="/b.mp4">`);
  });

  it("keeps an authored id — <Video id> is the handle hasAudio and <Animate> target it by", () => {
    const html = withVideoElementIds(
      `<video id="main" src="/a.mp4" data-has-audio="true"></video>`,
    );
    expect(html).toContain(`<video id="main"`);
    expect(html).not.toContain("konte-video-");
  });
});

describe("harvestCompositionVideos", () => {
  it("reads each clip's window off the timeline attributes", () => {
    const videos = harvestCompositionVideos(
      `<video id="v0" src="/a.mp4" data-start="1.5" data-duration="2" data-media-start="0.25"></video>`,
    );
    expect(videos).toEqual([
      { id: "v0", src: "/a.mp4", start: 1.5, end: 3.5, mediaStart: 0.25, loop: false },
    ]);
  });

  it("reads the bare `loop` attribute — a looping clip wraps instead of running off its source", () => {
    const [video] = harvestCompositionVideos(
      `<video id="v0" src="/a.mp4" data-start="0" data-duration="9" loop=""></video>`,
    );
    expect(video?.loop).toBe(true);
  });

  it("treats a clip with no data-duration as unbounded", () => {
    const [video] = harvestCompositionVideos(`<video id="v0" src="/a.mp4" data-start="0"></video>`);
    expect(video?.end).toBe(Infinity);
  });

  it("ignores <audio> and <img> — only <video> needs a frame injected", () => {
    const videos = harvestCompositionVideos(
      `<video id="v0" src="/a.mp4" data-start="0" data-duration="2"></video>` +
        `<audio id="a0" src="/a.mp3" data-start="0"></audio>` +
        `<img id="i0" src="/a.png" data-start="0" data-duration="2">`,
    );
    expect(videos.map((v) => v.id)).toEqual(["v0"]);
  });
});
