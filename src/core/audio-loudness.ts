import { ffmpegBin } from "./ffmpeg-binary.js";
import { execFileAsync } from "./exec-file.js";

/**
 * What one decode pass measured on an audio-bearing file. `integratedLufs` is the program loudness a
 * dialogue/music cue is levelled by; `truePeakDb` is what a percussive cue is levelled by;
 * `leadInSec` is the silence an sfx cue skips and a line ducks a bed from the end of.
 */
export interface AudioLoudness {
  /** Integrated loudness in LUFS; null for content too short or too quiet to hold one. */
  integratedLufs: number | null;
  /** True peak in dBFS. */
  truePeakDb: number;
  /** Seconds before the sound begins; absent on a record measured before it was. */
  leadInSec?: number;
}

// The `-inf` ffmpeg prints for digital silence parses to NaN and is rejected with it.
const NUMBER = String.raw`(-?[\d.]+|-inf)`;

// The sound begins at the first 10 ms window within this of the loudest one.
const LEAD_IN_FLOOR_DB = 30;
const LEAD_IN_WINDOW = 480;
const LEAD_IN_RATE = 48000;

/**
 * The `Summary:` block ffmpeg's ebur128 filter writes to stderr. Null when the block is absent (a
 * failed run) or its peak unreadable.
 */
export function parseEbur128Summary(stderr: string): AudioLoudness | null {
  const start = stderr.lastIndexOf("Summary:");
  if (start < 0) return null;
  const tail = stderr.slice(start);
  const peak = new RegExp(String.raw`Peak:\s+${NUMBER}\s+dBFS`).exec(tail);
  if (!peak) return null;
  const truePeakDb = Number.parseFloat(peak[1] ?? "");
  if (!Number.isFinite(truePeakDb)) return null;
  const integrated = new RegExp(String.raw`\bI:\s+${NUMBER}\s+LUFS`).exec(tail);
  const lufs = Number.parseFloat(integrated?.[1] ?? "");
  return { integratedLufs: Number.isFinite(lufs) ? lufs : null, truePeakDb };
}

/**
 * Where the sound begins, from the per-window RMS levels `ametadata` prints to stdout. 0 for a file
 * that never rises out of digital silence.
 */
export function parseLeadIn(stdout: string): number {
  const windows: { at: number; level: number }[] = [];
  let at: number | null = null;
  for (const line of stdout.split("\n")) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) {
      at = Number.parseFloat(time[1] ?? "");
      continue;
    }
    const level = /RMS_level=(.+)$/.exec(line);
    if (level && at !== null) {
      const value = Number.parseFloat(level[1] ?? "");
      if (Number.isFinite(value)) windows.push({ at, level: value });
      at = null;
    }
  }
  if (windows.length === 0) return 0;
  const loudest = Math.max(...windows.map((w) => w.level));
  return windows.find((w) => w.level >= loudest - LEAD_IN_FLOOR_DB)?.at ?? 0;
}

/**
 * Measure one file with a decode pass (`-f null`): the ebur128 summary on stderr, the lead-in's
 * per-window levels on stdout. Null on any failure — a file with no audio stream, an unreadable one,
 * a missing ffmpeg — which callers read as "unmeasured".
 */
export async function measureAudioLoudness(absPath: string): Promise<AudioLoudness | null> {
  try {
    const ffmpeg = await ffmpegBin();
    const windows =
      `aformat=channel_layouts=mono,aresample=${LEAD_IN_RATE},` +
      `asetnsamples=n=${LEAD_IN_WINDOW}:p=0,` +
      "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level," +
      "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-";
    const { stdout, stderr } = await execFileAsync(ffmpeg, [
      "-nostats",
      "-hide_banner",
      "-i",
      absPath,
      "-filter_complex",
      `asplit[a][b];[a]ebur128=peak=true[loudness];[b]${windows}[windows]`,
      "-map",
      "[loudness]",
      "-f",
      "null",
      "-",
      "-map",
      "[windows]",
      "-f",
      "null",
      "-",
    ]);
    const loudness = parseEbur128Summary(stderr);
    return loudness ? { ...loudness, leadInSec: parseLeadIn(stdout) } : null;
  } catch {
    return null;
  }
}
