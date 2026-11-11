import { useEffect, useMemo, useState } from "react";
import { fetchCompositionHtml } from "../api.js";
import type { ShotInfo } from "../types.js";

function reelCompositionKey(pinned: Record<string, string>, standInShotKey: string): string {
  return JSON.stringify([
    Object.entries(pinned).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    standInShotKey,
  ]);
}

/**
 * The reel's composition HTML, pinned to the takes on screen. `current` is false while `html` is
 * of other takes than the page now names — a fetch under way, or one that failed. `onLoad` runs
 * before each fetch; `onError` gets a failure that is not an abort.
 */
export function useReelComposition({
  shots,
  compositionRefVariants,
  effectiveVariants,
  onLoad,
  onError,
}: {
  shots: ShotInfo[];
  compositionRefVariants: Record<string, string>;
  effectiveVariants: Record<string, string>;
  onLoad: () => void;
  onError: (message: string) => void;
}): { html: string | null; current: boolean } {
  const [loaded, setLoaded] = useState<{ html: string; key: string } | null>(null);

  // The stand-ins this page was told about, as a stable key: the reel is re-fetched when the set
  // moves (a shot whose picture just landed must redraw), and never merely because state was re-read.
  const standInShotKey = useMemo(
    () =>
      shots
        .filter((s) => s.showingStandIn)
        .map((s) => s.shotId)
        .join(","),
    [shots],
  );

  // Pinned to the same takes the submit will record, or the composite re-resolves its external
  // refs against state loaded for THIS request — a reroll landing between the two draws one take
  // and the comment written over it names another. A gallery pick still wins.
  const pinned = useMemo(
    () => ({ ...compositionRefVariants, ...effectiveVariants }),
    [compositionRefVariants, effectiveVariants],
  );
  const key = useMemo(() => reelCompositionKey(pinned, standInShotKey), [pinned, standInShotKey]);

  useEffect(() => {
    // Switching takes in quick succession (or a hot-reload landing on top of one) leaves two
    // fetches in flight, and the slower one is not always the older one — abort the previous
    // request so the composition on screen is always the one last asked for.
    let controller: AbortController | null = null;
    function load() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const overrides = Object.keys(pinned).length > 0 ? pinned : undefined;
      fetchCompositionHtml(overrides, signal, standInShotKey ? standInShotKey.split(",") : [])
        .then((html) => setLoaded({ html, key }))
        .catch((err) => {
          if (signal.aborted) return;
          onError(err.message);
        });
    }
    onLoad();
    load();
    window.addEventListener("konte:reload", load);
    return () => {
      controller?.abort();
      window.removeEventListener("konte:reload", load);
    };
  }, [pinned, key, onLoad, onError, standInShotKey]);

  return { html: loaded?.html ?? null, current: loaded?.key === key };
}
