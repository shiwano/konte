// What a song take's audio says about its own clock, read off mono PCM and the beats and bar heads
// Beat This! hears in it: the meter it plays in, which beat is beat 0, where its texture changes
// enough to be a section boundary, and — from a separated vocal track — where the singing starts and
// stops. Pure arithmetic over samples; decoding, separation and beat tracking are the caller's.

// The rate the analysis reads at: 10ms frames, a 1024-sample window (43ms) that resolves a kick
// from the bass under it.
export const ANALYSIS_RATE = 24000;
const HOP = 240;
const WINDOW = 1024;
const FRAME_RATE = ANALYSIS_RATE / HOP;
// A frame's time is its window's centre.
const FRAME_CENTER_SEC = WINDOW / 2 / ANALYSIS_RATE;
const secFrame = (sec: number): number => (sec - FRAME_CENTER_SEC) * FRAME_RATE;

// The meter a take is read in when it has too few bar heads to count one.
const DEFAULT_BEATS_PER_BAR = 4;

export type SongBeatReading = {
  // Take-seconds of every beat, ascending.
  beats: number[];
  // The index in `beats` of beat 0, the first bar head at or after the first sound.
  firstBeat: number;
  beatsPerBar: number;
  // Take-seconds where the texture changes most, each on a bar head, strongest first.
  sectionSecs: number[];
  durationSec: number;
};

export type SungPhrase = { startSec: number; endSec: number };

// ── FFT ──────────────────────────────────────────────────────────────────────────────────────────

function fftInPlace(re: Float64Array, im: Float64Array): void {
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
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b]! * curRe - im[b]! * curIm;
        const tIm = re[b]! * curIm + im[b]! * curRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// The log-compressed magnitude spectrum of every frame, and each frame's RMS.
function spectrogram(samples: Float32Array): { frames: Float64Array[]; rms: Float64Array } {
  const count = Math.max(0, Math.floor((samples.length - WINDOW) / HOP) + 1);
  const window = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
  const frames: Float64Array[] = [];
  const rms = new Float64Array(count);
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  for (let f = 0; f < count; f++) {
    let energy = 0;
    for (let i = 0; i < WINDOW; i++) {
      const s = samples[f * HOP + i]!;
      energy += s * s;
      re[i] = s * window[i]!;
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / WINDOW);
    fftInPlace(re, im);
    const mag = new Float64Array(WINDOW / 2);
    for (let k = 0; k < WINDOW / 2; k++) {
      mag[k] = Math.log1p(1000 * Math.hypot(re[k]!, im[k]!));
    }
    frames.push(mag);
  }
  return { frames, rms };
}

const binOf = (hz: number): number => Math.round((hz * WINDOW) / ANALYSIS_RATE);

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────

// Mean log spectrum over [fromFrame, toFrame), in coarse bands from the bass up.
function bandProfile(
  frames: readonly Float64Array[],
  fromFrame: number,
  toFrame: number,
): number[] {
  const edges = [40, 80, 160, 320, 640, 1280, 2560, 5120, 10240];
  const out: number[] = new Array(edges.length - 1).fill(0);
  const from = Math.max(0, Math.round(fromFrame));
  const to = Math.min(frames.length, Math.round(toFrame));
  if (to <= from) return out;
  for (let f = from; f < to; f++) {
    for (let b = 0; b + 1 < edges.length; b++) {
      let sum = 0;
      const lo = binOf(edges[b]!);
      const hi = binOf(edges[b + 1]!);
      for (let k = lo; k < hi; k++) sum += frames[f]![k]!;
      out[b]! += sum / Math.max(1, hi - lo);
    }
  }
  return out.map((v) => v / (to - from));
}

function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(sum);
}

// The first frame the take is audibly playing: 40 dB under its loudest 10ms.
function firstSoundFrame(rms: Float64Array): number {
  let peak = 0;
  for (const r of rms) peak = Math.max(peak, r);
  const floor = peak * 0.01;
  for (let f = 0; f < rms.length; f++) if (rms[f]! > floor) return f;
  return 0;
}

// Bar heads where the two bars after differ most from the two before, in texture and in level. A
// bar is a candidate where its change stands clear of the song's typical one; at most one per two
// bars, strongest first. Bars need not be one length: each window runs to the bar head two away.
function sectionCandidates(
  frames: readonly Float64Array[],
  rms: Float64Array,
  barSecs: readonly number[],
): number[] {
  if (barSecs.length < 5) return [];
  const barFrames = barSecs.map(secFrame);
  const levelOf = (from: number, to: number): number => {
    let sum = 0;
    let n = 0;
    for (let f = Math.max(0, Math.round(from)); f < Math.min(rms.length, Math.round(to)); f++) {
      sum += rms[f]! ** 2;
      n++;
    }
    return 10 * Math.log10(n > 0 ? sum / n + 1e-12 : 1e-12);
  };
  const novelty: { bar: number; score: number }[] = [];
  for (let i = 2; i + 2 <= barFrames.length; i++) {
    const at = barFrames[i]!;
    const from = barFrames[i - 2]!;
    const to = barFrames[i + 2] ?? Math.min(frames.length, 2 * at - from);
    const before = bandProfile(frames, from, at);
    const after = bandProfile(frames, at, to);
    const level = Math.abs(levelOf(at, to) - levelOf(from, at)) / 6;
    novelty.push({ bar: i, score: distance(before, after) + level });
  }
  const sorted = [...novelty.map((n) => n.score)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const deviations = sorted.map((s) => Math.abs(s - median)).sort((a, b) => a - b);
  const spread = deviations[Math.floor(deviations.length / 2)] ?? 0;
  const threshold = median + 2 * Math.max(spread, 1e-6);
  const picked: { bar: number; score: number }[] = [];
  for (const n of [...novelty].sort((a, b) => b.score - a.score)) {
    if (n.score <= threshold) break;
    if (picked.some((p) => Math.abs(p.bar - n.bar) < 2)) continue;
    picked.push(n);
  }
  return picked.map((p) => barSecs[p.bar]!);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

// The beats between adjacent bar heads, most often counted; the smaller on a tie.
export function meterOf(beats: readonly number[], downbeats: readonly number[]): number {
  const indexOf = (sec: number) => {
    let best = 0;
    for (let i = 1; i < beats.length; i++) {
      if (Math.abs(beats[i]! - sec) < Math.abs(beats[best]! - sec)) best = i;
    }
    return best;
  };
  const counts = new Map<number, number>();
  const heads = downbeats.map(indexOf);
  for (let i = 1; i < heads.length; i++) {
    const n = heads[i]! - heads[i - 1]!;
    if (n > 0) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best: [number, number] | null = null;
  for (const [n, c] of counts) {
    if (!best || c > best[1] || (c === best[1] && n < best[0])) best = [n, c];
  }
  return best?.[0] ?? DEFAULT_BEATS_PER_BAR;
}

// The index in `beats` of the first bar head at or after `soundSec`, give or take a quarter beat of
// attack; the first beat there where no bar head is, and 0 where no beat is.
export function firstBeatOf(
  beats: readonly number[],
  downbeats: readonly number[],
  soundSec: number,
): number {
  if (beats.length === 0) return 0;
  const gaps = beats
    .slice(1)
    .map((b, i) => b - beats[i]!)
    .sort((a, b) => a - b);
  const slack = (gaps[Math.floor(gaps.length / 2)] ?? 0) / 4;
  const from = soundSec - slack;
  const head = downbeats.find((d) => d >= from);
  const at = head ?? beats.find((b) => b >= from);
  if (at === undefined) return 0;
  let best = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i]! - at) < Math.abs(beats[best]! - at)) best = i;
  }
  return best;
}

export function readSongBeat(
  samples: Float32Array,
  heard: { beats: readonly number[]; downbeats: readonly number[] },
): SongBeatReading {
  const durationSec = samples.length / ANALYSIS_RATE;
  const { frames, rms } = spectrogram(samples);
  const beats = [...heard.beats];
  const beatsPerBar = meterOf(beats, heard.downbeats);
  const soundSec = firstSoundFrame(rms) / FRAME_RATE + FRAME_CENTER_SEC;
  const firstBeat = firstBeatOf(beats, heard.downbeats, soundSec);
  const barSecs: number[] = [];
  for (let i = firstBeat; i < beats.length; i += beatsPerBar) barSecs.push(beats[i]!);
  return {
    beats,
    firstBeat,
    beatsPerBar,
    sectionSecs: sectionCandidates(frames, rms, barSecs),
    durationSec,
  };
}

// ── Singing ──────────────────────────────────────────────────────────────────────────────────────

// A phrase re-attacked inside itself — the next line sung straight after the last with no breath
// the separation can see — dips between the two. A frame 10 dB under the loudest of the 300ms on
// each side of it, and the lowest of its own 100ms, splits the phrase there.
const DIP_DB = 10;

function splitAtDips(db: Float64Array, [from, to]: [number, number]): [number, number][] {
  const side = Math.round(0.3 * FRAME_RATE);
  const own = Math.round(0.05 * FRAME_RATE);
  const out: [number, number][] = [];
  let start = from;
  for (let f = from + side; f < to - side; f++) {
    let lowest = true;
    for (let g = f - own; g <= f + own && lowest; g++) if (db[g]! < db[f]!) lowest = false;
    if (!lowest) continue;
    let before = -Infinity;
    let after = -Infinity;
    for (let g = f - side; g < f; g++) before = Math.max(before, db[g]!);
    for (let g = f + 1; g <= f + side; g++) after = Math.max(after, db[g]!);
    if (db[f]! > Math.min(before, after) - DIP_DB) continue;
    out.push([start, f]);
    start = f + 1;
    f += own;
  }
  out.push([start, to]);
  return out;
}

// Where a separated vocal track is singing. A stretch opens where the track comes within 20 dB of its
// loud passages (its 95th percentile, and never under −45 dBFS) and closes where it falls 6 dB
// further, so the bleed a separation leaves between phrases does not bridge them; it splits again at
// a dip inside it (`splitAtDips`), and one under 150ms is dropped.
export function readSungPhrases(vocals: Float32Array): SungPhrase[] {
  const frameLen = HOP;
  const count = Math.floor(vocals.length / frameLen);
  const db = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = 0; i < frameLen; i++) sum += vocals[f * frameLen + i]! ** 2;
    db[f] = 10 * Math.log10(sum / frameLen + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? -120;
  const opens = Math.max(loud - 20, -45);
  const closes = opens - 6;
  const minFrames = Math.round(0.15 * FRAME_RATE);

  const raw: [number, number][] = [];
  let open: number | null = null;
  for (let f = 0; f <= count; f++) {
    const level = f < count ? db[f]! : -Infinity;
    if (open === null && level > opens) open = f;
    else if (open !== null && level <= closes) {
      raw.push([open, f]);
      open = null;
    }
  }
  return raw
    .flatMap((span) => splitAtDips(db, span))
    .filter(([a, b]) => b - a >= minFrames)
    .map(([a, b]) => ({
      startSec: Math.round((a / FRAME_RATE) * 1000) / 1000,
      endSec: Math.round((b / FRAME_RATE) * 1000) / 1000,
    }));
}
