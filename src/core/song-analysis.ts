import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { separateVocals } from "./sherpa-binary.js";
import { ANALYSIS_RATE, readSongBeat, readSungPhrases } from "./song-beat.js";
import type { SongAnalysis } from "./types/index.js";

async function decodeMono(file: string): Promise<Float32Array> {
  const { stdout } = await execFileAsync(
    await ffmpegBin(),
    [
      "-v",
      "quiet",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(ANALYSIS_RATE),
      "-f",
      "f32le",
      "-",
    ],
    { encoding: "buffer" },
  );
  const copy = new Uint8Array(stdout.byteLength - (stdout.byteLength % 4));
  copy.set(stdout.subarray(0, copy.byteLength));
  return new Float32Array(copy.buffer);
}

/**
 * Read one take of the song: its clock off the mix, and where it is sung off the vocal track
 * sherpa-onnx separates from it. A separation that fails leaves `phrases` null and says why in
 * `log`; the clock still stands.
 */
export async function analyzeSongTake(opts: {
  file: string;
  bpm: number;
  beatsPerBar: number;
  // A scratch directory under the video, removed when the analysis ends.
  workDir: string;
  log: (line: string) => void;
}): Promise<SongAnalysis> {
  const beat = readSongBeat(await decodeMono(opts.file), {
    bpm: opts.bpm,
    beatsPerBar: opts.beatsPerBar,
  });
  opts.log(
    `Clock: ${beat.bpm} BPM, first bar head at ${beat.downbeatSec}s, ` +
      `${beat.sectionSecs.length} section boundary candidate(s)`,
  );

  let phrases: SongAnalysis["phrases"] = null;
  fs.mkdirSync(opts.workDir, { recursive: true });
  try {
    const stereo = path.join(opts.workDir, "song.wav");
    const vocals = path.join(opts.workDir, "vocals.wav");
    await execFileAsync(await ffmpegBin(), [
      "-v",
      "quiet",
      "-y",
      "-i",
      opts.file,
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
    await separateVocals(stereo, vocals);
    phrases = readSungPhrases(await decodeMono(vocals));
    opts.log(`Singing: ${phrases.length} sung stretch(es)`);
  } catch (err) {
    opts.log(
      `Warning: the vocal track could not be separated, so no line is placed: ${errorMessage(err)}`,
    );
  } finally {
    fs.rmSync(opts.workDir, { recursive: true, force: true });
  }

  return {
    bpm: beat.bpm,
    downbeatSec: beat.downbeatSec,
    sectionSecs: beat.sectionSecs,
    phrases,
    analyzedAt: new Date().toISOString(),
  };
}
