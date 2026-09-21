import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatPlayerTime, formatTimecode } from "../format-time.js";

export const MIN_PX_PER_SEC = 2;
export const MAX_PX_PER_SEC = 1280;
export const ZOOM_STEP = 1.4;

// Evenly-spaced ruler ticks whose spacing lands on a "nice" number of seconds for the
// current zoom (aiming for ~one label per 80px), so labels never crowd.
export function tickInterval(pxPerSec: number): number {
  const target = 80 / pxPerSec;
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return nice.find((n) => n >= target) ?? nice[nice.length - 1]!;
}

// A tick's label at the ruler's own resolution: `m:ss` reads two neighbouring sub-second ticks as
// the same time, so the finest step spells the tenth out.
export function tickLabel(seconds: number, step: number): string {
  return step < 1 ? formatPlayerTime(seconds) : formatTimecode(seconds);
}

export interface TimelineZoom {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  // null = auto-fit to the viewport; a number = a manual zoom that survives viewport resizes.
  pxPerSec: number | null;
  setPxPerSec: (v: number | null) => void;
  fitPxPerSec: number;
  effectivePxPerSec: number;
  timelineWidth: number;
  zoomBy: (factor: number, anchorClientX?: number) => void;
  resetZoom: () => void;
  panHandlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  };
  // Whether the gesture that just ended panned rather than picked — a clip's own click handler
  // reads it to tell "clicked me" from "dragged across me".
  wasDragged: () => boolean;
}

/**
 * The shared mechanics of a time-proportional strip: fit-to-width until the reader zooms,
 * wheel-zoom anchored at the cursor, and drag-to-pan. Both timelines konte draws over a
 * duration — the video review's NLE and the direction page's map — read the same way
 * because they run on this; what they draw *into* the track is their own business.
 */
export function useTimelineZoom({
  totalDuration,
  labelWidth,
  noPanSelector,
  onTap,
}: {
  totalDuration: number;
  labelWidth: number;
  // Elements a pan must not start from (their own handlers own the gesture).
  noPanSelector?: string;
  // A pointer gesture that ended without panning — a pick, at `e.clientX`.
  onTap?: (e: React.PointerEvent<HTMLDivElement>) => void;
}): TimelineZoom {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pxPerSec, setPxPerSec] = useState<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setViewportWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Never floored: a fit that does not fit is not a fit, and a long piece's is finer than
  // MIN_PX_PER_SEC on its own (an hour over a 1200px track is a fifth of a pixel per second).
  const fitPxPerSec = useMemo(() => {
    const track = Math.max(viewportWidth - labelWidth, 120);
    return totalDuration > 0 ? track / totalDuration : 40;
  }, [viewportWidth, labelWidth, totalDuration]);

  // Zooming out bottoms out at MIN_PX_PER_SEC, or at the fit when the whole piece is already
  // coarser than that — there is nothing to see past the point where it all fits on screen.
  const minPxPerSec = Math.min(MIN_PX_PER_SEC, fitPxPerSec);

  const effectivePxPerSec = pxPerSec ?? fitPxPerSec;

  const zoomBy = useCallback(
    (factor: number, anchorClientX?: number) => {
      const el = scrollRef.current;
      const current = pxPerSec ?? fitPxPerSec;
      const next = Math.min(Math.max(current * factor, minPxPerSec), MAX_PX_PER_SEC);
      if (next === current) return;
      if (el) {
        const rect = el.getBoundingClientRect();
        const anchorX = (anchorClientX ?? rect.left + rect.width / 2) - rect.left;
        const contentX = el.scrollLeft + anchorX - labelWidth;
        const t = contentX / current;
        setPxPerSec(next);
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = t * next + labelWidth - anchorX;
        });
      } else {
        setPxPerSec(next);
      }
    },
    [pxPerSec, fitPxPerSec, minPxPerSec, labelWidth],
  );

  // Wheel over the strip zooms at the cursor. A native, non-passive listener is required so
  // preventDefault actually suppresses the page scroll (React's onWheel is passive).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const resetZoom = useCallback(() => {
    setPxPerSec(null);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, []);

  const drag = useRef<{ startX: number; startScroll: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (noPanSelector && (e.target as HTMLElement).closest(noPanSelector)) return;
      const el = scrollRef.current;
      if (!el) return;
      dragged.current = false;
      drag.current = { startX: e.clientX, startScroll: el.scrollLeft, moved: false };
      el.setPointerCapture(e.pointerId);
    },
    [noPanSelector],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!drag.current || !el) return;
    const dx = e.clientX - drag.current.startX;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    if (drag.current.moved) el.scrollLeft = drag.current.startScroll - dx;
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      dragged.current = drag.current?.moved ?? false;
      if (drag.current && !drag.current.moved) onTap?.(e);
      drag.current = null;
      if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    },
    [onTap],
  );

  return {
    scrollRef,
    pxPerSec,
    setPxPerSec,
    fitPxPerSec,
    effectivePxPerSec,
    timelineWidth: totalDuration * effectivePxPerSec,
    zoomBy,
    resetZoom,
    panHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    wasDragged: () => dragged.current,
  };
}
