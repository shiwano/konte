import type { ShotStage } from "./address.js";
import { runInRenderMode } from "./dsl/shot-context.js";
import type { AudioLevelling, CueKind, ShotCueLevels } from "./audio-level.js";
import { clampEffectiveGain, cueBySrc, isVoiceKind, loudnessOf } from "./audio-level.js";
import type { SoundtrackEntry } from "./dsl/builders.js";
import {
  buildDuckEnvelope,
  duckSettings,
  narrationDuck,
  voiceTriggerSpan,
  type Duck,
  type DuckStep,
  type Span,
} from "./audio-duck.js";
import type { AudioLoudness } from "./audio-loudness.js";
import type { MuxAudioTrack } from "./ffmpeg.js";
import { renderToHtml, HARVEST_TYPOGRAPHY } from "./jsx-html.js";
import type { VariantMedia } from "./types/index.js";
import { mediaDurationSec, mediaHasAudio } from "./variant-media.js";
import { probeHasAudio, probeMediaDuration } from "./video-probe.js";

// One standalone audio placement harvested from a shot's composition, with timing local to the
// shot it sits in. `<Audio>` emits `data-konte-track="sound"`; `<Video hasAudio>` emits
// `data-has-audio` and contributes its embedded audio as an "embedded" role. Timeline-spanning
// beds are not harvested here — they come from the `soundtracks` list (see buildTimelineTracks).
type AudioRole = "sound" | "embedded";

export interface RawShotAudio {
  levelling?: AudioLevelling;
  role: AudioRole;
  // What the direction says this cue is (see classifyShotCues). Only a line (`isVoiceKind`) ducks a bed. Not
  // optional: a harvest that leaves it unset drops every line it saw out of the duck, and a role
  // this reader has not met yet must say so rather than default to silence.
  kind: CueKind | undefined;
  file: string; // absolute path to the source media (audio file, or the video for embedded)
  localStart: number;
  localEnd: number | null; // shot-local timeline end; null means "to the shot/source end"
  mediaStart: number;
  // Source seconds per timeline second (`data-playback-rate`).
  rate: number;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  // The cue's own id (`data-konte-cue`), for labelling; null where the element carries none.
  cueId: string | null;
}

// A timeline-spanning soundtrack (bed/music), resolved to a concrete clip file. Its span is given
// by `from`/`until` shot anchors (shot-internal seconds); buildTimelineTracks resolves those to
// absolute time using the accumulated actual shot durations.
export interface ResolvedSoundtrack {
  id: string;
  file: string;
  from?: { shot: string; at?: number };
  until?: { shot: string; at?: number };
  mediaStart: number;
  // The bed's final gain: the author's `volume` already scaled by its levelling.
  volume: number;
  // The take's measured loudness, so an unauthored duck depth resolves to the duck target.
  loudness?: AudioLoudness;
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  duck: Duck;
  // The stage's song bed (`mixedSoundtracks`).
  song?: true;
}

function toNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value !== "") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Harvest the standalone audio placements from one shot's composition. Rendered with absolute file
 * paths so every `src` is the on-disk source the mux reads — no HTTP/relative mapping. Audio is
 * never baked into the shot composite; it is reconstructed from these placements at final mux.
 *
 * The one reader of a rendered shot's cues: the mux and the probe read it, then place what it
 * returns with `placeTimelineAudio`.
 */
export function collectShotAudioCues(opts: {
  stage: ShotStage;
  shotId: string;
  duration: number;
  renderFn: () => React.ReactElement;
  size: { width: number; height: number };
  resolvedFiles: Record<string, string>;
  // The timeline's own absolute files by name, for a cue the shot's closure captured off it.
  timelineFiles?: Record<string, string>;
  // Each cue's levelling gain and sfx lead-in (see shotCueLevels), folded into its `data-volume` and
  // `data-media-start` by the render. Omitted leaves every cue as declared.
  cueLevels?: ShotCueLevels;
  // Each cue source's kind, so a bed knows which placements are lines to yield to.
  cueKinds?: Record<string, CueKind>;
  // A shot that fails to render: "throw" for a spend path, where a lost cue ships a muted take;
  // "skip" for a read surface, which draws the rest of the timeline instead of blanking it.
  onRenderError: "throw" | "skip";
}): RawShotAudio[] {
  const { stage, shotId, duration, renderFn, size, resolvedFiles, timelineFiles } = opts;
  const { cueLevels, cueKinds } = opts;
  const cueSrcs = { stage, shotId, resolvedFiles, timelineFiles };
  const out: RawShotAudio[] = [];
  const adjustments = cueBySrc({ ...cueSrcs, byAddress: cueLevels?.adjustments });

  try {
    const jsx = runInRenderMode(stage, shotId, renderFn, resolvedFiles, resolvedFiles);
    renderToHtml(
      jsx,
      {
        shotId,
        width: size.width,
        height: size.height,
        duration,
        levelGains: cueBySrc({ ...cueSrcs, byAddress: cueLevels?.gains }),
        leadIns: cueBySrc({ ...cueSrcs, byAddress: cueLevels?.leadIns }),
        typography: HARVEST_TYPOGRAPHY,
      },
      (tag, props) => {
        const src = props.src;
        if (typeof src !== "string" || src === "") return;
        if (tag === "audio") {
          if (props["data-konte-track"] !== "sound") return;
        } else if (tag === "video") {
          if (props["data-has-audio"] !== "true" && props["data-has-audio"] !== true) return;
        } else {
          return;
        }

        const start = toNum(props["data-start"]) ?? 0;
        const dataDuration = toNum(props["data-duration"]);
        const cue = props["data-konte-cue"];
        out.push({
          role: tag === "audio" ? "sound" : "embedded",
          levelling: adjustments?.[src],
          kind: cueKinds?.[src],
          file: src,
          localStart: start,
          localEnd: dataDuration != null ? start + dataDuration : null,
          mediaStart: Math.max(0, toNum(props["data-media-start"]) ?? 0),
          rate: toNum(props["data-playback-rate"]) ?? 1,
          volume: toNum(props["data-volume"]) ?? 1,
          fadeIn: toNum(props["data-fade-in"]) ?? undefined,
          fadeOut: toNum(props["data-fade-out"]) ?? undefined,
          cueId: typeof cue === "string" && cue !== "" ? cue : null,
        });
      },
    );
  } catch (err) {
    if (opts.onRenderError === "throw") throw err;
    return [];
  }

  return out;
}

// Resolve a soundtrack's from/until shot anchors to an absolute [start, end] span. `from` omitted
// → timeline start (0); `until` omitted → timeline end. Within an anchor, `at` is shot-internal
// seconds (omitted: from→0 / until→that shot's duration). Shared by the final mux and the live
// preview so both place a bed identically.
export function resolveSoundtrackSpan(
  st: { from?: { shot: string; at?: number }; until?: { shot: string; at?: number } },
  offsets: Map<string, number>,
  durations: Map<string, number>,
  totalDuration: number,
): { start: number; end: number } {
  const start = st.from ? (offsets.get(st.from.shot) ?? 0) + (st.from.at ?? 0) : 0;
  const end = st.until
    ? (offsets.get(st.until.shot) ?? 0) + (st.until.at ?? durations.get(st.until.shot) ?? 0)
    : totalDuration;
  return { start, end: Math.max(start, end) };
}

// A soundtrack auto-loops only when its usable source falls short of the span by more than this.
// Generators rarely hit the requested length exactly (a "15s" source decodes to 14.95s); without
// slack that sub-frame shortfall would auto-loop and `ceil` would report a spurious extra lap.
const LOOP_UNDERRUN_SLACK = 0.25;

// Whether a bed must loop to cover its span, given the usable source length (source minus mediaStart)
// and the span. A shortfall within LOOP_UNDERRUN_SLACK counts as "fills the span" — no loop. Pure —
// unit-tested directly; the explicit `loop` option overrides this at the call site. Shared by the
// final mux and the probe so both judge looping identically.
export function shouldAutoLoop(usableSource: number, span: number): boolean {
  return usableSource < span - LOOP_UNDERRUN_SLACK;
}

/** One lap of a bed: where on its span it starts, where in the source, and how long it plays. */
interface BedPass {
  at: number;
  mediaStart: number;
  duration: number;
}

// A bed's span as the laps the mux plays it in: the first from `mediaStart`, each later one from the
// source's head (ffmpeg's -stream_loop rewinds to the file start, not to -ss). The preview places
// one element per lap because HyperFrames ends an audio clip at its source's end, `loop` or not.
export function bedPasses(opts: {
  span: number;
  mediaStart: number;
  sourceSec: number | undefined;
  loop: boolean | undefined;
}): BedPass[] {
  const { span, mediaStart, sourceSec } = opts;
  const whole = [{ at: 0, mediaStart, duration: span }];
  if (sourceSec == null || sourceSec - mediaStart <= 0) return whole;
  if (!(opts.loop ?? shouldAutoLoop(sourceSec - mediaStart, span))) return whole;
  const passes: BedPass[] = [];
  let at = 0;
  let from = mediaStart;
  while (span - at > 1e-6) {
    const duration = Math.min(sourceSec - from, span - at);
    passes.push({ at, mediaStart: from, duration });
    at += duration;
    from = 0;
  }
  return passes;
}

// What the placement reads off a cue's source take.
export interface CueSource {
  // Null when unmeasured; read only for an open-ended `<Audio>`.
  durationSec: number | null;
  // Read only for an embedded clip.
  hasAudio: boolean;
  loudness: AudioLoudness | undefined;
}

export interface PlacedCue<C extends RawShotAudio> {
  cue: C;
  shotId: string;
  start: number;
  duration: number | null;
  // False for an embedded clip with no audio stream: the mux drops it.
  muxed: boolean;
  // Where a line sounds — what a ducking bed yields to; null for a cue that is not a line.
  trigger: Span | null;
  // The dips an embedded clip's own track takes under the narration over it.
  duck: { steps: DuckStep[]; depth: number } | null;
}

export interface PlacedBed<B extends ResolvedSoundtrack> {
  bed: B;
  start: number;
  end: number;
  duration: number;
  loop: boolean;
  duck: { steps: DuckStep[]; depth: number } | null;
}

// A cue's played length on the timeline.
export function cueDuration(
  cue: Pick<RawShotAudio, "role" | "localStart" | "localEnd" | "mediaStart" | "rate">,
  shotDuration: number,
  sourceSec: number | null,
): number | null {
  if (cue.role === "embedded") {
    const end = cue.localEnd != null ? Math.min(cue.localEnd, shotDuration) : shotDuration;
    return Math.max(0, end - cue.localStart);
  }
  if (cue.localEnd != null) return Math.max(0, cue.localEnd - cue.localStart);
  return sourceSec != null ? Math.max(0, sourceSec - cue.mediaStart) / cue.rate : null;
}

// The span a voice cue ducks a bed over, null for a cue that is not a line or does not sound.
export function cueTrigger(
  cue: Pick<RawShotAudio, "role" | "kind" | "mediaStart" | "rate">,
  start: number,
  duration: number | null,
  source: Pick<CueSource, "hasAudio" | "loudness">,
): Span | null {
  if (!isVoiceKind(cue.kind) || duration == null || duration <= 0) return null;
  if (cue.role === "embedded" && !source.hasAudio) return null;
  return voiceTriggerSpan({
    start,
    end: start + duration,
    mediaStart: cue.mediaStart,
    rate: cue.rate,
    leadInSec: source.loudness?.leadInSec,
    soundEndSec: source.loudness?.soundEndSec,
  });
}

function layOutShots(shots: ReadonlyArray<{ shotId: string; duration: number }>): {
  offsets: Map<string, number>;
  durations: Map<string, number>;
  totalDuration: number;
} {
  const offsets = new Map<string, number>();
  const durations = new Map<string, number>();
  let acc = 0;
  for (const { shotId, duration } of shots) {
    offsets.set(shotId, acc);
    durations.set(shotId, duration);
    acc += duration;
  }
  return { offsets, durations, totalDuration: acc };
}

// Every cue and bed placed on the timeline the shots' durations lay out: the one placement the mux
// plays and the probe reports.
export function placeTimelineAudio<C extends RawShotAudio, B extends ResolvedSoundtrack>(opts: {
  shots: ReadonlyArray<{ shotId: string; duration: number }>;
  cues: ReadonlyArray<{ shotId: string; cue: C; source: CueSource }>;
  beds: ReadonlyArray<{ bed: B; sourceSec: number | null }>;
}): {
  offsets: Map<string, number>;
  durations: Map<string, number>;
  totalDuration: number;
  cues: PlacedCue<C>[];
  beds: PlacedBed<B>[];
} {
  const { offsets, durations, totalDuration } = layOutShots(opts.shots);

  const cues: PlacedCue<C>[] = opts.cues.map(({ shotId, cue, source }) => {
    const start = (offsets.get(shotId) ?? 0) + cue.localStart;
    const duration = cueDuration(cue, durations.get(shotId) ?? 0, source.durationSec);
    return {
      cue,
      shotId,
      start,
      duration,
      muxed: cue.role !== "embedded" || source.hasAudio,
      trigger: cueTrigger(cue, start, duration, source),
      duck: null,
    };
  });

  const voices = cues.flatMap((p) => (p.trigger ? [p.trigger] : []));
  const narration = cues.flatMap((p) =>
    p.trigger && p.cue.role === "sound" && p.cue.kind === "narration" ? [p.trigger] : [],
  );
  for (const [i, p] of cues.entries()) {
    if (p.cue.role !== "embedded" || !p.muxed || p.duration == null) continue;
    p.duck = narrationDuck({
      clip: { start: p.start, end: p.start + p.duration },
      narration,
      volume: p.cue.volume,
      loudness: opts.cues[i]!.source.loudness,
    });
  }

  const beds: PlacedBed<B>[] = [];
  for (const { bed, sourceSec } of opts.beds) {
    const { start, end } = resolveSoundtrackSpan(bed, offsets, durations, totalDuration);
    const duration = Math.max(0, end - start);
    if (duration <= 0) continue;
    const loop =
      bed.loop ?? (sourceSec != null && shouldAutoLoop(sourceSec - bed.mediaStart, duration));
    const settings = duckSettings(bed.duck, { volume: bed.volume, loudness: bed.loudness });
    const steps = settings
      ? buildDuckEnvelope({ bed: { start, end }, triggers: voices, settings })
      : [];
    beds.push({
      bed,
      start,
      end,
      duration,
      loop,
      duck: settings && steps.length > 0 ? { steps, depth: settings.depth } : null,
    });
  }

  return { offsets, durations, totalDuration, cues, beds };
}

export function resolveSoundtracks(
  soundtracks: readonly SoundtrackEntry[],
  bedLevels: Readonly<Record<string, { gain: number; loudness?: AudioLoudness }>>,
  resolveSrc: (src: string) => string,
): ResolvedSoundtrack[] {
  return soundtracks.map((st) => {
    const level = bedLevels[st.id];
    return {
      id: st.id,
      file: resolveSrc(st.src.src),
      from: st.options.from,
      until: st.options.until,
      mediaStart: st.options.mediaStart ?? 0,
      volume: clampEffectiveGain((st.options.volume ?? 1) * (level?.gain ?? 1)),
      ...(level?.loudness ? { loudness: level.loudness } : {}),
      fadeIn: st.options.fadeIn,
      fadeOut: st.options.fadeOut,
      loop: st.options.loop,
      duck: st.options.duck,
      ...(st.song ? { song: true } : {}),
    };
  });
}

// The mux tracks of a timeline laid out on the ACTUAL rendered shot durations (ffprobed).
export async function buildTimelineTracks(opts: {
  shotOrder: string[];
  actualDurations: Map<string, number>;
  audioByShot: Map<string, RawShotAudio[]>;
  soundtracks?: ResolvedSoundtrack[];
  // Every source here is a variant's file, measured when it landed (`mediaByFile`). Without it each
  // source costs a probe or two.
  mediaOf?: (absFile: string) => VariantMedia | undefined;
}): Promise<MuxAudioTrack[]> {
  const { shotOrder, actualDurations, audioByShot, soundtracks = [], mediaOf } = opts;

  const sourceDurations = new Map<string, number | null>();
  const sourceDuration = async (file: string): Promise<number | null> => {
    if (!sourceDurations.has(file)) {
      const recorded = mediaDurationSec(mediaOf?.(file) ?? null);
      sourceDurations.set(file, recorded ?? (await probeMediaDuration(file)));
    }
    return sourceDurations.get(file) ?? null;
  };
  const hasAudio = async (file: string): Promise<boolean> => {
    const recorded = mediaOf?.(file);
    return recorded ? mediaHasAudio(recorded) : await probeHasAudio(file);
  };

  const cues: Array<{ shotId: string; cue: RawShotAudio; source: CueSource }> = [];
  for (const shotId of shotOrder) {
    for (const cue of audioByShot.get(shotId) ?? []) {
      const embedded = cue.role === "embedded";
      const audible = !embedded || (await hasAudio(cue.file));
      const openEnded = !embedded && cue.localEnd == null;
      cues.push({
        shotId,
        cue,
        source: {
          durationSec: openEnded ? await sourceDuration(cue.file) : null,
          hasAudio: audible,
          loudness: loudnessOf(mediaOf?.(cue.file)),
        },
      });
    }
  }
  const beds: Array<{ bed: ResolvedSoundtrack; sourceSec: number | null }> = [];
  const shots = shotOrder.map((shotId) => ({ shotId, duration: actualDurations.get(shotId) ?? 0 }));
  const { offsets, durations, totalDuration } = layOutShots(shots);
  for (const bed of soundtracks) {
    // A bed with an empty span is never placed: leave its source unprobed.
    const { start, end } = resolveSoundtrackSpan(bed, offsets, durations, totalDuration);
    if (end <= start) continue;
    beds.push({ bed, sourceSec: await sourceDuration(bed.file) });
  }

  const placed = placeTimelineAudio({
    shots,
    cues,
    beds,
  });

  const tracks: MuxAudioTrack[] = [];
  for (const { cue, start, duration, muxed, duck } of placed.cues) {
    if (!muxed) continue;
    tracks.push({
      file: cue.file,
      start,
      mediaStart: cue.mediaStart,
      rate: cue.rate,
      duration,
      volume: cue.volume,
      ...(duck ? { duck } : {}),
      loop: false,
      fadeIn: cue.fadeIn,
      fadeOut: cue.fadeOut,
    });
  }
  for (const { bed, start, duration, loop, duck } of placed.beds) {
    tracks.push({
      file: bed.file,
      start,
      mediaStart: bed.mediaStart,
      rate: 1,
      duration,
      volume: bed.volume,
      ...(duck ? { duck } : {}),
      loop,
      fadeIn: bed.fadeIn,
      fadeOut: bed.fadeOut,
    });
  }

  tracks.sort((a, b) => a.start - b.start);
  return tracks;
}
