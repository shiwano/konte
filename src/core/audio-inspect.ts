import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { formatAddress, formatTimelineAddress } from "./address.js";
import { isAssetPath } from "./composition-refs.js";
import {
  type AudioLevelling,
  clampEffectiveGain,
  cueKindsBySrc,
  isVoiceKind,
  loudnessOf,
  playedLufs,
  shotCueLevels,
} from "./audio-level.js";
import { buildDuckEnvelope, duckSettings, voiceTriggerSpan, type Span } from "./audio-duck.js";
import type { AudioLoudness } from "./audio-loudness.js";
import { parsePlaceholder, runTimelineInRenderMode } from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import { ffmpegBin } from "./ffmpeg-binary.js";
import { inferMediaType } from "./media-type.js";
import { computeBedLevels } from "./render-plan.js";
import type { StateManager } from "./state/index.js";
import {
  collectShotAudioCues,
  type RawShotAudio,
  resolveSoundtrackSpan,
  shouldAutoLoop,
} from "./timeline-audio.js";
import type { StageDefinition } from "./types/index.js";
import { probeMediaDuration } from "./video-probe.js";
import { execFileAsync } from "./exec-file.js";

// One audio track laid on the timeline, with its identity preserved (which shot/cue/bed it came
// from) — unlike the mux's MuxAudioTrack, which is anonymous. Times are timeline-absolute and
// NOMINAL: offsets accumulate from each shot's declared `duration`, not the ffprobed render. So
// this view is render-free (no shot .mp4 needed) and may differ from the final mux by the few ms
// of AAC priming/keyframe drift the real pipeline re-probes for.
export interface AudioTrack {
  kind: "sound" | "embedded" | "soundtrack";
  /** Concise human label, e.g. "01 sound" / "01 embedded" / "bed". */
  label: string;
  shotId: string | null;
  cueId: string | null;
  soundtrackId: string | null;
  /** Source media path, project-root-relative for display. */
  file: string;
  fileExists: boolean;
  /** Probed source length in seconds, or null when unreadable. */
  sourceDuration: number | null;
  /** For embedded tracks: whether the source video actually carries an audio stream. */
  hasAudioStream: boolean | null;
  start: number;
  end: number;
  mediaStart: number;
  /** Played length; null when the source is open-ended and its length couldn't be probed. */
  duration: number | null;
  /** The gain the mux writes: the declared volume with its levelling folded in. */
  volume: number;
  levelling: AudioLevelling;
  /** Whole-source LUFS plus effective gain, before trimming, fades and final mixing. */
  lufs: number | null;
  /** A ducking bed's level under the lines it yields to. Null when it ducks under none. */
  duckedLufs: number | null;
  loop: boolean;
  fadeIn?: number;
  fadeOut?: number;
  /** Per-bucket RMS amplitude over [start, end], normalized to 0-1 within the track. */
  envelope: number[];
  warnings: string[];
  notes: string[];
}

export interface AudioInspectModel {
  totalDuration: number;
  /** The slice of the timeline this model describes (the whole timeline, or one shot). */
  view: { start: number; end: number };
  shots: { shotId: string; start: number; end: number }[];
  tracks: AudioTrack[];
  notes: string[];
}

// The mux's own cue, tagged with the shot it was harvested from.
type RawPlacement = RawShotAudio & { shotId: string };

// A source still unresolved at inspect time renders as a `__konte:<stage>:<assetPath>__` placeholder
// rather than a file path. Surface it as the asset path ("not generated yet") instead of a bogus file.
function interpretSource(
  raw: string,
  videoRoot: string,
): { absFile: string; displayFile: string; isPlaceholder: boolean } {
  const m = raw.match(/^__konte:(.+)__$/);
  if (m) return { absFile: raw, displayFile: m[1]!, isPlaceholder: true };
  const absFile = path.isAbsolute(raw) ? raw : path.resolve(videoRoot, raw);
  return { absFile, displayFile: path.relative(videoRoot, absFile), isPlaceholder: false };
}

// A source's whole-file amplitude, decoded once and cached on disk. RMS at PROFILE_RATE Hz over the
// entire file (un-normalized, quantized) plus the audio-stream duration. `rms` is empty when the
// source carries no audio (so embedded "hasAudio" with a silent source is detectable here).
interface SourceProfile {
  durationSec: number | null;
  rate: number;
  rms: number[];
}

// Music sits 10-20 dB under dialogue.
const BURIED_UNDER_LINES_DB = 18;

/**
 * A bed nobody can hear. `heardLufs` is where the bed actually plays: under the lines when it
 * ducks. Null when there are no lines to be under, or the bed's source was never measured.
 */
export function buriedBedWarning(
  voiceLufs: readonly number[],
  heardLufs: number | null,
): string | null {
  if (voiceLufs.length === 0 || heardLufs == null) return null;
  const under = Math.max(...voiceLufs) - heardLufs;
  if (under <= BURIED_UNDER_LINES_DB) return null;
  return `${under.toFixed(0)} dB under the lines at ${heardLufs.toFixed(1)} LUFS — inaudible; raise its \`volume\``;
}

const DECODE_RATE = 4000; // ffmpeg PCM rate before reduction
const PROFILE_RATE = 100; // stored RMS buckets per second
const PROFILE_SCALE = 1000; // integer quantization for the on-disk array

// Every audio source a user can author resolves, in render mode, to a variant's committed file —
// `asset()` returns either that resolved file or an unresolved placeholder (handled
// separately), and `makeMediaAsset` (literal paths) is internal-only, never exposed in the DSL. So a
// resolved, on-disk source always has a backing variant; its absence is an invariant violation.
function requireVariant(
  absFile: string,
  fileToVariant: Map<string, { variantId: string; outputHash: string | null }>,
): { variantId: string; outputHash: string | null } {
  const variant = fileToVariant.get(absFile);
  if (!variant) {
    throw new KonteError(
      "VARIANT_NOT_FOUND",
      `No variant backs the resolved audio source: ${absFile}`,
    );
  }
  return variant;
}

function getVariantSourceProfile(
  absFile: string,
  fileToVariant: Map<string, { variantId: string; outputHash: string | null }>,
  videoRoot: string,
  memo: Map<string, SourceProfile | null>,
): Promise<SourceProfile | null> {
  const v = requireVariant(absFile, fileToVariant);
  return getSourceProfile(absFile, v.variantId, v.outputHash, videoRoot, memo);
}

async function decodeSourceProfile(absFile: string): Promise<SourceProfile | null> {
  const args = [
    "-v",
    "quiet",
    "-i",
    absFile,
    "-map",
    "0:a:0?",
    "-ac",
    "1",
    "-ar",
    String(DECODE_RATE),
    "-f",
    "s16le",
    "-",
  ];

  let buf: Buffer;
  try {
    const ffmpeg = await ffmpegBin();
    const res = await execFileAsync(ffmpeg, args, { encoding: "buffer" });
    buf = res.stdout;
  } catch {
    return null;
  }

  const n = Math.floor(buf.length / 2);
  if (n === 0)
    return { durationSec: await probeMediaDuration(absFile), rate: PROFILE_RATE, rms: [] };

  const per = DECODE_RATE / PROFILE_RATE;
  const buckets = Math.ceil(n / per);
  const sum = new Array<number>(buckets).fill(0);
  const count = new Array<number>(buckets).fill(0);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    const b = Math.floor(i / per);
    sum[b] = (sum[b] ?? 0) + s * s;
    count[b] = (count[b] ?? 0) + 1;
  }
  // Quantize here, not only on write, so a fresh decode and a cache read yield byte-identical
  // amplitudes — the rendered waveform never shifts between a cold and a warm run.
  const rms = sum.map((v, b) => {
    const c = count[b] ?? 0;
    const r = c ? Math.sqrt(v / c) : 0;
    return Math.round(Math.min(1, r) * PROFILE_SCALE) / PROFILE_SCALE;
  });
  return { durationSec: n / DECODE_RATE, rate: PROFILE_RATE, rms };
}

// The whole-file amplitude profile for a source, served from (in order) the per-run memo, the disk
// cache (`.konte/cache/audio/<key>.json`), or a fresh decode that is then cached. No file paths or secrets
// are persisted — only the duration and the amplitude array.
async function getSourceProfile(
  absFile: string,
  variantId: string,
  outputHash: string | null,
  videoRoot: string,
  memo: Map<string, SourceProfile | null>,
): Promise<SourceProfile | null> {
  if (memo.has(absFile)) return memo.get(absFile) ?? null;

  // Key the cache on `<variantId>/<outputHash>` so a variant whose bytes change (a swapped
  // `file` asset) misses on the new hash, while clean/prune still delete by variantId.
  // A null hash (source file missing) can't be keyed, so skip the disk cache entirely.
  const cacheFile = outputHash
    ? path.join(videoRoot, ".konte", "cache", "audio", variantId, `${outputHash}.json`)
    : null;

  if (cacheFile && existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(readFileSync(cacheFile, "utf-8")) as {
        durationSec: number | null;
        rate: number;
        rms: number[];
      };
      const profile: SourceProfile = {
        durationSec: raw.durationSec,
        rate: raw.rate,
        rms: raw.rms.map((v) => v / PROFILE_SCALE),
      };
      memo.set(absFile, profile);
      return profile;
    } catch {
      // corrupt cache: fall through and re-decode
    }
  }

  const profile = await decodeSourceProfile(absFile);
  if (profile && cacheFile) {
    try {
      pruneSupersededAudioHashes(videoRoot, variantId, outputHash as string);
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(
        cacheFile,
        JSON.stringify({
          durationSec: profile.durationSec,
          rate: profile.rate,
          rms: profile.rms.map((v) => Math.round(Math.min(1, v) * PROFILE_SCALE)),
        }),
      );
    } catch {
      // best-effort cache; its absence just means a re-decode next time
    }
  }
  memo.set(absFile, profile);
  return profile;
}

// Sweep sibling hash files (superseded bytes) for this variant, mirroring the thumbnail
// cache's pruneSuperseded — clean is variant-scoped and won't reclaim them otherwise.
function pruneSupersededAudioHashes(
  videoRoot: string,
  variantId: string,
  currentHash: string,
): void {
  const variantDir = path.join(videoRoot, ".konte", "cache", "audio", variantId);
  try {
    for (const entry of readdirSync(variantDir)) {
      if (entry !== `${currentHash}.json`) {
        rmSync(path.join(variantDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // best-effort GC of stale audio caches
  }
}

function envelopeBuckets(duration: number): number {
  return Math.max(8, Math.min(480, Math.round(duration * 40)));
}

// Slice the played region [mediaStart, mediaStart+duration] out of a source profile into `buckets`
// peak-of-RMS samples, normalized within the slice. Looping wraps the source to fill the span. All
// in-memory — the expensive decode already happened in getSourceProfile.
function sliceEnvelope(
  profile: SourceProfile,
  mediaStart: number,
  duration: number,
  loop: boolean,
  buckets: number,
): number[] {
  const out = new Array<number>(buckets).fill(0);
  const src = profile.rms;
  const len = src.length;
  if (len === 0 || duration <= 0 || buckets <= 0) return out;

  const startIdx = mediaStart * profile.rate;
  const spanIdx = duration * profile.rate;
  for (let bkt = 0; bkt < buckets; bkt++) {
    const lo = Math.floor(startIdx + (bkt / buckets) * spanIdx);
    const hi = Math.max(lo + 1, Math.floor(startIdx + ((bkt + 1) / buckets) * spanIdx));
    let m = 0;
    for (let i = lo; i < hi; i++) {
      const idx = loop ? ((i % len) + len) % len : i;
      if (idx < 0 || idx >= len) continue;
      const v = src[idx]!;
      if (v > m) m = v;
    }
    out[bkt] = m;
  }
  const peak = Math.max(...out);
  return peak > 0 ? out.map((v) => v / peak) : out;
}

interface AudioWarning {
  type: string;
  message: string;
}

// A bucket counts as audible when its RMS clears both floors: the absolute one, which catches true
// digital silence, and one relative to the file's own peak, which gates a low-level noise tail under
// loud content. The relative term only ever raises the bar — below a peak of ~0.32 the absolute floor
// is what applies. Both sit far below anything a listener calls quiet: raising them makes a faint
// ambience (~-44 dBFS) read as silent and cuts a decaying transient off at its attack.
const SILENCE_ABS_FLOOR = 0.0018; // -55 dBFS
const SILENCE_REL = 0.0056; // -45 dB below the file's peak
// Don't flag a head/tail gap shorter than this — a short lead-in or a tail of decay is normal.
const MIN_EDGE_SILENCE = 1.5;

// Detect leading/trailing silence (and a wholly silent file) in a whole-file RMS envelope: bound the
// audible span by the first/last bucket above the floor, and flag a silent head or tail longer than
// MIN_EDGE_SILENCE. Music models like ACE-Step routinely end a generation seconds early, leaving a
// silent tail under the requested duration; a hard, cross-clip-comparable warning lets a self-review
// catch "the last N seconds are silent" without eyeballing the sparkline. Pure — unit-tested directly.
export function summarizeAudioSilence(
  rms: number[],
  rate: number,
  durationSec: number | null,
): AudioWarning[] {
  const warnings: AudioWarning[] = [];
  if (rms.length === 0 || rate <= 0) return warnings;

  const total = durationSec != null && durationSec > 0 ? durationSec : rms.length / rate;
  const peak = Math.max(...rms);
  const threshold = Math.max(SILENCE_ABS_FLOOR, peak * SILENCE_REL);

  let firstAudible = -1;
  let lastAudible = -1;
  for (let i = 0; i < rms.length; i++) {
    if ((rms[i] ?? 0) > threshold) {
      if (firstAudible < 0) firstAudible = i;
      lastAudible = i;
    }
  }

  if (firstAudible < 0) {
    warnings.push({
      type: "silent",
      message: `No audible signal above the noise floor — the whole ${total.toFixed(1)}s file is silent.`,
    });
    return warnings;
  }

  const contentStart = firstAudible / rate;
  const contentEnd = (lastAudible + 1) / rate;

  if (contentStart >= MIN_EDGE_SILENCE) {
    warnings.push({
      type: "leading_silence",
      message: `leading silence: ${contentStart.toFixed(1)}s (audio starts at ${contentStart.toFixed(
        1,
      )}s / ${total.toFixed(1)}s)`,
    });
  }
  const trailing = total - contentEnd;
  if (trailing >= MIN_EDGE_SILENCE) {
    warnings.push({
      type: "trailing_silence",
      message: `trailing silence: ${trailing.toFixed(1)}s (audio ends at ${contentEnd.toFixed(
        1,
      )}s / ${total.toFixed(1)}s)`,
    });
  }
  return warnings;
}

/** One stretch of audible sound inside a file, in seconds from its start. */
export interface AudibleSpan {
  start: number;
  end: number;
}

// Gaps shorter than this join the spans either side: a stop consonant or a comma pause inside one
// sentence drops under the floor for a moment, and splitting there reports a spoken line as a dozen
// spans.
const MIN_SPAN_GAP = 0.25;

// Where the sound sits, as spans. A take padded out past the content it had comes back as several
// with both its edges short — the shape summarizeAudioSilence cannot see. Reported, never warned
// on: a pause inside one spoken line and a model saying that line twice are the same shape here,
// and only the words tell them apart. The floor is summarizeAudioSilence's, so "audible" means the
// same in both. Pure — unit-tested.
export function detectAudibleSpans(rms: number[], rate: number): AudibleSpan[] {
  if (rms.length === 0 || rate <= 0) return [];
  const peak = Math.max(...rms);
  if (peak <= 0) return [];
  const threshold = Math.max(SILENCE_ABS_FLOOR, peak * SILENCE_REL);

  const spans: AudibleSpan[] = [];
  let open: { start: number; end: number } | null = null;
  for (let i = 0; i < rms.length; i++) {
    if ((rms[i] ?? 0) <= threshold) continue;
    const start = i / rate;
    const end = (i + 1) / rate;
    if (open && start - open.end < MIN_SPAN_GAP) open.end = end;
    else {
      if (open) spans.push(open);
      open = { start, end };
    }
  }
  if (open) spans.push(open);
  return spans;
}

interface AudioOnset {
  /** Seconds from the file's start to its first audible bucket. */
  startSec: number;
  /** Seconds from the file's start to its loudest bucket. */
  peakSec: number;
}

// Where the sound actually sits inside a file: its first audible sample and its loudest one. A
// generated SFX rarely starts at 0, so placing a cue on a frame means offsetting by that lead-in —
// `<Sound start>` = target time − startSec (− peakSec instead when a percussive attack, not the
// first breath of it, is what must land on the frame). Reading it off the sparkline is eyeballing;
// this is the number. Resolution is one bucket (1/rate s), and the floor is summarizeAudioSilence's,
// so "audible" means the same thing in both. Null for a silent or empty envelope. Pure — unit-tested.
export function detectAudioOnset(rms: number[], rate: number): AudioOnset | null {
  if (rms.length === 0 || rate <= 0) return null;
  const peak = Math.max(...rms);
  if (peak <= 0) return null;
  const threshold = Math.max(SILENCE_ABS_FLOOR, peak * SILENCE_REL);

  let first = -1;
  let peakIdx = 0;
  for (let i = 0; i < rms.length; i++) {
    const v = rms[i] ?? 0;
    if (first < 0 && v > threshold) first = i;
    if (v > (rms[peakIdx] ?? 0)) peakIdx = i;
  }
  if (first < 0) return null;
  return { startSec: first / rate, peakSec: peakIdx / rate };
}

// A window edge is only a click when the sound it lands on is loud, so this floor sits well above
// summarizeAudioSilence's audible one: a decaying tail crossing the boundary at -45 dB is inaudible
// where a vowel at -14 dB is a pop. Measured against the source's own peak, so it travels between
// takes of different levels.
const CUT_LEVEL_REL = 0.0178; // -35 dB below the source's peak
// One bucket over the floor is a transient, not a cut worth reporting.
const MIN_CUT_RUN = 0.05;

// A `<Audio>` window laid across sound that is still running. The take itself plays whole, so
// nothing in it reads as short — the cut happens in the composition, where the model that made it
// cannot be asked about it. Both edges: `duration` too small for the line leaves its tail unplayed,
// `mediaStart` too large opens inside the first syllable. Judged on the WHOLE source (the played
// slice cannot see what lies past its own end), and skipped for a looping bed, whose seam is the
// loop's own business. Pure — unit-tested directly.
export function detectWindowCuts(
  rms: number[],
  rate: number,
  mediaStart: number,
  duration: number | null,
  fades: { fadeIn?: number; fadeOut?: number } = {},
): (AudioWarning & { informational: boolean })[] {
  if (rms.length === 0 || rate <= 0 || duration == null || duration <= 0) return [];
  const peak = Math.max(...rms);
  if (peak <= 0) return [];
  const floor = Math.max(SILENCE_ABS_FLOOR, peak * CUT_LEVEL_REL);
  const run = Math.max(1, Math.round(MIN_CUT_RUN * rate));
  const loud = (i: number) => i >= 0 && i < rms.length && (rms[i] ?? 0) > floor;
  const dbBelowPeak = (v: number) => 20 * Math.log10(Math.max(v, 1e-6) / peak);

  const warnings: (AudioWarning & { informational: boolean })[] = [];
  const fadedIn = (fades.fadeIn ?? 0) > 0;
  const fadedOut = fades.fadeOut != null && fades.fadeOut > 0 && fades.fadeOut <= duration;
  const head = Math.round(mediaStart * rate);
  const tail = Math.round((mediaStart + duration) * rate);

  // Sound running continuously across an edge — audible on both sides for MIN_CUT_RUN either way.
  const spans = (from: number, step: number) => {
    for (let k = 0; k < run; k++) if (!loud(from + k * step)) return false;
    return true;
  };

  if (head > 0 && spans(head, 1) && spans(head - 1, -1)) {
    let before = 0;
    for (let i = head - 1; i >= 0 && loud(i); i--) before++;
    warnings.push({
      type: "window_opens_mid_sound",
      informational: fadedIn,
      message:
        `window opens mid-sound at ${(head / rate).toFixed(2)}s into the source ` +
        `(${dbBelowPeak(rms[head] ?? 0).toFixed(0)} dB below peak): ` +
        `${(before / rate).toFixed(2)}s of source audio precedes the window. ` +
        (fadedIn
          ? `fadeIn ${fades.fadeIn}s applied; this is a source boundary, not a measured output discontinuity.`
          : "No fadeIn; listen to the entrance before changing duration or mediaStart."),
    });
  }
  if (tail < rms.length && spans(tail, 1) && spans(tail - 1, -1)) {
    let after = 0;
    for (let i = tail; i < rms.length && loud(i); i++) after++;
    warnings.push({
      type: "window_cuts_mid_sound",
      informational: fadedOut,
      message:
        `window cuts mid-sound at ${(tail / rate).toFixed(2)}s into the source ` +
        `(${dbBelowPeak(rms[tail - 1] ?? 0).toFixed(0)} dB below peak): ` +
        `${(after / rate).toFixed(2)}s more follows in the source. ` +
        (fadedOut
          ? `fadeOut ${fades.fadeOut}s reaches silence at the window end; this is a source boundary, not a measured output discontinuity.`
          : "No completed fadeOut; listen to the exit before changing duration or shortening the line."),
    });
  }
  return warnings;
}

// Cut the region a track actually plays out of its source as raw (un-normalized) RMS at the profile
// rate, so summarizeAudioSilence judges what the mux will hear rather than the whole file — a clip
// trimmed with `mediaStart` must not read as "leading silence". A non-loop track plays
// [mediaStart, mediaStart+duration) and is zero-padded where the source runs out first: that underrun
// is silence on the timeline, not an absence of samples. A looped one repeats the whole source, the
// unit sliceEnvelope wraps and the mux replays, so a silent tail there recurs on every lap.
export function playedRms(
  profile: SourceProfile,
  mediaStart: number,
  duration: number | null,
  loop: boolean,
): number[] {
  if (loop) return profile.rms;
  if (duration == null || duration <= 0) return [];
  const lo = Math.max(0, Math.round(mediaStart * profile.rate));
  const played = new Array<number>(Math.round(duration * profile.rate)).fill(0);
  for (let i = 0; i < played.length; i++) played[i] = profile.rms[lo + i] ?? 0;
  return played;
}

// One source file's whole-file amplitude plus its identity in state. The waveform shares the same
// per-variant cache the timeline inspector fills (`.konte/cache/audio/<variantId>.json`).
interface SourceWaveform {
  variantId: string;
  address: string;
  /** Variant file path as stored in state (project-root-relative). */
  file: string;
  status: string;
  durationSec: number | null;
  /** Samples per second of `rms`. */
  rate: number;
  hasAudio: boolean;
  /** Whole-file RMS amplitude (un-normalized 0-1). Empty when the source carries no audio. */
  rms: number[];
  /** Where the sound sits inside the file; null when it carries none. */
  onset: AudioOnset | null;
  /** The audible stretches, in file order. One span is a continuous source; empty when silent. */
  spans: AudibleSpan[];
  /** Observational warnings — leading/trailing/whole-file silence. */
  warnings: AudioWarning[];
}

// Load a single variant's waveform by id, for `konte probe audio <variantId>`. Throws VARIANT_NOT_FOUND
// when the id is unknown or has no committed file, and ASSET_NOT_FOUND when that file is missing.
export async function loadSourceWaveform(opts: {
  manager: StateManager;
  videoRoot: string;
  variantId: string;
}): Promise<SourceWaveform> {
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

  const profile = await getSourceProfile(
    absFile,
    variantId,
    variant.outputHash ?? null,
    videoRoot,
    new Map(),
  );
  const rms = profile?.rms ?? [];
  const rate = profile?.rate ?? PROFILE_RATE;
  const durationSec = profile?.durationSec ?? null;
  return {
    variantId,
    address,
    file: variant.file,
    status: variant.status,
    durationSec,
    rate,
    hasAudio: rms.length > 0,
    rms,
    onset: detectAudioOnset(rms, rate),
    spans: detectAudibleSpans(rms, rate),
    warnings: summarizeAudioSilence(rms, rate, durationSec),
  };
}

// Build the audio inspection model for a video. Resolution is best-effort: a shot whose visual
// variant isn't generated yet still contributes its audio (file()-backed `<Audio>` sources resolve
// regardless of state), so audio timing is inspectable before any video is rendered.
export async function inspectTimelineAudio(opts: {
  video: StageDefinition;
  manager: StateManager;
  videoRoot: string;
  shotId?: string;
}): Promise<AudioInspectModel> {
  const { video, manager, videoRoot, shotId } = opts;
  const size = video.format.size;

  // Nominal offsets/durations over the WHOLE timeline — needed even for a single-shot view so a
  // soundtrack's from/until anchors (which may reference other shots) resolve correctly.
  const offsets = new Map<string, number>();
  const durations = new Map<string, number>();
  const shotSpans: { shotId: string; start: number; end: number }[] = [];
  let acc = 0;
  for (const shot of video.shots) {
    offsets.set(shot.id, acc);
    durations.set(shot.id, shot.duration);
    shotSpans.push({ shotId: shot.id, start: acc, end: acc + shot.duration });
    acc += shot.duration;
  }
  const totalDuration = acc;

  // Every resolved source is a variant's committed file; remember its variant id and output hash
  // so the waveform cache can key on `<variantId>/<outputHash>` rather than on the file path.
  const fileToVariant = new Map<string, { variantId: string; outputHash: string | null }>();
  // Loudness rides along: it is what a duck aims off.
  const loudnessByFile = new Map<string, AudioLoudness | undefined>();
  const resolveFile = (address: string): string | null => {
    const r = manager.resolveReference(address);
    if (r) {
      fileToVariant.set(r.file, { variantId: r.variantId, outputHash: r.outputHash });
      loudnessByFile.set(
        r.file,
        loudnessOf(manager.getState().assets[address]?.variants?.[r.variantId]?.media),
      );
    }
    return r?.file ?? null;
  };

  // An audio source may still be a placeholder — a `<Soundtrack src={reference.bgm}/>` bed, a
  // `<Sound src={reference.sfx}/>` cue pulled in by closure, or a `<Video src={shot(…).x} hasAudio>`
  // stem. The render pass only re-resolves a shot's own assets, so resolve the rest from state. A
  // src that is not a placeholder (a real file path) is returned untouched.
  const resolveAssetSrc = (src: string): string => {
    const assetPath = parsePlaceholder(src);
    if (assetPath === null || !isAssetPath(assetPath)) return src;
    // A dependency path IS its upstream address (address ≡ asset path).
    return resolveFile(assetPath) ?? src;
  };

  // Run the timeline in render mode (resolving what's available) to get the shot render fns and the
  // resolved soundtrack list — exactly as the final mux does.
  const timelineResolvedFiles: Record<string, string> = {};
  const timelineResolvedVariants: Record<string, string> = {};
  if (video.topLevelAssets) {
    for (const name of Object.keys(video.topLevelAssets)) {
      const file = resolveFile(formatTimelineAddress(video.stage, name));
      if (!file) continue;
      timelineResolvedFiles[name] = file;
      const variantId = fileToVariant.get(file)?.variantId;
      if (variantId) timelineResolvedVariants[name] = variantId;
    }
  }
  const timelineRun = video.timelineFn
    ? runTimelineInRenderMode(
        video.stage,
        () => video.timelineFn!({ format: video.format }),
        timelineResolvedFiles,
        timelineResolvedFiles,
      )
    : null;
  const renderShotInputs = timelineRun?.shots ?? null;
  const soundtracks = timelineRun?.soundtracks ?? video.timelineSoundtracks ?? [];
  const bedLevels = computeBedLevels(video, manager, timelineResolvedVariants);

  // Collect every shot's standalone placements.
  const placements: RawPlacement[] = [];
  for (const shot of video.shots) {
    const resolvedFiles: Record<string, string> = {};
    const resolvedVariants: Record<string, string> = {};
    for (const assetName of Object.keys(shot.assets)) {
      const file = resolveFile(formatAddress(video.stage, shot.id, assetName));
      if (!file) continue;
      resolvedFiles[assetName] = file;
      const variantId = fileToVariant.get(file)?.variantId;
      if (variantId) resolvedVariants[assetName] = variantId;
    }

    if (shot.shotFn) {
      const renderFn = renderShotInputs?.find((s) => s.id === shot.id)?.fn ?? shot.shotFn;
      placements.push(
        ...collectShotAudioCues({
          stage: video.stage,
          shotId: shot.id,
          duration: shot.duration,
          renderFn,
          size,
          resolvedFiles,
          timelineFiles: timelineResolvedFiles,
          cueLevels: shotCueLevels({
            stage: video.stage,
            shotId: shot.id,
            cueKinds: shot.cueKinds,
            pictureRefs: shot.pictureRefs,
            state: manager.getState(),
            resolvedVariants,
            timelineResolvedVariants,
            resolve: (address) => manager.resolveReference(address)?.variantId,
          }),
          cueKinds: cueKindsBySrc({
            stage: video.stage,
            shotId: shot.id,
            cueKinds: shot.cueKinds,
            resolvedFiles,
            timelineFiles: timelineResolvedFiles,
          }),
          // A read surface: a shot that fails to render contributes nothing rather than blanking
          // the timeline.
          onRenderError: "skip",
        }).map((cue) => ({ ...cue, shotId: shot.id })),
      );
    } else {
      // Fallback shot: its full-frame video may carry audio the mux keeps as an embedded track.
      const fallback = Object.values(resolvedFiles)[0];
      if (fallback && inferMediaType(fallback) === "video") {
        placements.push({
          role: "embedded",
          // No composition, so no cue to classify: this track is in the mix but ducks nothing.
          kind: undefined,
          shotId: shot.id,
          file: fallback,
          localStart: 0,
          localEnd: null,
          mediaStart: 0,
          volume: 1,
          cueId: null,
        });
      }
    }
  }

  const tracks: AudioTrack[] = [];
  const profileMemo = new Map<string, SourceProfile | null>();
  // Where the lines sit, and how loud — what a ducking bed yields to, and what "audible" is
  // measured against. Kept per line: a bed is only under the lines it overlaps.
  const voices: Array<Span & { lufs: number | null }> = [];

  for (const raw of placements) {
    const { absFile, displayFile, isPlaceholder } = interpretSource(
      resolveAssetSrc(raw.file),
      videoRoot,
    );
    const fileExists = !isPlaceholder && existsSync(absFile);
    const sourceProfile = fileExists
      ? await getVariantSourceProfile(absFile, fileToVariant, videoRoot, profileMemo)
      : null;
    const sourceDuration = sourceProfile?.durationSec ?? null;
    const hasAudioStream =
      raw.role === "embedded" ? (sourceProfile ? sourceProfile.rms.length > 0 : false) : null;

    const offset = offsets.get(raw.shotId) ?? 0;
    const shotDur = durations.get(raw.shotId) ?? 0;
    const start = offset + raw.localStart;

    let duration: number | null;
    if (raw.localEnd != null) {
      duration = Math.max(0, raw.localEnd - raw.localStart);
    } else if (raw.role === "embedded") {
      duration = Math.max(0, shotDur - raw.localStart);
    } else {
      duration = sourceDuration != null ? Math.max(0, sourceDuration - raw.mediaStart) : null;
    }
    const end = start + (duration ?? 0);

    const warnings: string[] = [];
    const notes: string[] = [];
    if (isPlaceholder) warnings.push("not generated yet");
    else if (!fileExists) warnings.push(`source not found: ${displayFile}`);
    if (raw.role === "embedded" && fileExists && hasAudioStream === false) {
      warnings.push("no audio stream (dropped from the mux)");
    }
    if (duration == null) warnings.push("unknown duration (source unreadable)");
    if (end > totalDuration + 0.01) {
      warnings.push(`extends ${(end - totalDuration).toFixed(2)}s past timeline end`);
    }
    if (sourceProfile) {
      const played = playedRms(sourceProfile, raw.mediaStart, duration, false);
      for (const w of summarizeAudioSilence(played, sourceProfile.rate, null)) {
        warnings.push(w.message);
      }
      for (const w of detectWindowCuts(
        sourceProfile.rms,
        sourceProfile.rate,
        raw.mediaStart,
        duration,
        raw,
      )) {
        (w.informational ? notes : warnings).push(w.message);
      }
    }

    const buckets = envelopeBuckets(duration ?? 0);
    const drawable = sourceProfile != null && duration != null && duration > 0;
    const envelope = drawable
      ? sliceEnvelope(sourceProfile, raw.mediaStart, duration!, false, buckets)
      : new Array<number>(buckets).fill(0);

    const lufs = playedLufs(loudnessByFile.get(absFile), raw.volume);
    if (isVoiceKind(raw.kind) && duration != null && duration > 0) {
      const trigger = voiceTriggerSpan({
        start,
        end,
        mediaStart: raw.mediaStart,
        leadInSec: loudnessByFile.get(absFile)?.leadInSec,
      });
      if (trigger) voices.push({ ...trigger, lufs });
    }

    tracks.push({
      kind: raw.role,
      label: `${raw.shotId} ${raw.role}`,
      shotId: raw.shotId,
      cueId: raw.cueId,
      soundtrackId: null,
      file: displayFile,
      fileExists,
      sourceDuration,
      hasAudioStream,
      start,
      end,
      mediaStart: raw.mediaStart,
      duration,
      volume: raw.volume,
      levelling: raw.levelling ?? { gain: 1, reason: "unclassified" },
      lufs,
      duckedLufs: null,
      loop: false,
      fadeIn: raw.fadeIn,
      fadeOut: raw.fadeOut,
      envelope,
      warnings,
      notes,
    });
  }

  for (const st of soundtracks) {
    const { absFile, displayFile, isPlaceholder } = interpretSource(
      resolveAssetSrc(st.src.src),
      videoRoot,
    );
    const fileExists = !isPlaceholder && existsSync(absFile);
    const sourceProfile = fileExists
      ? await getVariantSourceProfile(absFile, fileToVariant, videoRoot, profileMemo)
      : null;
    const sourceDuration = sourceProfile?.durationSec ?? null;
    const mediaStart = st.options.mediaStart ?? 0;
    const level = bedLevels[st.id];
    const volume = clampEffectiveGain((st.options.volume ?? 1) * (level?.gain ?? 1));

    const { start, end } = resolveSoundtrackSpan(st.options, offsets, durations, totalDuration);
    const duration = Math.max(0, end - start);
    if (duration <= 0) continue;

    // The duck the mux will apply, resolved off the same take.
    const loudness = loudnessByFile.get(absFile);
    const settings = duckSettings(st.options.duck, { volume, loudness });
    const ducks =
      settings != null &&
      buildDuckEnvelope({ bed: { start, end }, triggers: voices, settings }).length > 0;
    const lufs = playedLufs(loudness, volume);
    const duckedLufs = ducks && settings ? playedLufs(loudness, volume * settings.depth) : null;

    const loop =
      st.options.loop ??
      (sourceDuration != null && shouldAutoLoop(sourceDuration - mediaStart, duration));

    const warnings: string[] = [];
    const notes: string[] = [];
    if (isPlaceholder) warnings.push("not generated yet");
    else if (!fileExists) warnings.push(`source not found: ${displayFile}`);
    if (loop && sourceDuration != null) {
      const reps = Math.ceil(duration / Math.max(0.01, sourceDuration - mediaStart));
      warnings.push(
        `loops ×${reps} to fill ${duration.toFixed(1)}s span (source ${sourceDuration.toFixed(2)}s)`,
      );
    }
    if (sourceProfile) {
      const played = playedRms(sourceProfile, mediaStart, duration, loop);
      for (const w of summarizeAudioSilence(played, sourceProfile.rate, null)) {
        warnings.push(
          loop && w.type === "trailing_silence" ? `${w.message} — replays every loop` : w.message,
        );
      }
      if (!loop) {
        for (const w of detectWindowCuts(
          sourceProfile.rms,
          sourceProfile.rate,
          mediaStart,
          duration,
          st.options,
        )) {
          (w.informational ? notes : warnings).push(w.message);
        }
      }
    }

    const buckets = envelopeBuckets(duration);
    const envelope =
      sourceProfile != null && duration > 0
        ? sliceEnvelope(sourceProfile, mediaStart, duration, loop, buckets)
        : new Array<number>(buckets).fill(0);

    tracks.push({
      kind: "soundtrack",
      label: st.id,
      shotId: null,
      cueId: null,
      soundtrackId: st.id,
      file: displayFile,
      fileExists,
      sourceDuration,
      hasAudioStream: null,
      start,
      end,
      mediaStart,
      duration,
      volume,
      levelling: level?.adjustment ?? { gain: 1, reason: "unmeasured" },
      lufs,
      duckedLufs,
      loop,
      fadeIn: st.options.fadeIn,
      fadeOut: st.options.fadeOut,
      envelope,
      warnings,
      notes,
    });
  }

  for (const t of tracks) {
    if (t.kind !== "soundtrack") continue;
    // Only the lines this bed actually plays under.
    const under = voices
      .filter((v) => v.lufs != null && v.end > t.start && v.start < t.end)
      .map((v) => v.lufs!);
    const buried = buriedBedWarning(under, t.duckedLufs ?? t.lufs);
    if (buried) t.warnings.push(buried);
  }

  tracks.sort((a, b) => a.start - b.start || a.end - b.end);

  // View window: the whole timeline, or one shot's span.
  let view = { start: 0, end: totalDuration };
  let visible = tracks;
  if (shotId) {
    const span = shotSpans.find((s) => s.shotId === shotId);
    if (span) {
      view = { start: span.start, end: span.end };
      visible = tracks.filter((t) => t.end > view.start + 0.001 && t.start < view.end - 0.001);
    }
  }

  return {
    totalDuration,
    view,
    shots: shotId ? shotSpans.filter((s) => s.shotId === shotId) : shotSpans,
    tracks: visible,
    notes: describeGainOverlap(visible.filter(isMuxed)),
  };
}

function isMuxed(t: AudioTrack): boolean {
  return t.fileExists && t.hasAudioStream !== false;
}

function describeGainOverlap(tracks: AudioTrack[]): string[] {
  const bounds = new Set<number>();
  for (const t of tracks) {
    bounds.add(t.start);
    bounds.add(t.end);
  }
  const points = [...bounds].sort((a, b) => a - b);
  const hot: { start: number; end: number; peak: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b - a < 0.001) continue;
    const mid = (a + b) / 2;
    let sum = 0;
    let n = 0;
    for (const t of tracks) {
      if (t.start <= mid && mid < t.end) {
        sum += t.volume;
        n += 1;
      }
    }
    if (n >= 2 && sum > 1.0) {
      const last = hot[hot.length - 1];
      if (last && Math.abs(last.end - a) < 0.001) {
        last.end = b;
        last.peak = Math.max(last.peak, sum);
      } else {
        hot.push({ start: a, end: b, peak: sum });
      }
    }
  }
  return hot.map(
    (h) =>
      `effective gain sum ${h.peak.toFixed(1)} at ${h.start.toFixed(1)}s–${h.end.toFixed(1)}s ` +
      "(includes automatic levelling; excludes source amplitudes, fades and ducking; clipping and limiter reduction are unmeasured)",
  );
}
