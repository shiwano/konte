import type React from "react";
import { useCallback, useRef } from "react";
import { formatTimecode } from "../format-time.js";
import type { Playhead } from "../review/playhead.js";
import { useScrubPreview } from "../review/use-scrub-preview.js";
import type { ShotInfo, TimelineNote } from "../types.js";
import { PlayheadLine, ScrubPreview } from "./scrub-preview.js";

/**
 * The theater's stand-in for the review timeline: one slim bar under the frame carrying the
 * video's shots, the notes standing on them, and the playhead — where you are and where to jump,
 * in a fraction of the height the tracks want. The multi-track timeline is what theater mode
 * gives back to the frame, so this is the whole of what replaces it. Its playhead and its
 * drag-to-scrub thumbnail are the timeline's, so scrubbing reads the same in either layout.
 */
export function TheaterScrubber({
  shots,
  totalDuration,
  playhead,
  notes,
  shotFrames,
  shotAccepted,
  focusedShotId,
  onSeek,
  onSeekToNote,
}: {
  shots: ShotInfo[];
  totalDuration: number;
  playhead: Playhead;
  notes?: TimelineNote[];
  shotFrames: Record<string, { first: string | null; last: string | null }>;
  shotAccepted: Record<string, boolean>;
  focusedShotId?: string;
  onSeek: (time: number) => void;
  onSeekToNote?: (note: TimelineNote) => void;
}): React.ReactElement {
  const trackRef = useRef<HTMLDivElement>(null);
  const timeAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      return { time: ratio * totalDuration, barTop: rect.top };
    },
    [totalDuration],
  );
  const { scrub, handlers } = useScrubPreview(timeAt, onSeek);

  const pct = (time: number) => (totalDuration > 0 ? (time / totalDuration) * 100 : 0);

  return (
    <div className="theater-scrubber" ref={trackRef} role="presentation" {...handlers}>
      {shots.map((shot, i) => {
        const continues = i > 0 && shot.join === "continuous";
        const continued = shots[i + 1]?.join === "continuous";
        return (
          <div
            key={shot.shotId}
            className={`ts-shot${shotAccepted[shot.shotId] ? " ts-shot--accepted" : ""}${
              focusedShotId === shot.shotId ? " ts-shot--focused" : ""
            }${shot.pending ? " ts-shot--pending" : ""}${
              continues ? " ts-shot--continues" : ""
            }${continued ? " ts-shot--continued" : ""}`}
            style={{ left: `${pct(shot.startTime)}%`, width: `${pct(shot.duration)}%` }}
            title={`Shot ${shot.shotId}: ${formatTimecode(shot.startTime)}`}
          >
            <span className="ts-shot-id">{shot.shotId}</span>
          </div>
        );
      })}

      <PlayheadLine
        playhead={playhead}
        leftAt={(time) =>
          `${totalDuration > 0 ? Math.min(Math.max(time / totalDuration, 0), 1) * 100 : 0}%`
        }
        style={{ marginLeft: -1 }}
      />

      {notes?.map((n) => (
        <button
          key={n.id}
          type="button"
          className={`rt-note-marker${n.stale ? " rt-note-marker--stale" : ""}`}
          style={{ left: `${pct(Math.min(n.time, totalDuration))}%` }}
          title={n.text}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            (onSeekToNote ?? (() => onSeek(n.time)))(n);
          }}
        />
      ))}

      <ScrubPreview scrub={scrub} shots={shots} shotFrames={shotFrames} />
    </div>
  );
}
