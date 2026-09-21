import { duckTargetDepth } from "./audio-level.js";
import type { AudioLoudness } from "./audio-loudness.js";
import { KonteError } from "./errors.js";

/** How far a bed yields to the lines over it, and how quickly. */
export interface DuckOptions {
  /** Gain the bed is held at under a line; 1 is no duck. Default 0.35 (≈ −9 dB). */
  depth?: number;
  /** Seconds the bed takes to drop, ending as the line starts. Default 0.15. */
  attack?: number;
  /** Seconds the bed takes to come back. Default 0.4. */
  release?: number;
  /** Seconds the bed stays down after the line before releasing. Default 0.2. */
  hold?: number;
}

/** `duck` as authored: `true` takes the defaults, `false` yields to nothing. */
export type Duck = boolean | DuckOptions;

const DEFAULTS = { depth: 0.35, attack: 0.15, release: 0.4, hold: 0.2 };
// A ramp of zero length is a division by zero in the filter expression, and a step no ear wants.
const MIN_RAMP = 0.001;

// A volume lane holds 512 points and a dip costs four. Past this, dips are merged until they fit —
// in the ENVELOPE, so the mux coarsens with the preview.
const MAX_DUCK_STEPS = 120;

export interface Span {
  start: number;
  end: number;
}

/**
 * The span a voice cue ducks a bed over: its placement, advanced to where the take's sound actually
 * starts. A line opens with silence more often than not, and the bed must yield to the VOICE, not to
 * the clip carrying it — without this a take that leads with 0.3s of room tone has the bed already
 * bottomed out that much before a word is said.
 *
 * `leadInSec` is measured from the file's head (`AudioLoudness.leadInSec`), so a cue that already
 * skips part of it with `mediaStart` trims only the rest. Null when the trim leaves no span at all:
 * a take that never rises out of silence ducks nothing.
 *
 * The one reader of this, shared by the mux, the preview and the probe so the three cannot disagree
 * about where a line begins.
 */
export function voiceTriggerSpan(opts: {
  start: number;
  end: number;
  mediaStart: number;
  leadInSec: number | undefined;
}): Span | null {
  const onset = Math.max(0, (opts.leadInSec ?? 0) - opts.mediaStart);
  const start = opts.start + onset;
  return start < opts.end ? { start, end: opts.end } : null;
}

/** One resolved dip: down across [a,b], held to c, back up by d. Times are the bed's own. */
export interface DuckStep {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * `bed` is where the bed actually plays (its effective gain and the take's measured loudness);
 * given it, an unauthored depth resolves to whatever puts the bed on the duck target instead of the
 * flat DEFAULTS ratio. Omit it where only the SHAPE of the duck matters (a definition hash), so no
 * resolved take leaks into it.
 */
export function duckSettings(
  duck: Duck | undefined,
  bed?: { volume: number; loudness: AudioLoudness | undefined },
): Required<DuckOptions> | null {
  if (!duck) return null;
  const given = duck === true ? {} : duck;
  const depth = given.depth ?? (bed && duckTargetDepth(bed)) ?? DEFAULTS.depth;
  // A depth of 1 holds the bed at its own level under every line: `duck: false` said the long way,
  // and what a bed already at or under the duck target resolves to.
  if (depth >= 1) return null;
  return {
    depth,
    attack: Math.max(MIN_RAMP, given.attack ?? DEFAULTS.attack),
    release: Math.max(MIN_RAMP, given.release ?? DEFAULTS.release),
    hold: given.hold ?? DEFAULTS.hold,
  };
}

/**
 * The dips one bed takes, in the bed's own time base (0 = where the bed starts, which is where
 * `trackFilter` applies its filters — before `adelay` puts it on the timeline).
 *
 * Only the lines the bed actually plays under are read, and overlapping dips are merged BEFORE the
 * envelope is drawn. Both matter to the hash downstream: a line moved inside a run of dialogue
 * shifts no boundary.
 */
export function buildDuckEnvelope(opts: {
  bed: Span;
  triggers: readonly Span[];
  settings: Required<DuckOptions>;
}): DuckStep[] {
  const { bed, triggers, settings } = opts;
  const { attack, release, hold } = settings;

  const within = triggers
    .filter((t) => t.end > bed.start && t.start < bed.end && t.end > t.start)
    .map((t) => ({ start: t.start - bed.start, end: t.end - bed.start }))
    .sort((x, y) => x.start - y.start);

  // Two dips whose ramps would meet are one dip: the bed never gets back up between them.
  const mergeWithin = (gap: number): Span[] => {
    const out: Span[] = [];
    for (const span of within) {
      const last = out[out.length - 1];
      if (last && span.start - (last.end + hold) <= gap) {
        last.end = Math.max(last.end, span.end);
      } else {
        out.push({ ...span });
      }
    }
    return out;
  };

  const merged = mergeWithin(release + attack);
  // Over the lane's ceiling, the narrowest silence closes first, one pair at a time. Merging a pair
  // moves the gaps around it, so a single gap threshold takes every dip at once on an evenly spaced
  // reel.
  while (merged.length > MAX_DUCK_STEPS) {
    let at = 1;
    let narrowest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < merged.length; i++) {
      const gap = merged[i]!.start - merged[i - 1]!.end;
      if (gap < narrowest) {
        narrowest = gap;
        at = i;
      }
    }
    merged[at - 1]!.end = Math.max(merged[at - 1]!.end, merged[at]!.end);
    merged.splice(at, 1);
  }

  return merged.map(({ start, end }) => ({
    a: start - attack,
    b: start,
    c: end + hold,
    d: end + hold + release,
  }));
}

/**
 * The envelope as an ffmpeg `volume` expression, `baseVolume` scaled by the dips. Its commas are
 * left bare: the caller quotes it inside the filtergraph.
 */
export function duckVolumeExpr(
  baseVolume: number,
  steps: readonly DuckStep[],
  depth: number,
): string {
  const trapezoids = steps.map(
    ({ a, b, c, d }) => `clip(min((t-${f(a)})/${f(b - a)},(${f(d)}-t)/${f(d - c)}),0,1)`,
  );
  const peak = trapezoids.reduce((acc, one) => (acc ? `max(${acc},${one})` : one), "");
  return `${f(baseVolume)}*(1-${f(1 - depth)}*${peak})`;
}

// Trim float noise out of the expression.
function f(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** A `data-automation` volume lane: the bed's gain as breakpoints a player interpolates. */
export interface BedAutomation {
  version: 1;
  lanes: [{ target: "volume"; points: Array<{ t: number; v: number }> }];
}

/**
 * The ducked gain at one moment of the bed's own clock — the arithmetic `duckVolumeExpr` hands
 * ffmpeg, so a lane point and the filter agree wherever both are asked.
 */
export function duckGainAt(
  t: number,
  steps: readonly DuckStep[],
  volume: number,
  depth: number,
): number {
  let peak = 0;
  for (const { a, b, c, d } of steps) {
    const rise = (t - a) / (b - a);
    const fall = (d - t) / (d - c);
    peak = Math.max(peak, Math.min(1, Math.max(0, Math.min(rise, fall))));
  }
  return volume * (1 - (1 - depth) * peak);
}

/**
 * A bed's whole gain shape as HyperFrames' volume lane: the duck, and the declared fades, which the
 * preview has no other reader for. The lane owns the element's gain, its `t` is clip-local, and it
 * interpolates linearly, so the points are the envelope's own corners.
 *
 * A ramp running off either end of the bed is evaluated AT the end: ffmpeg starts the bed part-way
 * down when a line opens over its first moments.
 *
 * Null when the bed has neither a duck nor a fade.
 */
export function bedVolumeLane(opts: {
  span: number;
  volume: number;
  steps: readonly DuckStep[];
  depth: number;
  fadeIn?: number;
  fadeOut?: number;
}): BedAutomation | null {
  const { span, volume, steps, depth } = opts;
  const fadeIn = opts.fadeIn && opts.fadeIn > 0 ? Math.min(opts.fadeIn, span) : 0;
  const fadeOut = opts.fadeOut && opts.fadeOut > 0 ? Math.min(opts.fadeOut, span) : 0;
  if (steps.length === 0 && !fadeIn && !fadeOut) return null;

  const times = new Set<number>([0, span]);
  for (const step of steps) {
    for (const t of [step.a, step.b, step.c, step.d]) {
      if (t > 0 && t < span) times.add(t);
    }
  }
  if (fadeIn) times.add(fadeIn);
  if (fadeOut) times.add(span - fadeOut);

  // `volume` then the fades, the order `trackFilter` applies them in.
  const fadeAt = (t: number): number =>
    Math.min(
      fadeIn ? Math.min(1, Math.max(0, t / fadeIn)) : 1,
      fadeOut ? Math.min(1, Math.max(0, (span - t) / fadeOut)) : 1,
    );

  const points = [...times]
    .sort((x, y) => x - y)
    .map((t) => ({ t: round(t), v: round(duckGainAt(t, steps, volume, depth) * fadeAt(t)) }));
  return { version: 1, lanes: [{ target: "volume", points }] };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Reject a duck nobody can mean before it reaches the filtergraph: a depth outside 0–1 raises the
 * bed under the line or inverts it, and a non-finite time draws no expression.
 */
export function assertDuck(duck: Duck | undefined, where: string): void {
  if (duck === undefined || typeof duck === "boolean") return;
  const bad = (field: string, value: unknown, wanted: string): never => {
    throw new KonteError(
      "DUCK_INVALID",
      `${where}: duck.${field} ${String(value)} is not ${wanted}.`,
    );
  };
  const { depth, attack, release, hold } = duck;
  if (depth !== undefined && !(Number.isFinite(depth) && depth >= 0 && depth <= 1)) {
    bad("depth", depth, "a gain between 0 and 1 (1 is no duck)");
  }
  for (const [field, value] of [
    ["attack", attack],
    ["release", release],
    ["hold", hold],
  ] as const) {
    if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
      bad(field, value, "a finite number of seconds, 0 or more");
    }
  }
}
