import { statSync } from "node:fs";
import * as path from "node:path";
import { writeAtomically } from "./atomic-write.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import {
  ffmpegBin,
  ffprobeBin,
  SINGLE_FRAME_INPUT_ARGS,
  SINGLE_FRAME_OUTPUT_ARGS,
} from "./ffmpeg-binary.js";

/** Runs ffmpeg, rejecting with `FFMPEG_ERROR` as `<what>: <cause>`. */
export async function runFfmpeg(
  args: readonly string[],
  what: string,
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }>;
export async function runFfmpeg(
  args: readonly string[],
  what: string,
  options: { cwd?: string; encoding: "buffer" },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function runFfmpeg(
  args: readonly string[],
  what: string,
  options: { cwd?: string; encoding?: "buffer" } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const ffmpeg = await ffmpegBin();
  try {
    return options.encoding === "buffer"
      ? await execFileAsync(ffmpeg, args, { cwd: options.cwd, encoding: "buffer" })
      : await execFileAsync(ffmpeg, args, { cwd: options.cwd });
  } catch (err) {
    throw new KonteError("FFMPEG_ERROR", `${what}: ${errorMessage(err)}`);
  }
}

/** Runs a quiet ffprobe writing JSON and parses it, rejecting with `FFPROBE_ERROR`. */
export async function runFfprobeJson<T>(args: readonly string[]): Promise<T> {
  const ffprobe = await ffprobeBin();
  try {
    const { stdout } = await execFileAsync(ffprobe, ["-v", "quiet", "-of", "json", ...args]);
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new KonteError("FFPROBE_ERROR", `ffprobe failed: ${errorMessage(err)}`);
  }
}

/** Whether a path holds a finished file — ffmpeg can exit 0 having written nothing. */
export function hasBytes(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

/**
 * Encodes one frame of `input` to `output` through a temp moved into place, rejecting with
 * `FFMPEG_ERROR` as `<what>: <cause>` when ffmpeg fails or writes nothing.
 */
export async function writeFrame(options: {
  input: string;
  /** Input options ahead of `-i`: a format, a frame rate. */
  inputArgs?: readonly string[];
  seek?: number;
  filters?: string;
  /** `-q:v`; omitted, the encoder's default. */
  quality?: number;
  output: string;
  what: string;
  cwd?: string;
}): Promise<void> {
  const { input, inputArgs = [], seek, filters, quality, output, what, cwd } = options;
  await writeAtomically(path.resolve(output), async (tmp) => {
    await runFfmpeg(
      [
        "-y",
        ...SINGLE_FRAME_INPUT_ARGS,
        ...inputArgs,
        ...(seek == null ? [] : ["-ss", String(seek)]),
        "-i",
        input,
        ...SINGLE_FRAME_OUTPUT_ARGS,
        ...(filters == null ? [] : ["-vf", filters]),
        "-frames:v",
        "1",
        ...(quality == null ? [] : ["-q:v", String(quality)]),
        tmp,
      ],
      what,
      { cwd },
    );
    if (!hasBytes(tmp)) throw new KonteError("FFMPEG_ERROR", `${what}: ffmpeg wrote no frame`);
  });
}

/** Tiles `pattern` (`frame-%03d.jpg`, numbered from 1) in `dir` into one `columns`×`rows` sheet. */
export async function tileFrames(options: {
  dir: string;
  pattern: string;
  columns: number;
  rows: number;
  padding: number;
  margin: number;
  color: string;
  output: string;
  what: string;
}): Promise<void> {
  const { dir, pattern, columns, rows, padding, margin, color, output, what } = options;
  await writeFrame({
    input: pattern,
    inputArgs: ["-framerate", "1", "-start_number", "1"],
    filters: `tile=${columns}x${rows}:padding=${padding}:margin=${margin}:color=${color}`,
    quality: 3,
    output,
    what,
    cwd: dir,
  });
}

let drawTextSupport: Promise<boolean> | undefined;

/**
 * Whether this ffmpeg can burn text in — the filter being compiled in says nothing about a usable
 * font being installed, so it draws on a synthetic frame. Settled once per process, before any
 * labelled frame is rendered: a label is then all-or-nothing across a sheet, and a labelled frame
 * that fails is the source's fault, not the font's.
 */
export function ffmpegCanDrawText(): Promise<boolean> {
  drawTextSupport ??= runFfmpeg(
    [
      "-hide_banner",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64",
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-vf",
      "drawtext=text=probe:fontsize=12:fontcolor=white",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    "ffmpeg drawtext probe failed",
  ).then(
    () => true,
    () => false,
  );
  return drawTextSupport;
}
