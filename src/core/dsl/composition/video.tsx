import type { MediaAsset } from "../builders.js";
import { getRenderContext } from "../../jsx-html.js";
import { assertAudioGain } from "../../audio-gain.js";
import { applyLevelGain } from "../../audio-level.js";

type VideoElementProps = React.ComponentPropsWithoutRef<"video">;

export type VideoProps = Omit<VideoElementProps, "src"> & {
  src: MediaAsset<"video">;
  /** Timeline start in seconds (data-start). Defaults to 0. */
  start?: number;
  /** Clip duration in seconds (data-duration). Defaults to the shot duration. */
  duration?: number;
  /** Offset into the source media in seconds (data-media-start). */
  mediaStart?: number;
  /** Include the video's audio in the mix (data-has-audio). */
  hasAudio?: boolean;
  /** Audio gain 0–MAX_AUDIO_GAIN (+12 dB), 1 = unity (data-volume). Only applies when hasAudio is true. */
  volume?: number;
  /** Appended to `konte-clip` — a full-stage, cover-fit layer; Tailwind utilities here override it. */
  className?: string;
};

export function Video({
  src,
  children,
  muted = true,
  playsInline = true,
  start,
  duration,
  mediaStart,
  hasAudio,
  volume,
  className,
  ...rest
}: VideoProps): React.ReactElement {
  // Default the clip to span the whole shot. Without an explicit data-duration the
  // runtime treats the clip as infinite and keeps re-playing the video past the
  // composition end (last/first frame flicker). An explicit prop still wins.
  const { duration: shotDuration, shotId } = getRenderContext();

  // Raw data-* attributes are not part of the props type but are still accepted as
  // JSX attributes; honor them as fallbacks so the typed props stay opt-in. data-end
  // is not a HyperFrames attribute (the runtime bounds a clip by data-duration only),
  // so it is dropped (undefined) rather than forwarded from the spread.
  const raw = rest as Record<string, unknown>;
  const gain = volume ?? raw["data-volume"];
  assertAudioGain(gain, `Shot "${shotId}" <Video>`);
  // The clip's own track is levelled like a standalone cue (`shotCueLevels` decides which clips get
  // a gain at all). A clip with no gain for its src emits the declared value untouched.
  const levelled = applyLevelGain(src.src, gain);

  return (
    <video
      src={src.src}
      muted={muted}
      playsInline={playsInline}
      {...rest}
      className={className ? `konte-clip ${className}` : "konte-clip"}
      data-start={start ?? raw["data-start"] ?? 0}
      data-duration={duration ?? raw["data-duration"] ?? shotDuration}
      data-end={undefined}
      data-media-start={mediaStart ?? raw["data-media-start"]}
      data-has-audio={hasAudio === undefined ? raw["data-has-audio"] : hasAudio ? "true" : "false"}
      data-volume={levelled}
    >
      {children}
    </video>
  );
}
