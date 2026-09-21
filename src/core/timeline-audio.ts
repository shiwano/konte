import type { ShotStage } from "./address.js";
import { runInRenderMode } from "./dsl/shot-context.js";
import type { AudioLevelling, CueKind, ShotCueLevels } from "./audio-level.js";
import { cueBySrc, isVoiceKind, loudnessOf } from "./audio-level.js";
import {
  buildDuckEnvelope,
  duckSettings,
  voiceTriggerSpan,
  type Duck,
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
 * The one reader of a rendered shot's cues: the mux and the probe share it so they cannot disagree
 * about what is in the mix or what ducks a bed.
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

// Resolve audio into absolute-timeline mux tracks. Offsets accumulate from the ACTUAL rendered
// shot durations (ffprobed), so placement is sample-accurate even when a shot renders a frame or
// two off its nominal length. Per-shot `<Audio>` and embedded clips become one independent
// play-once track each; timeline `soundtracks` (beds) resolve to one span each (looping to fill if
// the source is shorter than the span), and may overlap.
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

  const offsets = new Map<string, number>();
  let acc = 0;
  for (const shotId of shotOrder) {
    offsets.set(shotId, acc);
    acc += actualDurations.get(shotId) ?? 0;
  }
  const totalDuration = acc;

  const tracks: MuxAudioTrack[] = [];
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

  // Where the spoken lines sit on the finished timeline — what a ducking bed yields to.
  const voiceSpans: Span[] = [];

  // <Sound> and embedded: one independent, play-once track per placement.
  for (const shotId of shotOrder) {
    const offset = offsets.get(shotId) ?? 0;
    const shotDur = actualDurations.get(shotId) ?? 0;
    for (const raw of audioByShot.get(shotId) ?? []) {
      if (raw.role === "embedded" && !(await hasAudio(raw.file))) continue;
      const start = offset + raw.localStart;
      let duration: number | null;
      if (raw.localEnd != null) {
        duration = Math.max(0, raw.localEnd - raw.localStart);
      } else if (raw.role === "embedded") {
        duration = Math.max(0, shotDur - raw.localStart);
      } else {
        const len = await sourceDuration(raw.file);
        duration = len != null ? Math.max(0, len - raw.mediaStart) : null;
      }
      if (isVoiceKind(raw.kind) && duration != null && duration > 0) {
        const trigger = voiceTriggerSpan({
          start,
          end: start + duration,
          mediaStart: raw.mediaStart,
          leadInSec: loudnessOf(mediaOf?.(raw.file))?.leadInSec,
        });
        if (trigger) voiceSpans.push(trigger);
      }
      tracks.push({
        file: raw.file,
        start,
        mediaStart: raw.mediaStart,
        duration,
        volume: raw.volume,
        loop: false,
        fadeIn: raw.fadeIn,
        fadeOut: raw.fadeOut,
      });
    }
  }

  // Timeline-level soundtracks: each is one span, resolved from its from/until shot anchors.
  // `from` omitted → timeline start (0); `until` omitted → timeline end. `at` within an anchor is
  // shot-internal seconds (omitted: from→0 / until→that shot's actual end). Beds may overlap.
  for (const st of soundtracks) {
    const { start: spanStart, end: spanEnd } = resolveSoundtrackSpan(
      st,
      offsets,
      actualDurations,
      totalDuration,
    );
    const spanDuration = Math.max(0, spanEnd - spanStart);
    if (spanDuration <= 0) continue;
    const len = await sourceDuration(st.file);
    const loop = st.loop ?? (len != null && shouldAutoLoop(len - st.mediaStart, spanDuration));
    const settings = duckSettings(st.duck, { volume: st.volume, loudness: st.loudness });
    const steps = settings
      ? buildDuckEnvelope({
          bed: { start: spanStart, end: spanEnd },
          triggers: voiceSpans,
          settings,
        })
      : [];
    tracks.push({
      file: st.file,
      start: spanStart,
      mediaStart: st.mediaStart,
      duration: spanDuration,
      volume: st.volume,
      ...(settings && steps.length > 0 ? { duck: { steps, depth: settings.depth } } : {}),
      loop,
      fadeIn: st.fadeIn,
      fadeOut: st.fadeOut,
    });
  }

  tracks.sort((a, b) => a.start - b.start);
  return tracks;
}
