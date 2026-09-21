import type React from "react";
import { CheckIcon } from "./icons.js";

/**
 * The accept toggle on one target: "Accept" until marked, "Accepted" after, clicking again
 * un-accepts. `overridden` marks a mark not yet persisted (a dashed border) — "what's wrong" lives
 * in feedback comments, not a reject flag.
 */
export function AcceptButton({
  accepted,
  overridden,
  title,
  disabled,
  onClick,
}: {
  accepted: boolean;
  overridden?: boolean;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={accepted}
      title={title}
      className={`accept-btn${accepted ? " accept-btn--active" : ""}${accepted && overridden ? " accept-btn--overridden" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <CheckIcon size={13} /> {accepted ? "Accepted" : "Accept"}
    </button>
  );
}
