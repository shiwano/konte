import { statSync } from "node:fs";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin, ffprobeBin } from "./ffmpeg-binary.js";

/** Runs ffmpeg, rejecting with `FFMPEG_ERROR` as `<what>: <cause>`. */
export async function runFfmpeg(
  args: readonly string[],
  what: string,
): Promise<{ stdout: string; stderr: string }>;
export async function runFfmpeg(
  args: readonly string[],
  what: string,
  options: { encoding: "buffer" },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function runFfmpeg(
  args: readonly string[],
  what: string,
  options: { encoding?: "buffer" } = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const ffmpeg = await ffmpegBin();
  try {
    return options.encoding === "buffer"
      ? await execFileAsync(ffmpeg, args, { encoding: "buffer" })
      : await execFileAsync(ffmpeg, args);
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
