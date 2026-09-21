import type React from "react";
import type { FeedbackInfo } from "../types.js";
import { PinMarker } from "./pin-marker.js";

// A draft comment as the layer needs it: pinned ones are drawn, the rest skipped.
export interface PendingPinNote {
  id: string;
  text: string;
  annotation: { kind: "pin"; x: number; y: number } | null;
}

/**
 * The pin markers over a frame: saved pins (deleted and, when hidden, stale ones dropped), draft
 * pins, and the one being placed. Rendered inside a positioned container; the frame's own click
 * handler places the pin.
 */
export function PinLayer({
  pins,
  pendingPins,
  pendingPin,
  hideStale,
  deletedFeedbackIds,
  pinIndexById,
  highlightedId,
  onPinClick,
}: {
  pins: FeedbackInfo[];
  pendingPins: PendingPinNote[];
  pendingPin: { x: number; y: number } | null;
  hideStale: boolean;
  deletedFeedbackIds: Set<string>;
  // Number shown on each pin's marker — matches the comment list (see buildPinIndex).
  pinIndexById?: Map<string, number>;
  highlightedId?: string | null;
  onPinClick: (feedbackId: string) => void;
}): React.ReactElement {
  const visiblePins = pins.filter((p) => !deletedFeedbackIds.has(p.id) && (!hideStale || !p.stale));
  return (
    <>
      {visiblePins.map((pin) =>
        pin.annotation ? (
          <PinMarker
            key={pin.id}
            index={pinIndexById?.get(pin.id) ?? null}
            left={`${pin.annotation.x * 100}%`}
            top={`${pin.annotation.y * 100}%`}
            text={pin.text}
            state={pin.stale ? "stale" : "saved"}
            highlighted={highlightedId === pin.id}
            onClick={() => onPinClick(pin.id)}
          />
        ) : null,
      )}
      {pendingPins.map((pp) =>
        pp.annotation ? (
          <PinMarker
            key={pp.id}
            index={pinIndexById?.get(pp.id) ?? null}
            left={`${pp.annotation.x * 100}%`}
            top={`${pp.annotation.y * 100}%`}
            text={pp.text}
            state="pending"
            highlighted={highlightedId === pp.id}
            onClick={() => onPinClick(pp.id)}
          />
        ) : null,
      )}
      {pendingPin && (
        <PinMarker
          index={null}
          left={`${pendingPin.x * 100}%`}
          top={`${pendingPin.y * 100}%`}
          state="pending"
        />
      )}
    </>
  );
}
