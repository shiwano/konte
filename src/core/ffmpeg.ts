import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KonteError, errorMessage } from "./errors.js";
import { duckVolumeExpr, type DuckStep } from "./audio-duck.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { probeHasAudio } from "./video-probe.js";
import { execFileAsync } from "./exec-file.js";

/** Resolve a usable ffmpeg (provisioning the managed build on first use); returns its path. */
export async function ensureFfmpeg(): Promise<string> {
  return ffmpegBin();
}

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

export async function trimVideo(options: {
  inputFile: string;
  outputFile: string;
  start: number;
  duration: number;
}): Promise<void> {
  const { inputFile, outputFile, start, duration } = options;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  // Re-encode rather than `-c copy`: stream copy can only cut on keyframes, so on a sparse-GOP
  // source (common for AI clips, and `file` assets skip keyframe normalization) the actual cut
  // drifts seconds from `start`. `-ss` stays before `-i` for a fast seek; modern ffmpeg then
  // decodes to the exact requested time, making the cut frame-accurate.
  const args = [
    "-y",
    "-ss",
    String(start),
    "-i",
    inputFile,
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputFile,
  ];

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `ffmpeg trimVideo failed: ${message}`);
  }
}

export async function videoToVideo(options: {
  videoFile: string;
  outputFile: string;
  fps: number;
  duration: number;
  size: { width: number; height: number };
  extraFilters?: string;
}): Promise<void> {
  const { videoFile, outputFile, fps, duration, size, extraFilters } = options;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  let vf = `scale=${size.width}:${size.height},setsar=1`;
  if (extraFilters) vf = `${vf},${extraFilters}`;

  // Preserve the source audio (e.g. Veo and other audio-bearing models); only synthesize a
  // silent track when the source has none, so every stitched shot still carries audio.
  const hasAudio = await probeHasAudio(videoFile);

  const args = ["-y", "-i", videoFile];
  if (!hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  }
  args.push(
    "-map",
    "0:v:0",
    "-map",
    hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    vf,
    "-r",
    String(fps),
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-shortest",
    outputFile,
  );

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `ffmpeg videoToVideo failed: ${message}`);
  }
}

export async function imageToVideo(options: {
  imageFile: string;
  outputFile: string;
  fps: number;
  duration: number;
  size: { width: number; height: number };
  extraFilters?: string;
}): Promise<void> {
  const { imageFile, outputFile, fps, duration, size, extraFilters } = options;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  let vf = `scale=${size.width}:${size.height},setsar=1`;
  if (extraFilters) vf = `${vf},${extraFilters}`;

  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    imageFile,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    String(duration),
    "-r",
    String(fps),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-shortest",
    outputFile,
  ];

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `ffmpeg imageToVideo failed: ${message}`);
  }
}

export interface MuxAudioTrack {
  /** Absolute path to the source media (audio file, or a video whose audio is used). */
  file: string;
  /** Timeline-absolute start in seconds. */
  start: number;
  /** Offset into the source media in seconds. */
  mediaStart: number;
  /** Played length in seconds; null plays the source to its end. */
  duration: number | null;
  /** Gain 0–MAX_AUDIO_GAIN, 1 = unity; checked upstream by `assertAudioGain`. */
  volume: number;
  /** Loop the source to fill `duration` (for a bed shorter than its span). */
  loop: boolean;
  /** The dips this bed takes under the lines over it (see buildDuckEnvelope), in its own time. */
  duck?: { steps: readonly DuckStep[]; depth: number };
  /** Fade-in seconds from the track's start. */
  fadeIn?: number;
  /** Fade-out seconds before the track's end. Requires a known `duration`. */
  fadeOut?: number;
}

// Per-track input args (-stream_loop / decode-accurate -ss / -i).
function pushTrackInput(args: string[], track: MuxAudioTrack): void {
  if (track.loop) args.push("-stream_loop", "-1");
  // `-ss` before `-i` is a fast, decode-accurate seek (same rationale as trimVideo).
  args.push("-ss", String(track.mediaStart), "-i", track.file);
}

// The filtergraph segment for one track: trim, volume, fades, then place it on the timeline.
// afade operates on the trimmed stream (st relative to its start), before adelay shifts it onto the
// timeline. Out-fade needs a known duration to place its start; skip it for play-to-end.
function trackFilter(track: MuxAudioTrack, inputIdx: number, label: string): string {
  const startMs = Math.round(track.start * 1000);
  const trim = track.duration != null ? `atrim=0:${track.duration},asetpts=PTS-STARTPTS,` : "";
  const fades: string[] = [];
  if (track.fadeIn != null && track.fadeIn > 0) {
    fades.push(`afade=t=in:st=0:d=${track.fadeIn}`);
  }
  if (track.fadeOut != null && track.fadeOut > 0 && track.duration != null) {
    fades.push(`afade=t=out:st=${Math.max(0, track.duration - track.fadeOut)}:d=${track.fadeOut}`);
  }
  const fade = fades.length > 0 ? `${fades.join(",")},` : "";
  // `t` here is the TRIMMED stream's own clock (atrim + asetpts above, adelay below), which is the
  // time base the envelope was built in.
  const volume = track.duck
    ? `volume=volume='${duckVolumeExpr(track.volume, track.duck.steps, track.duck.depth)}':eval=frame`
    : `volume=${track.volume}`;
  return `[${inputIdx}:a]${trim}${volume},${fade}adelay=${startMs}|${startMs}[${label}]`;
}

// Build the ffmpeg args that lay timeline audio tracks over a video's picture. Video is taken
// from input 0 only (`-map 0:v`), so any audio already baked into `videoFile` is discarded — the
// composited audio is fully reconstructed here, decode-accurate and seam-free. Pure (no I/O) so
// the arg shape can be unit-tested without invoking ffmpeg.
export function buildMuxArgs(
  videoFile: string,
  outputFile: string,
  tracks: MuxAudioTrack[],
  videoDuration?: number,
): string[] {
  const args = ["-y", "-i", videoFile];

  const labels: string[] = [];
  const filterParts: string[] = [];

  tracks.forEach((track, i) => {
    pushTrackInput(args, track);
    const label = `a${i}`;
    labels.push(`[${label}]`);
    filterParts.push(trackFilter(track, i + 1, label)); // tracks follow the video at input 0
  });

  // Sum the tracks (normalize=0 keeps each track's own gain) and limit only to prevent clipping
  // when overlapping tracks push past 0dBFS. No loudness normalization — that is a creative choice.
  // Clamp the mix to the picture length (amix runs to the longest input, so a track longer than the
  // timeline would otherwise stretch the file past the video and freeze the last frame in players).
  const mixed =
    tracks.length === 1
      ? labels[0]
      : `${labels.join("")}amix=inputs=${tracks.length}:normalize=0[mix];[mix]`;
  const clamp = videoDuration != null ? `,atrim=0:${videoDuration}` : "";
  filterParts.push(`${mixed}alimiter=level=false:limit=0.95${clamp}[aout]`);

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ar",
    "44100",
    "-ac",
    "2",
    outputFile,
  );

  return args;
}

// Above this many tracks the one-pass mux is chunked: a single ffmpeg would otherwise open
// one decoder per track (a 1000-shot timeline with per-shot dialogue is 1000+ inputs). The
// mix is a plain sum (amix normalize=0) with the limiter applied once at the end, so summing
// chunk pre-mixes is the same math — the pre-mixes are float PCM, keeping full headroom for
// the final limiter. One level of chunking bounds inputs up to CHUNK² tracks.
const MUX_CHUNK_SIZE = 48;

/**
 * Pre-mix one chunk of placed tracks into a float-PCM WAV: per-track trim/volume/fade/adelay
 * exactly as `buildMuxArgs`, summed with normalize=0 — but NO limiter and no clamp, which the
 * final pass applies once over the summed chunks. Pure, for the same testability reason.
 */
function buildChunkMixArgs(tracks: MuxAudioTrack[], outputFile: string): string[] {
  const args = ["-y"];
  const labels: string[] = [];
  const filterParts: string[] = [];

  tracks.forEach((track, i) => {
    pushTrackInput(args, track);
    const label = `a${i}`;
    labels.push(`[${label}]`);
    filterParts.push(trackFilter(track, i, label));
  });

  let outLabel: string;
  if (tracks.length === 1) {
    outLabel = labels[0]!;
  } else {
    filterParts.push(`${labels.join("")}amix=inputs=${tracks.length}:normalize=0[aout]`);
    outLabel = "[aout]";
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    outLabel,
    "-c:a",
    "pcm_f32le",
    outputFile,
  );
  return args;
}

// Lay one or more timeline audio tracks over the concatenated picture in a single encode pass,
// eliminating the per-shot encode seams that arise from baking audio into each shot.
export async function muxTimelineAudio(options: {
  videoFile: string;
  outputFile: string;
  tracks: MuxAudioTrack[];
  videoDuration?: number;
}): Promise<void> {
  const { videoFile, outputFile, tracks, videoDuration } = options;
  if (tracks.length === 0) {
    throw new KonteError("FFMPEG_ERROR", "muxTimelineAudio called with no tracks");
  }

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const ffmpeg = await ffmpegBin();
  let muxTracks = tracks;
  let tmpDir: string | null = null;
  try {
    if (tracks.length > MUX_CHUNK_SIZE) {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-mux-"));
      const intermediates: MuxAudioTrack[] = [];
      for (let i = 0; i < tracks.length; i += MUX_CHUNK_SIZE) {
        const chunk = tracks.slice(i, i + MUX_CHUNK_SIZE);
        const chunkFile = path.join(tmpDir!, `chunk-${i / MUX_CHUNK_SIZE}.wav`);
        await execFileAsync(ffmpeg, buildChunkMixArgs(chunk, chunkFile));
        // A pre-mix is already placed on the timeline (adelay baked in), so it enters the
        // final pass as a bare full-length track at t=0.
        intermediates.push({
          file: chunkFile,
          start: 0,
          mediaStart: 0,
          duration: null,
          volume: 1,
          loop: false,
        });
      }
      muxTracks = intermediates;
    }
    await execFileAsync(ffmpeg, buildMuxArgs(videoFile, outputFile, muxTracks, videoDuration));
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `ffmpeg muxTimelineAudio failed: ${message}`);
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Build the ffmpeg args that mix audio tracks into a single audio file (no video). Same per-track
// placement/fade logic as buildMuxArgs, but tracks start at input 0 and only `[aout]` is mapped.
// Used to materialize a shot's stem — the single clip an audio-driven model consumes. Pure.
// `duration` clamps the result the way buildMuxArgs clamps to the picture length: amix runs to the
// longest input, so without it the longest take decides the file's length — which for an animatic
// stem would let a TTS take, not the direction, decide the clip an audio-driven model returns.
export function buildAudioMixArgs(
  tracks: MuxAudioTrack[],
  outputFile: string,
  duration?: number,
): string[] {
  const args = ["-y"];
  const labels: string[] = [];
  const filterParts: string[] = [];

  tracks.forEach((track, i) => {
    pushTrackInput(args, track);
    const label = `a${i}`;
    labels.push(`[${label}]`);
    filterParts.push(trackFilter(track, i, label)); // no video — tracks start at input 0
  });

  const mixed =
    tracks.length === 1
      ? labels[0]
      : `${labels.join("")}amix=inputs=${tracks.length}:normalize=0[mix];[mix]`;
  // A clamp shorter than the mix has to pad as well as trim: a stem whose only take is shorter than
  // the window would otherwise hand the model a clip shorter than the shot.
  const clamp = duration != null ? `,apad=whole_dur=${duration},atrim=0:${duration}` : "";
  filterParts.push(`${mixed}alimiter=level=false:limit=0.95${clamp}[aout]`);

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[aout]",
    "-ar",
    "44100",
    "-ac",
    "2",
    outputFile,
  );

  return args;
}

// Mix audio tracks into a single audio file (the codec follows the output extension).
export async function mixAudioTracks(options: {
  outputFile: string;
  tracks: MuxAudioTrack[];
  duration?: number;
}): Promise<void> {
  const { outputFile, tracks, duration } = options;
  if (tracks.length === 0) {
    throw new KonteError("FFMPEG_ERROR", "mixAudioTracks called with no tracks");
  }

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, buildAudioMixArgs(tracks, outputFile, duration));
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `ffmpeg mixAudioTracks failed: ${message}`);
  }
}

export async function concatenateShots(options: {
  inputFiles: string[];
  outputFile: string;
  // Re-encode to a uniform codec instead of stream-copying. Stream copy (`-c copy`) only
  // works when every input shares codec/pixel-format/timebase; frame-delivery stitches
  // composites from arbitrary upscalers, so it must re-encode to avoid A/V desync or failure.
  reencode?: boolean;
  // Conform the output to this frame rate (re-encode only). Frame-delivery composites inherit
  // each upscaler's fps, which can diverge from the video's format.fps; forcing `-r` pins the
  // delivered picture to the declared rate.
  fps?: number;
  // Cut this frame from the centre of the picture. Frame delivery never re-composites, so the
  // delivery overshoot is trimmed here rather than in the browser. Implies a re-encode.
  crop?: { width: number; height: number };
}): Promise<void> {
  const { inputFiles, outputFile, reencode = false, fps, crop } = options;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const listContent = inputFiles.map((f) => `file '${escapeConcatPath(f)}'`).join("\n");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-concat-"));
  const listFile = path.join(tmpDir, "filelist.txt");

  try {
    await fs.writeFile(listFile, listContent, "utf-8");

    const codecArgs =
      reencode || crop
        ? [
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            ...(fps !== undefined ? ["-r", String(fps)] : []),
            "-c:a",
            "aac",
            "-ar",
            "44100",
            "-ac",
            "2",
          ]
        : ["-c", "copy"];
    const cropArgs = crop
      ? ["-vf", `crop=${crop.width}:${crop.height}:(in_w-${crop.width})/2:(in_h-${crop.height})/2`]
      : [];
    const args = [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      ...cropArgs,
      ...codecArgs,
      outputFile,
    ];

    const ffmpeg = await ffmpegBin();
    try {
      await execFileAsync(ffmpeg, args);
    } catch (err) {
      const message = errorMessage(err);
      throw new KonteError("FFMPEG_ERROR", `ffmpeg concatenateShots failed: ${message}`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Burn konte's provenance into the delivered MP4's container metadata, in place. A custom key
// needs `use_metadata_tags` — the mov muxer otherwise writes only the tags it knows and drops the
// rest silently — and a later concat discards them, so this runs last, after the stitch and the
// mux. Stream-copy: no re-encode.
export async function tagDeliverable(options: {
  file: string;
  tags: Record<string, string>;
}): Promise<void> {
  const { file, tags } = options;

  // ffmpeg picks the muxer off the output extension, so the temp keeps the deliverable's own.
  const ext = path.extname(file);
  const tmpFile = path.join(path.dirname(file), `.${path.basename(file, ext)}.tagging${ext}`);
  const args = [
    "-y",
    "-i",
    file,
    // Every stream, untouched — the default selection would drop a second audio track.
    "-map",
    "0",
    "-c",
    "copy",
    "-movflags",
    "use_metadata_tags+faststart",
    ...Object.entries(tags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
    tmpFile,
  ];

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
    await fs.rename(tmpFile, file);
  } catch (err) {
    await fs.rm(tmpFile, { force: true });
    throw new KonteError("FFMPEG_ERROR", `ffmpeg tagDeliverable failed: ${errorMessage(err)}`);
  }
}

/**
 * Write a copy of `inputFile` with `lead` seconds of its own first frame held in front of it,
 * picture only. Preview-only; see `preview-preroll.ts`.
 *
 * Re-encodes — an mp4 edit list would only shift timestamps, which Chrome normalizes back to zero.
 * Audio is dropped: the preview's mirrored `<audio>` keeps playing the untouched original.
 */
export async function padVideoClip(options: {
  inputFile: string;
  outputFile: string;
  /** Source time the copy starts at. */
  seek: number;
  /** Seconds of the first frame cloned in front. */
  lead: number;
  /** Seconds of the last frame cloned after the source ends. */
  tail: number;
  /** Seconds to write. Bounds the pass to the window the clip plays, not the whole source. */
  limit: number;
}): Promise<void> {
  const { inputFile, outputFile, seek, lead, tail, limit } = options;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const args = [
    "-y",
    ...(seek > 0 ? ["-ss", String(seek)] : []),
    "-i",
    inputFile,
    "-vf",
    `tpad=start_duration=${lead}:start_mode=clone:stop_duration=${tail}:stop_mode=clone`,
    "-t",
    String(limit),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputFile,
  ];

  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `ffmpeg padVideoClip failed: ${message}`);
  }
}
