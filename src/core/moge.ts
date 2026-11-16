import * as os from "node:os";
import * as path from "node:path";
import * as ort from "onnxruntime-web";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with { type: "file" };
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" };
import { downloadFile } from "./download.js";
import { endProgress, progressReporter } from "./download-progress.js";
import type { RgbImage } from "./rgb-image.js";
import { provisionOnce, toolCacheDir } from "./tool-cache.js";
import { toolPin } from "./tool-checksums.js";

// MoGe-2 ViT-B (Ruicheng/moge-2-vitb-normal-onnx@2d247a1) quantized to int8 but its `fc2` and
// `scale_head`, run on onnxruntime-web's WASM build. Post-processing mirrors upstream MoGe's
// `recover_focal_shift` and `points_to_depth`.

const RELEASE = "https://github.com/shiwano/moge-onnx/releases/download/v1";
const MODEL_FILE = "moge-2-vitb-normal-int8.onnx";
export const MOGE_URLS = [`${RELEASE}/${MODEL_FILE}`];

const RESOLUTION_LEVEL = 9;
const MAX_THREADS = 8;
const FOCAL_GRID = 64;

let modelDir: string | null = null;

/** The directory holding the MoGe model, downloading it on first use; `KONTE_MOGE_MODEL_DIR` names one instead. */
async function mogeModelDir(): Promise<string> {
  if (modelDir) return modelDir;
  const override = process.env.KONTE_MOGE_MODEL_DIR;
  if (override) {
    modelDir = override;
    return override;
  }
  const dir = toolCacheDir("moge-onnx-v1");
  await provisionOnce({
    dir,
    pin: toolPin(MOGE_URLS),
    files: [MODEL_FILE],
    label: "MoGe model",
    errorCode: "MOGE_SETUP_FAILED",
    fill: async () => {
      for (const url of MOGE_URLS) {
        await downloadFile(url, path.join(dir, path.basename(url)), progressReporter("moge"));
        endProgress();
      }
    },
  });
  modelDir = dir;
  return dir;
}

let session: Promise<ort.InferenceSession> | null = null;

function loadSession(): Promise<ort.InferenceSession> {
  session ??= (async () => {
    const dir = await mogeModelDir();
    ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
    ort.env.wasm.numThreads = Math.min(os.availableParallelism(), MAX_THREADS);
    return ort.InferenceSession.create(path.join(dir, MODEL_FILE));
  })().catch((err) => {
    session = null;
    throw err;
  });
  return session;
}

/**
 * A metric point per pixel in the camera's frame — x right, y down, z forward, in metres — and
 * `Infinity` on every coordinate where the model saw nothing. `fovX` is the horizontal field of view
 * in degrees it was solved at.
 */
export type PointMap = { width: number; height: number; points: Float32Array; fovX: number };

/** The model's raw reading: affine-invariant points, a validity mask and the metric scale. */
export type MogeReading = {
  width: number;
  height: number;
  points: Float32Array;
  mask: Float32Array;
  metricScale: number;
};

async function readImage(image: RgbImage): Promise<MogeReading> {
  const { width, height, data } = image;
  const plane = width * height;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) chw[c * plane + i] = data[i * 3 + c]! / 255;
  }
  const numTokens = Math.trunc(1200 + (RESOLUTION_LEVEL / 9) * 2400);
  const s = await loadSession();
  const out = await s.run({
    image: new ort.Tensor("float32", chw, [1, 3, height, width]),
    num_tokens: new ort.Tensor("int64", BigInt64Array.from([BigInt(numTokens)]), []),
  });
  const scale = (out.metric_scale ?? out.scale)!.data as Float32Array;
  return {
    width,
    height,
    points: out.points!.data as Float32Array,
    mask: out.mask!.data as Float32Array,
    metricScale: scale[0]!,
  };
}

/** The image's metric point map. */
export async function estimatePointMap(image: RgbImage): Promise<PointMap> {
  return toPointMap(await readImage(image));
}

/**
 * Solves the focal length and the z shift that turn the reading's affine-invariant points into a
 * pinhole camera's, then back-projects every valid pixel and applies the metric scale.
 */
export function toPointMap(reading: MogeReading): PointMap {
  const { width: W, height: H, points, mask, metricScale } = reading;
  const aspect = W / H;
  const diag = Math.hypot(1, aspect);
  const { shift, focal } = recoverFocalShift(reading);
  const fDiag = (focal / 2) * diag;
  const fx = fDiag / aspect;
  const fy = fDiag;
  const plane = W * H;
  const out = new Float32Array(plane * 3).fill(Infinity);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const z = points[k * 3 + 2]! + shift;
      if (!(mask[k]! > 0.5) || z <= 0) continue;
      out[k * 3] = (((x + 0.5) / W - 0.5) / fx) * z * metricScale;
      out[k * 3 + 1] = (((y + 0.5) / H - 0.5) / fy) * z * metricScale;
      out[k * 3 + 2] = z * metricScale;
    }
  }
  return { width: W, height: H, points: out, fovX: (2 * Math.atan(0.5 / fx) * 180) / Math.PI };
}

/**
 * MoGe's `recover_focal_shift` on a 64×64 nearest grid of the valid points: the shift minimizing
 * the reprojection error in view-plane coordinates, the focal its least-squares optimum. Focal is in units of half the image diagonal.
 */
export function recoverFocalShift(
  reading: Pick<MogeReading, "width" | "height" | "points" | "mask">,
): { shift: number; focal: number } {
  const { width: W, height: H, points, mask } = reading;
  const aspect = W / H;
  const diag = Math.hypot(1, aspect);
  const sx = aspect / diag;
  const sy = 1 / diag;
  const uv: number[] = [];
  const xyz: number[] = [];
  for (let j = 0; j < FOCAL_GRID; j++) {
    const y = Math.floor((j * H) / FOCAL_GRID);
    for (let i = 0; i < FOCAL_GRID; i++) {
      const x = Math.floor((i * W) / FOCAL_GRID);
      const k = y * W + x;
      if (!(mask[k]! > 0.5)) continue;
      uv.push(
        -sx * ((W - 1) / W) + (2 * sx * ((W - 1) / W) * x) / (W - 1),
        -sy * ((H - 1) / H) + (2 * sy * ((H - 1) / H) * y) / (H - 1),
      );
      xyz.push(points[k * 3]!, points[k * 3 + 1]!, points[k * 3 + 2]!);
    }
  }
  const n = uv.length / 2;
  if (n === 0) return { shift: 0, focal: 1 };
  const optimalFocal = (shift: number): number => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const z = xyz[i * 3 + 2]! + shift;
      const px = xyz[i * 3]! / z;
      const py = xyz[i * 3 + 1]! / z;
      num += px * uv[i * 2]! + py * uv[i * 2 + 1]!;
      den += px * px + py * py;
    }
    return num / den;
  };
  const cost = (shift: number): number => {
    const f = optimalFocal(shift);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const z = xyz[i * 3 + 2]! + shift;
      const dx = (f * xyz[i * 3]!) / z - uv[i * 2]!;
      const dy = (f * xyz[i * 3 + 1]!) / z - uv[i * 2 + 1]!;
      s += dx * dx + dy * dy;
    }
    return s;
  };
  let minZ = Infinity;
  for (let i = 0; i < n; i++) minZ = Math.min(minZ, xyz[i * 3 + 2]!);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = -minZ + 1e-4;
  let b = 10 * Math.max(1, Math.abs(minZ));
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let it = 0; it < 200 && b - a > 1e-7; it++) {
    if (cost(c) < cost(d)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  const shift = (a + b) / 2;
  return { shift, focal: optimalFocal(shift) };
}
