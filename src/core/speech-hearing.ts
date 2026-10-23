import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { definitionForAddress, type StageDefinitions } from "./definition-hashes.js";
import { lineMishearing } from "./line-hearing.js";
import { spokenLinesAt } from "./prompt-check.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { type HeardTokens, recognizeSpeech } from "./sherpa-binary.js";
import { type HeardSpeech, HeardSpeechSchema } from "./types/index.js";
import { variantDir } from "./variant-dir.js";

const HEARD_SPEECH_FILE = "heard.json";

// The recognizer is trained on utterances, not songs: a take is heard in windows of
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
  windows: readonly { startSec: number; heard: Pick<HeardTokens, "tokens" | "timestamps"> }[],
): HeardSpeech["heard"] {
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

/**
 * What the first audio stream of `file` (an audio or a video file) is heard to say, token by token
 * on the file's clock. `lang` is the BCP 47 tag of what is said; `workDir` holds the windows.
 */
export async function hearSpeech(
  file: string,
  durationSec: number,
  lang: string,
  workDir: string,
): Promise<HeardSpeech["heard"]> {
  const { starts, heard } = await hearWindows(file, durationSec, lang, workDir);
  return joinHeardWindows(starts.map((startSec, i) => ({ startSec, heard: heard[i]! })));
}

/**
 * What `file` is heard to say window by window, each in the language SenseVoice hears it in (`lang`
 * null), or in `lang`.
 */
export async function hearWindows(
  file: string,
  durationSec: number,
  lang: string | null,
  workDir: string,
): Promise<{ starts: number[]; heard: HeardTokens[] }> {
  const starts = hearingWindows(durationSec);
  mkdirSync(workDir, { recursive: true });
  const wavs = await mapConcurrent(starts, FFMPEG_CONCURRENCY, async (startSec, i) => {
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
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    return wav;
  });
  return { starts, heard: await recognizeSpeech(wavs, lang) };
}

function heardSpeechPath(videoRoot: string, address: string, variantId: string): string {
  return path.join(variantDir(videoRoot, address, variantId), HEARD_SPEECH_FILE);
}

export async function writeHeardSpeech(
  videoRoot: string,
  address: string,
  variantId: string,
  speech: HeardSpeech,
): Promise<void> {
  await writeFileAtomic(
    heardSpeechPath(videoRoot, address, variantId),
    `${JSON.stringify(speech, null, 2)}\n`,
  );
}

// What the take is heard to say, null where it was never heard or was heard off other bytes.
export function readHeardSpeech(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string | null | undefined,
): HeardSpeech["heard"] | null {
  if (!outputHash) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(heardSpeechPath(videoRoot, address, variantId), "utf-8"));
  } catch {
    return null;
  }
  const parsed = HeardSpeechSchema.safeParse(raw);
  if (!parsed.success || parsed.data.outputHash !== outputHash) return null;
  return parsed.data.heard;
}

export function heardText(heard: HeardSpeech["heard"]): string {
  return heard
    .map((t) => t.text)
    .join("")
    .trim();
}

// The lines a take at `address` owes, read off the stage that defines it.
export function linesOwedAt(definitions: StageDefinitions, address: string): string[] {
  const def = definitionForAddress(definitions, address);
  return def ? spokenLinesAt(def.prompts ?? [], address) : [];
}

// What a take gets wrong of the `lines` it owes, written in `lang`, as `heard "…" — <what>`, or null
// where it says them or was never heard.
export function takeMishearing(
  videoRoot: string,
  address: string,
  variantId: string,
  outputHash: string | null | undefined,
  lines: readonly string[],
  lang: string,
): string | null {
  if (lines.length === 0) return null;
  const heard = readHeardSpeech(videoRoot, address, variantId, outputHash);
  if (!heard) return null;
  const words = heardText(heard);
  const wrong = lineMishearing(lines.join(" "), words, lang);
  return wrong ? `heard "${words}" — ${wrong}` : null;
}
