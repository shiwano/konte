import { measureAudioLoudness } from "./audio-loudness.js";
import { ffprobeBin } from "./ffmpeg-binary.js";
import { inferMediaType } from "./media-type.js";
import type { VariantMedia } from "./types/index.js";
import { execFileAsync } from "./exec-file.js";

// The pixel dimensions of a media file's first video stream (an image counts as one), or null if it
// can't be probed (missing ffprobe, audio-only, corrupt file). Used to compute per-layer delivery
// upscale targets (source × scale), and to size a patch step from the take it corrects — in both
// cases the source's real resolution is only known once its file exists.
export async function probeVideoDimensions(
  absPath: string,
): Promise<{ width: number; height: number } | null> {
  const video = (await probeMediaDetail(absPath))?.video;
  return video ? { width: video.width, height: video.height } : null;
}

// A rational ffprobe rate (`24/1`, `24000/1001`) as a number; null for an unknown or malformed one
// (`0/0`, `N/A`, a zero denominator).
function parseRationalRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [num = Number.NaN, den = Number.NaN] = value.split("/").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num <= 0) return null;
  return num / den;
}

// ffprobe reports two rates per video stream: `avg_frame_rate` (frames ÷ duration — what ffmpeg
// prints as `fps`) and `r_frame_rate` (the timebase tick rate, printed as `tbr`). They diverge on a
// mux whose timestamps don't sit on a constant grid, where `tbr` reads as a multiple of the real
// rate — so the average is the deliverable's actual frame rate, and the tick rate is only a fallback
// for a stream that declares no average.
export function pickVideoFps(stream: {
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
}): number | null {
  return parseRationalRate(stream.avg_frame_rate) ?? parseRationalRate(stream.r_frame_rate);
}

// The duration in seconds of a media file, or null if it can't be probed. Used to place timeline
// audio (actual rendered shot lengths) and to decide whether a soundtrack must loop to fill its
// span (source shorter than the span).
export async function probeMediaDuration(absPath: string): Promise<number | null> {
  return (await probeMediaDetail(absPath))?.durationSec ?? null;
}

// Whether a video has at least one audio stream. Used to preserve the source audio of
// audio-bearing models (e.g. Veo) instead of overwriting it with silence; false on any
// probe failure (missing ffprobe, not a video) so callers fall back to a synthesized track.
export async function probeHasAudio(absPath: string): Promise<boolean> {
  const detail = await probeMediaDetail(absPath);
  return detail !== null && detail.audio !== null;
}

function positive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface RawProbe {
  format?: { duration?: unknown };
  streams?: Array<Record<string, unknown>>;
}

// Reduce one ffprobe dump to the record konte stores on the variant (`VariantMediaSchema`). `kind`
// is the caller's (`inferMediaType`), so this fills in the fields that kind promises and returns
// null the moment one of them is unreadable. A video's missing audio stream is the one legitimate
// null. Pure.
export function buildVariantMedia(
  kind: "image" | "video" | "audio",
  raw: unknown,
): VariantMedia | null {
  const probe = (raw ?? {}) as RawProbe;
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  // A container that declares no duration can still carry it on the stream (some WAV/MKV muxes).
  const durationOf = (stream: Record<string, unknown> | undefined): number | null =>
    positive(probe.format?.duration) ?? positive(stream?.duration);

  if (kind === "image") {
    const width = positive(video?.width);
    const height = positive(video?.height);
    return width && height ? { kind: "image", width, height } : null;
  }

  if (kind === "video") {
    const width = positive(video?.width);
    const height = positive(video?.height);
    const fps = video ? pickVideoFps(video) : null;
    const durationSec = durationOf(video);
    if (!width || !height || !fps || !durationSec) return null;
    if (!audio) return { kind: "video", width, height, fps, durationSec, audio: null };
    const channels = positive(audio.channels);
    const sampleRate = positive(audio.sample_rate);
    if (!channels || !sampleRate) return null;
    return { kind: "video", width, height, fps, durationSec, audio: { channels, sampleRate } };
  }

  const durationSec = durationOf(audio);
  const channels = positive(audio?.channels);
  const sampleRate = positive(audio?.sample_rate);
  if (!durationSec || !channels || !sampleRate) return null;
  return { kind: "audio", durationSec, channels, sampleRate };
}

// Everything konte reads off a media file, in one ffprobe. Both projections below take this dump,
// so a file is never walked twice.
const PROBE_ENTRIES =
  "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate," +
  "nb_frames,channels,channel_layout,sample_rate,bit_rate,duration";

async function ffprobeJson(absPath: string): Promise<RawProbe | null> {
  try {
    const ffprobe = await ffprobeBin();
    const res = await execFileAsync(ffprobe, [
      "-v",
      "quiet",
      "-show_entries",
      PROBE_ENTRIES,
      "-of",
      "json",
      absPath,
    ]);
    return JSON.parse(res.stdout) as RawProbe;
  } catch {
    return null;
  }
}

// The container-level metadata tags of a media file — where an export's provenance is burned in
// (see tagDeliverable). Kept out of the shared probe above, which every variant measurement pays
// for. Empty on any probe failure.
export async function probeContainerTags(absPath: string): Promise<Record<string, string>> {
  try {
    const ffprobe = await ffprobeBin();
    const res = await execFileAsync(ffprobe, [
      "-v",
      "quiet",
      "-show_entries",
      "format_tags",
      "-of",
      "json",
      absPath,
    ]);
    const tags = (JSON.parse(res.stdout) as { format?: { tags?: unknown } }).format?.tags;
    if (typeof tags !== "object" || tags === null) return {};
    return Object.fromEntries(
      Object.entries(tags as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}

// The record konte stores on a variant, measured once when its file lands. Null when the path
// carries no media extension, when ffprobe is unavailable, or when a promised field is unreadable.
export async function probeMediaInfo(absPath: string): Promise<VariantMedia | null> {
  const kind = inferMediaType(absPath);
  if (kind === null) return null;
  const raw = await ffprobeJson(absPath);
  const media = raw ? buildVariantMedia(kind, raw) : null;
  return media ? withAudioLoudness(media, absPath) : null;
}

// A second decode pass, taken once when the file lands, for the levels the mix needs. A still and a
// silent video have no audio to measure and skip it; a failed measurement leaves the record without
// one rather than dropping the whole thing.
async function withAudioLoudness(media: VariantMedia, absPath: string): Promise<VariantMedia> {
  if (media.kind === "image") return media;
  if (media.kind === "video" && media.audio === null) return media;
  if (media.kind === "audio") {
    const loudness = await measureAudioLoudness(absPath);
    return loudness ? { ...media, loudness } : media;
  }
  const loudness = await measureAudioLoudness(absPath);
  return loudness && media.audio ? { ...media, audio: { ...media.audio, loudness } } : media;
}

interface MediaDetail {
  durationSec: number | null;
  video: {
    width: number;
    height: number;
    fps: number | null;
    frames: number | null;
    durationSec: number | null;
  } | null;
  audio: AudioStreamInfo | null;
}

// The same file, as a human-facing surface wants it: codec names and bitrate included, every field
// nullable. For the deliverable a command was asked to measure (`probe export`, `probe audio`) — a
// live read of the real artifact.
export async function probeMediaDetail(absPath: string): Promise<MediaDetail | null> {
  const raw = await ffprobeJson(absPath);
  if (!raw) return null;
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const width = positive(video?.width);
  const height = positive(video?.height);
  return {
    durationSec: positive(raw.format?.duration) ?? positive(video?.duration ?? audio?.duration),
    video:
      width && height
        ? {
            width,
            height,
            fps: video ? pickVideoFps(video) : null,
            frames: positive(video?.nb_frames),
            durationSec: positive(video?.duration),
          }
        : null,
    audio: audio
      ? {
          codec: typeof audio.codec_name === "string" ? audio.codec_name : null,
          sampleRate: positive(audio.sample_rate),
          channels: positive(audio.channels),
          channelLayout: typeof audio.channel_layout === "string" ? audio.channel_layout : null,
          bitRate: positive(audio.bit_rate),
        }
      : null,
  };
}

export interface AudioStreamInfo {
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  bitRate: number | null;
}
