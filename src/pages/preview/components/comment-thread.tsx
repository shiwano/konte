import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatTimecode } from "../format-time.js";
import type { DirectionRosterKind, FeedbackInfo, ScriptLineView } from "../types.js";
import {
  CommentIcon,
  FilmIcon,
  PencilIcon,
  PlusIcon,
  SparkleIcon,
  VolumeIcon,
  XIcon,
} from "./icons.js";
import { NoteInput } from "./note-input.js";

export interface PendingFeedbackItem {
  id: string;
  address: string;
  text: string;
  annotation: { kind: "pin"; x: number; y: number } | null;
  time?: number;
}

// The lines spoken over what is on screen, each `speaker: text` (narration has no speaker).
// Read-only, pinned above the comments — the words the reel's audio is judged against.
export function ScriptCard({ script }: { script: ScriptLineView[] }): React.ReactElement {
  return (
    <div className="comment-card comment-card--move">
      <span className="comment-card-icon">
        <VolumeIcon size={12} />
      </span>
      <span className="comment-card-body">
        {/* Keyed by position: a shot can repeat the same line (a chant, a stutter), so the content
            is not unique — but the order is the definition's. */}
        {script.map((line, i) => (
          <span key={i} className="comment-script-line">
            {line.speaker !== null && (
              <span className="comment-script-speaker">{line.speaker}</span>
            )}
            <span className="comment-script-text">{line.text}</span>
            {/* How the line is said — the direction's own note, so the reviewer judges the take
                against what was asked for rather than against their own reading of the words. */}
            {line.acting && <span className="comment-script-acting">{line.acting}</span>}
          </span>
        ))}
      </span>
    </div>
  );
}

// The movement carrying the previous keyframe to this panel, labelled per half. Read-only, pinned
// above the comments — the claim the reviewer judges the pair of frames against.
export function MoveCard({
  panel,
  cutin,
  blocking,
  camera,
}: {
  // Which board panel the movement starts from. Passed only where a shot has more than one, or the
  // panel is its cutin's.
  panel?: string;
  // The panel keys the wipe laid over the shot rather than the shot's own picture.
  cutin?: boolean;
  blocking: string;
  camera: string;
}): React.ReactElement {
  return (
    <div className="comment-card comment-card--move">
      <span className="comment-card-icon">
        <FilmIcon size={12} />
      </span>
      <span className="comment-card-body">
        {panel && (
          <span className="comment-move-row">
            <span className="comment-move-label">{cutin ? "Cutin" : "Panel"}</span>
            <span className="comment-move-text">{panel}</span>
          </span>
        )}
        <span className="comment-move-row">
          <span className="comment-move-label">Blocking</span>
          <span className="comment-move-text">{blocking}</span>
        </span>
        <span className="comment-move-row">
          <span className="comment-move-label">Camera</span>
          <span className="comment-move-text">{camera}</span>
        </span>
      </span>
    </div>
  );
}

const ROSTER_LABEL: Record<DirectionRosterKind, string> = {
  character: "Character",
  "character-voice": "Voice",
  "narrator-voice": "Narrator",
  prop: "Prop",
  location: "Location",
};

// The direction part a reference asset anchors — the words `direction.ts` uses for this
// character/prop/location, or for the voice this sample casts. Read-only, pinned above the comments:
// accepting the media re-accepts this prose (see the roster cascade), so it has to be on the page the
// reviewer is looking at.
export function RosterCard({
  kind,
  name,
  description,
  needsReview,
}: {
  kind: DirectionRosterKind;
  name: string;
  description: string;
  needsReview?: boolean;
}): React.ReactElement {
  return (
    <div className="comment-card comment-card--move">
      <span className="comment-card-icon">
        <FilmIcon size={12} />
      </span>
      <span className="comment-card-body">
        <span className="comment-move-row">
          <span className="comment-move-label">{ROSTER_LABEL[kind]}</span>
          <span className="comment-move-text">{name}</span>
          {needsReview && <span className="comment-roster-flag">needs review</span>}
        </span>
        <span className="comment-move-row">
          <span className="comment-move-text">{description}</span>
        </span>
      </span>
    </div>
  );
}

// The agent's handoff note (AI -> reviewer): why this asset was revised.
export function HandoffCard({ text }: { text: string }): React.ReactElement {
  return (
    <div className="comment-card comment-card--agent">
      <span className="comment-card-icon">
        <SparkleIcon size={12} />
      </span>
      <span className="comment-card-body">{text}</span>
    </div>
  );
}

// One comment in a thread/list: a numbered pin badge (when the comment is anchored on the
// frame), a timecode chip (when timed), the text, and edit/delete actions. Clicking the
// body jumps to where the comment lives (its time and/or its pin).
export function CommentCard({
  pinIndex,
  time,
  text,
  stale,
  pending,
  highlighted,
  onJump,
  onEdit,
  onDelete,
}: {
  pinIndex?: number;
  time?: number;
  text: string;
  stale?: boolean;
  pending?: boolean;
  highlighted?: boolean;
  onJump?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlighted]);

  const cls = [
    "comment-card",
    stale ? "comment-card--stale" : "",
    pending ? "comment-card--pending" : "",
    highlighted ? "comment-card--highlighted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className={cls}>
      <button type="button" className="comment-card-main" onClick={onJump}>
        <span className="comment-card-meta">
          {pinIndex !== undefined ? (
            <span className="comment-card-pin-badge">{pinIndex}</span>
          ) : (
            <span className="comment-card-icon">
              {time !== undefined ? <CommentIcon size={12} /> : <CommentIcon size={12} />}
            </span>
          )}
          {time !== undefined && <span className="comment-card-time">{formatTimecode(time)}</span>}
        </span>
        <span className="comment-card-body">{text}</span>
      </button>
      {(onEdit || onDelete) && (
        <span className="comment-card-actions">
          {onEdit && (
            <button
              type="button"
              className="note-action-btn"
              title="Edit note"
              aria-label="Edit note"
              onClick={onEdit}
            >
              <PencilIcon size={13} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="note-action-btn note-action-btn--danger"
              title={pending ? "Discard note" : "Delete note"}
              aria-label={pending ? "Discard note" : "Delete note"}
              onClick={onDelete}
            >
              <XIcon size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * A target's comment thread: the agent handoff (read-only context) above the reviewer's saved and
 * draft comments, with an inline composer at the bottom. Pinned
 * comments carry the same number as their on-frame marker (`pinIndexById`), so the
 * list and the frame read as one.
 */
export function CommentThread({
  feedback,
  pendingFeedback,
  pendingPin,
  handoffNotes,
  emptyHint,
  hideStale,
  deletedFeedbackIds,
  editedTextById,
  pinIndexById,
  highlightedId,
  onAddPending,
  onRemovePending,
  onEditPending,
  onEditExisting,
  onDeleteExisting,
  onHighlightPin,
  onCancelPin,
  onJumpToTime,
}: {
  feedback: FeedbackInfo[];
  pendingFeedback: PendingFeedbackItem[];
  pendingPin: { x: number; y: number } | null;
  handoffNotes?: Array<{ assetName: string; text: string }>;
  // Shown in place of the comment list while the thread holds no reviewer comment, so an empty
  // thread reads as "nothing said yet" rather than as context with a stray button under it.
  emptyHint?: string;
  hideStale: boolean;
  deletedFeedbackIds: Set<string>;
  editedTextById?: Map<string, string>;
  pinIndexById?: Map<string, number>;
  highlightedId?: string | null;
  onAddPending: (text: string) => void;
  onRemovePending: (id: string) => void;
  onEditPending: (id: string, text: string) => void;
  onEditExisting: (id: string, text: string) => void;
  onDeleteExisting: (id: string) => void;
  onHighlightPin?: (feedbackId: string) => void;
  onCancelPin: () => void;
  onJumpToTime?: (time: number) => void;
}): React.ReactElement {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleAdd = useCallback(
    (text: string) => {
      onAddPending(text);
      setIsAdding(false);
    },
    [onAddPending],
  );

  const handleEditSave = useCallback(
    (text: string) => {
      if (!editingId) return;
      if (pendingFeedback.some((p) => p.id === editingId)) {
        onEditPending(editingId, text);
      } else {
        onEditExisting(editingId, text);
      }
      setEditingId(null);
    },
    [editingId, pendingFeedback, onEditPending, onEditExisting],
  );

  const visibleFeedback = feedback.filter(
    (f) => !deletedFeedbackIds.has(f.id) && (!hideStale || !f.stale),
  );

  // Saved comments first (their persisted order, edited text shown), then drafts — the order
  // buildPinIndex numbers them in.
  const comments = [
    ...visibleFeedback.map((fb) => ({
      id: fb.id,
      annotation: fb.annotation,
      time: fb.time,
      text: editedTextById?.get(fb.id) ?? fb.text,
      stale: fb.stale,
      pending: false,
      onDelete: () => onDeleteExisting(fb.id),
    })),
    ...pendingFeedback.map((pf) => ({
      id: pf.id,
      annotation: pf.annotation,
      time: pf.time,
      text: pf.text,
      stale: false,
      pending: true,
      onDelete: () => onRemovePending(pf.id),
    })),
  ];

  return (
    <div className="comment-thread">
      {handoffNotes?.map((an) => (
        <HandoffCard key={`agent-${an.assetName}`} text={an.text} />
      ))}

      {emptyHint && visibleFeedback.length === 0 && pendingFeedback.length === 0 && !pendingPin && (
        <p className="comment-thread-empty">{emptyHint}</p>
      )}

      {comments.map((c) =>
        editingId === c.id ? (
          <NoteInput
            key={c.id}
            initialText={c.text}
            onSave={handleEditSave}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <CommentCard
            key={c.id}
            pinIndex={c.annotation ? pinIndexById?.get(c.id) : undefined}
            time={c.time}
            text={c.text}
            stale={c.stale}
            pending={c.pending}
            highlighted={highlightedId === c.id}
            onJump={() => {
              if (c.time !== undefined) onJumpToTime?.(c.time);
              if (c.annotation) onHighlightPin?.(c.id);
            }}
            onEdit={() => setEditingId(c.id)}
            onDelete={c.onDelete}
          />
        ),
      )}

      {pendingPin ? (
        <NoteInput
          placeholder="Describe what you see at this pin…"
          onSave={onAddPending}
          onCancel={onCancelPin}
        />
      ) : isAdding ? (
        <NoteInput onSave={handleAdd} onCancel={() => setIsAdding(false)} />
      ) : (
        <button type="button" className="comment-add-btn" onClick={() => setIsAdding(true)}>
          <PlusIcon size={13} /> Add note
        </button>
      )}
    </div>
  );
}

// Ordinal numbering for pinned comments: saved feedback first (their persisted order),
// then drafts — matching the order CommentThread renders them in. Shared by every view
// so the on-frame markers and the comment list always agree.
export function buildPinIndex(
  feedback: Array<{ id: string; annotation: unknown; stale: boolean; settled?: boolean }>,
  pending: Array<{ id: string; annotation: unknown }>,
  opts: { hideStale: boolean; deletedFeedbackIds: Set<string> },
): Map<string, number> {
  const map = new Map<string, number>();
  let n = 1;
  for (const f of feedback) {
    if (!f.annotation || opts.deletedFeedbackIds.has(f.id)) continue;
    if (opts.hideStale && f.stale) continue;
    map.set(f.id, n++);
  }
  for (const p of pending) {
    if (!p.annotation) continue;
    map.set(p.id, n++);
  }
  return map;
}
