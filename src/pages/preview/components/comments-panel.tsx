import type React from "react";
import { useState } from "react";
import { formatTimecode } from "../format-time.js";
import type { ScriptLineView, ShotMoveInfo } from "../types.js";
import { CommentCard, HandoffCard, MoveCard, ScriptCard } from "./comment-thread.js";
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
 * The video review's feedback sidebar: the focused target's comments as they were written,
 * drafts last, each carrying its timecode and — when pinned — the same number as its on-frame
 * marker.
 * Clicking a comment seeks to it. The shot's spoken lines, the board's declared movement and the
 * agent handoff sit pinned on top as read-only context, and an "Add note" composer sits at the
 * bottom, matching the animatic/reference threads. The composer's target is the caller's
 * `draft` — the instant it opened at, and the pin if one was placed on the frame.
 *
 * The target is a shot, or the soundtrack — which takes timed comments but no pin, there
 * being no frame position to point at in a bed.
 */
export function CommentsPanel({
  subject,
  pinnable = true,
  script,
  moves,
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
  // What the panel is pointed at, shown beside the title (e.g. "Shot 03", "Soundtrack").
  subject?: string;
  pinnable?: boolean;
  script?: ScriptLineView[];
  // One card per board panel that declares a movement.
  moves?: ShotMoveInfo[];
  handoffNotes?: Array<{ assetName: string; text: string }>;
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
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="comments-panel">
      <div className="panel-title-row">
        <h3 className="panel-title">
          Feedback
          {subject && <span className="panel-title-sub">{subject}</span>}
        </h3>
        {comments.length > 0 && <span className="comments-panel-count">{comments.length}</span>}
      </div>

      {(scriptLines.length > 0 ||
        moveCards.length > 0 ||
        (handoffNotes && handoffNotes.length > 0)) && (
        <div className="comments-panel-context">
          {scriptLines.length > 0 && <ScriptCard script={scriptLines} />}
          {moveCards.map((m) => (
            <MoveCard
              key={m.panel}
              panel={moveCards.length > 1 || m.cutin ? m.panel : undefined}
              cutin={m.cutin}
              blocking={m.blocking}
              camera={m.camera}
            />
          ))}
          {handoffNotes?.map((n) => (
            <HandoffCard key={`agent-${n.assetName}`} text={n.text} />
          ))}
        </div>
      )}

      {comments.length === 0 ? (
        <p className="comments-panel-empty">
          {pinnable
            ? "No notes on this shot yet. Add one below, or click the frame to pin one."
            : "No notes on the soundtrack yet. Add one below at the moment you mean."}
        </p>
      ) : (
        <div className="comments-panel-list">
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
