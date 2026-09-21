import type React from "react";
import { XIcon } from "./icons.js";

/** A unit the review will regenerate, as the list marks it. */
export interface RegenerateMark {
  // The unit whose accept asked, by label.
  origin: string;
  // The row this unit follows when the answer sits there: its id on this page, and its label.
  follows: { id: string; label: string } | null;
  // The names of its takes, as the list shows them.
  takes: string[];
}

/**
 * The Regenerate mark on a list item, and the way back from it. A row's mark is a chip with an x:
 * click it to keep the unit after all. A follow's mark reads the same word; its title names the row
 * it follows and a click jumps there, since that row's answer is the only one to change.
 */
export function RegenerateBadge({
  mark,
  onKeep,
  onJumpToRow,
}: {
  mark: RegenerateMark;
  onKeep: () => void;
  onJumpToRow: (id: string) => void;
}): React.ReactElement {
  const takes = mark.takes.length > 0 ? ` (${mark.takes.join(", ")})` : "";
  if (mark.follows) {
    const { id, label } = mark.follows;
    return (
      <button
        type="button"
        className="status-badge status-badge--regenerate status-badge--action"
        title={`Made from ${label}, which regenerates, so this regenerates with it${takes}. Keep ${label} to keep this too. Click to go to ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onJumpToRow(id);
        }}
      >
        Regenerate
      </button>
    );
  }
  return (
    <button
      type="button"
      className="status-badge status-badge--regenerate status-badge--action"
      title={`Regenerated after this review, since ${mark.origin} changed${takes}. Click to keep it instead`}
      onClick={(e) => {
        e.stopPropagation();
        onKeep();
      }}
    >
      Regenerate <XIcon size={10} />
    </button>
  );
}
