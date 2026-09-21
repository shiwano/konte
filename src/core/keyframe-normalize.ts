import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ffmpegBin, ffprobeBin } from "./ffmpeg-binary.js";
import { inferMediaType } from "./media-type.js";
import { probeVideo } from "./thumbnail.js";
import { execFileAsync } from "./exec-file.js";

// HyperFrames seeks frame-by-frame during capture and render. When a source
// video's keyframes are more than this many seconds apart, those seeks decode a
// long chain of P/B frames, which is slow and can drop frames (freezing / A/V
// desync). Mirrors @hyperframes/engine's analyzeKeyframeIntervals threshold.
const MAX_KEYFRAME_INTERVAL_SECONDS = 2;

interface KeyframeNormalizeResult {
  normalized: boolean;
  /** Why normalization was skipped (only set when normalized is false). */
  skipReason?: string;
  /** Largest gap between keyframes in the source, when it could be measured. */
  maxIntervalSeconds?: number;
}

/** Largest interval between keyframes (incl. the tail to end-of-stream), or null if unprobeable. */
async function maxKeyframeIntervalSeconds(absPath: string): Promise<number | null> {
  let stdout: string;
  try {
    const ffprobe = await ffprobeBin();
    const res = await execFileAsync(ffprobe, [
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
      absPath,
    ]);
    stdout = res.stdout;
  } catch {
    return null;
  }

  const timestamps = stdout
    .split("\n")
    .map((line) => Number.parseFloat(line.trim()))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (timestamps.length === 0) return null;

  // The span from the last keyframe to the end of the stream is itself a seek gap.
  // A short AI clip encoded with x264's default GOP (keyint=250) often has a single
  // keyframe at t=0, so it has no inter-keyframe gap at all yet is the worst case for
  // seeking — measure the tail against the duration so it isn't mistaken for "dense".
  // The keyframes above come from the video stream, so the tail must be measured against
  // that stream's own length: a longer audio track would inflate the gap into a re-encode
  // the picture never needed.
  let duration = 0;
  try {
    duration = (await probeVideo(absPath)).videoDuration;
  } catch {
    // duration unknown: fall back to inter-keyframe gaps only
  }

  let max = duration > 0 ? Math.max(0, duration - (timestamps[timestamps.length - 1] ?? 0)) : 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = (timestamps[i] ?? 0) - (timestamps[i - 1] ?? 0);
    if (gap > max) max = gap;
  }
  return max;
}

interface PixelInfo {
  pixFmt: string;
  /** Encoded bit depth per component, or null when ffprobe doesn't report it. */
  bitsPerRawSample: number | null;
}

/**
 * Why an 8-bit libx264 re-encode would degrade this pixel format, or null when it's a plain
 * 8-bit non-alpha source safe to normalize. `bitsPerRawSample` is the authoritative depth
 * signal (catches rgb48le, gbrp16le, …); the pix_fmt regexes are the fallback when ffprobe
 * omits it, and cover formats ffmpeg names without a bit-depth suffix (ya8 = 8-bit gray+alpha).
 */
export function pixelFormatDegradeReason(info: PixelInfo): string | null {
  if (info.pixFmt === "") return "pixel format could not be probed";
  if (/yuva|ya8|ya16|rgba|argb|abgr|bgra|gbrap|gray[a-z0-9]*a/.test(info.pixFmt)) {
    return "has alpha channel";
  }
  if (
    (info.bitsPerRawSample ?? 8) > 8 ||
    /(?:10|12|14|16)(?:le|be)|p0(?:10|12|16)/.test(info.pixFmt)
  ) {
    return "high bit depth (HDR)";
  }
  return null;
}

async function probePixelInfo(absPath: string): Promise<PixelInfo | null> {
  try {
    const ffprobe = await ffprobeBin();
    const res = await execFileAsync(ffprobe, [
      "-v",
      "quiet",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt,bits_per_raw_sample",
      "-of",
      "json",
      absPath,
    ]);
    const stream = JSON.parse(res.stdout)?.streams?.[0];
    if (!stream) return null;
    const pixFmt = typeof stream.pix_fmt === "string" ? stream.pix_fmt.toLowerCase() : "";
    const bits = Number.parseInt(stream.bits_per_raw_sample, 10);
    return { pixFmt, bitsPerRawSample: Number.isFinite(bits) ? bits : null };
  } catch {
    return null;
  }
}

/**
 * Re-encode a video in place when its keyframes are too sparse for reliable
 * seeking, inserting a keyframe roughly every second. No-op for non-video files,
 * already-dense videos, and unprobeable inputs. Skips (rather than degrades)
 * videos with alpha or >8-bit depth, which an 8-bit libx264 pass would silently
 * flatten — those keep the engine's render-time warning instead. The source is
 * an intermediate that the final export re-encodes again, so a single high-quality
 * (crf 18) generation here is visually lossless.
 */
export async function normalizeKeyframesIfSparse(
  absPath: string,
): Promise<KeyframeNormalizeResult> {
  if (inferMediaType(absPath) !== "video") {
    return { normalized: false, skipReason: "not a video" };
  }

  const maxInterval = await maxKeyframeIntervalSeconds(absPath);
  if (maxInterval === null) {
    return { normalized: false, skipReason: "keyframe interval could not be probed" };
  }
  if (maxInterval <= MAX_KEYFRAME_INTERVAL_SECONDS) {
    return { normalized: false, maxIntervalSeconds: maxInterval };
  }

  // Can't confirm the format is a plain 8-bit non-alpha source — skip rather than risk an
  // 8-bit libx264 pass silently flattening alpha or HDR. Probe failure (null) lands here too.
  const pixelInfo = await probePixelInfo(absPath);
  const degradeReason =
    pixelInfo === null ? "pixel format could not be probed" : pixelFormatDegradeReason(pixelInfo);
  if (degradeReason !== null) {
    return { normalized: false, skipReason: degradeReason, maxIntervalSeconds: maxInterval };
  }

  let fps = 30;
  try {
    fps = (await probeVideo(absPath)).fps || 30;
  } catch {
    // keep default fps
  }
  const gop = Math.max(1, Math.round(fps));

  // Unique per process so concurrent normalizers (MCP watcher and `konte job wait`
  // both waiting the same job) never write the same temp or delete each other's,
  // mirroring writeFileAtomic's temp naming.
  const ext = path.extname(absPath) || ".mp4";
  const tmpPath = path.join(
    path.dirname(absPath),
    `.konte-reencode-${path.basename(absPath, ext)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${ext}`,
  );

  try {
    // -map 0 + default -c copy keeps every audio/subtitle/data track (multi-language audio,
    // captions); only the video stream is re-encoded for denser keyframes. Output keeps the
    // source container (same extension), so copying the other streams back is always valid.
    const ffmpeg = await ffmpegBin();
    await execFileAsync(ffmpeg, [
      "-y",
      "-i",
      absPath,
      "-map",
      "0",
      "-c",
      "copy",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-movflags",
      "+faststart",
      tmpPath,
    ]);
    await fs.rename(tmpPath, absPath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }

  return { normalized: true, maxIntervalSeconds: maxInterval };
}
