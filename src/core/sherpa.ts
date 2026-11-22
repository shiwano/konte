import { KonteError } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { modelFiles, sherpaRecognizerBin, sherpaSeparatorBin } from "./sherpa-binary.js";

const SENSE_VOICE_LANGS = new Set(["zh", "en", "ja", "ko", "yue"]);
const PARAKEET_LANGS = new Set([
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "es",
  "et",
  "fi",
  "fr",
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "uk",
]);

/**
 * Separate a 44.1 kHz stereo WAV into its voice (`vocalsWav`) and the rest (`instrumentalWav`).
 * spleeter reads 44.1 kHz; the caller converts.
 */
export async function separateSong(
  inputWav: string,
  out: { vocalsWav: string; instrumentalWav: string },
): Promise<void> {
  const [bin, model] = await Promise.all([sherpaSeparatorBin(), modelFiles("spleeter")]);
  await execFileAsync(bin, [
    `--spleeter-vocals=${model.vocals}`,
    `--spleeter-accompaniment=${model.accompaniment}`,
    `--input-wav=${inputWav}`,
    `--output-vocals-wav=${out.vocalsWav}`,
    `--output-accompaniment-wav=${out.instrumentalWav}`,
  ]);
}

// What one 16 kHz mono WAV is heard to say: each token and the second it starts at in that WAV, and
// the language the recognizer heard it in (`ja`, `en`, …; null where it names none).
export type HeardTokens = { tokens: string[]; timestamps: number[]; lang: string | null };

type Recognizer = "sense-voice" | "parakeet";

function recognizerOf(lang: string): Recognizer | null {
  const primary = lang.split("-")[0]!.toLowerCase();
  if (SENSE_VOICE_LANGS.has(primary)) return "sense-voice";
  if (PARAKEET_LANGS.has(primary)) return "parakeet";
  return null;
}

/** Whether speech in `lang` (a BCP 47 tag) is recognized. */
export function recognizesSpeechIn(lang: string): boolean {
  return recognizerOf(lang) !== null;
}

async function recognizerArgs(recognizer: Recognizer, lang: string | null): Promise<string[]> {
  if (recognizer === "parakeet") {
    const model = await modelFiles("parakeet");
    return [
      `--encoder=${model.encoder}`,
      `--decoder=${model.decoder}`,
      `--joiner=${model.joiner}`,
      `--tokens=${model.tokens}`,
      "--model-type=nemo_transducer",
    ];
  }
  const model = await modelFiles("senseVoice");
  return [
    `--sense-voice-model=${model.model}`,
    `--tokens=${model.tokens}`,
    `--sense-voice-language=${lang === null ? "auto" : lang.split("-")[0]!.toLowerCase()}`,
  ];
}

/**
 * Recognize speech in each 16 kHz mono WAV, in order. `lang` is the BCP 47 tag of what is said, one
 * `recognizesSpeechIn` accepts, or null to have SenseVoice tell the language itself among its own.
 */
export async function recognizeSpeech(
  wavs: readonly string[],
  lang: string | null,
): Promise<HeardTokens[]> {
  const recognizer = lang === null ? "sense-voice" : recognizerOf(lang);
  if (!recognizer) {
    throw new KonteError("VALIDATION_FAILED", `Speech in "${lang}" is not recognized.`);
  }
  if (wavs.length === 0) return [];
  const [bin, args] = await Promise.all([sherpaRecognizerBin(), recognizerArgs(recognizer, lang)]);
  const { stdout } = await execFileAsync(bin, [...args, "--num-threads=4", ...wavs]);
  const results = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Partial<HeardTokens>)
    .map((r) => ({
      tokens: r.tokens ?? [],
      timestamps: r.timestamps ?? [],
      lang: /^<\|([a-z]+)\|>$/.exec(r.lang ?? "")?.[1] ?? null,
    }));
  if (results.length !== wavs.length) {
    throw new KonteError(
      "SHERPA_SETUP_FAILED",
      `sherpa-onnx heard ${results.length} of ${wavs.length} audio file(s).`,
    );
  }
  return results;
}
