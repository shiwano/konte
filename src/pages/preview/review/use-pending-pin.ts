import { useCallback, useState } from "react";
import type { CommentThreadBinding, ReviewSession } from "./use-review-session.js";

/**
 * A pin being placed on one target's frame, awaiting its note text. Keyed by address so the
 * marker and the note composer appear only on the frame that was clicked — in a table row or in
 * the detail modal alike. The note that lands next on that address takes the pin as its
 * annotation.
 */
export function usePendingPin(session: Pick<ReviewSession, "addPending" | "threadFor">) {
  const [pendingPin, setPendingPin] = useState<{ address: string; x: number; y: number } | null>(
    null,
  );

  const placePin = useCallback((address: string, x: number, y: number) => {
    setPendingPin({ address, x, y });
  }, []);

  const cancelPin = useCallback(() => setPendingPin(null), []);

  const { addPending: addPendingNote, threadFor: sessionThreadFor } = session;
  const addPending = useCallback(
    (address: string, text: string) => {
      const annotation =
        pendingPin && pendingPin.address === address
          ? { kind: "pin" as const, x: pendingPin.x, y: pendingPin.y }
          : null;
      addPendingNote(address, text, { annotation });
      setPendingPin(null);
    },
    [addPendingNote, pendingPin],
  );

  // The pin as one frame sees it: its coordinates when it is that frame's, else nothing.
  const pinFor = useCallback(
    (address: string): { x: number; y: number } | null =>
      pendingPin?.address === address ? { x: pendingPin.x, y: pendingPin.y } : null,
    [pendingPin],
  );

  // The session's thread for an address, its next note taking the pin placed on that frame.
  const threadFor = useCallback(
    (address: string): CommentThreadBinding => ({
      ...sessionThreadFor(address),
      addPending: (text) => addPending(address, text),
    }),
    [sessionThreadFor, addPending],
  );

  return { pendingPin, placePin, cancelPin, addPending, pinFor, threadFor };
}
