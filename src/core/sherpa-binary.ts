import * as fs from "node:fs";
import * as path from "node:path";
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";

// Pinned sherpa-onnx release; the version names its tool-cache dir.
const SHERPA_VERSION = "1.13.8";
const SEPARATOR = "sherpa-onnx-offline-source-separation";

// spleeter's two-stem model (vocals / accompaniment), half precision.
export const SPLEETER_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2";
const SPLEETER_FILES = ["vocals.fp16.onnx", "accompaniment.fp16.onnx"];

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

function separatorName(): string {
  return process.platform === "win32" ? `${SEPARATOR}.exe` : SEPARATOR;
}

let separatorPath: string | null = null;
let modelDir: string | null = null;
const provisioning = new Map<string, Promise<void>>();

// Provision one tool-cache dir under its lock, once per process.
async function provisionOnce(
  dir: string,
  pin: string,
  files: string[],
  fill: () => Promise<void>,
): Promise<void> {
  if (toolCacheReady(dir, pin, files)) return;
  let running = provisioning.get(dir);
  if (!running) {
    running = withToolCacheLock(dir, async () => {
      if (toolCacheReady(dir, pin, files)) return;
      resetToolCacheDir(dir);
      await fill();
      await markToolCacheReady(dir, pin);
    }).catch((err) => {
      provisioning.delete(dir);
      if (err instanceof KonteError) throw err;
      throw new KonteError("SHERPA_SETUP_FAILED", `sherpa-onnx setup failed: ${errorMessage(err)}`);
    });
    provisioning.set(dir, running);
  }
  await running;
}

// A `.tar.bz2` into `dest`, its one top-level directory flattened away.
async function unpackInto(url: string, dest: string, label: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(dest, ".dl-"));
  try {
    const archive = path.join(tmp, "archive.tar.bz2");
    await downloadFile(url, archive, progressReporter(label));
    endProgress();
    const out = path.join(tmp, "out");
    fs.mkdirSync(out);
    await execFileAsync("tar", ["xjf", archive, "-C", out]);
    const [top] = fs.readdirSync(out);
    const root = top ? path.join(out, top) : out;
    for (const entry of fs.readdirSync(root)) {
      fs.renameSync(path.join(root, entry), path.join(dest, entry));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Absolute path to sherpa-onnx's source separator, provisioning the managed build on first use. */
export async function sherpaSeparationBin(): Promise<string> {
  if (separatorPath) return separatorPath;
  const override = process.env.KONTE_SHERPA_SEPARATION_PATH;
  if (override) {
    separatorPath = override;
    return override;
  }
  const url = sherpaDownloadUrl(process.platform, process.arch);
  const dir = toolCacheDir(`sherpa-onnx-${SHERPA_VERSION}`);
  const bin = path.join("bin", separatorName());
  await provisionOnce(dir, toolPin([url]), [bin], async () => {
    console.error(`konte: provisioning sherpa-onnx ${SHERPA_VERSION} → ${dir}`);
    await unpackInto(url, dir, "sherpa-onnx");
    if (process.platform !== "win32") fs.chmodSync(path.join(dir, bin), 0o755);
  });
  separatorPath = path.join(dir, bin);
  return separatorPath;
}

/**
 * The directory holding spleeter's two stems (`vocals.fp16.onnx`, `accompaniment.fp16.onnx`),
 * downloading them on first use; `KONTE_SPLEETER_MODEL_DIR` names one instead.
 */
export async function spleeterModelDir(): Promise<string> {
  if (modelDir) return modelDir;
  const override = process.env.KONTE_SPLEETER_MODEL_DIR;
  if (override) {
    modelDir = override;
    return override;
  }
  const dir = toolCacheDir("spleeter-2stems-fp16");
  await provisionOnce(dir, toolPin([SPLEETER_URL]), SPLEETER_FILES, async () => {
    console.error(`konte: provisioning the spleeter 2-stem model → ${dir}`);
    await unpackInto(SPLEETER_URL, dir, "spleeter");
  });
  modelDir = dir;
  return dir;
}

/**
 * Separate the voice of a 44.1 kHz stereo WAV into `vocalsWav`. spleeter reads 44.1 kHz; the caller
 * converts.
 */
export async function separateVocals(inputWav: string, vocalsWav: string): Promise<void> {
  const [bin, model] = await Promise.all([sherpaSeparationBin(), spleeterModelDir()]);
  const accompaniment = `${vocalsWav}.accompaniment.wav`;
  try {
    await execFileAsync(bin, [
      `--spleeter-vocals=${path.join(model, "vocals.fp16.onnx")}`,
      `--spleeter-accompaniment=${path.join(model, "accompaniment.fp16.onnx")}`,
      `--input-wav=${inputWav}`,
      `--output-vocals-wav=${vocalsWav}`,
      `--output-accompaniment-wav=${accompaniment}`,
    ]);
  } finally {
    fs.rmSync(accompaniment, { force: true });
  }
}

export { SHERPA_VERSION };
