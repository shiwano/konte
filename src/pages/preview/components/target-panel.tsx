import type React from "react";
import { useState } from "react";
import { formatTimecode } from "../format-time.js";
import type { ScriptLineView, ShotMoveInfo, ShotWaiverInfo } from "../types.js";
import { CommentCard, HandoffCard, MoveCard, ScriptCard, WaiverCard } from "./comment-thread.js";
import { PlusIcon } from "./icons.js";
import { NoteInput } from "./note-input.js";

// One comment as the panel displays it — saved feedback and drafts merged, already filtered
// (stale/deleted) and ordered by the caller: saved comments as they were written, drafts last.
export interface DisplayComment {
  id: string;
  address: string;
  time: number;
  // The shot the comment belongs to. Absent on a soundtrack comment: a bed spans the
  // timeline, so it hangs off the timeline stem instead of any one shot.
  shotId?: string;
  text: string;
  stale?: boolean;
  pending?: boolean;
  // Pin anchor in composition px (absent for un-pinned, subtitle-style comments).
  x?: number;
  y?: number;
  pinIndex?: number;
}

// A comment being written: the instant it is about, frozen by the caller, and the pin on that
// frame if one was placed.
export interface NoteDraft {
  time: number;
  pin: { x: number; y: number } | null;
}

/**
 * The reel review's sidebar for the focused target, titled by it. The shot's spoken lines, the
 * board's declared movement, its waivers and the agent handoff sit on top as read-only context;
 * under them, the target's comments as they were written, drafts last, each carrying its timecode
 * and — when pinned — the same number as its on-frame marker.
 * Clicking a comment seeks to it. An "Add note" composer sits at the bottom, matching the
 * animatic/reference threads. The composer's target is the caller's
 * `draft` — the instant it opened at, and the pin if one was placed on the frame.
 *
 * The target is a shot, or a target spanning shots (the soundtrack, an overlay) — which takes timed
 * comments but no pin.
 */
export function TargetPanel({
  subject,
  pinnable = true,
  script,
  moves,
  board = false,
  waivers,
  handoffNotes,
  comments,
  highlightedId,
  draft,
  onJump,
  onEditSave,
  onDelete,
  onAddNote,
  onOpenComposer,
  onCloseComposer,
}: {
  // What the panel is pointed at, shown as its title (e.g. "Shot 03", "Soundtrack").
  subject?: string;
  pinnable?: boolean;
  script?: ScriptLineView[];
  // One card per board panel that declares a movement.
  moves?: ShotMoveInfo[];
  // The moves are judged against the animatic's stills, so each card names its panel and role.
  board?: boolean;
  waivers?: ShotWaiverInfo[];
  handoffNotes?: string[];
  comments: DisplayComment[];
  highlightedId: string | null;
  // The comment being written, or null while the composer is closed.
  draft: NoteDraft | null;
  onJump: (c: DisplayComment) => void;
  onEditSave: (c: DisplayComment, text: string) => void;
  onDelete: (c: DisplayComment) => void;
  onAddNote: (text: string) => void;
  onOpenComposer: () => void;
  onCloseComposer: () => void;
}): React.ReactElement {
  const scriptLines = script ?? [];
  const moveCards = moves ?? [];
  const waiverCards = waivers ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="target-panel">
      {subject && <h3 className="panel-title">{subject}</h3>}

      {(scriptLines.length > 0 ||
        moveCards.length > 0 ||
        waiverCards.length > 0 ||
        (handoffNotes && handoffNotes.length > 0)) && (
        <div className="target-panel-context">
          {scriptLines.length > 0 && <ScriptCard script={scriptLines} />}
          {moveCards.map((m) => (
            <MoveCard
              key={m.panel}
              panel={board && (moveCards.length > 1 || m.cutin) ? m.panel : undefined}
              cutin={m.cutin}
              role={board ? m.role : undefined}
              blocking={m.blocking}
              camera={m.camera}
            />
          ))}
          {waiverCards.map((w) => (
            <WaiverCard
              key={`${w.code}_${w.subject}`}
              code={w.code}
              subject={w.subject}
              reason={w.reason}
              needsReview={w.needsReview}
            />
          ))}
          {handoffNotes?.map((text, i) => (
            <HandoffCard key={`agent-${i}`} text={text} />
          ))}
        </div>
      )}

      <div className="target-panel-comments-head">
        <span className="target-panel-comments-label">Feedback</span>
        {comments.length > 0 && (
          <span className="target-panel-comments-count">{comments.length}</span>
        )}
      </div>

      {comments.length === 0 ? (
        <p className="target-panel-comments-empty">
          {pinnable
            ? "No notes on this shot yet. Add one below, or click the frame to pin one."
            : `No notes on the ${subject?.toLowerCase() ?? "soundtrack"} yet. Add one below at the moment you mean.`}
        </p>
      ) : (
        <div className="target-panel-comments-list">
          {comments.map((c) =>
            editingId === c.id ? (
              <NoteInput
                key={c.id}
                initialText={c.text}
                onSave={(text) => {
                  onEditSave(c, text);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <CommentCard
                key={c.id}
                pinIndex={c.pinIndex}
                time={c.time}
                text={c.text}
                stale={c.stale}
                pending={c.pending}
                highlighted={highlightedId === c.id}
                onJump={() => onJump(c)}
                onEdit={() => setEditingId(c.id)}
                onDelete={() => onDelete(c)}
              />
            ),
          )}
        </div>
      )}

      {draft ? (
        <NoteInput
          placeholder={
            draft.pin
              ? `Describe what you see at this pin (${formatTimecode(draft.time)})…`
              : `Add a note at ${formatTimecode(draft.time)}…`
          }
          onSave={onAddNote}
          onCancel={onCloseComposer}
        />
      ) : (
        <button type="button" className="comment-add-btn" onClick={onOpenComposer}>
          <PlusIcon size={13} /> Add note
        </button>
      )}
    </div>
  );
}
