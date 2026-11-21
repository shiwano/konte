import type { MediaAsset } from "./media.js";

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
  // The song bed konte lays under a piece with `policy.song` (see `mixedSoundtracks`).
  song?: true;
}
