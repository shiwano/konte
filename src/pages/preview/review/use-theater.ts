import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/**
 * Theater: the review fills the window below the header, the frame taking every pixel the controls,
 * the timeline and the two side columns leave — the columns stay, so a note is still written where
 * it always was. The browser's fullscreen is asked for on top of it; where it is refused (no user
 * activation, an embedding that forbids it) the in-window mode still stands, so the toggle never
 * silently does nothing.
 *
 * `fill` is the phone layout (see useFillLayout), which fills the screen whether or not theater was
 * asked for. Both hand the viewport its height, so `immersive` is what the page lays out by;
 * `theater` stays the toggle alone.
 */
export function useTheater(fill: boolean): {
  theater: boolean;
  immersive: boolean;
  toggleTheater: () => void;
  exitTheater: () => void;
} {
  const [theater, setTheater] = useState(false);
  const immersive = theater || fill;

  useEffect(() => {
    document.body.classList.toggle("theater-mode", immersive);
    document.body.classList.toggle("fill-mode", fill);
    return () => {
      document.body.classList.remove("theater-mode");
      document.body.classList.remove("fill-mode");
    };
  }, [immersive, fill]);

  // Escape leaves the browser's fullscreen without the click that would tell us; drop the
  // in-window mode with it, so the two never disagree.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setTheater(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      // The review is going away (submitted, reloaded into another stage) — give the screen back
      // rather than leave the closing message holding it.
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const theaterRef = useRef(theater);
  theaterRef.current = theater;

  const exitTheater = useCallback(() => {
    setTheater(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  const toggleTheater = useCallback(() => {
    if (theaterRef.current) {
      exitTheater();
      return;
    }
    setTheater(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }, [exitTheater]);

  return { theater, immersive, toggleTheater, exitTheater };
}

// Height as well as width: in theater the viewport's height is handed to it by the column rather
// than derived from its width, so it has to be measured to scale the frame into it.
export function useElementBox(ref: RefObject<HTMLElement | null>): {
  width: number;
  height: number;
} {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setBox({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries)
        setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}
