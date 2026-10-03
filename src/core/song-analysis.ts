import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { type HeardTokens, recognizeSpeech } from "./sherpa-binary.js";
import { ANALYSIS_RATE, readSongBeat, readSungPhrases } from "./song-beat.js";
import { songParts } from "./song-parts.js";
import type { SongReading } from "./types/index.js";

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

// The recognizer is trained on utterances, not songs: the vocal track is heard in windows of
// `HEARING_WINDOW_SEC`, each starting `HEARING_STEP_SEC` after the last, and a token heard twice is
// kept from the window it falls nearer the middle of.
const HEARING_WINDOW_SEC = 20;
const HEARING_STEP_SEC = 15;

export function hearingWindows(durationSec: number): number[] {
  const starts = [0];
  while (starts.at(-1)! + HEARING_WINDOW_SEC < durationSec) {
    starts.push(starts.at(-1)! + HEARING_STEP_SEC);
  }
  return starts;
}

// Each window's tokens on the take's clock, the overlap of two windows split down its middle.
export function joinHeardWindows(
  windows: readonly { startSec: number; heard: HeardTokens }[],
): NonNullable<SongReading["heard"]> {
  const edge = (HEARING_WINDOW_SEC - HEARING_STEP_SEC) / 2;
  return windows.flatMap(({ startSec, heard }, i) => {
    const from = i === 0 ? -Infinity : edge;
    const to = i === windows.length - 1 ? Infinity : HEARING_WINDOW_SEC - edge;
    return heard.tokens.flatMap((text, k) => {
      const at = heard.timestamps[k];
      return at !== undefined && at >= from && at < to
        ? [{ text, startSec: Math.round((startSec + at) * 1000) / 1000 }]
        : [];
    });
  });
}

async function hearVocals(
  vocals: string,
  durationSec: number,
  lang: string,
  workDir: string,
): Promise<NonNullable<SongReading["heard"]>> {
  const starts = hearingWindows(durationSec);
  const wavs = await Promise.all(
    starts.map(async (startSec, i) => {
      const wav = path.join(workDir, `heard-${i}.wav`);
      await execFileAsync(await ffmpegBin(), [
        "-v",
        "quiet",
        "-y",
        "-ss",
        String(startSec),
        "-t",
        String(HEARING_WINDOW_SEC),
        "-i",
        vocals,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav,
      ]);
      return wav;
    }),
  );
  const heard = await recognizeSpeech(wavs, lang);
  return joinHeardWindows(starts.map((startSec, i) => ({ startSec, heard: heard[i]! })));
}

/**
 * Read one take of the song: its clock off the mix, and where it is sung and what it is heard to
 * sing off the vocal track sherpa-onnx separates from it. A separation that fails leaves `phrases`
 * and `heard` null, a recognition that fails `heard` alone, and says why in `log`; the clock still
 * stands.
 */
export async function analyzeSongTake(opts: {
  file: string;
  outputHash: string | null | undefined;
  videoRoot: string;
  bpm: number;
  beatsPerBar: number;
  // The language the lyrics are sung in.
  lang: string;
  // A scratch directory under the video, removed when the analysis ends.
  workDir: string;
  log: (line: string) => void;
}): Promise<SongReading> {
  const beat = readSongBeat(await decodeMono(opts.file), {
    bpm: opts.bpm,
    beatsPerBar: opts.beatsPerBar,
  });
  opts.log(
    `Clock: ${beat.bpm} BPM, first bar head at ${beat.downbeatSec}s, ` +
      `${beat.sectionSecs.length} section boundary candidate(s)`,
  );

  let phrases: SongReading["phrases"] = null;
  let heard: SongReading["heard"] = null;
  fs.mkdirSync(opts.workDir, { recursive: true });
  try {
    const { vocals } = await songParts(opts.videoRoot, {
      file: opts.file,
      outputHash: opts.outputHash,
    });
    const voice = await decodeMono(vocals);
    phrases = readSungPhrases(voice);
    opts.log(`Singing: ${phrases.length} sung stretch(es)`);
    try {
      heard = await hearVocals(vocals, voice.length / ANALYSIS_RATE, opts.lang, opts.workDir);
      opts.log(`Heard: ${heard.length} token(s)`);
    } catch (err) {
      opts.log(
        `Warning: the vocal track could not be recognized, so no line is placed: ${errorMessage(err)}`,
      );
    }
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
    heard,
    analyzedAt: new Date().toISOString(),
  };
}
