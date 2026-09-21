import type React from "react";
import { SparkleIcon } from "./icons.js";

/**
 * Top-of-screen banner: the agent's one-line summary (AI -> reviewer). Per-asset
 * handoff notes are shown inline next to each shot, not here — except any the page has nothing to
 * draw them next to, which land here under the address they were written for.
 */
export function ChangesBanner({
  summary,
  unroutedNotes,
}: {
  summary?: string;
  unroutedNotes?: Array<{ address: string; text: string }>;
}): React.ReactElement | null {
  if (!summary && !unroutedNotes?.length) return null;

  return (
    <div className="handoff-banner">
      {summary && (
        <p className="handoff-summary">
          <span className="handoff-icon">
            <SparkleIcon size={14} />
          </span>
          {summary}
        </p>
      )}
      {unroutedNotes?.map((n) => (
        <p className="handoff-summary handoff-unrouted" key={n.address}>
          <span className="handoff-icon">
            <SparkleIcon size={14} />
          </span>
          <span className="handoff-unrouted-address">{n.address}</span>
          {n.text}
        </p>
      ))}
    </div>
  );
}
