import type { MediaAsset, NarrationStem } from "../builders.js";
import { assertAudioGain } from "../../audio-gain.js";
import { applyLevelGain } from "../../audio-level.js";
import { getRenderContext } from "../../jsx-html.js";

type AudioElementProps = React.ComponentPropsWithoutRef<"audio">;

export type AudioProps = Omit<AudioElementProps, "src" | "id"> & {
  src: MediaAsset<"audio"> | NarrationStem;
  /**
   * Stable cue id, local to the shot (data-konte-cue) — a display label for the review timeline and
   * `konte probe`. Not an address: `#` is konte's reserved namespace (see address.ts), and a cue id
   * is authored, so a cue is never addressed `…#<id>`. Accept and focus route through the shot.
   */
  id?: string;
  /** Timeline start in seconds, local to the shot it is placed in (data-start). Defaults to 0. */
  start?: number;
  /** Clip duration in seconds (data-duration). Defaults to the source length. */
  duration?: number;
  /**
   * Offset into the source media in seconds (data-media-start). Omitted on a sound effect, the
   * silence its take leads with is skipped, so `start` is where the sound lands.
   */
  mediaStart?: number;
  /** Gain 0–MAX_AUDIO_GAIN (+12 dB), 1 = unity (data-volume). */
  volume?: number;
  /** Fade-in seconds (data-fade-in). */
  fadeIn?: number;
  /** Fade-out seconds (data-fade-out). */
  fadeOut?: number;
};

/**
 * A one-shot sound placed in a shot's composition (dialogue, SFX, narration). Plays once at full
 * length from `start`, extending past the shot boundary if longer than the shot. Muxed onto the
 * final timeline, never baked per shot. For a timeline-spanning bed/music, use the `soundtrack()`
 * entries in the timeline return's `soundtracks` array.
 */
export function Audio({
  src,
  children,
  id,
  start,
  duration,
  mediaStart,
  volume,
  fadeIn,
  fadeOut,
  ...rest
}: AudioProps): React.ReactElement {
  // Raw data-* attributes are not part of the props type but are still accepted as
  // JSX attributes; honor them as fallbacks so the typed props stay opt-in. data-end
  // is not a HyperFrames attribute (the runtime bounds a clip by data-duration only),
  // so it is dropped (undefined) rather than forwarded from the spread. With no duration,
  // no data-duration is emitted and the sound plays its full source length.
  const raw = rest as Record<string, unknown>;
  const gain = volume ?? raw["data-volume"];
  // The ceiling is checked against what the AUTHOR declared, never the levelled result.
  assertAudioGain(gain, `Shot "${getRenderContext().shotId}" <Audio${id ? ` id="${id}"` : ""}>`);
  const levelled = applyLevelGain(src.src, gain);

  return (
    <audio
      src={src.src}
      {...rest}
      data-konte-track="sound"
      data-konte-cue={id ?? raw["data-konte-cue"]}
      data-start={start ?? raw["data-start"] ?? 0}
      data-duration={duration ?? raw["data-duration"]}
      data-end={undefined}
      data-media-start={
        mediaStart ?? raw["data-media-start"] ?? getRenderContext().leadIns?.[src.src]
      }
      data-volume={levelled}
      data-fade-in={fadeIn ?? raw["data-fade-in"]}
      data-fade-out={fadeOut ?? raw["data-fade-out"]}
    >
      {children}
    </audio>
  );
}
