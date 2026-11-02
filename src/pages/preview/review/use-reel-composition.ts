import { useEffect, useMemo, useState } from "react";
import { fetchCompositionHtml } from "../api.js";
import type { ShotInfo } from "../types.js";

/**
 * The reel's composition HTML, pinned to the takes on screen. `onLoad` runs before each fetch;
 * `onError` gets a failure that is not an abort.
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
}): string | null {
  const [compositionHtml, setCompositionHtml] = useState<string | null>(null);

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

  useEffect(() => {
    // Switching takes in quick succession (or a hot-reload landing on top of one) leaves two
    // fetches in flight, and the slower one is not always the older one — abort the previous
    // request so the composition on screen is always the one last asked for.
    let controller: AbortController | null = null;
    function load() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      // Pinned to the same takes the submit will record, or the composite re-resolves its external
      // refs against state loaded for THIS request — a reroll landing between the two draws one take
      // and the comment written over it names another. A gallery pick still wins.
      const pinned = { ...compositionRefVariants, ...effectiveVariants };
      const overrides = Object.keys(pinned).length > 0 ? pinned : undefined;
      fetchCompositionHtml(
        undefined,
        undefined,
        overrides,
        signal,
        standInShotKey ? standInShotKey.split(",") : [],
      )
        .then(setCompositionHtml)
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
  }, [effectiveVariants, compositionRefVariants, onLoad, onError, standInShotKey]);

  return compositionHtml;
}
