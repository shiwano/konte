import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { KonteError } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin, SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "./ffmpeg-binary.js";
import { hasBytes, runFfmpeg } from "./ffmpeg-exec.js";
import { probeVideo } from "./video-probe.js";

export interface ExtractKeyframesOptions {
  threshold?: number;
  maxFrames?: number;
  quality?: number;
  minInterval?: number;
}

export interface ThumbnailInfo {
  file: string;
  timestamp: number;
}

// How many frame intervals back from the reported duration the last seekable moment sits. A duration
// is rounded to the millisecond, so `duration - one frame` can land a hair *after* the last frame's
// timestamp — and `-ss` takes the first frame at or past its target, so there is none: ffmpeg writes
// nothing and then fails opening the encoder on an empty stream ("ff_frame_thread_encoder_init
// failed"), blaming the encoder for a seek. A constant-rate clip runs `lastPts + one frame` long, so
// aiming half a frame *before* the last timestamp lands on it whichever way the rounding went.
const LAST_FRAME_MARGIN = 1.5;
// Assumed rate when a source declares none usable — the same value the motion probe caps decoding at.
const FALLBACK_FPS = 30;

// Seconds between frames on the source's own grid. A rate is only nonsense when it is non-positive
// or non-finite — 0.2fps is a legitimate rate, and clamping it to 1 would put every margin and
// step-back short of the frames they exist to reach.
export function frameInterval(nativeFps: number): number {
  return Number.isFinite(nativeFps) && nativeFps > 0 ? 1 / nativeFps : 1 / FALLBACK_FPS;
}

/**
 * The last timestamp a seek can land on and still find a frame, given the source's own frame rate.
 * Pure, so the margin above is unit-tested against real container durations.
 */
export function lastSeekableTime(durationSec: number, nativeFps: number): number {
  return Math.max(0, durationSec - LAST_FRAME_MARGIN * frameInterval(nativeFps));
}

// How many of a shot's final frames the "out" sample steps over. A generative motion model degrades
// across its last frames, and a board read there calls a cut broken when only the sample was. Small
// enough that a genuinely broken tail — which runs far longer than this — still shows.
const TAIL_SKIP_FRAMES = 2;

// The share of a shot the skip may eat, so a constant sized for a normal shot does not swallow a
// short one's whole tail. Never below one frame: a skip of zero is the tail this exists to avoid.
const TAIL_SKIP_MAX_SHARE = 0.1;

/**
 * `count` sample times across a shot, from its first frame to {@link TAIL_SKIP_FRAMES} frames short
 * of its last, evenly spaced and inclusive of both ends — so `count: 2` is exactly the in/out pair a
 * cut is read on. Snapped to the shot's own frame grid, so the time a sample is labelled with is the
 * time the frame is taken at. Pure, so the skip is unit-tested against real shot durations.
 *
 * Only the tail is trimmed: a shot's first frame is the keyframe its motion was conditioned on, so
 * it is the one frame in the clip that carries no generative drift.
 *
 * The last frame starts one interval before the duration, so stepping over `skip` frames lands
 * `skip + 1` intervals back — which also keeps `out` at least {@link LAST_FRAME_MARGIN} inside, so
 * it stays seekable. A shot too short to hold the skip collapses to its first frame: the caller's
 * grid is laid out in whole shots and a short one must still fill it.
 */
/**
 * The frame that actually shows a keyframe: the first one on the fps grid at or after its `start`.
 * A capture quantizes its timestamp onto that grid by rounding DOWN (`quantizeTimeToFrame`), so an
 * off-grid time inside the window falls back onto the OUTGOING panel's frame.
 *
 * Null when the window holds no grid frame (a panel pinned less than a frame from the next one):
 * that keyframe never reaches the screen, so there is no cell to tile for it.
 */
export function panelSampleTime(start: number, windowSec: number, fps: number): number | null {
  if (!(fps > 0)) return null;
  if (start <= 0) return 0;
  // Tolerance so a start already ON the grid is not pushed to the next frame by float error.
  const frame = Math.ceil(start * fps - 1e-9);
  const time = frame / fps;
  return time < start + windowSec ? time : null;
}

export function compositionSampleTimes(durationSec: number, fps: number, count: number): number[] {
  const interval = frameInterval(fps);
  const totalFrames = Math.max(1, Math.floor(durationSec / interval));
  const skipFrames = Math.max(
    1,
    Math.min(TAIL_SKIP_FRAMES, Math.floor(totalFrames * TAIL_SKIP_MAX_SHARE)),
  );
  const out = Math.max(0, durationSec - (skipFrames + 1) * interval);
  if (count <= 1) return [0];
  const snap = (t: number): number => Math.round(t / interval) * interval;
  return Array.from({ length: count }, (_, i) => snap((out * i) / (count - 1)));
}

/**
 * One sample time per `<Subtitle>` line on screen within a shot's composition document (overlay
 * laid in, so its lines are already on shot-local time): the grid frame nearest the middle of the
 * part of the line the shot holds. A line that holds no grid frame of the shot has none.
 */
export function subtitleSampleTimes(html: string, durationSec: number, fps: number): number[] {
  const interval = frameInterval(fps);
  const times: number[] = [];
  for (const [tag] of html.matchAll(/<[a-z][a-z0-9-]*\b[^>]*>/gi)) {
    if (!/\sclass="[^"]*\bkonte-subtitle\b/.test(tag)) continue;
    const start = Number(/\sdata-start="([^"]*)"/.exec(tag)?.[1]);
    const duration = Number(/\sdata-duration="([^"]*)"/.exec(tag)?.[1]);
    if (!Number.isFinite(start) || !Number.isFinite(duration)) continue;
    const from = Math.max(0, start);
    const to = Math.min(durationSec, start + duration);
    // The grid frames the line is on screen for: the first at or after `from`, the last before `to`.
    const first = Math.ceil(from / interval - 1e-9);
    const last = Math.ceil(to / interval - 1e-9) - 1;
    if (first > last) continue;
    const frame = Math.min(last, Math.max(first, Math.round((from + to) / 2 / interval)));
    const time = frame * interval;
    if (!times.some((t) => Math.abs(t - time) < 1e-9)) times.push(time);
  }
  return times.sort((a, b) => a - b);
}

export function parseShowInfoTimestamps(stderr: string, minInterval: number): number[] {
  const timestamps: number[] = [];
  const regex = /pts_time:([\d.]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stderr)) !== null) {
    const ts = Number.parseFloat(match[1]!);
    if (timestamps.length === 0 || ts - timestamps[timestamps.length - 1]! >= minInterval) {
      timestamps.push(ts);
    }
  }

  return timestamps;
}

export function generateUniformTimestamps(
  duration: number,
  count: number,
  existingTimestamps: number[],
): number[] {
  if (duration <= 0 || count <= 0) return [];

  const candidates: number[] = [];
  const step = duration / (count + 1);

  for (let i = 1; i <= count; i++) {
    const ts = step * i;
    const alreadyExists = existingTimestamps.some((e) => Math.abs(e - ts) < 0.3);
    if (!alreadyExists) {
      candidates.push(ts);
    }
  }

  return candidates;
}

export function subsampleTimestamps(timestamps: number[], maxFrames: number): number[] {
  if (timestamps.length <= maxFrames) return timestamps;
  if (maxFrames <= 1) return timestamps.length > 0 ? [timestamps[0]!] : [];

  const step = (timestamps.length - 1) / (maxFrames - 1);
  const result: number[] = [];
  for (let i = 0; i < maxFrames; i++) {
    result.push(timestamps[Math.round(step * i)]!);
  }
  return result;
}

export async function extractKeyframes(
  videoPath: string,
  outputDir: string,
  options?: ExtractKeyframesOptions,
): Promise<ThumbnailInfo[]> {
  const threshold = options?.threshold ?? 0.3;
  const maxFrames = options?.maxFrames ?? 8;
  const quality = options?.quality ?? 2;
  const minInterval = options?.minInterval ?? 0.5;

  await fs.mkdir(outputDir, { recursive: true });

  const probe = await probeVideo(videoPath);

  let timestamps = await detectSceneChanges(videoPath, threshold, minInterval);

  // The picture's own length, not the container's: an audio track that outruns the video would put
  // these top-up samples after the last frame, where extraction finds nothing.
  if (timestamps.length < 3 && probe.videoDuration > 0) {
    const needed = maxFrames - timestamps.length;
    if (needed > 0) {
      const uniform = generateUniformTimestamps(probe.videoDuration, needed, timestamps);
      timestamps = [...timestamps, ...uniform].sort((a, b) => a - b);
    }
  }

  timestamps = subsampleTimestamps(timestamps, maxFrames);

  // One ffmpeg seek per frame, each writing its own file, so they run several at a time.
  return mapConcurrent(timestamps, FFMPEG_CONCURRENCY, async (ts, i) => {
    const filename = `keyframe-${String(i + 1).padStart(3, "0")}.jpg`;
    const outputPath = path.join(outputDir, filename);
    await extractFrameAt(videoPath, ts, outputPath, quality);
    return { file: outputPath, timestamp: ts };
  });
}

export async function detectSceneChanges(
  videoPath: string,
  threshold: number,
  minInterval: number,
): Promise<number[]> {
  const args = [
    "-i",
    videoPath,
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-vsync",
    "vfr",
    "-f",
    "null",
    "-",
  ];

  const ffmpeg = await ffmpegBin();
  try {
    const result = await execFileAsync(ffmpeg, args);
    return parseShowInfoTimestamps(result.stderr, minInterval);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stderr" in err) {
      return parseShowInfoTimestamps((err as { stderr: string }).stderr, minInterval);
    }
    return [];
  }
}

export async function extractFrameAt(
  videoPath: string,
  timestamp: number,
  outputPath: string,
  quality = 2,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Write beside the destination and move the finished frame into place. ffmpeg leaves whatever was
  // already at its output path untouched when it fails, so writing direct would let a previous
  // frame's bytes pass for this one's — and every caller here treats the path's existence as a
  // cache, so a truncated file would be served as a finished frame forever after.
  const tmpPath = path.join(
    path.dirname(outputPath),
    `.konte-frame-${process.pid}-${randomBytes(4).toString("hex")}${path.extname(outputPath)}`,
  );

  const args = [
    "-y",
    ...SINGLE_FRAME_INPUT_ARGS,
    "-ss",
    String(timestamp),
    "-i",
    videoPath,
    ...SINGLE_FRAME_OUTPUT_ARGS,
    "-frames:v",
    "1",
    "-q:v",
    String(quality),
    tmpPath,
  ];

  try {
    await runFfmpeg(args, `Frame extraction failed at ${timestamp}s`);
    if (!hasBytes(tmpPath)) {
      throw new KonteError(
        "FFMPEG_ERROR",
        `Frame extraction produced no frame at ${timestamp}s (seek past end of clip?)`,
      );
    }
    await fs.rename(tmpPath, outputPath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

/** The frame `at` seconds into `videoPath`, held to its last frame. */
export async function extractFrameWithin(
  videoPath: string,
  at: number,
  outputPath: string,
): Promise<void> {
  const probe = await probeVideo(videoPath);
  const last = probe.videoDuration > 0 ? lastSeekableTime(probe.videoDuration, probe.fps) : at;
  await extractFrameAt(videoPath, Math.min(at, last), outputPath);
}
