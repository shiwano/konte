import type React from "react";
import { useEffect, useRef } from "react";
import { shotChangedSinceAccept } from "../review/changed-since-accept.js";
import { shotAcceptable } from "../review/shot-acceptable.js";
import type { ShotInfo } from "../types.js";
import { AcceptButton } from "./accept-button.js";
import { CommentIcon } from "./icons.js";
import { RegenerateBadge, type RegenerateMark } from "./regenerate-badge.js";
import { StatusBadge } from "./status-badge.js";

export function ShotList({
  shots,
  progress,
  shotAccepted,
  decisions,
  noteCounts,
  focusedShotId,
  regenerate,
  onKeepShot,
  onToggleDecision,
  onJumpToShot,
  titleAction,
}: {
  shots: ShotInfo[];
  progress: { accepted: number; total: number };
  shotAccepted: Record<string, boolean>;
  decisions: Record<string, "accepted" | "none">;
  // Live note count per shot — drafts included, deleted and (when hidden) stale excluded.
  noteCounts: Record<string, number>;
  focusedShotId?: string;
  // Per shot, the Regenerate answer standing for it; a follow's names the shot answered for it.
  regenerate?: Record<string, RegenerateMark>;
  // Takes a shot's Regenerate back.
  onKeepShot?: (shotId: string) => void;
  onToggleDecision: (shotId: string) => void;
  onJumpToShot: (shot: ShotInfo) => void;
  titleAction?: React.ReactNode;
}): React.ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLDivElement>(null);

  // Follow the playhead: the card of the shot it is in is kept in view. Scrolling the list's own
  // box — rather than scrollIntoView, which walks every scrollable ancestor — leaves the page
  // (which scrolls too, outside theater) where the reviewer put it.
  useEffect(() => {
    const list = listRef.current;
    const item = focusedRef.current;
    if (!list || !item) return;
    const listBox = list.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    const delta =
      itemBox.top < listBox.top
        ? itemBox.top - listBox.top
        : itemBox.bottom > listBox.bottom
          ? itemBox.bottom - listBox.bottom
          : 0;
    if (delta !== 0) list.scrollBy({ top: delta, behavior: "smooth" });
  }, [focusedShotId]);

  return (
    <div className="shot-list">
      <div className="panel-title-row">
        <h3 className="panel-title">Shots</h3>
        {titleAction}
      </div>
      {progress.total > 0 && (
        <div className="shot-list-progress">
          <div className="shot-list-progress-label">
            <span>
              {progress.accepted} of {progress.total} accepted
            </span>
            <span>{Math.round((progress.accepted / progress.total) * 100)}%</span>
          </div>
          <progress value={progress.accepted} max={progress.total} aria-label="Accepted shots" />
        </div>
      )}
      <div className="shot-list-items" ref={listRef}>
        {shots.length === 0 && <p className="shot-list-empty">No shots need review.</p>}
        {shots.map((shot) => {
          // Accept is a toggle: an accepted shot shows "Accepted" and clicking it
          // un-accepts. A dashed border marks an unsaved override of the persisted
          // state. "What's wrong" lives in feedback comments, not a reject flag.
          const focused = focusedShotId === shot.shotId;
          const accepted = shotAccepted[shot.shotId] ?? false;
          const hasOverride = shot.shotId in decisions;
          const noteCount = noteCounts[shot.shotId] ?? 0;
          const changed = shotChangedSinceAccept(shot);
          return (
            // The card is clickable but contains nested <button>s, so it can't be a
            // real <button> (invalid nesting); role="button" + keydown is the correct pattern.
            /* oxlint-disable jsx-a11y/prefer-tag-over-role */
            <div
              key={shot.shotId}
              ref={focused ? focusedRef : undefined}
              role="button"
              tabIndex={0}
              className={`vp-shot-item${focused ? " vp-shot-item--focused" : ""}${accepted ? " vp-shot-item--accepted" : ""}`}
              aria-current={focused ? "true" : undefined}
              aria-label={`Shot ${shot.shotId}: ${shot.action}`}
              onClick={() => onJumpToShot(shot)}
              // Enter only, not Space: a click leaves the card focused, and Space is the
              // review's play/pause — activating the card on it would re-seek to the shot's
              // start on every play and every pause.
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                  e.preventDefault();
                  onJumpToShot(shot);
                }
              }}
              title="Jump to this shot"
            >
              <div className="vp-shot-item-top">
                <span className="shot-list-item-id">Shot {shot.shotId}</span>
                {noteCount > 0 && (
                  <span className="vp-shot-item-notes">
                    <CommentIcon size={12} /> {noteCount}
                  </span>
                )}
                {shot.pending && <StatusBadge status="pending" label="Pending" />}
                {/* Not work waiting to be done — a shot the board deliberately does not draw. */}
                {shot.aside && <StatusBadge status="pending" label="Aside" />}
                {/* The one thing a reviewer cannot see for themselves: this shot is standing in
                    with the board, not the finished picture — so it reads as done otherwise. */}
                {shot.showingStandIn && (
                  <StatusBadge status="animatic" label="Animatic: not made yet" />
                )}
                {shot.notReady && !shot.showingStandIn && (
                  <StatusBadge status="not-ready" label="Not ready" />
                )}
                {changed && <StatusBadge status="changed" label="Changed" />}
                {regenerate?.[shot.shotId] && (
                  <RegenerateBadge
                    mark={regenerate[shot.shotId]!}
                    onKeep={() => onKeepShot?.(shot.shotId)}
                    onJumpToRow={(id) => {
                      const row = shots.find((s) => s.shotId === id);
                      if (row) onJumpToShot(row);
                    }}
                  />
                )}
              </div>
              {shot.action && (
                <p className="vp-shot-action" title={shot.action}>
                  {shot.action}
                </p>
              )}
              <div className="vp-shot-item-bottom">
                <AcceptButton
                  accepted={accepted}
                  overridden={hasOverride}
                  disabled={!shotAcceptable(shot)}
                  title={
                    shot.aside && !shot.hasComposition
                      ? "An aside is not boarded here. It is signed off on the video, where its picture is"
                      : shot.pending
                        ? "An undeveloped shot has nothing to accept. Develop it first"
                        : shot.showingStandIn
                          ? "Standing in with the board: this shot's picture is not made yet, so there is nothing here to sign off"
                          : shot.notReady
                            ? "A track this shot plays is not generated yet. Generate it first"
                            : accepted
                              ? "Click to unaccept"
                              : "Accept this shot"
                  }
                  onClick={() => onToggleDecision(shot.shotId)}
                />
              </div>
            </div>
            /* oxlint-enable jsx-a11y/prefer-tag-over-role */
          );
        })}
      </div>
    </div>
  );
}
