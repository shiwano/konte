import * as fs from "node:fs";
import * as path from "node:path";
import { KonteError } from "./errors.js";
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

// Parakeet TDT v3, int8: speech recognition in 25 European languages, with a time on every token.
// It names no language and is told none.
export const PARAKEET_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";

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

export function sherpaSeparatorBin(): Promise<string> {
  return sherpaBin(SEPARATOR, process.env.KONTE_SHERPA_SEPARATION_PATH);
}

export function sherpaRecognizerBin(): Promise<string> {
  return sherpaBin(RECOGNIZER, process.env.KONTE_SHERPA_RECOGNIZER_PATH);
}

const modelDirs = new Map<ModelKey, string>();

/**
 * The absolute path of each file of model `key`, downloading the model on first use; its
 * `override` env var names a directory to read them from instead.
 */
export async function modelFiles<K extends ModelKey>(key: K): Promise<ModelFiles<K>> {
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
