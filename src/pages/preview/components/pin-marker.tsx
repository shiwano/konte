import type React from "react";

/**
 * A numbered, frame.io-style annotation marker: a small circle anchored where the
 * comment was pinned. The comment text lives in the comment list (and in a hover
 * tip here), so the marker never covers the frame the way a full-text sticky would.
 * `index` is the comment's number in the visible comment list; a pending pin (still
 * being typed) renders as a pulsing "+".
 */
export function PinMarker({
  index,
  left,
  top,
  text,
  state = "saved",
  highlighted,
  onClick,
}: {
  index: number | null;
  left: string | number;
  top: string | number;
  text?: string;
  state?: "saved" | "pending" | "stale";
  highlighted?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}): React.ReactElement {
  const cls = ["pin-marker", `pin-marker--${state}`, highlighted ? "pin-marker--highlighted" : ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <span className="pin-marker-dot">{index === null ? "+" : index}</span>
      {text && <span className="pin-marker-tip">{text}</span>}
    </>
  );
  if (!onClick) {
    return (
      <span className={cls} style={{ left, top }}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={{ left, top }}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      {body}
    </button>
  );
}
