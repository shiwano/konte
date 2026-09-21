import { useEffect, useState } from "react";

// Surfaces that own the highlight: the marker itself, the comment card it is twinned with, and
// the video review's on-frame subtitle. A mousedown anywhere else is a click away from the note.
const HIGHLIGHT_SURFACES = ".pin-marker, .comment-card, .timed-subtitle";

/**
 * The feedback comment currently highlighted — its on-frame pin scaled up and its text tip held
 * open. Clicking a pin (or its comment card) opens the tip; clicking anywhere else, or pressing
 * Escape, closes it again. Without this the tip, being tied to state rather than :hover, would
 * stay on screen forever.
 */
export function useHighlightedFeedback(): [string | null, (id: string | null) => void] {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    if (!highlightedId) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(HIGHLIGHT_SURFACES)) setHighlightedId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHighlightedId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [highlightedId]);

  return [highlightedId, setHighlightedId];
}
