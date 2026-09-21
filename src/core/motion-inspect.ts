import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { KonteError, errorMessage } from "./errors.js";
import { ffmpegBin, SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "./ffmpeg-binary.js";
import { inferMediaType } from "./media-type.js";
import { shotById } from "./shot-index.js";
import type { StateManager } from "./state/index.js";
import {
  captureCompositionFrames,
  COMPOSITION_FRAME_FORMAT,
  COMPOSITION_FRAME_QUALITY,
  frameInterval,
  lastSeekableTime,
  probeVideo,
  shotFrameDir,
  type VideoProbeResult,
} from "./thumbnail.js";
import type { StageDefinition } from "./types/index.js";
import { execFileAsync } from "./exec-file.js";

// The audio inspector decodes PCM, buckets RMS amplitude, and caches the result; motion is the exact
// analog over the time axis — decode downscaled grayscale frames, measure the per-frame-pair diff
// energy, and weight it by how *coherent* that energy is (coherent → real motion; incoherent
// frame-wide scatter → AI flicker/noise). The same on-disk cache convention applies.
//
// Coherence is the max of two independent rescues, because real motion takes two spatial shapes that
// each look "dispersed" to the other's measure:
//   - concentration — energy collapsed into a few tiles ⇒ a localized moving subject.
//   - edge-coherence — the diff field aligns with the frame's spatial edges ⇒ global camera motion
//     (dolly/pan/zoom moves the whole frame, so its energy is spread across every tile yet sits
//     precisely on the edges it displaces). Concentration alone misreads this as flicker.
// Only energy that is BOTH dispersed AND off-edge (no single geometric motion explains it) is treated
// as flicker/morphing.
//
// "Did anything move at all" is a second, independent axis — see DISPLACEMENT_WINDOW_SEC.

const DECODE_WIDTH = 64; // downscaled frame width; height preserves aspect ratio
const TILES_X = 8; // coarse grid columns for the spatial-concentration measure
const DEFAULT_FPS_CAP = 30; // default decode fps is min(nativeFps, this)
const PROFILE_SCALE = 1000; // integer quantization for the on-disk arrays
const MIN_KEEP = 0.35; // coherence weight floor — low coherence only ever lightly suppresses
const ENERGY_FLOOR = 0.008; // below this a sample carries no motion to attribute to flicker/subject
// How far apart the two frames of a displacement sample sit. "Did anything move" is a question about
// DISPLACEMENT, but a consecutive pair measures SPEED: a 6%-over-5s push-in shifts a decoded frame by
// a fraction of a pixel and reads as noise. Grain is temporally uncorrelated, so it reads the same at
// any spacing — widening the window lifts real motion clear of it without lifting the floor. Widening
// the decode instead does not: it raises both together.
const DISPLACEMENT_WINDOW_SEC = 1;
// The displacement floor, on `displacementEnergy`'s scale. Calibrated on measured clips: the noisiest
// motionless one (heavy grain) reads 0.0051, the quietest moving one (a 3%-over-5s push-in) 0.0185.
const LOCAL_ENERGY_FLOOR = 0.01;
const LOCAL_SCALE = 10000; // finer than PROFILE_SCALE: 1/1000 would quantize a frozen clip to 0.000
// Bumped whenever the coherence math changes: a cached profile stamped with a different version is
// ignored and re-decoded, so a stale `coherent` array from an older algorithm never leaks through.
const MOTION_ALGO_VERSION = 4;

interface MotionProfile {
  durationSec: number | null;
  /** Samples per second (== decode fps). */
  fps: number;
  /** Raw mean-abs-diff energy per consecutive frame pair (0-1). */
  raw: number[];
  /** Raw weighted by spatial coherence (0-1) — the de-flickered motion signal. */
  coherent: number[];
  /**
   * Busiest tile's displacement energy (0-1) — how far anything moved between this sample's frame and
   * the one a `DISPLACEMENT_WINDOW_SEC` later. Undiluted by the still rest of the frame, and blind to
   * exposure drift. Index-aligned with `raw`/`coherent`; the tail's window shrinks to the clip's end.
   */
  local: number[];
}

// The frame spacing of a displacement sample, in samples. Derived from fps rather than stored, so the
// decode and the warning that reports the window agree without carrying it through the cache.
export function displacementStride(fps: number, frames: number): number {
  const span = Math.max(1, frames - 1);
  return Math.max(1, Math.min(span, Math.round(fps * DISPLACEMENT_WINDOW_SEC)));
}

// Resolve the decode fps: a numeric override, "native" for the source's own rate, or the default cap.
export function resolveDecodeFps(nativeFps: number, override?: number | "native"): number {
  if (override === "native") return Math.max(1, Math.round(nativeFps));
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }
  return Math.max(1, Math.round(Math.min(nativeFps, DEFAULT_FPS_CAP)));
}

// Shannon-entropy concentration of tile energies in [0,1]: 0 when energy is spread evenly across all
// tiles (≈ flicker), 1 when it collapses into a single tile (≈ a localized moving subject).
function tileConcentration(tileEnergy: number[]): number {
  const total = tileEnergy.reduce((a, b) => a + b, 0);
  const t = tileEnergy.length;
  if (total <= 0 || t <= 1) return 0;
  let entropy = 0;
  for (const e of tileEnergy) {
    if (e <= 0) continue;
    const p = e / total;
    entropy -= p * Math.log(p);
  }
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(t)));
}

// One consecutive frame pair's motion, as raw energy plus a spatial coherence weight in [0,1]. Both
// signals come from a single pass over the grayscale pixels:
//   - concentration — Shannon-entropy tile concentration of the diff energy (localized subject).
//   - edgeCoherence — cosine similarity between the per-pixel |diff| field and prev's spatial-gradient
//     magnitude field. Geometric motion (pan/dolly/zoom) displaces edges, so its diff energy lands on
//     high-gradient pixels ⇒ cosine high; spatially random flicker puts energy in flat regions too
//     ⇒ cosine low. It captures camera motion in any direction without a per-direction search.
//     The gradient is a *central* difference on prev (not forward): a forward difference localizes an
//     edge to one side, so a 1px displacement one way lands the diff off the gradient (cosine → 0)
//     while the other way lands on it — the central form responds on both sides and stays direction-
//     symmetric. It is taken on prev only, never cur: flicker manufactures its own high-frequency
//     structure in cur, so a cur gradient would self-align with the flicker and mask it.
// `weight = max(concentration, edgeCoherence)`: energy is "real" if it is either localized OR
// edge-aligned, and only flicker (dispersed AND off-edge) drives the weight low. Exported for tests.
export function frameCoherence(
  prev: Uint8Array | number[],
  cur: Uint8Array | number[],
  w: number,
  h: number,
): {
  rawEnergy: number;
  concentration: number;
  edgeCoherence: number;
  weight: number;
} {
  const tilesY = Math.max(2, Math.round((TILES_X * h) / w));
  const tileEnergy = new Array<number>(TILES_X * tilesY).fill(0);
  let sumAbs = 0;
  let sdg = 0; // Σ |diff|·|grad|
  let sdd = 0; // Σ |diff|²
  let sgg = 0; // Σ |grad|²
  for (let y = 0; y < h; y++) {
    const ty = Math.min(tilesY - 1, Math.floor((y / h) * tilesY));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.abs(cur[i]! - prev[i]!);
      sumAbs += d;
      const tx = Math.min(TILES_X - 1, Math.floor((x / w) * TILES_X));
      const ti = ty * TILES_X + tx;
      tileEnergy[ti] = tileEnergy[ti]! + d;
      const gx = x > 0 && x + 1 < w ? Math.abs(prev[i + 1]! - prev[i - 1]!) : 0;
      const gy = y > 0 && y + 1 < h ? Math.abs(prev[i + w]! - prev[i - w]!) : 0;
      const g = gx + gy;
      sdg += d * g;
      sdd += d * d;
      sgg += g * g;
    }
  }
  const rawEnergy = sumAbs / (w * h * 255);
  const concentration = tileConcentration(tileEnergy);
  const edgeCoherence =
    sdd > 0 && sgg > 0 ? Math.max(0, Math.min(1, sdg / Math.sqrt(sdd * sgg))) : 0;
  return {
    rawEnergy,
    concentration,
    edgeCoherence,
    weight: Math.max(concentration, edgeCoherence),
  };
}

// How far the picture moved between two frames, as the busiest tile's mean absolute deviation of the
// diff around that tile's OWN mean shift. Two departures from `rawEnergy`:
//   - per tile, not per frame — a subject filling a fraction of the frame is not averaged away by the
//     still pixels around it.
//   - around the tile's mean shift, not around zero — a uniform brightening displaces nothing. Without
//     this an exposure drift reads like a slow move and silences the warning on a frozen clip.
// The price is a translation whose diff field is locally constant — a featureless gradient sliding —
// which is arithmetically an exposure shift and reads as one. Such content lands under the floor with
// or without the correction.
// The frames are handed in a window apart (see DISPLACEMENT_WINDOW_SEC), not consecutive. Exported for
// tests.
export function displacementEnergy(
  prev: Uint8Array | number[],
  cur: Uint8Array | number[],
  w: number,
  h: number,
): number {
  const tilesY = Math.max(2, Math.round((TILES_X * h) / w));
  const tiles = TILES_X * tilesY;
  const tileSum = new Array<number>(tiles).fill(0);
  const tilePixels = new Array<number>(tiles).fill(0);
  const tileOf = (x: number, y: number): number =>
    Math.min(tilesY - 1, Math.floor((y / h) * tilesY)) * TILES_X +
    Math.min(TILES_X - 1, Math.floor((x / w) * TILES_X));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ti = tileOf(x, y);
      tileSum[ti] = tileSum[ti]! + (cur[y * w + x]! - prev[y * w + x]!);
      tilePixels[ti] = tilePixels[ti]! + 1;
    }
  }
  const tileMean = tileSum.map((sum, ti) => (tilePixels[ti]! > 0 ? sum / tilePixels[ti]! : 0));

  const tileDeviation = new Array<number>(tiles).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ti = tileOf(x, y);
      const i = y * w + x;
      tileDeviation[ti] = tileDeviation[ti]! + Math.abs(cur[i]! - prev[i]! - tileMean[ti]!);
    }
  }

  let energy = 0;
  for (let ti = 0; ti < tiles; ti++) {
    const px = tilePixels[ti]!;
    if (px > 0) energy = Math.max(energy, tileDeviation[ti]! / (px * 255));
  }
  return energy;
}

// Decode the whole clip to downscaled grayscale, then walk consecutive frames computing the
// mean-abs-diff energy, its spatial coherence, and each sample's windowed displacement. Returns null
// when the source can't be decoded.
// Throws (FFPROBE_ERROR / FFMPEG_ERROR) rather than returning null on a failed probe or decode — an
// unsupported codec or a blown buffer must surface as an error, never be mistaken for "no motion".
async function decodeMotionProfile(absFile: string, fps: number): Promise<MotionProfile> {
  const probe = await probeVideo(absFile);
  const h =
    probe.width > 0
      ? Math.max(2, Math.round((DECODE_WIDTH * probe.height) / probe.width / 2) * 2)
      : 36;
  const w = DECODE_WIDTH;

  const args = [
    "-v",
    "quiet",
    "-i",
    absFile,
    "-vf",
    `scale=${w}:${h},format=gray`,
    "-r",
    String(fps),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ];

  const ffmpeg = await ffmpegBin();
  let buf: Buffer;
  try {
    const res = await execFileAsync(ffmpeg, args, { encoding: "buffer" });
    buf = res.stdout;
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `Failed to decode video for motion analysis: ${message}`);
  }

  const frameSize = w * h;
  const frames = Math.floor(buf.length / frameSize);
  if (frames < 2) {
    return { durationSec: probe.videoDuration || null, fps, raw: [], coherent: [], local: [] };
  }

  const raw: number[] = [];
  const coherent: number[] = [];
  const local: number[] = [];
  const stride = displacementStride(fps, frames);
  const frameAt = (f: number): Buffer => buf.subarray(f * frameSize, (f + 1) * frameSize);

  for (let f = 1; f < frames; f++) {
    const prev = frameAt(f - 1);
    const cur = frameAt(f);
    const { rawEnergy, weight } = frameCoherence(prev, cur, w, h);
    // Clamped to the last frame: the tail's window shrinks rather than dropping samples, so all three
    // arrays stay index-aligned.
    const localEnergy = displacementEnergy(
      prev,
      frameAt(Math.min(frames - 1, f - 1 + stride)),
      w,
      h,
    );
    // Below the noise floor there is no motion to attribute; leave it un-suppressed so the flicker
    // score reads 0 rather than penalizing decode noise.
    const coherentEnergy =
      rawEnergy < ENERGY_FLOOR ? rawEnergy : rawEnergy * (MIN_KEEP + (1 - MIN_KEEP) * weight);
    // Quantize here, not only on write, so a fresh decode and a cache read yield byte-identical
    // values — the rendered waveform never shifts between a cold and a warm run.
    raw.push(Math.round(Math.min(1, rawEnergy) * PROFILE_SCALE) / PROFILE_SCALE);
    coherent.push(Math.round(Math.min(1, coherentEnergy) * PROFILE_SCALE) / PROFILE_SCALE);
    local.push(Math.round(Math.min(1, localEnergy) * LOCAL_SCALE) / LOCAL_SCALE);
  }

  // The picture's own length: this profile is a video signal, and the strip's frame grid is derived
  // from whichever duration reaches it — including through this cache, when a later re-probe fails.
  return { durationSec: probe.videoDuration || frames / fps, fps, raw, coherent, local };
}

function motionCacheFile(
  videoRoot: string,
  variantId: string,
  outputHash: string,
  fps: number,
): string {
  return path.join(
    videoRoot,
    ".konte",
    "cache",
    "motion",
    variantId,
    `${outputHash}-fps${fps}.json`,
  );
}

// Sweep sibling cache entries (superseded bytes) for this variant, keeping every entry — waveform
// JSONs and strip dirs alike — that belongs to the current output hash. Mirrors the audio/thumbnail
// caches: clean is variant-scoped and won't reclaim these otherwise.
function pruneSupersededMotionHashes(
  videoRoot: string,
  variantId: string,
  currentHash: string,
): void {
  const variantDir = path.join(videoRoot, ".konte", "cache", "motion", variantId);
  try {
    for (const entry of readdirSync(variantDir)) {
      if (entry !== currentHash && !entry.startsWith(`${currentHash}-`)) {
        rmSync(path.join(variantDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // best-effort GC of stale motion caches
  }
}

// A variant's motion profile, served from (in order) the per-run memo, the disk cache, or a fresh
// decode that is then cached. The decode fps is part of the key — a different sampling rate yields
// a different signal. No file paths or secrets are persisted, only the duration, fps, and arrays.
async function getMotionProfile(
  absFile: string,
  variantId: string,
  outputHash: string | null,
  fps: number,
  videoRoot: string,
  memo: Map<string, MotionProfile>,
): Promise<MotionProfile> {
  const memoKey = `${absFile}|${fps}`;
  const cached = memo.get(memoKey);
  if (cached) return cached;

  const cacheFile = outputHash ? motionCacheFile(videoRoot, variantId, outputHash, fps) : null;

  if (cacheFile && existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(readFileSync(cacheFile, "utf-8")) as {
        algo?: number;
        durationSec: number | null;
        fps: number;
        raw: number[];
        coherent: number[];
        local: number[];
      };
      // A profile written by an older coherence algorithm carries a stale `coherent`/`flickerScore`;
      // ignore it and re-decode so the fix reaches variants probed before the bump. Re-decoding
      // overwrites this same file, so no orphaned old-version entry is left behind.
      if (raw.algo === MOTION_ALGO_VERSION) {
        const profile: MotionProfile = {
          durationSec: raw.durationSec,
          fps: raw.fps,
          raw: raw.raw.map((v) => v / PROFILE_SCALE),
          coherent: raw.coherent.map((v) => v / PROFILE_SCALE),
          local: raw.local.map((v) => v / LOCAL_SCALE),
        };
        memo.set(memoKey, profile);
        return profile;
      }
    } catch {
      // corrupt cache: fall through and re-decode
    }
  }

  const profile = await decodeMotionProfile(absFile, fps);
  if (cacheFile) {
    try {
      pruneSupersededMotionHashes(videoRoot, variantId, outputHash as string);
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(
        cacheFile,
        JSON.stringify({
          algo: MOTION_ALGO_VERSION,
          durationSec: profile.durationSec,
          fps: profile.fps,
          raw: profile.raw.map((v) => Math.round(Math.min(1, v) * PROFILE_SCALE)),
          coherent: profile.coherent.map((v) => Math.round(Math.min(1, v) * PROFILE_SCALE)),
          local: profile.local.map((v) => Math.round(Math.min(1, v) * LOCAL_SCALE)),
        }),
      );
    } catch {
      // best-effort cache; its absence just means a re-decode next time
    }
  }
  memo.set(memoKey, profile);
  return profile;
}

interface MotionSegment {
  type: "active" | "still";
  start: number;
  end: number;
}

interface MotionWarning {
  type: string;
  message: string;
}

// One variant's motion analysis: the three waveforms plus the derived statistics, peak, segments and
// observational warnings. `isVideo` is false for image variants (nothing to measure).
export interface MotionWaveform {
  variantId: string;
  address: string;
  file: string;
  status: string;
  isVideo: boolean;
  /** Content hash of the committed file — keys the strip cache dir. Not surfaced in CLI output. */
  outputHash: string | null;
  durationSec: number | null;
  fps: number;
  /** The source's own frame rate — the grid a seek has to land on, whatever `fps` decoded at. */
  nativeFps: number;
  samples: number;
  mean: number;
  peak: { time: number; value: number };
  /**
   * Strongest single-tile displacement — the one statistic comparable across clips. `time` is where
   * the window it was measured over starts, spanning `displacementWindowSec` from there.
   */
  magnitude: { time: number; value: number };
  /** Seconds the reported `magnitude` was measured over, starting at `magnitude.time`. */
  displacementWindowSec: number;
  /** Raw mean-abs-diff energy (un-normalized 0-1). */
  raw: number[];
  /** Coherence-weighted motion (un-normalized 0-1) — the displayed signal. */
  coherent: number[];
  /** Busiest tile's displacement energy per sample (0-1), over `displacementWindowSec`. */
  local: number[];
  /** Per-sample dispersed-energy proportion (raw−coherent)/raw in [0,1]. */
  flickerScore: number[];
  segments: MotionSegment[];
  warnings: MotionWarning[];
}

function sampleTime(index: number, fps: number): number {
  return (index + 0.5) / fps;
}

// Group consecutive samples that satisfy `pred` into segments lasting at least `minDuration`.
function findSegments(
  values: number[],
  fps: number,
  pred: (v: number) => boolean,
  type: "active" | "still",
  minDuration: number,
): MotionSegment[] {
  const out: MotionSegment[] = [];
  let runStart = -1;
  for (let i = 0; i <= values.length; i++) {
    const inRun = i < values.length && pred(values[i]!);
    if (inRun && runStart < 0) {
      runStart = i;
    } else if (!inRun && runStart >= 0) {
      const start = sampleTime(runStart, fps);
      const end = sampleTime(i - 1, fps);
      if (end - start >= minDuration) {
        out.push({ type, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
      }
      runStart = -1;
    }
  }
  return out;
}

function deriveFlicker(raw: number[], coherent: number[]): number[] {
  return raw.map((r, i) =>
    r > ENERGY_FLOOR ? Math.max(0, Math.min(1, (r - coherent[i]!) / r)) : 0,
  );
}

interface MotionSummary {
  samples: number;
  mean: number;
  peak: { time: number; value: number };
  /** Strongest single-tile displacement in the clip — the cross-clip-comparable "how much moved". */
  magnitude: { time: number; value: number };
  /** Seconds the reported `magnitude` was measured over, starting at `magnitude.time`. */
  displacementWindowSec: number;
  flickerScore: number[];
  segments: MotionSegment[];
  warnings: MotionWarning[];
}

// Derive the displayed statistics from the waveforms — pure, so it is unit-tested directly without
// decoding a file. `mean`/`peak` describe the coherent (de-flickered) signal; thresholds are relative
// to the peak so the active/still split scales with the clip's own motion range. `magnitude` comes
// from `local` instead, the one statistic that means the same thing across clips. The displacement
// window is re-derived from `fps` and the sample count, the same way the decode picked it.
export function summarizeMotion(
  raw: number[],
  coherent: number[],
  local: number[],
  fps: number,
): MotionSummary {
  const flickerScore = deriveFlicker(raw, coherent);
  const samples = coherent.length;
  const mean = samples > 0 ? coherent.reduce((a, b) => a + b, 0) / samples : 0;
  let peakIdx = 0;
  for (let i = 1; i < samples; i++) if (coherent[i]! > coherent[peakIdx]!) peakIdx = i;
  const peakValue = samples > 0 ? coherent[peakIdx]! : 0;
  const peak = {
    time: samples > 0 ? Math.round(sampleTime(peakIdx, fps) * 100) / 100 : 0,
    value: Math.round(peakValue * 1000) / 1000,
  };

  let magIdx = 0;
  for (let i = 1; i < local.length; i++) if (local[i]! > local[magIdx]!) magIdx = i;
  const magnitude = {
    time: local.length > 0 ? Math.round(sampleTime(magIdx, fps) * 100) / 100 : 0,
    value: local.length > 0 ? Math.round(local[magIdx]! * LOCAL_SCALE) / LOCAL_SCALE : 0,
  };
  // The span of the sample `magnitude` came from, not the nominal stride: the tail's windows shrink to
  // the clip's end, and the magnitude can land there — a 1Hz oscillation reads ~0 a second apart and
  // shows itself only in the short tail comparisons.
  const magSpan =
    local.length > 0
      ? Math.min(displacementStride(fps, local.length + 1), local.length - magIdx)
      : 0;
  const displacementWindowSec = Math.round((magSpan / fps) * 100) / 100;

  // Thresholds are peak-relative so the active/still split scales with the clip's own range — a
  // small absolute floor only keeps an essentially-static clip's noise from reading as motion.
  // (Localized subject motion lives around 0.02-0.04 on this full-frame mean-abs-diff scale, so an
  // absolute "active" floor much above that would never fire.)
  const stillThreshold = Math.max(0.01, peakValue * 0.2);
  const activeThreshold = Math.max(0.02, peakValue * 0.4);
  const segments = [
    ...findSegments(coherent, fps, (v) => v >= activeThreshold, "active", 0.3),
    ...findSegments(coherent, fps, (v) => v <= stillThreshold, "still", 0.5),
  ].sort((a, b) => a.start - b.start);

  // Warnings are kept to signals that hold up as absolute and cross-clip-comparable. The old
  // peak-relative "low motion" warning is deliberately gone — keyed on the fraction of samples below
  // a share of the clip's own peak, it fired on nearly every clip (localized motion concentrates its
  // energy into a few frames, leaving most samples "still") and carried no signal. Within-clip
  // structure is left to the active/still segments.
  const warnings: MotionWarning[] = [];
  if (samples > 0) {
    // Low motion: over no window in the clip does even its busiest tile move enough to clear the noise
    // floor. It is keyed on `magnitude` rather than the frame-wide `peak` because `peak` divides by the
    // whole frame: a cat breathing or a paw settling fills so little of it that the reading lands under
    // any frame-wide floor while the motion is plain to see. Absolute, so it stays comparable across
    // clips. The message reports the number and its window and stops: a deliberately still shot
    // measures the same as one that failed to animate, and only the shot's intent says which was asked
    // for.
    if (magnitude.value <= LOCAL_ENERGY_FLOOR) {
      warnings.push({
        type: "low_motion",
        message: `motion magnitude ${magnitude.value.toFixed(
          4,
        )} over ${displacementWindowSec}s — nothing in frame moves that far.`,
      });
    }
    // Energy-weighted mean flicker proportion: how much of the *moving* energy is dispersed.
    const rawTotal = raw.reduce((a, b) => a + b, 0);
    if (rawTotal > 0) {
      const dispersed = raw.reduce((a, r, i) => a + r * flickerScore[i]!, 0) / rawTotal;
      if (dispersed > 0.5) {
        warnings.push({
          type: "dispersed_motion",
          message: `${Math.round(
            dispersed * 100,
          )}% of motion energy is spatially dispersed — possible flicker/morphing rather than subject motion.`,
        });
      }
    }
  }

  return {
    samples,
    mean: Math.round(mean * 1000) / 1000,
    peak,
    magnitude,
    displacementWindowSec,
    flickerScore,
    segments,
    warnings,
  };
}

// Load a single variant's motion analysis by id, for `konte probe motion <variantId>`. Throws
// VARIANT_NOT_FOUND when the id is unknown or has no committed file, ASSET_NOT_FOUND when that file
// is missing. An image variant returns isVideo=false with empty waveforms.
export async function loadMotionWaveform(opts: {
  manager: StateManager;
  videoRoot: string;
  variantId: string;
  fps?: number | "native";
}): Promise<MotionWaveform> {
  const { manager, videoRoot, variantId } = opts;
  const address = manager.resolveVariantAddress(variantId);
  const variant = manager.getState().assets[address]?.variants?.[variantId];
  if (!variant?.file) {
    throw new KonteError("VARIANT_NOT_FOUND", `Variant "${variantId}" has no output file`);
  }

  const absFile = path.resolve(videoRoot, variant.file);
  if (!existsSync(absFile)) {
    throw new KonteError("ASSET_NOT_FOUND", `Variant file not found on disk: ${variant.file}`);
  }

  const base = {
    variantId,
    address,
    file: variant.file,
    status: variant.status,
    outputHash: variant.outputHash ?? null,
  };

  if (inferMediaType(variant.file) !== "video") {
    return {
      ...base,
      isVideo: false,
      durationSec: null,
      fps: 0,
      nativeFps: 0,
      samples: 0,
      mean: 0,
      peak: { time: 0, value: 0 },
      magnitude: { time: 0, value: 0 },
      displacementWindowSec: 0,
      raw: [],
      coherent: [],
      local: [],
      flickerScore: [],
      segments: [],
      warnings: [],
    };
  }

  let probe: VideoProbeResult | null = null;
  try {
    probe = await probeVideo(absFile);
  } catch {
    // unreadable header — fall back to the default cap. Only a warm cache gets this far: a cold one
    // re-probes inside decodeMotionProfile, which throws rather than guess.
  }
  const nativeFps = probe?.fps || 30;
  const fps = resolveDecodeFps(nativeFps, opts.fps);

  const profile = await getMotionProfile(
    absFile,
    variantId,
    variant.outputHash ?? null,
    fps,
    videoRoot,
    new Map(),
  );

  const { raw, coherent, local } = profile;
  const summary = summarizeMotion(raw, coherent, local, fps);

  return {
    ...base,
    isVideo: true,
    // The picture's own duration, not the container's: a motion probe measures the video stream, and
    // an audio track that outruns it would put the strip's last sample past the last frame.
    durationSec: probe?.videoDuration || profile.durationSec,
    fps,
    nativeFps,
    samples: summary.samples,
    mean: summary.mean,
    peak: summary.peak,
    magnitude: summary.magnitude,
    displacementWindowSec: summary.displacementWindowSec,
    raw,
    coherent,
    local,
    flickerScore: summary.flickerScore,
    segments: summary.segments,
    warnings: summary.warnings,
  };
}

interface MotionStripSpec {
  /** Center the window here; defaults to the waveform peak. Ignored when `full`. */
  at?: number;
  /** Total window span in seconds (centered on `at`). Ignored when `full`. */
  window?: number;
  /** Number of tiled frames. */
  frames?: number;
  /** Sample uniformly across the whole clip instead of a window. */
  full?: boolean;
}

const DEFAULT_WINDOW = 0.6;
const DEFAULT_PEAK_FRAMES = 12;
const DEFAULT_FULL_FRAMES = 16;
const STRIP_FRAME_WIDTH = 320;
// Frame intervals a failed sample may step back before the strip gives up — a backstop for a source
// whose frames sit off the grid its declared rate describes. It is bounded, so it rescues a sample
// that overshot by a frame or two, not one facing an arbitrary gap.
const MAX_SEEK_STEPBACK = 2;

// ffmpeg can exit 0 having written nothing, or leave a truncated file behind when it dies mid-write,
// so "the path exists" is never enough to call an image finished.
function hasBytes(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

// The binary is pinned for the process's lifetime, so its filter list is asked for once.
let drawtextSupport: Promise<boolean> | undefined;
function ffmpegHasDrawtext(): Promise<boolean> {
  drawtextSupport ??= (async () => {
    try {
      const ffmpeg = await ffmpegBin();
      const res = await execFileAsync(ffmpeg, ["-hide_banner", "-filters"]);
      return /\bdrawtext\b/.test(res.stdout);
    } catch {
      return false;
    }
  })();
  return drawtextSupport;
}

// `timestamp` null reads a still image.
async function extractStripFrame(
  sourcePath: string,
  timestamp: number | null,
  outputPath: string,
  label: string | null,
): Promise<void> {
  const filters = [`scale=${STRIP_FRAME_WIDTH}:-2`];
  if (label) {
    const fontsize = Math.max(12, Math.round(STRIP_FRAME_WIDTH / 18));
    filters.push(
      `drawtext=text='${label}':x=6:y=6:fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`,
    );
  }
  const args = [
    "-y",
    ...SINGLE_FRAME_INPUT_ARGS,
    ...(timestamp == null ? [] : ["-ss", String(timestamp)]),
    "-i",
    sourcePath,
    ...SINGLE_FRAME_OUTPUT_ARGS,
    "-frames:v",
    "1",
    "-vf",
    filters.join(","),
    "-q:v",
    "3",
    outputPath,
  ];
  const ffmpeg = await ffmpegBin();
  await execFileAsync(ffmpeg, args);
}

// Tile `frame-001.jpg`… in `framesDir` into one sheet at `tilePath`. The caller writes `tilePath`
// beside its destination and moves it into place: a strip cache is keyed by the file's existence
// alone, so a half-written sheet left by a failed run would be served forever.
async function tileStripFrames(
  framesDir: string,
  count: number,
  tilePath: string,
  outDir: string,
): Promise<void> {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  mkdirSync(outDir, { recursive: true });
  const tileArgs = [
    "-y",
    ...SINGLE_FRAME_INPUT_ARGS,
    "-framerate",
    "1",
    "-start_number",
    "1",
    "-i",
    path.join(framesDir, "frame-%03d.jpg"),
    ...SINGLE_FRAME_OUTPUT_ARGS,
    "-vf",
    `tile=${cols}x${rows}:padding=6:margin=6:color=0x111111`,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    tilePath,
  ];
  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, tileArgs);
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `Failed to tile motion strip: ${message}`);
  }
  if (!hasBytes(tilePath)) {
    throw new KonteError("FFMPEG_ERROR", "ffmpeg wrote no motion strip");
  }
}

// Render a tiled contact sheet of frames around a window (or the whole clip) into the variant's
// motion cache, returning the absolute path (openable as-is). The spec makes a deterministic cache key,
// so an identical request is never re-rendered. Time labels are baked per-frame via drawtext, with a
// label-less fallback when the ffmpeg build lacks usable fonts.
export async function renderMotionStrip(opts: {
  videoRoot: string;
  waveform: MotionWaveform;
  spec: MotionStripSpec;
}): Promise<{ path: string; timestamps: number[]; window: { start: number; end: number } }> {
  const { videoRoot, waveform, spec } = opts;
  if (!waveform.isVideo) {
    throw new KonteError("INVALID_ASSET_TYPE", `Variant "${waveform.variantId}" is not a video`);
  }
  const duration = waveform.durationSec ?? 0;
  if (duration <= 0) {
    throw new KonteError("ASSET_NOT_FOUND", `Variant "${waveform.variantId}" has no duration`);
  }

  const full = spec.full ?? false;
  const frames = Math.max(2, spec.frames ?? (full ? DEFAULT_FULL_FRAMES : DEFAULT_PEAK_FRAMES));

  // ffmpeg yields no frame when seeking past the last one (it succeeds writing nothing, or fails to
  // open the encoder), which would silently drop the last tile while the JSON still claims `frames`.
  // Cap sampling at the last frame that actually exists — on the *source's* grid, since the decode
  // fps is capped below it (and `--fps` can lift it above it), and a seek only meets real frames.
  const lastFrameTime = lastSeekableTime(duration, waveform.nativeFps);

  let start: number;
  let end: number;
  if (full) {
    start = 0;
    end = lastFrameTime;
  } else {
    const center = spec.at ?? waveform.peak.time;
    const win = spec.window ?? DEFAULT_WINDOW;
    start = Math.max(0, center - win / 2);
    end = Math.min(lastFrameTime, center + win / 2);
    if (end <= start) end = Math.min(lastFrameTime, start + win);
  }

  const timestamps: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? start : start + ((end - start) * i) / (frames - 1);
    timestamps.push(Math.min(lastFrameTime, Math.max(0, t)));
  }

  const spec_str = full
    ? `full-f${frames}`
    : `at${Math.round((spec.at ?? waveform.peak.time) * 1000)}ms-w${Math.round(
        (end - start) * 1000,
      )}ms-f${frames}`;

  // Strips live under the variant's content-hash dir, beside the `<hash>-fps<n>.json` waveforms, so
  // the hash-scoped prune reclaims them when the variant's bytes change. A hashless variant (missing
  // source) can't be keyed, so it renders under a "live" dir that prune never retains.
  const outDir = path.join(
    videoRoot,
    ".konte",
    "cache",
    "motion",
    waveform.variantId,
    waveform.outputHash ?? "live",
  );
  const outFile = path.join(outDir, `strip-${spec_str}.jpg`);
  const window = { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };

  if (hasBytes(outFile)) {
    return { path: outFile, timestamps, window };
  }

  const videoPath = path.resolve(videoRoot, waveform.file);
  if (!existsSync(videoPath)) {
    throw new KonteError("ASSET_NOT_FOUND", `Variant file not found on disk: ${waveform.file}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-strip-"));
  const tilePath = path.join(outDir, `.${path.basename(tmpDir)}.jpg`);
  try {
    let useLabel = await ffmpegHasDrawtext();
    let lastFailure = "";

    // ffmpeg reports "this seek found no frame" two ways — a non-zero exit, and exit 0 with nothing
    // written — and leaves whatever was already at the path untouched when it fails. So an attempt
    // clears its target first and then judges by the bytes that came back, and neither form escapes
    // as a raw ffmpeg dump.
    const tryFrame = async (
      t: number,
      framePath: string,
      label: string | null,
    ): Promise<boolean> => {
      rmSync(framePath, { force: true });
      try {
        await extractStripFrame(videoPath, t, framePath, label);
      } catch (err) {
        lastFailure = errorMessage(err);
        return false;
      }
      return hasBytes(framePath);
    };

    // A labeled attempt can fail for either of two unrelated reasons, and they call for opposite
    // responses: an ffmpeg build with no usable font fails every frame until labels are dropped,
    // while a seek past the last frame fails at this timestamp whether or not it is labeled. Retry
    // the same moment unlabeled to tell them apart — only its success convicts drawtext.
    //
    // `seekAt` is where the frame is read from, `labelAt` what gets burned in — they part only when a
    // step-back rescues a tile, and the label follows the *requested* moment so it agrees with the
    // timestamp this function returns (and returns again from cache on every later run).
    const tryFrameAt = async (
      seekAt: number,
      labelAt: number,
      framePath: string,
    ): Promise<boolean> => {
      if (!useLabel) return tryFrame(seekAt, framePath, null);
      if (await tryFrame(seekAt, framePath, `${labelAt.toFixed(2)}s`)) return true;
      if (!(await tryFrame(seekAt, framePath, null))) return false;
      useLabel = false;
      return true;
    };

    const interval = frameInterval(waveform.nativeFps);
    // Each tile is its own ffmpeg seek writing its own file, so they run several at a time. The
    // drawtext verdict is still shared: it only ever flips on a failure, so no tile that flipped it
    // kept its label and the sheet stays all-or-nothing labelled.
    await mapConcurrent(timestamps, FFMPEG_CONCURRENCY, async (at, i) => {
      const framePath = path.join(tmpDir, `frame-${String(i + 1).padStart(3, "0")}.jpg`);
      // Step back a frame at a time rather than fail the whole strip over one tile. The requested
      // timestamp is what gets reported and burned in either way: it is a pure function of the spec,
      // and the cached strip is returned with it on every later run, so a rescued tile must not make
      // this run's numbers disagree with the next one's over at most two frames.
      let landed = false;
      for (let back = 0; back <= MAX_SEEK_STEPBACK && !landed; back++) {
        const t = Math.max(0, at - back * interval);
        landed = await tryFrameAt(t, at, framePath);
        if (!landed && t === 0) break;
      }
      if (!landed) {
        throw new KonteError(
          "FFMPEG_ERROR",
          `ffmpeg produced no frame at ${at}s${lastFailure ? `: ${lastFailure}` : ""}`,
        );
      }
    });

    await tileStripFrames(tmpDir, timestamps.length, tilePath, outDir);
    await fs.rename(tilePath, outFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(tilePath, { force: true });
  }

  return { path: outFile, timestamps, window };
}

/**
 * A composition strip's sample times, on the shot's own fps grid. `full` spans the shot; otherwise
 * a window centered on `at`.
 */
export function compositionStripTimes(
  durationSec: number,
  fps: number,
  spec: MotionStripSpec,
): { timestamps: number[]; frames: number; start: number; end: number } {
  const full = spec.full ?? false;
  const frames = Math.max(2, spec.frames ?? (full ? DEFAULT_FULL_FRAMES : DEFAULT_PEAK_FRAMES));
  const interval = frameInterval(fps);
  const lastFrame = Math.max(0, Math.ceil(durationSec / interval - 1e-9) - 1);
  const lastFrameTime = lastFrame * interval;

  let start = 0;
  let end = lastFrameTime;
  if (!full) {
    if (spec.at == null) {
      throw new KonteError(
        "INVALID_OPTION",
        "A composition window needs --at: it has no motion peak",
      );
    }
    const win = spec.window ?? DEFAULT_WINDOW;
    start = Math.min(lastFrameTime, Math.max(0, spec.at - win / 2));
    end = Math.min(lastFrameTime, spec.at + win / 2);
  }

  const timestamps: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = start + ((end - start) * i) / (frames - 1);
    const frame = Math.min(lastFrame, Math.max(0, Math.round(t / interval)));
    const snapped = Math.round(frame * interval * 1e6) / 1e6;
    if (timestamps.at(-1) !== snapped) timestamps.push(snapped);
  }
  return { timestamps, frames, start, end };
}

// The strip for a shot's composition as the live definition draws it, clips included. Frames come
// from the composition-frame cache `probe reel-thumbnails` fills, keyed by the composition's content;
// the strip sits in that same hash dir, so a changed composition misses and `prune` reclaims both.
export async function renderCompositionMotionStrip(opts: {
  videoRoot: string;
  video: StageDefinition;
  manager: StateManager;
  shotId: string;
  spec: MotionStripSpec;
}): Promise<{ path: string; timestamps: number[]; window: { start: number; end: number } }> {
  const { videoRoot, video, manager, shotId, spec } = opts;
  const shot = shotById(video.shots, shotId);
  const outputDir = shotFrameDir(video, videoRoot, shotId);
  if (!shot || !outputDir) {
    throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" has no composition to capture`);
  }
  const {
    timestamps,
    frames: requested,
    start,
    end,
  } = compositionStripTimes(shot.duration, video.format.fps, spec);
  const window = { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };

  const frames = await captureCompositionFrames({
    video,
    manager,
    shotId,
    videoRoot,
    outputDir,
    captureOptions: {
      timestamps,
      format: COMPOSITION_FRAME_FORMAT,
      quality: COMPOSITION_FRAME_QUALITY,
      pruneSuperseded: true,
    },
  });
  const framePaths = frames.map((f) => path.resolve(videoRoot, f.file));
  const outDir = path.dirname(framePaths[0]!);
  // Keyed by the requested count: two counts can dedupe to as many frames at different times.
  const specStr = spec.full
    ? `full-f${requested}`
    : `at${Math.round(spec.at! * 1000)}ms-w${Math.round((end - start) * 1000)}ms-f${requested}`;
  const outFile = path.join(outDir, `strip-${specStr}.jpg`);
  if (hasBytes(outFile)) return { path: outFile, timestamps, window };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-strip-"));
  const tilePath = path.join(outDir, `.${path.basename(tmpDir)}.jpg`);
  try {
    let useLabel = await ffmpegHasDrawtext();
    await mapConcurrent(framePaths, FFMPEG_CONCURRENCY, async (source, i) => {
      const framePath = path.join(tmpDir, `frame-${String(i + 1).padStart(3, "0")}.jpg`);
      const tryFrame = async (label: string | null): Promise<boolean> => {
        rmSync(framePath, { force: true });
        try {
          await extractStripFrame(source, null, framePath, label);
        } catch {
          return false;
        }
        return hasBytes(framePath);
      };
      if (useLabel && (await tryFrame(`${timestamps[i]!.toFixed(2)}s`))) return;
      if (!(await tryFrame(null))) {
        throw new KonteError(
          "FFMPEG_ERROR",
          `ffmpeg could not scale the frame at ${timestamps[i]}s`,
        );
      }
      useLabel = false;
    });
    await tileStripFrames(tmpDir, framePaths.length, tilePath, outDir);
    await fs.rename(tilePath, outFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(tilePath, { force: true });
  }
  return { path: outFile, timestamps, window };
}
