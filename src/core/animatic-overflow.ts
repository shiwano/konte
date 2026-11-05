import { formatShotAddress, listShotStems } from "./address.js";
import { MAX_RETIME_RATE } from "./audio-retime.js";
import { cueLeadIn, type CueKind } from "./audio-level.js";
import { harvestShotAudioStructure, type StemAudioEntry } from "./composition-builder.js";
import { shortHash } from "./content-hash.js";
import { DURATION_GRID } from "./direction.js";
import { OVERFLOW_FLOOR } from "./dsl/clip-length-collect.js";
import { selectResolvedVariant, type StalenessCache } from "./staleness.js";
import type { StateManager } from "./state/index.js";
import type {
  AnimaticDefinition,
  KonteState,
  ShotDefinition,
  VariantMedia,
} from "./types/index.js";
import { mediaDurationSec } from "./variant-media.js";
import { formatSeconds } from "./format-duration.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { bedPasses, resolveSoundtrackSpan } from "./timeline-audio.js";

// An animatic shot's stem is clamped to the shot's `duration` (`prepareShotStem`), so a shot
// whose spoken lines run longer loses its tail: the truncated stem is exactly as long as the shot, which
// is what a stem that fits looks like too.
//
// The difference, from the cues' recorded lengths (`VariantMediaSchema`) against the clamp. No
// probing: a cue whose take is unmeasured contributes nothing rather than a guess, so this is a floor.

export interface AnimaticOverflow {
  shotId: string;
  /** The stem the clamp cuts — `animatic:shot.<id>#stem` or `#narrationStem`. */
  address: string;
  /** The shot's `duration`: what the stem is clamped to. */
  durationSec: number;
  /** Where the last cue would end unclamped. */
  neededSec: number;
  /** How much is cut: `neededSec - durationSec`, always above OVERFLOW_FLOOR. */
  overflowSec: number;
  /** Cues whose length is not known, so the real overflow may be larger than reported. */
  unmeasuredCues: number;
  /** The `audioRetime` that fits the one cue the clamp cuts, when it stays inside the rate gate. */
  retime: AnimaticRetime | null;
}

interface AnimaticRetime {
  /** The cue's address — the `source` of the retime. */
  src: string;
  /** The room the cue has from its `start` to the shot's end: the retime's `duration`. */
  roomSec: number;
  /** The tempo that lands the take on `roomSec`. */
  rate: number;
}

interface CueSpan {
  src: string;
  start: number;
  end: number;
  /** Where the take's sound ends, short of `end` by the silence it closes on; null if it plays none. */
  soundEnd: number | null;
  sourceSec: number;
  untrimmed: boolean;
}

function cueSpan(
  cue: StemAudioEntry,
  kind: CueKind | undefined,
  state: KonteState,
  cache: StalenessCache,
): CueSpan | "unmeasured" | "silent" {
  const start = cue.start ?? 0;
  // A cue mixed at zero is in the stem and in nobody's ears (`volume`, `trackFilter`).
  if (cue.volume === 0) return "silent";

  // The source bounds the cue even when the cue declares a `duration`: that becomes an `atrim`, which
  // shortens a take but never pads one (only the final clamp pads, `buildAudioMixArgs`). Unknown
  // source, no claim.
  const resolved = selectResolvedVariant(state, cue.src, undefined, cache);
  if (!resolved) return "unmeasured";
  const variant = state.assets[cue.src]?.variants?.[resolved.variantId];
  const sourceDuration = mediaDurationSec(variant?.media ?? null);
  if (sourceDuration === null) return "unmeasured";

  const mediaStart = cue.mediaStart ?? cueLeadIn(kind, variant?.media);
  const playedFor = (sourceEnd: number) => {
    const available = Math.max(0, sourceEnd - mediaStart) / cue.rate;
    return start + (cue.duration != null ? Math.min(cue.duration, available) : available);
  };
  const audible = audibleEndSec(variant?.media, sourceDuration);
  const soundEnd = audible === null ? null : playedFor(audible);
  return {
    src: cue.src,
    start,
    end: playedFor(sourceDuration),
    soundEnd: soundEnd !== null && soundEnd > start ? soundEnd : null,
    sourceSec: sourceDuration,
    untrimmed: cue.duration == null && mediaStart === 0 && cue.rate === 1,
  };
}

// Where a take's sound ends in its source; null for a take measured silent.
function audibleEndSec(media: VariantMedia | undefined, sourceSec: number): number | null {
  if (media?.kind !== "audio") return sourceSec;
  if (media.silent) return null;
  return Math.min(sourceSec, media.loudness?.soundEndSec ?? sourceSec);
}

// A retime replaces the whole take, so it fixes a stem only when one untrimmed cue is all the clamp
// cuts. The room is floored to the centisecond so the retimed take fits.
function retimeFor(spans: readonly CueSpan[], durationSec: number): AnimaticRetime | null {
  const cut = spans.filter((span) => span.end - durationSec > OVERFLOW_FLOOR);
  if (cut.length !== 1) return null;
  const [span] = cut as [CueSpan];
  if (!span.untrimmed) return null;
  const roomSec = Math.floor((durationSec - span.start) * 100) / 100;
  if (roomSec <= 0) return null;
  const rate = span.sourceSec / roomSec;
  if (rate > MAX_RETIME_RATE) return null;
  return { src: span.src, roomSec, rate };
}

/**
 * Every shot whose lines are cut by the clamp, in shot order. Reads state and the loaded animatic
 * only — no ffprobe — so `status` can carry it on a project of any size.
 */
export function findAnimaticOverflows(
  animatic: AnimaticDefinition,
  manager: StateManager,
  // One memo for the whole pass: resolution recurses through a candidate's inputs, so a per-cue
  // context re-explores the same upstream cone once per cue. A caller with its own hands it over;
  // the manager's carries whatever definitions were registered for the video.
  cache: StalenessCache = manager.stalenessCache(),
): AnimaticOverflow[] {
  return animatic.shots.flatMap((shot) => findShotOverflows(animatic, manager, shot, cache));
}

/** The stems of one board shot whose lines the clamp cuts. */
export function findShotOverflows(
  animatic: AnimaticDefinition,
  manager: StateManager,
  shot: ShotDefinition,
  cache: StalenessCache = manager.stalenessCache(),
): AnimaticOverflow[] {
  const state = manager.getState();
  const stems = listShotStems("animatic", shot);
  if (stems.length === 0) return [];
  const cues = harvestShotAudioStructure(animatic, shot.id);
  if (cues === null || cues.length === 0) return [];
  const durationSec = shot.duration;

  const overflows: AnimaticOverflow[] = [];
  for (const stem of stems) {
    let neededSec = 0;
    let unmeasuredCues = 0;
    const spans: CueSpan[] = [];
    for (const cue of cues) {
      if (!stem.refs.includes(cue.src)) continue;
      const span = cueSpan(cue, shot.cueKinds?.[cue.src], state, cache);
      if (span === "unmeasured") unmeasuredCues++;
      else if (span !== "silent") {
        spans.push(span);
        neededSec = Math.max(neededSec, span.end);
      }
    }

    const overflowSec = neededSec - durationSec;
    if (overflowSec <= OVERFLOW_FLOOR) continue;
    overflows.push({
      shotId: shot.id,
      address: stem.address,
      durationSec,
      neededSec,
      overflowSec,
      unmeasuredCues,
      retime: unmeasuredCues === 0 ? retimeFor(spans, durationSec) : null,
    });
  }
  return overflows;
}

/** One line of prose for a surface that reports these, without the address it is keyed by. */
export function formatAnimaticOverflow(o: AnimaticOverflow): string {
  const partial = o.unmeasuredCues > 0 ? ` (${o.unmeasuredCues} cue(s) not measured yet)` : "";
  return (
    `lines truncated by ${formatSeconds(o.overflowSec)} — ` +
    `${formatSeconds(o.neededSec)} of audio in a ${formatSeconds(o.durationSec)} shot${partial}`
  );
}

// A shot whose sound ends at least this long before its cut, and this share of the shot, holds
// dead air a human hears.
const SILENT_TAIL_FLOOR_SEC = 2;
const SILENT_TAIL_SHARE = 0.25;
// The silence a suggested `duration` leaves after the last sound, before rounding up to the grid.
const TAIL_BREATH_SEC = 1;

export interface SilentTail {
  shotId: string;
  /** The shot's address — what `konte vouch` takes for the tail. */
  address: string;
  durationSec: number;
  /** Where the shot's last sound — a cue of any kind, or a bed — ends. */
  soundEndSec: number;
  tailSec: number;
  /** The grid `duration` that leaves a breath after the last sound. */
  fitDurationSec: number;
  /** What the tail was measured from: the clamp, the cues, the take each resolves to, the beds. */
  tailHash: string;
  /** A vouch stands for this tail as a hold. */
  vouched: boolean;
}

/**
 * Every board shot with lines that goes quiet long before its cut, in shot order. A coverage shot,
 * one with an unmeasured cue, under the song, or with its stems accepted as they stand is never one.
 */
export function findAnimaticSilentTails(
  animatic: AnimaticDefinition,
  manager: StateManager,
  cache: StalenessCache = manager.stalenessCache(),
): SilentTail[] {
  const offsets = new Map<string, number>();
  const durations = new Map<string, number>();
  let total = 0;
  for (const shot of animatic.shots) {
    offsets.set(shot.id, total);
    durations.set(shot.id, shot.duration);
    total += shot.duration;
  }
  const state = manager.getState();
  const beds = (animatic.timelineSoundtracks ?? [])
    .filter((st) => st.options.volume !== 0)
    .map((st) => {
      const span = resolveSoundtrackSpan(st.options, offsets, durations, total);
      const src = parsePlaceholder(st.src.src) ?? st.src.src;
      const take = selectResolvedVariant(state, src, undefined, cache)?.variantId ?? null;
      return {
        sounding: bedSounding(state, src, take, st.options, span),
        identity: { id: st.id, src, take, options: st.options },
      };
    });

  const tails: SilentTail[] = [];
  for (const shot of animatic.shots) {
    const from = offsets.get(shot.id) ?? 0;
    const to = from + shot.duration;
    const shotBeds = beds.flatMap((bed) => {
      const ends = bed.sounding
        .filter((s) => s.start < to && s.end > from)
        .map((s) => Math.min(s.end, to) - from);
      return ends.length > 0 ? [{ ...bed.identity, end: Math.max(...ends) }] : [];
    });
    const tail = findShotSilentTail(animatic, manager, shot, shotBeds, cache);
    if (!tail) continue;
    tails.push({
      ...tail,
      vouched: manager.getShotVouch(tail.address)?.tailHash === tail.tailHash,
    });
  }
  return tails;
}

// Where a bed sounds on the timeline: from each lap's start to where its sound stops in that lap,
// laid out as the mix lays it (`bedPasses`). An unmeasured bed sounds through its span.
function bedSounding(
  state: KonteState,
  src: string,
  take: string | null,
  options: { mediaStart?: number; loop?: boolean },
  span: { start: number; end: number },
): Array<{ start: number; end: number }> {
  const media = take ? state.assets[src]?.variants?.[take]?.media : undefined;
  const sourceSec = mediaDurationSec(media ?? null);
  if (sourceSec === null) return [span];
  const soundEnd = audibleEndSec(media, sourceSec);
  if (soundEnd === null) return [];
  return bedPasses({
    span: span.end - span.start,
    mediaStart: options.mediaStart ?? 0,
    sourceSec,
    loop: options.loop,
  })
    .map((p) => ({
      start: span.start + p.at,
      end: span.start + p.at + Math.min(p.duration, Math.max(0, soundEnd - p.mediaStart)),
    }))
    .filter((lap) => lap.end > lap.start);
}

/** A bed sounding in a shot: what it plays, and where it stops, shot-local. */
interface ShotBed {
  id: string;
  src: string;
  take: string | null;
  options: unknown;
  end: number;
}

function findShotSilentTail(
  animatic: AnimaticDefinition,
  manager: StateManager,
  shot: ShotDefinition,
  beds: readonly ShotBed[],
  cache: StalenessCache,
): Omit<SilentTail, "vouched"> | null {
  // A coverage shot's take is cut inside by the model, which holds where the sound has stopped.
  if (shot.songCue || shot.coverage) return null;
  const cues = harvestShotAudioStructure(animatic, shot.id);
  if (!cues) return null;
  // A shot of effects alone may settle into silence.
  const kinds = shot.cueKinds ?? {};
  if (!cues.some((cue) => kinds[cue.src] === "voice" || kinds[cue.src] === "narration")) {
    return null;
  }
  const state = manager.getState();
  // A shot's stems accepted as they stand are the mix a human watched the tail in and signed off.
  const stems = listShotStems("animatic", shot);
  if (
    stems.length > 0 &&
    stems.every((stem) =>
      selectResolvedVariant(state, stem.address, { requireAccepted: true }, cache),
    )
  ) {
    return null;
  }
  let soundEnd = Math.max(0, ...beds.map((bed) => bed.end));
  const takes: Array<string | null> = [];
  for (const cue of cues) {
    const span = cueSpan(cue, kinds[cue.src], state, cache);
    if (span === "unmeasured") return null;
    if (span !== "silent" && span.soundEnd !== null) soundEnd = Math.max(soundEnd, span.soundEnd);
    takes.push(selectResolvedVariant(state, cue.src, undefined, cache)?.variantId ?? null);
  }

  const durationSec = shot.duration;
  const soundEndSec = Math.min(soundEnd, durationSec);
  const tailSec = durationSec - soundEndSec;
  if (tailSec < SILENT_TAIL_FLOOR_SEC || tailSec < durationSec * SILENT_TAIL_SHARE) return null;
  return {
    shotId: shot.id,
    address: formatShotAddress("animatic", shot.id),
    durationSec,
    soundEndSec,
    tailSec,
    fitDurationSec: Math.ceil((soundEndSec + TAIL_BREATH_SEC) / DURATION_GRID) * DURATION_GRID,
    tailHash: shortHash({
      duration: durationSec,
      kinds,
      cues: cues.map((cue, i) => ({ ...cue, take: takes[i] })),
      beds,
    }),
  };
}

/** One line of prose for a surface that reports these, without the address it is keyed by. */
export function formatSilentTail(t: SilentTail): string {
  return (
    `sound ends at ${formatSeconds(t.soundEndSec)} in a ${formatSeconds(t.durationSec)} shot — ` +
    `${formatSeconds(t.tailSec)} of silence after it`
  );
}
