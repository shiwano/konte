import type { MediaAsset } from "../builders.js";
import { getRenderContext } from "../../jsx-html.js";
import { assertAudioGain } from "../../audio-gain.js";
import { assertPlaybackRate } from "../../playback-rate.js";
import { applyLevelGain } from "../../audio-level.js";
import { KonteError } from "../../errors.js";
import { songSpanOf, songWindowStart } from "../song-window.js";

type VideoElementProps = React.ComponentPropsWithoutRef<"video">;

export type VideoProps = Omit<VideoElementProps, "src"> & {
  src: MediaAsset<"video">;
  /** Timeline start in seconds (data-start). Defaults to 0. */
  start?: number;
  /** Clip duration in seconds (data-duration). Defaults to the shot duration. */
  duration?: number;
  /**
   * Offset into the source media in seconds (data-media-start). konte fills it for a take cut to
   * the song, and refuses one written there.
   */
  mediaStart?: number;
  /**
   * Source seconds played per timeline second (data-playback-rate), 0.1–10: 1.625 fits a 1.625 s
   * take into a 1 s clip; a hasAudio track plays at the same rate, its pitch kept. Refused on a take
   * cut to the song.
   */
  playbackRate?: number;
  /** Include the video's audio in the mix (data-has-audio). Refused on a take cut to the song. */
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
  playbackRate,
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
  const clipStart = start ?? raw["data-start"] ?? 0;
  const clipHasAudio =
    hasAudio ?? (raw["data-has-audio"] === true || raw["data-has-audio"] === "true");
  const rate = playbackRate ?? raw["data-playback-rate"];
  assertPlaybackRate(rate, `Shot "${shotId}" <Video>`);
  const window = songClipWindow({
    src,
    shotId,
    start: Number(clipStart),
    mediaStart: mediaStart ?? raw["data-media-start"],
    rate,
    hasAudio: clipHasAudio,
  });

  return (
    <video
      src={src.src}
      muted={muted}
      playsInline={playsInline}
      {...rest}
      className={className ? `konte-clip ${className}` : "konte-clip"}
      data-start={clipStart}
      data-duration={duration ?? raw["data-duration"] ?? shotDuration}
      data-end={undefined}
      data-media-start={window ?? mediaStart ?? raw["data-media-start"]}
      data-playback-rate={rate}
      data-has-audio={hasAudio === undefined ? raw["data-has-audio"] : hasAudio ? "true" : "false"}
      data-volume={levelled}
    >
      {children}
    </video>
  );
}

// The window of a take cut to the song: where the song is when the clip starts, less where the take
// starts on it. Undefined for any other take.
function songClipWindow(clip: {
  src: MediaAsset<"video">;
  shotId: string;
  start: number;
  mediaStart: unknown;
  rate: unknown;
  hasAudio: boolean;
}): number | undefined {
  const span = songSpanOf(clip.src);
  if (!span) return undefined;
  const label = `Shot "${clip.shotId}" <Video>`;
  if (clip.hasAudio) {
    throw new KonteError(
      "SONG_DOUBLED",
      `${label} takes the audio of a take cut to the song, which the song bed already plays. Drop ` +
        `hasAudio, and place the shot's lines with <Audio>.`,
    );
  }
  if (clip.rate !== undefined && clip.rate !== null && Number(clip.rate) !== 1) {
    throw new KonteError(
      "SONG_WINDOW_INVALID",
      `${label} writes a playbackRate on a take cut to the song. The take is cut to the song at ` +
        `its own speed — drop playbackRate.`,
    );
  }
  if (span.start === null) return undefined;
  if (clip.mediaStart !== undefined) {
    throw new KonteError(
      "SONG_WINDOW_INVALID",
      `${label} writes a mediaStart on a take cut to the song. Where the take sits on the song ` +
        `fixes its window, and konte fills it — drop mediaStart.`,
    );
  }
  return songWindowStart(span, clip.shotId, clip.start, label);
}
