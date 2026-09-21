import type React from "react";
import { useEffect, useRef, useState } from "react";
import type {
  KeepDecision,
  KeepPrompt,
  KeepPromptRow,
  KeepStage,
} from "../review/keep-or-regenerate.js";
import { Modal } from "./modal.js";

function names(labels: readonly string[]): string {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The one question an accept that moves an upstream asks, one row per accepted unit made from what
 * it changes: keep it as it is, or regenerate it from the new take. Every row starts on Keep, the
 * answer konte gives on its own; Regenerate is the reviewer's call, row by row.
 */
export function KeepOrRegenerateModal({
  prompt,
  accepting,
  onAnswer,
}: {
  prompt: KeepPrompt;
  // How many units the interrupted accept settles: one names itself on the button, more is
  // "Accept all".
  accepting: number;
  onAnswer: (decisions: Record<string, KeepDecision> | null) => void;
}): React.ReactElement {
  const [decisions, setDecisions] = useState<Record<string, KeepDecision>>({});
  // Focus lands on the button that completes the accept: with every row on Keep, Enter is enough.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  const decisionOf = (unit: string): KeepDecision => decisions[unit] ?? "keep";
  const rows = prompt.stages.flatMap((s) => s.rows);
  const total = rows.length;
  const regenerating = rows.filter((r) => decisionOf(r.unit) === "regenerate").length;
  const cancel = () => onAnswer(null);
  const setAll = (units: readonly string[], decision: KeepDecision) =>
    setDecisions((prev) => ({
      ...prev,
      ...Object.fromEntries(units.map((u) => [u, decision])),
    }));

  // What the row's current answer means beyond itself, given the answers around it.
  const consequence = (row: KeepPromptRow, stage: KeepStage): string | null => {
    const regenerated = row.madeFrom.filter((m) => decisionOf(m.unit) === "regenerate");
    if (decisionOf(row.unit) === "keep") {
      return regenerated.length > 0
        ? `Asked again once the new ${names(regenerated.map((m) => m.label))} is accepted.`
        : null;
    }
    const parts: string[] = [];
    if (row.follows.length > 0) {
      parts.push(`Also regenerates ${names(row.follows)}, made from it.`);
    }
    const across = regenerated.filter((m) => m.stage !== stage);
    if (across.length > 0) {
      parts.push(`Made once the new ${names(across.map((m) => m.label))} is accepted.`);
    }
    return parts.length > 0 ? parts.join(" ") : null;
  };

  const origin = prompt.origins.length === 1 ? prompt.origins[0]! : null;
  return (
    <Modal className="keep-modal" title="Keep or regenerate" onClose={cancel}>
      <p className="keep-modal-note">
        Accepting{" "}
        {prompt.origins.length <= 3 ? names(prompt.origins) : `${prompt.origins.length} targets`}{" "}
        replaces {prompt.origins.length === 1 ? "a take" : "takes"} that {total} accepted{" "}
        {total === 1 ? "target was" : "targets were"} made from. Keep leaves a target as it is.
        Regenerate makes it again from the new take after this review; its current take stays in the
        gallery.
      </p>
      <ul className="keep-modal-stages">
        {prompt.stages.map((s) => (
          <li key={s.stage}>
            <div className="keep-modal-stage-head">
              <span className="keep-modal-stage">{s.stage}</span>
              {s.rows.length > 1 && (
                <span className="keep-modal-bulk">
                  <button
                    type="button"
                    className="keep-modal-bulk-btn"
                    onClick={() =>
                      setAll(
                        s.rows.map((r) => r.unit),
                        "keep",
                      )
                    }
                  >
                    Keep all
                  </button>
                  <button
                    type="button"
                    className="keep-modal-bulk-btn"
                    onClick={() =>
                      setAll(
                        s.rows.map((r) => r.unit),
                        "regenerate",
                      )
                    }
                  >
                    Regenerate all
                  </button>
                </span>
              )}
            </div>
            <ul className="keep-modal-rows">
              {s.rows.map((row) => {
                const decision = decisionOf(row.unit);
                const note = consequence(row, s.stage);
                return (
                  <li key={row.unit} className={`keep-modal-row keep-modal-row--${decision}`}>
                    <div className="keep-modal-row-text">
                      <span className="keep-modal-row-label">
                        {row.label}
                        {row.takes.length > 0 && (
                          <span className="keep-modal-row-takes"> {row.takes.join(", ")}</span>
                        )}
                      </span>
                      {note && <span className="keep-modal-row-note">{note}</span>}
                    </div>
                    <div
                      className="keep-seg"
                      role="radiogroup"
                      aria-label={`${row.label}: keep or regenerate`}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={decision === "keep"}
                        className={`keep-seg-btn keep-seg-btn--keep ${decision === "keep" ? "keep-seg-btn--on" : ""}`}
                        onClick={() => setAll([row.unit], "keep")}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={decision === "regenerate"}
                        className={`keep-seg-btn keep-seg-btn--regenerate ${decision === "regenerate" ? "keep-seg-btn--on" : ""}`}
                        onClick={() => setAll([row.unit], "regenerate")}
                      >
                        Regenerate
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <div className="keep-modal-actions">
        <span className="keep-modal-tally">
          {regenerating === 0 ? "Everything kept." : `${regenerating} of ${total} to regenerate.`}
        </span>
        <button type="button" className="ctrl-btn" onClick={cancel}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button
          type="button"
          className="ctrl-btn ctrl-btn--primary keep-modal-confirm"
          // The accept this prompt interrupted: confirming is what completes it.
          onClick={() => onAnswer(decisions)}
          ref={confirmRef}
        >
          {accepting === 1 && origin ? `Accept ${origin}` : "Accept all"}
        </button>
      </div>
    </Modal>
  );
}
