import type React from "react";
import { createPortal } from "react-dom";
import { formatPlayerTime } from "../format-time.js";
import { type Playhead, usePlayheadTime } from "../review/playhead.js";
import type { ScrubState } from "../review/use-scrub-preview.js";
import type { ShotInfo } from "../types.js";

// The YouTube-style thumbnail above the bar while scrubbing: the first frame of the shot under
// the pointer, with the time and the shot's id. Portaled to the body so no scroll container clips it.
export function ScrubPreview({
  scrub,
  shots,
  shotFrames,
}: {
  scrub: ScrubState | null;
  shots: ShotInfo[];
  shotFrames: Record<string, { first: string | null; last: string | null }>;
}): React.ReactElement | null {
  if (!scrub) return null;
  const shot =
    shots.find((s) => scrub.time >= s.startTime && scrub.time < s.startTime + s.duration) ??
    shots[shots.length - 1];
  const frame = shot ? shotFrames[shot.shotId]?.first : null;
  return createPortal(
    <div className="rt-scrub-preview" style={{ left: scrub.x, top: scrub.barTop - 8 }}>
      {frame && <img className="rt-scrub-thumb" src={frame} alt="" />}
      <div className="rt-scrub-time">
        {formatPlayerTime(scrub.time)}
        {shot ? ` · ${shot.shotId}` : ""}
      </div>
    </div>,
    document.body,
  );
}

// The only thing that moves with playback. Subscribing here (rather than taking the time as a
// prop) keeps the ~30/s playhead updates off the bar's positioned clips and markers.
export function PlayheadLine({
  playhead,
  leftAt,
  style,
}: {
  playhead: Playhead;
  leftAt: (time: number) => number | string;
  style?: React.CSSProperties;
}): React.ReactElement {
  const time = usePlayheadTime(playhead);
  return <div className="rt-playhead" style={{ ...style, left: leftAt(time) }} />;
}
