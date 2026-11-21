import * as fs from "node:fs";
import * as path from "node:path";
import { KonteError } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { exeName, provisionOnce, toolCacheDir, unpackTarballInto } from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";

// Pinned sherpa-onnx release; the version names its tool-cache dir.
const SHERPA_VERSION = "1.13.8";
const SEPARATOR = "sherpa-onnx-offline-source-separation";
const RECOGNIZER = "sherpa-onnx-offline";

// spleeter's two-stem model (vocals / accompaniment), half precision.
export const SPLEETER_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2";

// SenseVoice, int8: speech recognition in zh, en, ja, ko and yue, with a time on every token.
export const SENSE_VOICE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
const SENSE_VOICE_LANGS = new Set(["zh", "en", "ja", "ko", "yue"]);

// Parakeet TDT v3, int8: speech recognition in 25 European languages, with a time on every token.
// It names no language and is told none.
export const PARAKEET_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";
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

const MODELS = {
  spleeter: {
    url: SPLEETER_URL,
    cacheName: "spleeter-2stems-fp16",
    label: "spleeter 2-stem model",
    progressLabel: "spleeter",
    override: "KONTE_SPLEETER_MODEL_DIR",
    files: { vocals: "vocals.fp16.onnx", accompaniment: "accompaniment.fp16.onnx" },
  },
  senseVoice: {
    url: SENSE_VOICE_URL,
    cacheName: "sense-voice-int8-2024-07-17",
    label: "SenseVoice model",
    progressLabel: "sense-voice",
    override: "KONTE_SENSE_VOICE_MODEL_DIR",
    files: { model: "model.int8.onnx", tokens: "tokens.txt" },
  },
  parakeet: {
    url: PARAKEET_URL,
    cacheName: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet model",
    progressLabel: "parakeet",
    override: "KONTE_PARAKEET_MODEL_DIR",
    files: {
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
    },
  },
} as const;

type ModelKey = keyof typeof MODELS;
type ModelFiles<K extends ModelKey> = Record<keyof (typeof MODELS)[K]["files"], string>;

/** Where each platform/arch fetches its version-pinned sherpa-onnx build. Pure (for testing). */
export function sherpaDownloadUrl(platform: NodeJS.Platform, arch: string): string {
  const base = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/sherpa-onnx-v${SHERPA_VERSION}`;
  if (platform === "linux" && arch === "x64") return `${base}-linux-x64-shared-no-tts.tar.bz2`;
  if (platform === "linux" && arch === "arm64") return `${base}-linux-aarch64-shared-cpu.tar.bz2`;
  if (platform === "darwin" && arch === "arm64") return `${base}-osx-arm64-shared-no-tts.tar.bz2`;
  if (platform === "darwin" && arch === "x64") return `${base}-osx-x64-shared-no-tts.tar.bz2`;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return `${base}-win-${arch}-shared-MD-Release-no-tts.tar.bz2`;
  }
  throw new KonteError(
    "SHERPA_SETUP_FAILED",
    `No managed sherpa-onnx build for ${platform}-${arch}. Install sherpa-onnx and set ` +
      `KONTE_SHERPA_SEPARATION_PATH to its ${SEPARATOR}.`,
  );
}

let sherpaDir: string | null = null;
// The managed sherpa-onnx build, provisioned on first use.
async function managedSherpaDir(): Promise<string> {
  if (sherpaDir) return sherpaDir;
  const url = sherpaDownloadUrl(process.platform, process.arch);
  const dir = toolCacheDir(`sherpa-onnx-${SHERPA_VERSION}`);
  const bins = [SEPARATOR, RECOGNIZER].map((name) => path.join("bin", exeName(name)));
  await provisionOnce({
    dir,
    pin: toolPin([url]),
    files: bins,
    label: `sherpa-onnx ${SHERPA_VERSION}`,
    errorCode: "SHERPA_SETUP_FAILED",
    fill: async () => {
      await unpackTarballInto(url, dir, "sherpa-onnx");
      if (process.platform !== "win32") {
        for (const bin of bins) fs.chmodSync(path.join(dir, bin), 0o755);
      }
    },
  });
  sherpaDir = dir;
  return dir;
}

/** Provisions the managed sherpa-onnx build unless an override names each of its tools. */
export async function ensureSherpa(): Promise<void> {
  if (process.env.KONTE_SHERPA_SEPARATION_PATH && process.env.KONTE_SHERPA_RECOGNIZER_PATH) return;
  await managedSherpaDir();
}

// One sherpa-onnx tool: the path `override` names, else the managed build's.
async function sherpaBin(name: string, override: string | undefined): Promise<string> {
  if (override) return override;
  return path.join(await managedSherpaDir(), "bin", exeName(name));
}

const modelDirs = new Map<ModelKey, string>();

/**
 * The absolute path of each file of model `key`, downloading the model on first use; its
 * `override` env var names a directory to read them from instead.
 */
async function modelFiles<K extends ModelKey>(key: K): Promise<ModelFiles<K>> {
  const model = MODELS[key];
  const dir = modelDirs.get(key) ?? (process.env[model.override] || (await provisionModel(key)));
  modelDirs.set(key, dir);
  return Object.fromEntries(
    Object.entries(model.files).map(([name, file]) => [name, path.join(dir, file)]),
  ) as ModelFiles<K>;
}

async function provisionModel(key: ModelKey): Promise<string> {
  const model = MODELS[key];
  const dir = toolCacheDir(model.cacheName);
  await provisionOnce({
    dir,
    pin: toolPin([model.url]),
    files: Object.values(model.files),
    label: model.label,
    errorCode: "SHERPA_SETUP_FAILED",
    fill: () => unpackTarballInto(model.url, dir, model.progressLabel),
  });
  return dir;
}

/**
 * Separate a 44.1 kHz stereo WAV into its voice (`vocalsWav`) and the rest (`instrumentalWav`).
 * spleeter reads 44.1 kHz; the caller converts.
 */
export async function separateSong(
  inputWav: string,
  out: { vocalsWav: string; instrumentalWav: string },
): Promise<void> {
  const [bin, model] = await Promise.all([
    sherpaBin(SEPARATOR, process.env.KONTE_SHERPA_SEPARATION_PATH),
    modelFiles("spleeter"),
  ]);
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
  const [bin, args] = await Promise.all([
    sherpaBin(RECOGNIZER, process.env.KONTE_SHERPA_RECOGNIZER_PATH),
    recognizerArgs(recognizer, lang),
  ]);
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
