import type React from "react";
import { useCallback, useRef } from "react";
import { normalizedPointIn } from "../review/normalized-point.js";
import { type Playhead, usePlayheadTime } from "../review/playhead.js";
import { PinMarker } from "./pin-marker.js";

export interface TimedNote {
  id: string;
  time: number;
  text: string;
  // Absent on a soundtrack note, which belongs to the timeline rather than to any one shot.
  shotId?: string;
  // Pin anchor, normalized to 0-1 of the frame — the same units every stage's pins use.
  x?: number;
  y?: number;
  stale?: boolean;
  pending?: boolean;
  // The comment's number in the sidebar list — shown on its on-frame marker so the
  // frame and the list read as one.
  pinIndex?: number;
}

const LEAD = 0.4;
const HOLD = 4;
const FADE = 0.4;
const MAX_SUBTITLES = 3;

// Opacity is derived from playback position so the fade is deterministic and
// also works while scrubbing or paused, with no enter/exit animation needed.
function surfaceOpacity(currentTime: number, noteTime: number): number {
  const total = LEAD + HOLD;
  const elapsed = currentTime - (noteTime - LEAD);
  if (elapsed <= 0 || elapsed >= total) return 0;
  if (elapsed < FADE) return elapsed / FADE;
  if (elapsed > total - FADE) return (total - elapsed) / FADE;
  return 1;
}

interface TimedNoteOverlayProps {
  width: number;
  height: number;
  scale: number;
  // The player box width (px). Subtitles span this rather than the (possibly narrow, e.g.
  // portrait) video frame, so a note isn't squeezed to a vertical video's width.
  frameWidth?: number;
  notes: TimedNote[];
  playhead: Playhead;
  currentShotId: string | undefined;
  pendingPinCoords: { x: number; y: number } | null;
  highlightedNoteId: string | null;
  onPinPlace: (x: number, y: number) => void;
  onNoteClick: (note: TimedNote) => void;
}

export function TimedNoteOverlay({
  width,
  height,
  scale,
  frameWidth,
  notes,
  playhead,
  currentShotId,
  pendingPinCoords,
  highlightedNoteId,
  onPinPlace,
  onNoteClick,
}: TimedNoteOverlayProps): React.ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);
  // The overlay redraws with the playhead (notes surface and fade), so it subscribes here
  // rather than taking the time as a prop and dragging the whole review along with it.
  const currentTime = usePlayheadTime(playhead);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const { x, y } = normalizedPointIn(rect, e);
      onPinPlace(x, y);
    },
    [onPinPlace],
  );

  // A note is suppressed the instant the playhead leaves its shot — feedback for a shot
  // shouldn't bleed over the cut into the next one. A soundtrack note answers to no shot, so it
  // is in scope wherever the playhead is.
  const inScope = (note: TimedNote) => note.shotId === undefined || note.shotId === currentShotId;
  const isPinned = (note: TimedNote) => note.x != null && note.y != null;
  // A pin points at a place in the picture, not at an instant, so it stands for as long as the
  // playhead is in its shot: the frame carries every standing note on the shot under review,
  // numbered as the sidebar numbers it. Only un-pinned notes surface at their time and fade.
  const pinned = notes.filter((note) => isPinned(note) && inScope(note)).map((note) => ({ note }));
  const subtitles = notes
    .filter((note) => !isPinned(note) && inScope(note))
    .map((note) => ({
      note,
      opacity: highlightedNoteId === note.id ? 1 : surfaceOpacity(currentTime, note.time),
    }))
    .filter((v) => v.opacity > 0.01)
    .sort((a, b) => a.note.time - b.note.time)
    .slice(-MAX_SUBTITLES);

  return (
    <div
      ref={overlayRef}
      role="presentation"
      className="frame-annotation-overlay frame-annotation-overlay--adding"
      style={{ width: width * scale, height: height * scale, pointerEvents: "auto" }}
      onClick={handleClick}
    >
      {pinned.map(({ note }) => (
        <span key={note.id} style={{ opacity: note.stale ? 0.55 : 1 }}>
          <PinMarker
            index={note.pinIndex ?? null}
            left={`${note.x! * 100}%`}
            top={`${note.y! * 100}%`}
            text={note.text}
            state={note.pending ? "pending" : note.stale ? "stale" : "saved"}
            highlighted={highlightedNoteId === note.id}
            onClick={() => onNoteClick(note)}
          />
        </span>
      ))}

      {pendingPinCoords && (
        <PinMarker
          index={null}
          left={`${pendingPinCoords.x * 100}%`}
          top={`${pendingPinCoords.y * 100}%`}
          state="pending"
        />
      )}

      {subtitles.length > 0 && (
        <div
          className="timed-subtitle-stack"
          // Size to the player width (not the video frame) so portrait videos don't squeeze notes.
          style={frameWidth ? { width: frameWidth * 0.86, maxWidth: "none" } : undefined}
        >
          {subtitles.map(({ note, opacity }) => (
            <button
              key={note.id}
              type="button"
              className={`timed-subtitle${highlightedNoteId === note.id ? " timed-subtitle--highlighted" : ""}`}
              style={{ opacity: opacity * (note.stale ? 0.5 : 1) }}
              onClick={(e) => {
                e.stopPropagation();
                onNoteClick(note);
              }}
            >
              {note.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
