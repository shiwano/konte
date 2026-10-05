import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ort from "onnxruntime-web";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with { type: "file" };
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" };
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import { KonteError, errorMessage } from "./errors.js";
import { execFileAsync } from "./exec-file.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import {
  markToolCacheReady,
  resetToolCacheDir,
  toolCacheDir,
  toolCacheReady,
  withToolCacheLock,
} from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";

// Beat This! (CPJKU, ISMIR 2024), its `final0` checkpoint exported to ONNX, run on onnxruntime-web's
// WASM build. Pre- and post-processing mirror upstream `b95c8ab`: `preprocessing.py`
// (`LogMelSpect`), `inference.py` (`split_piece`, `aggregate_prediction`) and
// `model/postprocessor.py` (`minimal`).

const RELEASE = "https://github.com/shiwano/beat-this-onnx/releases/download/final0";
const MODEL_FILE = "beat-this-final0.onnx";
const FRONTEND_FILE = "frontend.json";
export const BEAT_THIS_URLS = [`${RELEASE}/${MODEL_FILE}`, `${RELEASE}/${FRONTEND_FILE}`];

const SAMPLE_RATE = 22050;
const FPS = 50;
const CHUNK = 1500;
const BORDER = 6;
const MAX_THREADS = 8;

export type BeatThisReading = { beats: number[]; downbeats: number[]; durationSec: number };

// The log-mel frontend `frontend.json` carries: torchaudio's own Hann window and slaney mel filters.
export type BeatThisFrontend = {
  sample_rate: number;
  n_fft: number;
  hop_length: number;
  n_mels: number;
  window: number[];
  mel_filters: number[][];
};

let modelDir: string | null = null;
let provisioning: Promise<void> | null = null;

/**
 * The directory holding `beat-this-final0.onnx` and `frontend.json`, downloading them on first use;
 * `KONTE_BEAT_THIS_MODEL_DIR` names one instead.
 */
export async function beatThisModelDir(): Promise<string> {
  if (modelDir) return modelDir;
  const override = process.env.KONTE_BEAT_THIS_MODEL_DIR;
  if (override) {
    modelDir = override;
    return override;
  }
  const dir = toolCacheDir("beat-this-final0");
  const pin = toolPin(BEAT_THIS_URLS);
  const files = [MODEL_FILE, FRONTEND_FILE];
  if (!toolCacheReady(dir, pin, files)) {
    provisioning ??= withToolCacheLock(dir, async () => {
      if (toolCacheReady(dir, pin, files)) return;
      resetToolCacheDir(dir);
      console.error(`konte: provisioning the Beat This! model → ${dir}`);
      for (const url of BEAT_THIS_URLS) {
        await downloadFile(url, path.join(dir, path.basename(url)), progressReporter("beat-this"));
        endProgress();
      }
      await markToolCacheReady(dir, pin);
    }).catch((err) => {
      provisioning = null;
      if (err instanceof KonteError) throw err;
      throw new KonteError(
        "BEAT_THIS_SETUP_FAILED",
        `Beat This! model setup failed: ${errorMessage(err)}`,
      );
    });
    await provisioning;
  }
  modelDir = dir;
  return dir;
}

type BeatThisModel = { session: ort.InferenceSession; frontend: BeatThisFrontend };

let model: Promise<BeatThisModel> | null = null;

function loadModel(): Promise<BeatThisModel> {
  model ??= (async () => {
    const dir = await beatThisModelDir();
    const frontend = JSON.parse(
      fs.readFileSync(path.join(dir, FRONTEND_FILE), "utf-8"),
    ) as BeatThisFrontend;
    ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
    ort.env.wasm.numThreads = Math.min(os.availableParallelism(), MAX_THREADS);
    const session = await ort.InferenceSession.create(path.join(dir, MODEL_FILE));
    return { session, frontend };
  })().catch((err) => {
    model = null;
    throw err;
  });
  return model;
}

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
      String(SAMPLE_RATE),
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

// ── Log-mel ──────────────────────────────────────────────────────────────────────────────────────

/**
 * torchaudio's `MelSpectrogram(center=True, pad_mode="reflect", power=1, normalized="frame_length")`
 * then `log1p(1000·x)`: `[frames × n_mels]`, row-major. `frame_length` scales the STFT by
 * 1/√n_fft.
 */
export function logMelSpectrogram(samples: Float32Array, fe: BeatThisFrontend): Float32Array {
  const n = fe.n_fft;
  const bins = n / 2 + 1;
  const pad = n / 2;
  if (samples.length <= pad) return new Float32Array(0);
  const frames = 1 + Math.floor(samples.length / fe.hop_length);
  const last = samples.length - 1;
  const at = (i: number): number => {
    const k = Math.abs(i - pad);
    return samples[k > last ? 2 * last - k : k]!;
  };
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  const filters = fe.mel_filters.map((row) => {
    let from = 0;
    while (from < bins && row[from] === 0) from++;
    let to = bins;
    while (to > from && row[to - 1] === 0) to--;
    return { from, weights: Float64Array.from(row.slice(from, to)) };
  });
  const scale = 1 / Math.sqrt(n);
  const out = new Float32Array(frames * fe.n_mels);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      re[i] = at(f * fe.hop_length + i) * fe.window[i]!;
      im[i] = 0;
    }
    fft(re, im, cos, sin);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b]!, im[b]!) * scale;
    filters.forEach(({ from, weights }, m) => {
      let sum = 0;
      for (let b = 0; b < weights.length; b++) sum += weights[b]! * mag[from + b]!;
      out[f * fe.n_mels + m] = Math.log1p(1000 * sum);
    });
  }
  return out;
}

function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

// ── Chunks ───────────────────────────────────────────────────────────────────────────────────────

// One window the model reads: `frames` source frames from `start` (negative before the piece),
// zero-padded by `left` / `right`.
export type SpectChunk = { start: number; left: number; frames: number; right: number };

/**
 * `split_piece`: chunks of `chunk` frames overlapping by `border`, the first padded by `border` at
 * its head. The last is shifted to end `border` past the piece; a piece no longer than one chunk's
 * kept span is one shorter chunk.
 */
export function splitChunks(total: number, chunk = CHUNK, border = BORDER): SpectChunk[] {
  const starts: number[] = [];
  for (let s = -border; s < total - border; s += chunk - 2 * border) starts.push(s);
  if (total > chunk - 2 * border) starts[starts.length - 1] = total - (chunk - border);
  return starts.map((start) => {
    const from = Math.max(start, 0);
    const to = Math.min(start + chunk, total);
    return {
      start,
      left: Math.max(0, -start),
      frames: to - from,
      right: Math.max(0, Math.min(border, start + chunk - total)),
    };
  });
}

/**
 * `aggregate_prediction` with `keep_first`: each chunk's logits less `border` frames at either end,
 * an earlier chunk's frame kept over a later one's.
 */
export function joinChunks(
  chunks: readonly SpectChunk[],
  logits: readonly Float32Array[],
  total: number,
  border = BORDER,
): Float32Array {
  const out = new Float32Array(total).fill(-1000);
  for (let c = chunks.length - 1; c >= 0; c--) {
    const { start, left, frames, right } = chunks[c]!;
    const pred = logits[c]!;
    const len = left + frames + right;
    for (let i = border; i < len - border; i++) {
      const t = start + i;
      if (t >= 0 && t < total) out[t] = pred[i]!;
    }
  }
  return out;
}

// ── Peaks ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `postp_minimal` for one track: frames that are the maximum within ±3 frames and above logit 0,
 * each run of frames at most one apart averaged into one (`deduplicate_peaks`).
 */
export function pickPeaks(logits: Float32Array): number[] {
  const frames: number[] = [];
  for (let t = 0; t < logits.length; t++) {
    const v = logits[t]!;
    if (!(v > 0)) continue;
    let max = -Infinity;
    for (let k = Math.max(0, t - 3); k <= Math.min(logits.length - 1, t + 3); k++) {
      max = Math.max(max, logits[k]!);
    }
    if (v === max) frames.push(t);
  }
  const out: number[] = [];
  let p: number | null = null;
  let c = 0;
  for (const q of frames) {
    if (p !== null && q - p <= 1) {
      c++;
      p += (q - p) / c;
    } else {
      if (p !== null) out.push(p);
      p = q;
      c = 1;
    }
  }
  if (p !== null) out.push(p);
  return out;
}

/** Each bar head moved onto its nearest beat (the earlier on a tie), deduplicated, ascending. */
export function snapDownbeats(beats: readonly number[], downbeats: readonly number[]): number[] {
  if (beats.length === 0) return [...new Set(downbeats)].sort((a, b) => a - b);
  const snapped = downbeats.map((d) => {
    let best = beats[0]!;
    for (const b of beats) if (Math.abs(b - d) < Math.abs(best - d)) best = b;
    return best;
  });
  return [...new Set(snapped)].sort((a, b) => a - b);
}

const frameSec = (frame: number): number => Math.round((frame / FPS) * 1000) / 1000;

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

// Take-seconds (rounded to ms) of every beat and bar head Beat This! hears in `file`, ascending.
export async function detectBeats(file: string): Promise<BeatThisReading> {
  const [{ session, frontend }, samples] = await Promise.all([loadModel(), decodeMono(file)]);
  const durationSec = samples.length / SAMPLE_RATE;
  const spect = logMelSpectrogram(samples, frontend);
  const mels = frontend.n_mels;
  const total = spect.length / mels;
  const chunks = splitChunks(total);
  const beat: Float32Array[] = [];
  const downbeat: Float32Array[] = [];
  for (const chunk of chunks) {
    const len = chunk.left + chunk.frames + chunk.right;
    const input = new Float32Array(len * mels);
    const from = Math.max(chunk.start, 0);
    input.set(spect.subarray(from * mels, (from + chunk.frames) * mels), chunk.left * mels);
    const result = await session.run({
      spectrogram: new ort.Tensor("float32", input, [1, len, mels]),
    });
    beat.push(result.beat!.data as Float32Array);
    downbeat.push(result.downbeat!.data as Float32Array);
  }
  const beats = pickPeaks(joinChunks(chunks, beat, total)).map(frameSec);
  const downbeats = snapDownbeats(
    beats,
    pickPeaks(joinChunks(chunks, downbeat, total)).map(frameSec),
  );
  return { beats, downbeats, durationSec };
}
