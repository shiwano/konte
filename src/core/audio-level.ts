import { isStemAddress } from "./address.js";
import { MAX_AUDIO_GAIN } from "./audio-gain.js";
import { makeAddressPlaceholder } from "./dsl/shot-context.js";
import { getRenderContext } from "./jsx-html.js";
import type { AudioLoudness } from "./audio-loudness.js";
import type { KonteState, VariantMedia } from "./types/index.js";

/**
 * What a cue is, as far as the mix is concerned. Derived from the direction, never authored: a
 * `{ character }` line is a `voice`, a `{ narration }` line `narration`, a `{ speaker }` line a
 * `mob`, and a cue with no words behind it is `sfx`.
 */
export type CueKind = "voice" | "narration" | "mob" | "sfx";

/** A line a bed yields to — a character's or the narrator's. */
export function isVoiceKind(kind: CueKind | undefined): boolean {
  return kind === "voice" || kind === "narration";
}

/**
 * A cue kind, the timeline bed a `soundtrack()` places, the song `policy.song` names, or the
 * `ambience` a `<Video hasAudio>` clip carries in a shot with no lines.
 */
export type LevelKind = CueKind | "bed" | "song" | "ambience";

// Where each kind sits. `sfx` is levelled by true peak instead: integrated loudness measured over
// a 200 ms transient is not a number worth trusting.
const TARGET_LUFS: Record<Exclude<LevelKind, "sfx">, number> = {
  voice: -18,
  narration: -18,
  mob: -26,
  bed: -24,
  song: -14,
  ambience: -30,
};
const SFX_TARGET_PEAK_DB = -8;

/**
 * Where a bed sits while a line plays over it: 15 dB under the voice target. A duck aims here
 * rather than dipping by a fixed ratio, which would ride on the author's `volume`.
 */
const DUCK_TARGET_LUFS = -33;

// A measurement wide of the mark (a near-silent take, a mis-decoded file) must not be able to shove
// a cue across the mix. Past this the take itself is the thing to fix.
const MAX_LEVEL_GAIN_DB = 12;
// A quiet ambience is mostly noise floor, and its level is measured over the whole source while the
// shot plays a window of it.
const AMBIENCE_MAX_BOOST_DB = 6;

function maxBoostDb(kind: LevelKind): number {
  return kind === "ambience" ? AMBIENCE_MAX_BOOST_DB : MAX_LEVEL_GAIN_DB;
}

export type AudioLevelling =
  | { gain: number; limited: boolean; reason?: never }
  | {
      gain: 1;
      reason: "unmeasured" | "no-lufs" | "stem" | "unclassified";
      limited?: never;
    };

export function audioLevelling(
  kind: LevelKind,
  loudness: AudioLoudness | undefined,
): AudioLevelling {
  if (!loudness) return { gain: 1, reason: "unmeasured" };
  if (kind !== "sfx" && loudness.integratedLufs === null) {
    return { gain: 1, reason: "no-lufs" };
  }
  const db =
    kind === "sfx"
      ? SFX_TARGET_PEAK_DB - loudness.truePeakDb
      : TARGET_LUFS[kind] - loudness.integratedLufs!;
  if (!Number.isFinite(db)) return { gain: 1, limited: false };
  const boost = maxBoostDb(kind);
  const clamped = Math.min(boost, Math.max(-MAX_LEVEL_GAIN_DB, db));
  return { gain: 10 ** (clamped / 20), limited: db >= boost || db <= -MAX_LEVEL_GAIN_DB };
}

export function levellingGain(kind: LevelKind, loudness: AudioLoudness | undefined): number {
  return audioLevelling(kind, loudness).gain;
}

/**
 * The depth a duck takes to land its bed on DUCK_TARGET_LUFS, given where that bed already plays
 * (its measured loudness at its effective gain). Null when the source was never measured — the
 * caller falls back to the declared ratio. 1 when the bed already sits at or under the target.
 */
export function duckTargetDepth(bed: {
  volume: number;
  loudness: AudioLoudness | undefined;
}): number | null {
  const lufs = bed.loudness?.integratedLufs;
  if (lufs == null || !(bed.volume > 0)) return null;
  const played = lufs + 20 * Math.log10(bed.volume);
  if (played <= DUCK_TARGET_LUFS) return 1;
  return 10 ** ((DUCK_TARGET_LUFS - played) / 20);
}

/** Where a source plays once a gain is on it. */
export function playedLufs(loudness: AudioLoudness | undefined, volume: number): number | null {
  const lufs = loudness?.integratedLufs;
  if (lufs == null || !(volume > 0)) return null;
  return lufs + 20 * Math.log10(volume);
}

/** The loudness a measured file carries, from the record written when it landed. */
export function loudnessOf(media: VariantMedia | undefined): AudioLoudness | undefined {
  if (!media) return undefined;
  if (media.kind === "audio") return media.loudness;
  return media.kind === "video" ? media.audio?.loudness : undefined;
}

/**
 * The seconds of silence an sfx take leads with, which its cue skips when it declares no
 * `mediaStart`. 0 for a line, a clip's track, and a take measured before lead-in was.
 */
export function cueLeadIn(kind: CueKind | undefined, media: VariantMedia | undefined): number {
  if (kind !== "sfx" || media?.kind !== "audio") return 0;
  return media.loudness?.leadInSec ?? 0;
}

/** What each of a shot's measured cue takes does to the mix, keyed by ADDRESS. */
export interface ShotCueLevels {
  /** The gain that puts the cue in its place (`levellingGain`); absent at unity. */
  gains: Record<string, number>;
  adjustments: Record<string, AudioLevelling>;
  /** The lead-in an sfx cue skips (`cueLeadIn`); absent at 0. */
  leadIns: Record<string, number>;
  /** A `<Video hasAudio>` clip's measured loudness, which its duck under the narration aims off. */
  clipLoudness: Record<string, AudioLoudness>;
}

/**
 * One shot's cues levelled and trimmed exactly as the board stem mixes them — every cue, whether it
 * is the shot's own asset, the timeline's, or one reached outside both (a `reference:` asset, a prior
 * shot's take). Each render site re-keys the result to its own srcs with `cueBySrc`.
 *
 * Unity gains are omitted from `gains`; `adjustments` retains their reasons.
 */
export function shotCueLevels(opts: {
  stage: string;
  shotId: string;
  cueKinds: Readonly<Record<string, CueKind>> | undefined;
  // The shot's picture sources. A cue in both these and `cueKinds` is a `<Video hasAudio>` clip's
  // own track rather than a standalone cue; omitted, every cue is levelled as a standalone one.
  pictureRefs?: readonly string[];
  state: KonteState;
  /** The shot's own resolved variants by asset name — a previewed candidate among them. */
  resolvedVariants: Record<string, string>;
  /** The timeline's own resolved variants by asset name. */
  timelineResolvedVariants?: Record<string, string>;
  /** The variant any other address resolves to. */
  resolve: (address: string) => string | undefined;
}): ShotCueLevels {
  const shotPrefix = `${opts.stage}:shot.${opts.shotId}.`;
  const timelinePrefix = `${opts.stage}:timeline.`;
  const out: ShotCueLevels = { gains: {}, leadIns: {}, adjustments: {}, clipLoudness: {} };
  const picture = new Set(opts.pictureRefs ?? []);
  for (const [address, kind] of Object.entries(opts.cueKinds ?? {})) {
    if (isStemAddress(address)) {
      out.adjustments[address] = { gain: 1, reason: "stem" };
      continue;
    }
    const variantId = address.startsWith(shotPrefix)
      ? opts.resolvedVariants[address.slice(shotPrefix.length)]
      : address.startsWith(timelinePrefix)
        ? opts.timelineResolvedVariants?.[address.slice(timelinePrefix.length)]
        : opts.resolve(address);
    const media = variantId ? opts.state.assets[address]?.variants?.[variantId]?.media : undefined;
    const clip = picture.has(address) ? loudnessOf(media) : undefined;
    if (clip) out.clipLoudness[address] = clip;
    // A clip's own track is the shot's whole mix, not one cue. Where the shot speaks, that mix is
    // its line and belongs at the voice target; where it does not, it is the shot's ambience —
    // `sfx` aims a true peak meant for a door slam.
    const clipAmbience = kind === "sfx" && picture.has(address);
    const adjustment = audioLevelling(clipAmbience ? "ambience" : kind, loudnessOf(media));
    out.adjustments[address] = adjustment;
    const { gain } = adjustment;
    if (gain !== 1) out.gains[address] = gain;
    const leadIn = cueLeadIn(kind, media);
    if (leadIn > 0) out.leadIns[address] = leadIn;
  }
  return out;
}

/**
 * The gain actually written, once levelling has been folded into a declared `volume`. Capped at the
 * same ceiling the declared value is checked against: the preview's player clamps a gain there and
 * ffmpeg does not, so an uncapped product has the two mixing differently.
 */
export function clampEffectiveGain(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return 0;
  return Math.min(MAX_AUDIO_GAIN, gain);
}

/**
 * `volume` as the mix should hear it: the declared gain scaled by what levelling measured for this
 * source. A discovery render has no gains, so it emits the declared value untouched — which is what
 * the stem's identity is harvested from.
 */
export function applyLevelGain(src: string, declared: unknown): unknown {
  const level = getRenderContext().levelGains?.[src] ?? 1;
  if (level === 1) return declared;
  const base = declared === undefined || declared === null ? 1 : Number(declared);
  return Number.isFinite(base) ? clampEffectiveGain(base * level) : declared;
}

/** A shot's `cueKinds` re-keyed to the srcs a render reads (see `cueBySrc`). */
export function cueKindsBySrc(opts: {
  stage: string;
  shotId: string;
  cueKinds: Readonly<Record<string, CueKind>> | undefined;
  resolvedFiles: Record<string, string>;
  timelineFiles?: Record<string, string>;
}): Record<string, CueKind> | undefined {
  return cueBySrc({ ...opts, byAddress: opts.cueKinds });
}

/**
 * A per-cue record (keyed by address) re-keyed to the srcs a RENDER-mode render reads — the only
 * form `<Audio>` and the harvest see. Which form a cue arrives in depends on where it came from: the
 * render substitutes the shot's own assets and the timeline's own (a shot closure can capture one)
 * for files, and leaves everything else — the board's stem, a `reference:` cue, a prior shot's take
 * — as the `__konte:<address>__` placeholder it resolves only afterwards. BOTH keys are emitted for
 * every cue rather than the one a caller predicts.
 */
export function cueBySrc<T>(opts: {
  stage: string;
  shotId: string;
  byAddress: Readonly<Record<string, T>> | undefined;
  resolvedFiles: Record<string, string>;
  /** The timeline's own resolved assets by name, for a cue the shot's closure captured off it. */
  timelineFiles?: Record<string, string>;
}): Record<string, T> | undefined {
  const shotPrefix = `${opts.stage}:shot.${opts.shotId}.`;
  const timelinePrefix = `${opts.stage}:timeline.`;
  const out: Record<string, T> = {};
  for (const [address, kind] of Object.entries(opts.byAddress ?? {})) {
    out[makeAddressPlaceholder(address)] = kind;
    const file = address.startsWith(shotPrefix)
      ? opts.resolvedFiles[address.slice(shotPrefix.length)]
      : address.startsWith(timelinePrefix)
        ? opts.timelineFiles?.[address.slice(timelinePrefix.length)]
        : undefined;
    if (file) out[file] = kind;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
