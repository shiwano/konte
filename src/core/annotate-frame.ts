import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ffmpegBin, SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "./ffmpeg-binary.js";
import { clampUnit } from "./types/feedback.js";
import { probeVideoDimensions } from "./video-probe.js";
import { execFileAsync } from "./exec-file.js";

// The reticle is sized against the frame's short edge so it reads the same on any canvas, and wide
// enough to survive the downscale a contact-sheet cell applies (a 1920-wide frame lands at 384).
const RETICLE_FRACTION = 0.12;
const RETICLE_MIN = 48;
const RETICLE_MAX = 320;
const STROKE_DIVISOR = 150;
const STROKE_MIN = 2;

// A pin lands on footage of unknown value, so the mark carries its own contrast — a bright ring
// between two dark ones.
const HALO_COLOR = "0x000000@0.85";
const MARK_COLOR = "0xFFE000@1.0";

interface ReticleBox {
  x: number;
  y: number;
  size: number;
  color: string;
}

interface ReticleGeometry {
  /** Concentric hollow squares, outermost first. Each is drawn `stroke` px thick, inward. */
  boxes: ReticleBox[];
  stroke: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * The squares are hollow: anything drawn on the point covers what the pin points at.
 *
 * They may extend past the frame, and ffmpeg clips them — moving the reticle inward to fit would
 * put the mark somewhere the reviewer did not click.
 */
export function planPinReticle(
  width: number,
  height: number,
  x: number,
  y: number,
): ReticleGeometry {
  const shortEdge = Math.min(width, height);
  const stroke = Math.max(STROKE_MIN, Math.round(shortEdge / STROKE_DIVISOR));
  const size = Math.round(clamp(shortEdge * RETICLE_FRACTION, RETICLE_MIN, RETICLE_MAX));
  const half = Math.round(size / 2);
  const left = Math.round(clampUnit(x) * width) - half;
  const top = Math.round(clampUnit(y) * height) - half;

  const boxes: ReticleBox[] = [
    { x: left - stroke, y: top - stroke, size: size + stroke * 2, color: HALO_COLOR },
    { x: left, y: top, size, color: MARK_COLOR },
  ];
  const inner = size - stroke * 2;
  if (inner > 0) {
    boxes.push({ x: left + stroke, y: top + stroke, size: inner, color: HALO_COLOR });
  }
  return { boxes, stroke };
}

export function pinReticleFilters(geometry: ReticleGeometry): string {
  return geometry.boxes
    .map(
      (b) =>
        `drawbox=x=${b.x}:y=${b.y}:w=${b.size}:h=${b.size}:color=${b.color}:t=${geometry.stroke}`,
    )
    .join(",");
}

/**
 * Returns false — leaving `outputFile` absent — when the frame cannot be probed or ffmpeg fails.
 */
export async function annotateFrameWithPin(options: {
  sourceFile: string;
  outputFile: string;
  x: number;
  y: number;
}): Promise<boolean> {
  const { sourceFile, outputFile, x, y } = options;
  const dimensions = await probeVideoDimensions(sourceFile);
  if (!dimensions) return false;

  const filters = pinReticleFilters(planPinReticle(dimensions.width, dimensions.height, x, y));
  // This path is cached by existence alone, so a run killed mid-encode would otherwise leave a
  // truncated frame that is never re-rendered. The extension stays last: ffmpeg picks the muxer
  // off it, and a `.partial` tail leaves it guessing.
  const ext = path.extname(outputFile);
  const tmpFile = `${outputFile.slice(0, outputFile.length - ext.length)}.partial${ext}`;
  try {
    const ffmpeg = await ffmpegBin();
    await execFileAsync(ffmpeg, [
      "-y",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-i",
      sourceFile,
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-vf",
      filters,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      tmpFile,
    ]);
    if (!existsSync(tmpFile)) return false;
    await fs.rename(tmpFile, outputFile);
    return true;
  } catch {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    return false;
  }
}
