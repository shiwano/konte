import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  addressFromCacheSegments,
  addressToCacheSegments,
  formatCompositionAddress,
} from "./address.js";
import { writeFileAtomic } from "./atomic-write.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { isWithinRoot } from "./path-containment.js";
import { KonteError, errorMessage } from "./errors.js";
import {
  ffmpegBin,
  ffprobeBin,
  SINGLE_FRAME_INPUT_ARGS,
  SINGLE_FRAME_OUTPUT_ARGS,
} from "./ffmpeg-binary.js";
import { inferMediaType } from "./media-type.js";
import { shotById } from "./shot-index.js";
import { execFileAsync } from "./exec-file.js";

export interface VideoProbeResult {
  duration: number;
  /**
   * The video stream's own duration — for arithmetic that must stay inside the picture. `duration`
   * is the container's, which a longer audio track pushes past the last frame.
   */
  videoDuration: number;
  width: number;
  height: number;
  fps: number;
}

interface ExtractKeyframesOptions {
  threshold?: number;
  maxFrames?: number;
  quality?: number;
  minInterval?: number;
}

export interface ThumbnailInfo {
  file: string;
  timestamp: number;
}

export async function probeVideo(videoPath: string): Promise<VideoProbeResult> {
  const args = ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath];

  const ffprobe = await ffprobeBin();
  let stdout: string;
  try {
    const result = await execFileAsync(ffprobe, args);
    stdout = result.stdout;
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFPROBE_ERROR", `ffprobe failed: ${message}`);
  }

  return parseProbeOutput(stdout);
}

// ffprobe reports an unknown duration as "N/A" (and omits the field entirely on some containers),
// both of which parse to NaN and would poison every arithmetic downstream.
function finiteSeconds(raw: string | undefined): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether a path holds a finished file — ffmpeg can exit 0 having written nothing. */
async function hasBytes(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
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

export function parseProbeOutput(stdout: string): VideoProbeResult {
  const data = JSON.parse(stdout);

  const videoStream = data.streams?.find((s: { codec_type?: string }) => s.codec_type === "video");

  if (!videoStream) {
    throw new KonteError("FFPROBE_ERROR", "No video stream found");
  }

  const duration = finiteSeconds(data.format?.duration ?? videoStream.duration);
  // A stream that declares no duration (or "N/A") leaves only the container's, which a longer audio
  // track overstates — callers that must stay inside the picture treat the excess as best-effort.
  const videoDuration = finiteSeconds(videoStream.duration) || duration;
  const width = videoStream.width ?? 0;
  const height = videoStream.height ?? 0;

  let fps = 30;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    if (num && den) fps = num / den;
  }

  return { duration, videoDuration, width, height, fps };
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

async function detectSceneChanges(
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

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
    if (!(await hasBytes(tmpPath))) {
      throw new KonteError(
        "FFMPEG_ERROR",
        `Frame extraction produced no frame at ${timestamp}s (seek past end of clip?)`,
      );
    }
    await fs.rename(tmpPath, outputPath);
  } catch (err) {
    if (err instanceof KonteError) throw err;
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `Frame extraction failed at ${timestamp}s: ${message}`);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

// Variant thumbnails live entirely on disk, mirroring the composition-frame cache: the
// keyframes plus a manifest.json recording the scene-detected set (whose timestamps vary
// per run, so filenames alone can't restore them). The files are the source of truth, the
// manifest is the cache index — state holds nothing, so there is no path that can go stale.
// The cache is keyed `<stage>/<suffix>/<variantId>/<outputHash>` (the address split at its `:`
// delimiter into path-safe segments) so a variant whose bytes change (a swapped `file` asset)
// misses on the new hash; clean/prune still delete by variantId.
export function variantThumbnailDir(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string,
): string {
  return path.join(
    videoRoot,
    ".konte",
    "cache",
    "thumbnails",
    ...addressToCacheSegments(address),
    variantId,
    outputHash,
  );
}

// Walk the nested thumbnail cache (`<stage>/<suffix>`) and yield every address-level dir with its
// reconstructed address. Composition caches carry no state and live only on disk, so clean/prune
// enumerate them from here. Returns [] when no thumbnails dir exists yet.
export async function listThumbnailAddressDirs(
  thumbnailsRoot: string,
): Promise<{ address: string; dir: string }[]> {
  const out: { address: string; dir: string }[] = [];
  let stages: string[];
  try {
    stages = await fs.readdir(thumbnailsRoot);
  } catch {
    return out;
  }
  for (const stage of stages) {
    const stageDir = path.join(thumbnailsRoot, stage);
    let suffixes: string[];
    try {
      suffixes = await fs.readdir(stageDir);
    } catch {
      continue;
    }
    for (const suffix of suffixes) {
      out.push({
        address: addressFromCacheSegments([stage, suffix]),
        dir: path.join(stageDir, suffix),
      });
    }
  }
  return out;
}

function variantManifestPath(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string,
): string {
  return path.join(variantThumbnailDir(videoRoot, address, variantId, outputHash), "manifest.json");
}

/**
 * Cached thumbnails for a variant, or [] when none are cached. For images the variant file
 * is itself the thumbnail (nothing to extract). For videos, reads the on-disk manifest and
 * validates every referenced frame still exists. Synchronous so preview/inspect can call it
 * inline without an extraction round-trip.
 */
// Positive manifest cache. A manifest is content-addressed (its path carries the variant's
// outputHash), so a re-read — and the per-frame exists checks — is only needed when the file
// on disk changed; a matching mtime serves the parsed result for one stat call. The preview
// server calls this once per variant per state request, which was thousands of blocking
// syscalls on the request path. clean/prune remove the whole variant dir, so the stat fails
// (ENOENT) and the entry drops.
const manifestCache = new Map<string, { mtimeMs: number; thumbs: ThumbnailInfo[] }>();

export function readVariantThumbnails(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string | null | undefined,
  variantFile: string | null | undefined,
): ThumbnailInfo[] {
  if (!variantFile) return [];
  if (inferMediaType(variantFile) === "image") {
    return [{ file: variantFile, timestamp: 0 }];
  }
  // No content hash (e.g. a `file` asset whose file is missing) → nothing to key the cache on.
  if (!outputHash) return [];

  const manifestPath = variantManifestPath(videoRoot, address, variantId, outputHash);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    manifestCache.delete(manifestPath);
    return [];
  }
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.thumbs;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ThumbnailInfo[];
    if (manifest.length > 0 && manifest.every((m) => existsSync(path.resolve(videoRoot, m.file)))) {
      manifestCache.set(manifestPath, { mtimeMs, thumbs: manifest });
      return manifest;
    }
  } catch {
    // corrupt manifest: treat as a cache miss
  }
  return [];
}

/**
 * Ensure a variant's thumbnails exist on disk and return them, extracting keyframes (and
 * writing the manifest) on a cache miss. Images need no extraction — the file is the
 * thumbnail. Pass `force` to re-extract even when a valid cache is present.
 */
export async function ensureVariantThumbnails(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string | null | undefined,
  variantFile: string,
  options?: ExtractKeyframesOptions & { force?: boolean },
): Promise<ThumbnailInfo[]> {
  const mediaType = inferMediaType(variantFile);

  if (mediaType === "image") {
    return [{ file: variantFile, timestamp: 0 }];
  }
  if (mediaType !== "video") return [];
  // No content hash to key on — the only trigger is a `file` asset whose source is missing,
  // so there is nothing to extract from. Mirror readVariantThumbnails and report no cache.
  if (!outputHash) return [];

  if (!options?.force) {
    const cached = readVariantThumbnails(videoRoot, address, variantId, outputHash, variantFile);
    if (cached.length > 0) return cached;
  }

  const dir = variantThumbnailDir(videoRoot, address, variantId, outputHash);
  const rawResults = await extractKeyframes(path.resolve(videoRoot, variantFile), dir, options);
  const thumbnails: ThumbnailInfo[] = rawResults.map((r) => ({
    file: path.relative(videoRoot, r.file),
    timestamp: r.timestamp,
  }));

  // Sweep sibling hash dirs (superseded bytes) for this variant, mirroring the composition
  // cache's pruneSuperseded — clean is variant-scoped and won't reclaim them otherwise.
  pruneSupersededVariantHashes(videoRoot, address, variantId, outputHash);
  try {
    await fs.writeFile(
      variantManifestPath(videoRoot, address, variantId, outputHash),
      JSON.stringify(thumbnails),
      "utf-8",
    );
  } catch {
    // manifest is best-effort; its absence just means a cache miss next time
  }

  return thumbnails;
}

function pruneSupersededVariantHashes(
  videoRoot: string,
  address: string,
  variantId: string,
  currentHash: string,
): void {
  const variantDir = path.join(
    videoRoot,
    ".konte",
    "cache",
    "thumbnails",
    ...addressToCacheSegments(address),
    variantId,
  );
  try {
    for (const entry of readdirSync(variantDir)) {
      if (entry !== currentHash) {
        rmSync(path.join(variantDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // best-effort GC of stale variant thumbnail caches
  }
}

// Every writer of a shot's thumbnail dir renders at these settings. They are part of the cache key,
// so a caller that picked its own would land in a second hash dir — and `pruneSuperseded` would have
// the two deleting each other's frames on every miss.
export const COMPOSITION_FRAME_FORMAT = "jpeg" as const;
export const COMPOSITION_FRAME_QUALITY = 80;

export interface CaptureCompositionOptions {
  timestamps?: number[];
  maxFrames?: number;
  sceneThreshold?: number;
  format?: "jpeg" | "png";
  quality?: number;
  force?: boolean;
  // Remove sibling cache dirs (older composition hashes) for this shot when rendering.
  pruneSuperseded?: boolean;
}

// --at frames are named deterministically from their timecode so the file's
// existence alone is a valid cache hit (same composition hash + same timecode).
function atFrameName(ts: number, ext: string): string {
  return `at-${String(Math.round(ts * 1000)).padStart(8, "0")}ms.${ext}`;
}

// The frame injector reaches each <video> by `document.getElementById(id)`, and `<Video>` only
// carries an id when the author gave it one (for `hasAudio`). Mint the missing ones before both
// the harvest below and the write, so the two sides agree on every id.
export function withVideoElementIds(html: string): string {
  let n = 0;
  return html.replace(/<video\b[^>]*>/g, (tag) =>
    /\sid="/.test(tag) ? tag : tag.replace("<video", `<video id="konte-video-${n++}"`),
  );
}

interface CompositionVideo {
  id: string;
  src: string;
  start: number;
  end: number;
  mediaStart: number;
  loop: boolean;
}

// Every <video> on the composition's timeline, with the window the runtime bounds it by.
// Operates on the well-formed HTML our own renderer emits (same basis as stripAudioFromHtml).
export function harvestCompositionVideos(html: string): CompositionVideo[] {
  const videos: CompositionVideo[] = [];
  for (const [tag] of html.matchAll(/<video\b[^>]*>/g)) {
    const attr = (name: string): string | undefined =>
      tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const id = attr("id");
    const src = attr("src");
    if (!id || !src) continue;
    const start = Number(attr("data-start") ?? 0);
    const duration = Number(attr("data-duration"));
    videos.push({
      id,
      src,
      start,
      // No data-duration means an unbounded clip — the runtime plays it to the composition's end.
      end: Number.isFinite(duration) ? start + duration : Infinity,
      mediaStart: Number(attr("data-media-start") ?? 0),
      loop: /\sloop\b/.test(tag),
    });
  }
  return videos;
}

// The `src` of a composition <video>, resolved to the file it will serve. Mirrors the capture file
// server's own lookup: the URL is percent-encoded per segment and the link tree below `workspace`
// is laid out under the decoded names.
function workspaceFileForSrc(src: string, workspace: string): string {
  const segments = src.split("/").filter(Boolean).map(decodeURIComponent);
  return path.join(workspace, ...segments);
}

// Headless Chromium does not decode a <video> reliably under a deterministic seek: the element
// yields whatever it happens to hold at screenshot time, which for most frames is nothing — a
// black rectangle. HyperFrames' answer is a before-capture hook that swaps each <video> for an
// <img> of the ffmpeg-extracted frame at that time; `executeRenderJob` wires one up internally,
// which is why exports are correct and only this hand-rolled capture path was not.
//
// The hook is built from a frame lookup, which upstream fills by extracting *every* frame of
// *every* clip. We know the handful of timestamps up front, so extract just those, through konte's
// own managed ffmpeg (`extractFrameAt`) rather than the engine's PATH-resolved one. The injector
// only ever asks the lookup for `getActiveFramePayloads(time)`, so that one method is the whole
// contract we have to satisfy.
//
// `suppliedVideoIds` are the clips the hook covers at every captured moment. Their <video> is never
// on screen, so its own load state is left out of the capture's media check, as the render does.
async function buildVideoFrameInjector(
  videos: CompositionVideo[],
  timestamps: number[],
  workspace: string,
  fps: number,
): Promise<{
  injector: import("@hyperframes/producer").BeforeCaptureHook | null;
  suppliedVideoIds: string[];
}> {
  const { createVideoFrameInjector, quantizeTimeToFrame } = await import("@hyperframes/producer");
  const framesDir = path.join(workspace, ".frames");
  await fs.mkdir(framesDir, { recursive: true });

  // Keyed by the capture's own frame number: `captureFrame` quantizes each timestamp onto the fps
  // grid before calling the hook, so the hook's `time` is that grid's value, not the raw request.
  const byCaptureFrame = new Map<number, Map<string, { framePath: string; frameIndex: number }>>();
  const unsupplied = new Set<string>();

  // Two different lengths, because the runtime uses two. A looping clip wraps on its *container*
  // length — that is what a media element's currentTime runs to and what HyperFrames' own lookup
  // wraps by, so anything else would make these frames disagree with the render they preview. Past
  // the last picture frame that lookup then holds the final frame rather than going blank, so the
  // picture's own length is what an extract has to be pulled back into. A clip whose audio outruns
  // its video needs both: wrap at 12s, but read no frame after 3s.
  const loopWindows = new Map<string, number>();
  const pictureEnds = new Map<string, number>();
  for (const video of videos) {
    try {
      const probe = await probeVideo(workspaceFileForSrc(video.src, workspace));
      if (video.loop) loopWindows.set(video.id, probe.duration);
      if (probe.videoDuration > 0) {
        pictureEnds.set(video.id, lastSeekableTime(probe.videoDuration, probe.fps));
      }
    } catch {
      // unreadable source — handled per frame below
    }
  }

  for (const ts of timestamps) {
    const time = quantizeTimeToFrame(ts, fps);
    const payloads = new Map<string, { framePath: string; frameIndex: number }>();
    for (const video of videos) {
      if (time < video.start || time >= video.end) continue;
      let mediaTime = time - video.start + video.mediaStart;
      // Past the source's end a `loop` clip restarts at mediaStart, matching how the runtime
      // wraps a looping element's currentTime. Without this the extract lands beyond the file,
      // finds no frame, and the shot falls back to the black <video> this hook exists to avoid.
      const sourceDuration = loopWindows.get(video.id);
      if (sourceDuration !== undefined && mediaTime >= sourceDuration) {
        const window = sourceDuration - video.mediaStart;
        if (window > 0) mediaTime = video.mediaStart + ((mediaTime - video.mediaStart) % window);
      }
      // Hold the last picture frame past the end of the video stream, as the render's own lookup
      // does. Without it an audio-padded clip's tail extracts nothing and falls back to the black
      // <video> this hook exists to avoid.
      const pictureEnd = pictureEnds.get(video.id);
      if (pictureEnd !== undefined && mediaTime > pictureEnd) mediaTime = pictureEnd;
      // Two capture timestamps can land on one source frame — extract it once, and let the
      // injector skip re-injecting it by reporting the same frameIndex.
      const frameIndex = Math.floor(mediaTime * fps);
      // PNG, not JPEG: the injector reads the mime off this extension, and a source with alpha
      // (a transparent overlay) must reach the page unflattened. It also spares the frame a
      // JPEG generation it would only lose detail to before the screenshot re-encodes it.
      const framePath = path.join(framesDir, `${video.id}-${frameIndex}.png`);
      if (!existsSync(framePath)) {
        try {
          await extractFrameAt(workspaceFileForSrc(video.src, workspace), mediaTime, framePath);
        } catch {
          // An unreadable source is the resolver's problem, not the capture's: leave this clip to
          // the browser rather than failing every frame of the shot over one bad file.
          unsupplied.add(video.id);
          continue;
        }
      }
      payloads.set(video.id, { framePath, frameIndex });
    }
    byCaptureFrame.set(Math.round(time * fps), payloads);
  }

  const lookup = {
    getActiveFramePayloads: (time: number) =>
      byCaptureFrame.get(Math.round(time * fps)) ?? new Map(),
  };
  return {
    injector: createVideoFrameInjector(
      lookup as unknown as NonNullable<Parameters<typeof createVideoFrameInjector>[0]>,
    ),
    suppliedVideoIds: videos.map((v) => v.id).filter((id) => !unsupplied.has(id)),
  };
}

/**
 * Where this shot's frames cache, for the composition as it stands now.
 *
 * The composition HTML embeds the timeline and every resolved variant reference — but a reference
 * names an address, a variant id and a filename, NOT the bytes behind them, and a `file` asset is
 * re-synced in place under the same variant (`file-sync`). So the HTML alone would keep its hash
 * across a picture change; the resolved inputs' content fingerprints go in beside it, and only both
 * together make any input/definition change a new dir — a cache miss, never a stale frame served as
 * current. Older hash dirs (superseded compositions) are swept on render when `pruneSuperseded` is
 * set, since `clean` is variant-scoped and would not otherwise reclaim them.
 *
 * A read surface, so it builds tolerantly: a ref with no ready take falls back to the newest stale
 * one, and a layer with none at all leaves a hole. It throws only when there is no frame to show at
 * all: no such shot, no composition, or a page that draws nothing.
 */
async function resolveCompositionCacheDir(options: {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  shotId: string;
  outputDir: string;
  format: "jpeg" | "png";
  quality: number;
}): Promise<{
  compositionResult: Awaited<
    ReturnType<typeof import("./composition-builder.js").buildShotCompositionHtml>
  >;
  cacheDir: string;
}> {
  const { video, manager, shotId, outputDir, format, quality } = options;
  const { buildShotCompositionHtml, compositionDrawsSomething } =
    await import("./composition-builder.js");
  const { compositionInputFingerprints, pictureRefsOf, unresolvedPictureRefs } =
    await import("./composition-resource.js");
  const target = shotById(video.shots, shotId);
  const compositionResult = await buildShotCompositionHtml({
    video,
    manager,
    shotId,
    // A read surface, so it falls back to the newest stale take and draws what is there — the same
    // tolerance the review page builds with. Refusing would hold a whole board of pictures on one
    // unready asset the sheet does not even show.
    allowNotReady: true,
    // Root-absolute so URLs resolve to "/<enc-address>/<variant>/<file>" against
    // the capture file server. `buildAssetUrl` adds the leading slash; a value of
    // "./" here would produce ".//…" → the browser resolves it to "//…" (404).
    assetBaseUrl: "",
  });
  // What "this shot cannot be captured" means: the built page would draw nothing. Asked of the
  // render, not the refs, so a shot with text or a background over its missing layers still frames.
  if (!compositionDrawsSomething(compositionResult.html)) {
    const gone = target ? unresolvedPictureRefs(manager, target) : [];
    throw new KonteError(
      "COMPOSITION_BUILD_FAILED",
      `Shot "${shotId}" has nothing to capture: it draws only ${gone.join(", ") || "layers"}, which resolve to nothing`,
    );
  }
  const fingerprints = target ? compositionInputFingerprints(manager, pictureRefsOf(target)) : {};
  const compHash = createHash("sha256")
    .update(compositionResult.html)
    .update(
      `|${compositionResult.size.width}x${compositionResult.size.height}|${compositionResult.fps}|${format}|${quality}`,
    )
    .update(`|${JSON.stringify(Object.entries(fingerprints).sort())}`)
    .digest("hex")
    .slice(0, 12);
  return { compositionResult, cacheDir: path.join(outputDir, compHash) };
}

export async function captureCompositionFrames(options: {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  shotId: string;
  videoRoot: string;
  outputDir: string;
  captureOptions?: CaptureCompositionOptions;
}): Promise<ThumbnailInfo[]> {
  const { video, manager, shotId, videoRoot, outputDir, captureOptions } = options;
  const maxFrames = captureOptions?.maxFrames ?? 8;
  const sceneThreshold = captureOptions?.sceneThreshold ?? 0.3;
  const format = captureOptions?.format ?? "jpeg";
  const quality = captureOptions?.quality ?? 80;
  const force = captureOptions?.force ?? false;
  const ext = format === "png" ? "png" : "jpg";
  const requested = captureOptions?.timestamps;

  const { compositionResult, cacheDir } = await resolveCompositionCacheDir({
    video,
    manager,
    shotId,
    outputDir,
    format,
    quality,
  });
  const manifestPath = path.join(cacheDir, "manifest.json");

  // Fast paths: a full cache hit skips the expensive capture session (and, for the
  // scene-detected set, the scene detection) entirely.
  if (!force) {
    if (requested) {
      const hits = requested.map((ts) => ({
        file: path.join(cacheDir, atFrameName(ts, ext)),
        timestamp: ts,
      }));
      if (hits.every((h) => existsSync(h.file))) {
        return hits.map((h) => ({
          file: path.relative(videoRoot, h.file),
          timestamp: h.timestamp,
        }));
      }
    } else if (existsSync(manifestPath)) {
      // Scene-detected timestamps vary per run, so a manifest records the set.
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as ThumbnailInfo[];
        if (
          manifest.length > 0 &&
          manifest.every((m) => existsSync(path.resolve(videoRoot, m.file)))
        ) {
          return manifest;
        }
      } catch {
        // corrupt manifest: fall through and re-render
      }
    }
  }

  // Cache miss — resolve which timestamps to render.
  const {
    assertCaptureMediaLoaded,
    ensureHyperFrames,
    linkIntoWorkspace,
    makeCaptureWorkspace,
    silenceHyperFramesLogs,
  } = await import("./hyperframes.js");
  const { buildAssetUrl, parseServedAssetUrl } = await import("./composition-builder.js");
  await ensureHyperFrames();

  let timestamps: number[];
  const sceneMode = !requested;
  if (requested) {
    timestamps = requested; // honor every --at timecode exactly (no subsampling)
  } else {
    const detected = await detectCompositionKeyframes(
      video,
      manager,
      shotId,
      videoRoot,
      sceneThreshold,
      maxFrames,
    );
    if (detected.length === 0) return [];
    timestamps = subsampleTimestamps(detected, maxFrames); // cap only the auto-detected set
  }

  await fs.mkdir(cacheDir, { recursive: true });

  if (captureOptions?.pruneSuperseded) {
    try {
      for (const entry of await fs.readdir(outputDir)) {
        if (entry !== path.basename(cacheDir)) {
          await fs.rm(path.join(outputDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // best-effort GC of stale composition caches
    }
  }

  // Per-frame plan with deterministic output names; reuse on-disk frames for --at.
  const plan = timestamps.map((ts, i) => {
    const name = sceneMode
      ? `keyframe-${String(i + 1).padStart(3, "0")}.${ext}`
      : atFrameName(ts, ext);
    const finalPath = path.join(cacheDir, name);
    return { ts, finalPath, cached: !sceneMode && !force && existsSync(finalPath) };
  });

  const results: ThumbnailInfo[] = new Array(plan.length);

  if (plan.some((p) => !p.cached)) {
    const {
      createFileServer,
      createCaptureSession,
      initializeSession,
      captureFrame,
      closeCaptureSession,
    } = await import("@hyperframes/producer");

    const restoreLogs = silenceHyperFramesLogs();
    let workspace: string | undefined;
    let captureDir: string | undefined;
    try {
      workspace = await makeCaptureWorkspace(videoRoot, "capture-");
      // The producer names a frame by its index in the session, so two runs capturing straight into
      // the shared cacheDir rename each other's `frame_NNNNNN` away. Each run captures into its own
      // dir inside cacheDir — one filesystem, so moving a finished frame into place is atomic.
      captureDir = await fs.mkdtemp(path.join(cacheDir, ".capture-"));
      const captureHtml = withVideoElementIds(compositionResult.html);
      await fs.writeFile(path.join(workspace, "index.html"), captureHtml, "utf-8");

      const state = manager.getState();
      for (const [address, assetState] of Object.entries(state.assets)) {
        if (!assetState.variants) continue;
        for (const [variantId, variant] of Object.entries(assetState.variants)) {
          // Only what the page references: a hard link or copy fails on a take whose file is gone.
          if (
            variant.file &&
            captureHtml.includes(buildAssetUrl("", address, variantId, variant.file))
          ) {
            const absPath = path.resolve(videoRoot, variant.file);
            // The composition URLs are percent-encoded per segment, but the capture file
            // server decodes each segment before the filesystem lookup. Lay the links out
            // under the decoded path — the address split at `@`/`:` (so no `:` dir is created)
            // plus the variant — so they match what the server resolves the URL to.
            const targetDir = path.join(workspace, ...addressToCacheSegments(address), variantId);
            await fs.mkdir(targetDir, { recursive: true });
            try {
              await linkIntoWorkspace(absPath, path.join(targetDir, path.basename(variant.file)));
            } catch (err) {
              throw new KonteError(
                "FRAME_CAPTURE_FAILED",
                `${address} (${variantId}): cannot stage ${variant.file} for capture: ${errorMessage(err)}`,
              );
            }
          }
        }
      }

      // The page-side runtime quantizes every seek onto its own fps grid and falls back to 30 when
      // the server does not name one — so an unstated fps rounds a 24fps panel's start back over
      // the cut before it, and the frame captured for a keyframe is the OUTGOING one.
      const server = await createFileServer({
        projectDir: workspace,
        fps: { num: compositionResult.fps, den: 1 },
      });

      const { injector, suppliedVideoIds } = await buildVideoFrameInjector(
        harvestCompositionVideos(captureHtml),
        plan.filter((p) => !p.cached).map((p) => p.ts),
        workspace,
        compositionResult.fps,
      );

      const session = await createCaptureSession(
        server.url,
        captureDir,
        {
          width: compositionResult.size.width,
          height: compositionResult.size.height,
          // The composition's own fps: capture quantizes each timestamp onto this grid, so any
          // other value samples moments the delivered video never shows.
          fps: { num: compositionResult.fps, den: 1 },
          format,
          quality,
          skipReadinessVideoIds: suppliedVideoIds,
        },
        injector,
      );

      try {
        await initializeSession(session);
        assertCaptureMediaLoaded(session, (urlPath) => {
          const served = parseServedAssetUrl(urlPath, "");
          if (!served?.variantId) return null;
          const file = state.assets[served.address]?.variants?.[served.variantId]?.file;
          return `${served.address} (${served.variantId}${file ? `: ${file}` : ""})`;
        });
        let renderIdx = 0;
        for (let i = 0; i < plan.length; i++) {
          const entry = plan[i]!;
          if (entry.cached) {
            results[i] = {
              file: path.relative(videoRoot, entry.finalPath),
              timestamp: entry.ts,
            };
            continue;
          }
          const captureResult = await captureFrame(session, renderIdx++, entry.ts);
          await fs.rename(captureResult.path, entry.finalPath);
          results[i] = {
            file: path.relative(videoRoot, entry.finalPath),
            timestamp: entry.ts,
          };
        }
      } finally {
        await closeCaptureSession(session);
        server.close();
      }
    } finally {
      for (const dir of [workspace, captureDir]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      restoreLogs();
    }
  } else {
    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i]!;
      results[i] = { file: path.relative(videoRoot, entry.finalPath), timestamp: entry.ts };
    }
  }

  if (sceneMode) {
    try {
      await writeFileAtomic(manifestPath, JSON.stringify(results));
    } catch {
      // manifest is best-effort; its absence just means a cache miss next time
    }
  }

  return results;
}

// A note id is a path component of its pin frame, and it comes off schema-validated JSON that is a
// text file a human can edit — so it is checked for the shape `generateFeedbackId` mints, not
// trusted. A note that fails this simply gets no pin frame.
const SAFE_FEEDBACK_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The marked twin of a captured frame — the reticle burned in, beside the plain capture rather than
 * over it. The plain frame is shared by every note at that instant, so the twin carries the note id
 * that fixes where the pin sits.
 */
function annotatedFramePath(file: string, feedbackId: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}-pin-${feedbackId}${ext}`;
}

/**
 * Where a shot's note frames cache: the shot composition's own thumbnail dir, the one
 * `probe reel-thumbnails` fills, so a frame is shared by every note standing at that instant and
 * `clean` / `prune` reclaim it as the composition cache it is.
 *
 * Null when the shot has no composition of its own, or when the shot id would take the dir out of
 * the cache tree — it reaches here off a review record, which is editable text.
 *
 * A shot with no `shotFn` renders a fallback (its board frame), and `probe reel-thumbnails` refuses
 * those for the same reason this does: the address is not a live composition, so `prune` reads its
 * cache as orphaned, and the fallback source is outside what the cache key fingerprints.
 */
export function shotFrameDir(
  video: import("./types/index.js").StageDefinition,
  videoRoot: string,
  shotId: string,
): string | null {
  if (!shotById(video.shots, shotId)?.shotFn) return null;
  const root = path.join(videoRoot, ".konte", "cache", "thumbnails");
  const dir = path.join(
    root,
    ...addressToCacheSegments(formatCompositionAddress(video.stage, shotId)),
  );
  return isWithinRoot(dir, root) ? dir : null;
}

export interface FeedbackFrameOptions {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  videoRoot: string;
  feedbackId: string;
  shotId: string;
  localTime: number;
  annotation?: import("./types/feedback.js").FeedbackAnnotation | null;
}

/**
 * Where a note's frame lives for the composition as it stands now — the whole of what used to be
 * recorded on the note, derived instead. Null when the shot no longer composes or draws nothing at
 * all, which is also the answer to "may this be rendered"; a partly-resolved picture still yields a
 * frame. Returns the videoRoot-relative path, the `-pin-<id>` twin for a pinned note.
 */
export async function feedbackFramePath(options: FeedbackFrameOptions): Promise<string | null> {
  const { videoRoot, feedbackId, shotId, localTime, annotation } = options;
  const outputDir = shotFrameDir(options.video, videoRoot, shotId);
  if (!outputDir) return null;
  let cacheDir: string;
  try {
    ({ cacheDir } = await resolveCompositionCacheDir({
      video: options.video,
      manager: options.manager,
      shotId,
      outputDir,
      format: COMPOSITION_FRAME_FORMAT,
      quality: COMPOSITION_FRAME_QUALITY,
    }));
  } catch {
    return null;
  }
  const file = path.join(cacheDir, atFrameName(Math.max(0, localTime), "jpg"));
  if (annotation?.kind !== "pin") return path.relative(videoRoot, file);
  if (!SAFE_FEEDBACK_ID.test(feedbackId)) return null;
  return path.relative(videoRoot, annotatedFramePath(file, feedbackId));
}

/**
 * Why a note has no frame. `unavailable` is the expected answer — the shot left the definition, its
 * refs no longer resolve, the note addresses nothing inside the cache tree — and says the record is
 * simply older than the piece. `failed` is the rendering machinery breaking (no Chromium, no disk,
 * a capture session dying), which a reader must be told about rather than read as the first.
 */
export type FeedbackFrameResult =
  | { kind: "frame"; file: string }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

/** One shot's notes, as `resolveShotFeedbackFrames` takes them. */
export interface FeedbackFrameNote {
  feedbackId: string;
  /** Offset within the shot, which is what a composition capture takes. */
  localTime: number;
  annotation?: import("./types/feedback.js").FeedbackAnnotation | null;
}

/**
 * The composition frames for one shot's notes — rendered on demand and cached, never recorded. In
 * one capture session for the whole shot: the notes of a review cluster on the shots it flagged,
 * and a session per note would pay Chromium's startup for each.
 *
 * The cache dir is keyed on the composition hash (the definition plus every resolved input's
 * content fingerprint), so a hit is by construction a frame of the composition as it stands now; a
 * changed shot is a miss, not a stale frame served as current.
 *
 * Returns one result per note, in the order given. A frame's path is videoRoot-relative.
 */
export async function resolveShotFeedbackFrames(options: {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  videoRoot: string;
  shotId: string;
  notes: readonly FeedbackFrameNote[];
}): Promise<FeedbackFrameResult[]> {
  const { video, manager, videoRoot, shotId, notes } = options;
  const outputDir = shotFrameDir(video, videoRoot, shotId);
  if (!outputDir) return notes.map(() => ({ kind: "unavailable" }) as const);

  const timestamps = notes.map((n) => Math.max(0, n.localTime));
  let frames: ThumbnailInfo[];
  try {
    frames = await captureCompositionFrames({
      video,
      manager,
      shotId,
      videoRoot,
      outputDir,
      captureOptions: {
        timestamps,
        format: COMPOSITION_FRAME_FORMAT,
        quality: COMPOSITION_FRAME_QUALITY,
        // The same sweep `probe reel-thumbnails` does on this dir: only the current hash survives.
        pruneSuperseded: true,
      },
    });
  } catch (err) {
    // The one expected failure: the shot no longer composes. Everything else is the rendering
    // machinery, and reporting it as "this note has no frame" would hide a broken install.
    const result: FeedbackFrameResult =
      err instanceof KonteError && err.code === "COMPOSITION_BUILD_FAILED"
        ? { kind: "unavailable" }
        : { kind: "failed", message: errorMessage(err) };
    return notes.map(() => result);
  }

  const results: FeedbackFrameResult[] = [];
  for (const [i, note] of notes.entries()) {
    const file = frames[i]?.file;
    if (!file) {
      results.push({ kind: "unavailable" });
      continue;
    }
    if (note.annotation?.kind !== "pin") {
      results.push({ kind: "frame", file });
      continue;
    }
    if (!SAFE_FEEDBACK_ID.test(note.feedbackId)) {
      results.push({ kind: "frame", file });
      continue;
    }
    const source = path.resolve(videoRoot, file);
    const marked = annotatedFramePath(source, note.feedbackId);
    if (!existsSync(marked)) {
      const { annotateFrameWithPin } = await import("./annotate-frame.js");
      const ok = await annotateFrameWithPin({
        sourceFile: source,
        outputFile: marked,
        x: note.annotation.x,
        y: note.annotation.y,
      });
      // A reticle that would not burn in is cosmetic; the frame under it is still the evidence.
      if (!ok) {
        results.push({ kind: "frame", file });
        continue;
      }
    }
    results.push({ kind: "frame", file: path.relative(videoRoot, marked) });
  }
  return results;
}

async function detectCompositionKeyframes(
  video: import("./types/index.js").StageDefinition,
  manager: import("./state/index.js").StateManager,
  shotId: string,
  videoRoot: string,
  threshold: number,
  maxFrames: number,
): Promise<number[]> {
  const { buildRenderPlan } = await import("./render-plan.js");

  let plan;
  try {
    plan = buildRenderPlan(video, manager, {
      shotId,
      outputDir: "",
      allowUnaccepted: true,
    });
  } catch {
    return [];
  }

  const shotPlan = plan.shots[0];
  if (!shotPlan) return [];

  const duration = shotPlan.duration;
  const allTimestamps: number[] = [];

  for (const [, filePath] of Object.entries(shotPlan.resolvedFiles)) {
    const absPath = path.resolve(videoRoot, filePath);
    const mediaType = inferMediaType(filePath);
    if (mediaType !== "video") continue;

    try {
      const ts = await detectSceneChanges(absPath, threshold, 0.5);
      allTimestamps.push(...ts.filter((t) => t <= duration));
    } catch {
      // skip unreadable files
    }
  }

  if (allTimestamps.length === 0 && duration > 0) {
    return generateUniformTimestamps(duration, maxFrames, []);
  }

  const unique = [...new Set(allTimestamps)].sort((a, b) => a - b);
  const filtered: number[] = [];
  for (const ts of unique) {
    if (filtered.length === 0 || ts - filtered[filtered.length - 1]! >= 0.5) {
      filtered.push(ts);
    }
  }

  // Low-motion shots yield only 1-2 scene changes, leaving too few frames to judge motion. Top up
  // with uniform timestamps to the full requested density so --max-frames actually controls how
  // finely a subtle-motion clip is sampled (a peak-collapsed pair of stills reads as "no motion").
  if (filtered.length < 3 && duration > 0) {
    const needed = maxFrames - filtered.length;
    if (needed > 0) {
      const uniform = generateUniformTimestamps(duration, needed, filtered);
      return [...filtered, ...uniform].sort((a, b) => a - b);
    }
  }

  return filtered;
}
