import { useEffect, useState } from "react";

// A phone-sized viewport, in either orientation. Below this the three columns have nowhere to
// stand, so the review fills the screen instead: the frame takes what it can and the panels take
// the band it leaves.
const FILL_QUERY = "(max-width: 640px), (max-height: 540px)";

/**
 * Which edge the frame stops short of, and so where the panels go. Fitted into the viewport, the
 * frame touches either the left and right edges (the room it leaves is below) or the top and
 * bottom (the room is beside it) — decided by the two aspects, not by orientation: a 9:16 reel on
 * a portrait phone still leaves its room below, and a 16:9 one on a landscape phone beside.
 */
export type BandSide = "bottom" | "side";

export interface FillLayout {
  fill: boolean;
  bandSide: BandSide;
}

function measure(videoAspect: number): FillLayout {
  return {
    fill: window.matchMedia(FILL_QUERY).matches,
    // Width-limited exactly when the viewport is the narrower shape of the two.
    bandSide: window.innerWidth / window.innerHeight < videoAspect ? "bottom" : "side",
  };
}

/**
 * The full-screen review's shape. Both answers move with the window, so a rotation re-decides
 * them together — the frame's own scaling is the viewport box's (see VideoPreview), which this
 * only sizes.
 */
export function useFillLayout(videoAspect: number): FillLayout {
  const [layout, setLayout] = useState<FillLayout>(() => measure(videoAspect));

  useEffect(() => {
    const update = () => setLayout(measure(videoAspect));
    update();
    // The keyboard opening changes the visual viewport, not this one, so a reviewer typing a
    // comment does not resize the frame under themselves.
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [videoAspect]);

  return layout;
}
