import type React from "react";
import { useCallback, useRef, useState } from "react";

export interface ScrubState {
  time: number;
  // The cursor's x; `barTop` pins the preview to the bar's height so it never rides up and down
  // with the pointer.
  x: number;
  barTop: number;
}

/**
 * Drag-to-scrub over a bar: pointer capture, seeking as the pointer moves, and the state the
 * thumbnail preview draws from. `resolve` maps a clientX to the time under it (null to ignore the
 * point) and the bar's top edge.
 */
export function useScrubPreview(
  resolve: (clientX: number) => { time: number; barTop: number } | null,
  onSeek: (time: number) => void,
): { scrub: ScrubState | null; handlers: React.DOMAttributes<HTMLDivElement> } {
  const scrubbing = useRef(false);
  const [scrub, setScrub] = useState<ScrubState | null>(null);

  const scrubAt = useCallback(
    (clientX: number) => {
      const hit = resolve(clientX);
      if (!hit) return;
      onSeek(hit.time);
      setScrub({ time: hit.time, x: clientX, barTop: hit.barTop });
    },
    [resolve, onSeek],
  );

  const handlers: React.DOMAttributes<HTMLDivElement> = {
    onPointerDown: (e) => {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // no real pointer (e.g. a synthetic event) — capture is optional
      }
      scrubbing.current = true;
      scrubAt(e.clientX);
    },
    onPointerMove: (e) => {
      if (scrubbing.current) scrubAt(e.clientX);
    },
    onPointerUp: (e) => {
      scrubbing.current = false;
      setScrub(null);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: () => {
      scrubbing.current = false;
      setScrub(null);
    },
  };

  return { scrub, handlers };
}
