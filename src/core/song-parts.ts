import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./content-hash.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { separateSong } from "./sherpa-binary.js";

export type SongPart = "vocals" | "instrumental";

export type SongParts = Record<SongPart, string>;

// A take of the song separated into its voice and the rest, each a WAV on the take's own clock.
// Kept under the video's cache by the take's output hash, so each take is separated once.
export async function songParts(
  videoRoot: string,
  take: { file: string; outputHash: string | null | undefined },
): Promise<SongParts> {
  const hash = take.outputHash ?? sha256Hex(fs.readFileSync(take.file));
  const dir = path.join(videoRoot, ".konte", "cache", "song-parts", hash);
  const parts: SongParts = {
    vocals: path.join(dir, "vocals.wav"),
    instrumental: path.join(dir, "instrumental.wav"),
  };
  if (fs.existsSync(dir)) return parts;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}-`);
  try {
    const stereo = path.join(staging, "song.wav");
    await execFileAsync(await ffmpegBin(), [
      "-v",
      "quiet",
      "-y",
      "-i",
      take.file,
      "-map",
      "0:a:0",
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s16le",
      stereo,
    ]);
    await separateSong(stereo, {
      vocalsWav: path.join(staging, "vocals.wav"),
      instrumentalWav: path.join(staging, "instrumental.wav"),
    });
    fs.rmSync(stereo);
    try {
      fs.renameSync(staging, dir);
    } catch (err) {
      // Another run separated the same take meanwhile.
      if (!fs.existsSync(dir)) throw err;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return parts;
}
