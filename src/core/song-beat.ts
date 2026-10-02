// What a song take's audio says about its own clock, read off mono PCM alone: the tempo it actually
// plays at near the one the direction declared, where its beats and bar heads fall, where its
// texture changes enough to be a section boundary, and — from a separated vocal track — where the
// singing starts and stops. Pure arithmetic over samples; decoding and separation are the caller's.

// The rate the analysis reads at: 10ms frames, a 1024-sample window (43ms) that resolves a kick
// from the bass under it.
export const ANALYSIS_RATE = 24000;
const HOP = 240;
const WINDOW = 1024;
const FRAME_RATE = ANALYSIS_RATE / HOP;
// A frame's time is its window's centre: an onset lifts the flux of the frame whose window it
// enters, so reading the frame at its start would place every beat half a window early.
const FRAME_CENTER_SEC = WINDOW / 2 / ANALYSIS_RATE;
const frameSec = (frame: number): number =>
  Math.round((frame / FRAME_RATE + FRAME_CENTER_SEC) * 1000) / 1000;

// How far from the declared tempo a take is searched. A generated song lands on its tempo or close
// to it; a half- or double-time reading lies far outside this.
const TEMPO_SEARCH_RATIO = 0.08;

export type SongBeatReading = {
  // The tempo the take plays at, in beats per minute.
  bpm: number;
  // The take-second of the first bar head at or after the first sound, where beat 0 falls.
  downbeatSec: number;
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

// ── Onset envelope ───────────────────────────────────────────────────────────────────────────────

const binOf = (hz: number): number => Math.round((hz * WINDOW) / ANALYSIS_RATE);

// Half-wave rectified spectral flux over [loHz, hiHz), with its local mean taken out so a loud
// passage does not outweigh a quiet one, scaled to unit peak.
function flux(frames: readonly Float64Array[], loHz: number, hiHz: number): Float64Array {
  const lo = Math.max(1, binOf(loHz));
  const hi = Math.min(WINDOW / 2, binOf(hiHz));
  const out = new Float64Array(frames.length);
  for (let f = 1; f < frames.length; f++) {
    const cur = frames[f]!;
    const prev = frames[f - 1]!;
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += Math.max(0, cur[k]! - prev[k]!);
    out[f] = sum;
  }
  const radius = Math.round(FRAME_RATE / 4);
  const detrended = new Float64Array(out.length);
  let peak = 0;
  for (let f = 0; f < out.length; f++) {
    let sum = 0;
    let n = 0;
    for (let g = Math.max(0, f - radius); g <= Math.min(out.length - 1, f + radius); g++) {
      sum += out[g]!;
      n++;
    }
    detrended[f] = Math.max(0, out[f]! - sum / n);
    peak = Math.max(peak, detrended[f]!);
  }
  if (peak > 0) for (let f = 0; f < detrended.length; f++) detrended[f]! /= peak;
  return detrended;
}

// The envelope at a fractional frame, linearly interpolated; zero outside it.
function sampleAt(env: Float64Array, frame: number): number {
  if (frame < 0 || frame > env.length - 1) return 0;
  const i = Math.floor(frame);
  const t = frame - i;
  return env[i]! * (1 - t) + (env[Math.min(i + 1, env.length - 1)] ?? 0) * t;
}

// ── Tempo and phase ──────────────────────────────────────────────────────────────────────────────

// How well a constant beat grid of `periodFrames` starting at `phaseFrames` lands on the onsets:
// the mean envelope over every beat inside the take.
function gridScore(env: Float64Array, periodFrames: number, phaseFrames: number): number {
  let sum = 0;
  let n = 0;
  for (let t = phaseFrames; t < env.length; t += periodFrames) {
    sum += sampleAt(env, t);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function fitGrid(env: Float64Array, declaredBpm: number): { bpm: number; phaseFrames: number } {
  let best = { score: -1, bpm: declaredBpm, phase: 0 };
  const search = (bpms: number[], phases: (period: number) => number[]) => {
    for (const bpm of bpms) {
      const period = (60 / bpm) * FRAME_RATE;
      for (const phase of phases(period)) {
        const score = gridScore(env, period, phase);
        if (score > best.score) best = { score, bpm, phase };
      }
    }
  };
  const range = (from: number, to: number, step: number): number[] => {
    const out: number[] = [];
    for (let v = from; v <= to + step / 2; v += step) out.push(v);
    return out;
  };
  search(
    range(declaredBpm * (1 - TEMPO_SEARCH_RATIO), declaredBpm * (1 + TEMPO_SEARCH_RATIO), 0.05),
    (period) => range(0, period - 1, 1),
  );
  const coarse = best;
  search(range(coarse.bpm - 0.1, coarse.bpm + 0.1, 0.005), (period) =>
    range(coarse.phase - 1, coarse.phase + 1, 0.1).map((p) => (p + period) % period),
  );
  return { bpm: Math.round(best.bpm * 1000) / 1000, phaseFrames: best.phase };
}

// ── Bars ─────────────────────────────────────────────────────────────────────────────────────────

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

// Which beat of the bar each beat is: the position whose beats open on the most bass attack and the
// most change in what is sounding — a chord moves, and a kick lands, on the bar head.
function barPosition(
  frames: readonly Float64Array[],
  bass: Float64Array,
  beatFrames: readonly number[],
  beatsPerBar: number,
): number {
  const scores = new Array<number>(beatsPerBar).fill(0);
  const period = beatFrames.length > 1 ? beatFrames[1]! - beatFrames[0]! : FRAME_RATE / 2;
  // A beat a whole beat from either end of the take: past it, one side is silence the take never had.
  // A change into something quieter counts half: the beat after an accented head changes as much.
  const change: number[] = beatFrames.map((b) => {
    if (b - period < 0 || b + period > frames.length) return 0;
    const before = bandProfile(frames, b - period, b);
    const after = bandProfile(frames, b, b + period);
    const rises = after.reduce((x, y) => x + y, 0) >= before.reduce((x, y) => x + y, 0);
    return distance(before, after) * (rises ? 1 : 0.5);
  });
  const maxChange = Math.max(1e-9, ...change);
  beatFrames.forEach((b, i) => {
    let attack = 0;
    for (let d = -2; d <= 2; d++) attack = Math.max(attack, sampleAt(bass, b + d));
    scores[i % beatsPerBar]! += attack + change[i]! / maxChange;
  });
  return scores.indexOf(Math.max(...scores));
}

// The first frame the take is audibly playing: 40 dB under its loudest 10ms.
function firstSoundFrame(rms: Float64Array): number {
  let peak = 0;
  for (const r of rms) peak = Math.max(peak, r);
  const floor = peak * 0.01;
  for (let f = 0; f < rms.length; f++) if (rms[f]! > floor) return f;
  return 0;
}

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────

// Bar heads where the two bars after differ most from the two before, in texture and in level. A
// bar is a candidate where its change stands clear of the song's typical one; at most one per two
// bars, strongest first.
function sectionCandidates(
  frames: readonly Float64Array[],
  rms: Float64Array,
  barFrames: readonly number[],
): number[] {
  if (barFrames.length < 5) return [];
  const barLen = barFrames[1]! - barFrames[0]!;
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
    const before = bandProfile(frames, at - 2 * barLen, at);
    const after = bandProfile(frames, at, at + 2 * barLen);
    const level = Math.abs(levelOf(at, at + 2 * barLen) - levelOf(at - 2 * barLen, at)) / 6;
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
  return picked.map((p) => frameSec(barFrames[p.bar]!));
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

export function readSongBeat(
  samples: Float32Array,
  declared: { bpm: number; beatsPerBar: number },
): SongBeatReading {
  const durationSec = samples.length / ANALYSIS_RATE;
  const { frames, rms } = spectrogram(samples);
  const broad = flux(frames, 30, 11000);
  const bass = flux(frames, 30, 160);
  const env = new Float64Array(broad.length);
  // The bass onset weighs double: a hi-hat's noise lifts every band at once, and on the off-beat.
  for (let f = 0; f < env.length; f++) env[f] = broad[f]! + 2 * bass[f]!;

  const { bpm, phaseFrames } = fitGrid(env, declared.bpm);
  const period = (60 / bpm) * FRAME_RATE;
  const beatFrames: number[] = [];
  for (let t = phaseFrames; t < env.length; t += period) beatFrames.push(t);
  const position = barPosition(frames, bass, beatFrames, declared.beatsPerBar);

  const barLen = period * declared.beatsPerBar;
  const firstHead = beatFrames[position] ?? phaseFrames;
  const start = firstSoundFrame(rms);
  // The first bar head at or after the first sound, give or take a quarter beat of attack.
  const heads = Math.ceil((start - period / 4 - firstHead) / barLen);
  const downbeat = firstHead + heads * barLen;
  const barFrames: number[] = [];
  for (let t = downbeat; t < env.length; t += barLen) barFrames.push(t);

  return {
    bpm,
    // A take that opens on its bar head can read it a hair before 0.
    downbeatSec: Math.max(0, frameSec(downbeat)),
    sectionSecs: sectionCandidates(frames, rms, barFrames),
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
