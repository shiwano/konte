import type { DeliveryUpscaleFn, Export, VideoDefinition, VideoFormat } from "../types/index.js";
import { beginPromptCollection } from "./prompt-collect.js";
import { assertRespellings, beginRespellCollection } from "./respell.js";
import { scriptTexts } from "./shot-script.js";
import { attachCueKinds } from "../spoken-text.js";
import { assertNarrationStemsHeard } from "../narration-stem.js";
import type { ShotFunction } from "./shot-context.js";
import type {
  DirectionEntry,
  StageGraphicShotStarter,
  StagePendingShotStarter,
  StageShotStarter,
  VideoAsideShotStarter,
} from "./direction.js";
import { getDirectionIndex, makeVideoShotStarter } from "./direction.js";
import type { StageTimelineReturn } from "./animatic-builders.js";
import { defineStage } from "./stage-define.js";
import { validateAssetName } from "./validate-identifier.js";
import { assertAudioGain } from "../audio-gain.js";
import { assertDuck, type Duck } from "../audio-duck.js";

export type MediaKind = "image" | "video" | "audio";

export interface MediaAsset<T extends MediaKind = MediaKind> {
  readonly src: string;
  readonly __kind?: T;
}

/**
 * A board shot's narration mix, `animatic.shot(id).narrationStem`. Only `<Audio>` takes it: nothing
 * on screen speaks narration, so no model input accepts it.
 */
export interface NarrationStem {
  readonly src: string;
  readonly __kind?: "narrationStem";
}

// `__kind` is a phantom field — never present at runtime — so a caller that knows the media kind
// mints it directly rather than casting at every site.
export function makeMediaAsset<T extends MediaKind = MediaKind>(src: string): MediaAsset<T> {
  return { src };
}

export interface ShotOptions {
  duration: number;
}

export interface VideoShotOptions extends ShotOptions {
  action: string;
}

/**
 * One developed shot of either stage: its id, the closure that builds its `<Composition>`, and the
 * shot facts the direction injected.
 */
export interface ShotInput<TId extends string = string> {
  __shotInput: true;
  // A graphic shot's build (`graphicShot`).
  __graphicShot?: true;
  id: TId;
  fn: ShotFunction;
  options: VideoShotOptions;
}

/**
 * An "undeveloped shot" marker that carries no composition/asset/job and nothing of its own; the shot
 * it stands for is the direction's `action`. It lets a stage file mirror the whole direction before
 * every shot is built; preview renders it as a black tile, and export refuses while any remain.
 */
export interface PendingShotInput<TId extends string = string> {
  __shotInput: true;
  __pendingShot: true;
  id: TId;
  options: VideoShotOptions;
}

/**
 * A shot that occupies the clock without being part of the arc (see `AsideShot`). The video
 * authors it like any other shot (`fn` builds the picture, usually a `file`); the animatic never
 * boards it and carries it with no `fn` at all, konte filling that span with a labelled slug.
 */
export interface AsideShotInput<TId extends string = string> {
  __shotInput: true;
  __asideShot: true;
  id: TId;
  fn?: ShotFunction;
  options: AsideShotOptions;
}

export interface AsideShotOptions extends ShotOptions {
  label: string;
}

// Any shot a stage chain may hold. Narrowing helpers below rather than a `kind` field: each reader
// asks the one question it has.
export type AnyShotInput<TId extends string = string> =
  | ShotInput<TId>
  | PendingShotInput<TId>
  | AsideShotInput<TId>;

export function isPendingShotInput(input: AnyShotInput): input is PendingShotInput {
  return "__pendingShot" in input && input.__pendingShot === true;
}

export function isAsideShotInput(input: AnyShotInput): input is AsideShotInput {
  return "__asideShot" in input && input.__asideShot === true;
}

// The shots that carry a composition to discover — a developed shot, or a video's aside (which has a
// picture to build). An animatic aside and a pending shot both have none.
export function isBuiltShotInput(input: AnyShotInput): input is ShotInput | AsideShotInput {
  return !isPendingShotInput(input) && typeof (input as ShotInput).fn === "function";
}

export interface ShotAnchor<TId extends string = string> {
  /** The shot this anchor is relative to. */
  shot: TId;
  /** Seconds from that shot's start. Defaults: `from`→0 (shot head), `until`→the shot's end. */
  at?: number;
}

export interface SoundtrackOptions<TId extends string = string> {
  /**
   * Whether this bed yields to the spoken lines over it — `true` for the default curve, `false` for
   * a bed that holds its level through them. Required: konte cannot tell which lines a bed runs
   * under until the shots have real durations, long after this is written.
   */
  duck: Duck;
  /** Span start anchor. Omitted = the timeline start (0). */
  from?: ShotAnchor<TId>;
  /** Span end anchor. Omitted = the timeline end. */
  until?: ShotAnchor<TId>;
  /** Offset into the source media in seconds. */
  mediaStart?: number;
  /** Gain 0–MAX_AUDIO_GAIN (+12 dB), 1 = unity. */
  volume?: number;
  /** Fade-in seconds. */
  fadeIn?: number;
  /** Fade-out seconds. */
  fadeOut?: number;
  /** Loop the source to fill the span if it is shorter than the span. Defaults to true. */
  loop?: boolean;
}

export interface SoundtrackEntry<TId extends string = string> {
  __soundtrackEntry: true;
  id: string;
  src: MediaAsset<"audio">;
  options: SoundtrackOptions<TId>;
}

/**
 * A timeline-spanning audio bed / music track. Placed in the `soundtracks` array of the
 * `timeline()` return — not inside a shot composition. `from`/`until` anchor the span to shot
 * positions (shot-internal seconds, resolved to absolute time at render via accumulated actual
 * durations). Beds loop to fill their span and may overlap (each is its own muxed track).
 */
// Default TId to `never` (not `string`): an anchor-less bed has no shot to infer from, and
// SoundtrackEntry<never> is assignable to any shot-id set, so `{ shots, soundtracks }` type-checks.
// An anchor still infers its literal shot id, which the NoInfer check validates against the shots.
export function soundtrack<const TId extends string = never>(
  id: string,
  src: MediaAsset<"audio">,
  options: SoundtrackOptions<TId>,
): SoundtrackEntry<TId> {
  validateAssetName(id);
  assertAudioGain(options.volume, `soundtrack "${id}"`);
  assertDuck(options.duck, `soundtrack "${id}"`);
  // Defence-in-depth: a soundtrack whose `src` is undefined otherwise flows all the way to export
  // and only surfaces as a cryptic `st.src.src` deref deep in the audio mux. Common causes are a
  // reference asset declared with asset() but never RETURNED from defineReference() (so
  // `reference.<name>` is undefined), or a stale upstream module in a long-lived process. Fail here
  // with the soundtrack named instead.
  if (src == null || typeof src !== "object" || typeof (src as MediaAsset).src !== "string") {
    throw new Error(
      `soundtrack "${id}" has an invalid src (got ${src === undefined ? "undefined" : JSON.stringify(src)}). ` +
        `Pass an audio asset — and if it is a reference asset, make sure defineReference() returns it.`,
    );
  }
  return { __soundtrackEntry: true, id, src, options };
}

/**
 * One already-placed shot's assets by name. Each accessor names the media kind it expects and checks
 * it against what that shot declared: an unknown name, a kind mismatch, or an undeveloped
 * (pendingShot) target throws while the definition loads.
 */
export interface ShotHandle {
  video(assetName: string): MediaAsset<"video">;
  image(assetName: string): MediaAsset<"image">;
  audio(assetName: string): MediaAsset<"audio">;
}

/**
 * The `shot` accessor every stage build receives — any shot the chain has ALREADY placed, by id.
 * `TIds` is the chain's covered-id cursor, so a later shot, an unknown id, and the shot being built
 * are all type errors. A video shot normally references the animatic, not a prior video shot; to
 * share an asset with a shot that is not downstream of it, hoist it to a timeline or reference asset
 * (which stays in scope).
 */
export type StageShots<TIds extends string = string> = (shotId: TIds) => ShotHandle;

/**
 * The video's export wiring. It carries no delivery `size` — the delivery resolution is
 * `direction.policy.format.size.delivery`; here the author only wires HOW to reach it (the upscaler).
 * Provide `delivery.upscale` iff the direction declares a `size.delivery`.
 */
export interface DefineVideoExport {
  delivery?: { upscale: { video?: DeliveryUpscaleFn; frame?: DeliveryUpscaleFn } };
}

export interface DefineVideoOptions<D = unknown, Ids extends string = string> {
  // Prompt findings this stage accepts, keyed the way `konte status` prints them
  // (`prompt-negation:<hash>`) over the reason each is right for the model it is written for. One
  // key covers every address a shared phrase reaches; never a fixable one — rewrite that prompt.
  waivers?: Record<string, string>;
  // Export-time upscale wiring. Never read while building the creative graph.
  export?: DefineVideoExport;
  // The single authoring surface: declare any timeline assets with asset() at the top, then walk the
  // direction (`shot(first, …).nextShot(…)…`) and return it under `shots`, optionally with
  // timeline-spanning `soundtracks`. Assets may derive their inputs from the injected `format` (the
  // working canvas derived from the direction). `shot`/`pendingShot`/`asideShot` are the video-bound
  // shot starters.
  timeline: (args: {
    format: VideoFormat;
    shot: StageShotStarter<D, "video">;
    // A graphic shot: the same component the board placed, with a `<Cutin>` holding the wipe's take
    // where the shot declares one.
    graphicShot: StageGraphicShotStarter<D, "video">;
    pendingShot: StagePendingShotStarter<D, "video">;
    // The aside starter. Unlike the animatic's it takes a build: an aside is never boarded, so the
    // video is where its picture comes from — usually a `file` asset holding finished media.
    asideShot: VideoAsideShotStarter<D>;
  }) => StageTimelineReturn<Ids>;
}

export function defineVideo<const D, Ids extends string = string>(
  direction: DirectionEntry<D>,
  opts: DefineVideoOptions<D, Ids>,
): VideoDefinition {
  const index = getDirectionIndex(direction);
  const starter = makeVideoShotStarter(index);
  const shot = starter.shot as unknown as StageShotStarter<D, "video">;
  const graphicShot = starter.graphicShot as unknown as StageGraphicShotStarter<D, "video">;
  const pendingShot = starter.pendingShot as unknown as StagePendingShotStarter<D, "video">;
  const asideShot = starter.asideShot as unknown as VideoAsideShotStarter<D>;

  // Delivery is export-only: assemble it permissively (either half may be absent) and let the export
  // gate validate the pairing + aspect. Throwing on load would break read-only and reference-stage
  // commands mid-wiring.
  const deliverySize = index.format.size.delivery;
  const upscale = opts.export?.delivery?.upscale;
  const hasUpscaler = !!(upscale && (upscale.video || upscale.frame));
  const exportDef: Export | undefined =
    deliverySize || hasUpscaler ? { delivery: { size: deliverySize, upscale } } : undefined;

  beginPromptCollection(scriptTexts(index.scriptById));
  beginRespellCollection();
  const { definition } = defineStage({
    stage: "video",
    index,
    runTimeline: (format) => opts.timeline({ format, shot, graphicShot, pendingShot, asideShot }),
    waivers: opts.waivers,
  });

  assertRespellings(definition.respellings, index.scriptById);
  attachCueKinds(definition, index.scriptById);

  const video: VideoDefinition = {
    ...definition,
    stage: "video",
    ...(exportDef ? { export: exportDef } : {}),
  };
  assertNarrationStemsHeard(video);
  return video;
}
