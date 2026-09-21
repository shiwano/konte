import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChangesBanner } from "../components/changes-banner.js";
import { HelpIcon, XIcon } from "../components/icons.js";
import type { RegenerateSummary } from "./keep-or-regenerate.js";
import { useDialogFocus } from "./use-dialog-focus.js";

export type ShortcutRows = Array<[string[], string]>;

/**
 * The chrome every review shares: the dismissible error banner, the agent handoff
 * banner, the header slot (Needs-review / Hide-stale toggles, the
 * shortcuts popover, view-specific actions), the floating Submit button and the submit dialog it
 * raises, and the post-submit screen. Views render their content as children and keep their own
 * decision model.
 */
export function ReviewShell({
  error,
  onDismissError,
  handoffSummary,
  unroutedHandoffNotes,
  showChangedOnly,
  onToggleChangedOnly,
  hideStale,
  onToggleHideStale,
  shortcuts,
  headerExtra,
  actionsTarget,
  submitting,
  submitted,
  submittedTitle,
  canSubmit = true,
  submitHint,
  onSubmit,
  undecided,
  regenerate,
  submitOpen,
  overallComment = "",
  onOverallCommentChange,
  onConfirmSubmit,
  onCancelSubmit,
  children,
}: {
  error: string | null;
  onDismissError: () => void;
  handoffSummary?: string;
  unroutedHandoffNotes?: Array<{ address: string; text: string }>;
  showChangedOnly?: boolean;
  onToggleChangedOnly?: () => void;
  hideStale: boolean;
  onToggleHideStale: () => void;
  shortcuts?: ShortcutRows;
  headerExtra?: React.ReactNode;
  // Where the toggles and actions render, when it isn't the header: the video review's theater
  // mode hides the header and offers a slot of its own, so they travel with the layout that
  // replaced it instead of going down with it.
  actionsTarget?: HTMLElement | null;
  submitting: boolean;
  submitted: boolean;
  submittedTitle: string;
  // Whether this review carries anything to submit. The floating button opens the dialog either
  // way — what an empty review needs is to be told so, not a button that does nothing — and it is
  // the dialog's own Submit this gates, with `submitHint` printed above it as the reason.
  canSubmit?: boolean;
  submitHint?: string;
  // Raises the submit dialog. The only path to a submit: nothing writes from the button itself.
  onSubmit?: () => void;
  // Targets left with neither an accept nor a comment (see review/undecided.ts). The dialog names
  // them, then proceeds if the reviewer says so — deliberately a pause, not a block.
  undecided?: string[];
  // The units a Regenerate answer names, each with those that go with it.
  regenerate?: RegenerateSummary[];
  submitOpen?: boolean;
  // The reviewer's word on the pass as a whole, written in the dialog. Held by the session so it
  // survives the dialog closing and rides along on the submit.
  overallComment?: string;
  onOverallCommentChange?: (text: string) => void;
  onConfirmSubmit?: () => void;
  onCancelSubmit?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLElement | null>(null);
  useEffect(() => setHeaderActionsEl(document.getElementById("header-actions")), []);
  const actionsEl = actionsTarget ?? headerActionsEl;
  const [showShortcuts, setShowShortcuts] = useState(false);
  const overallCommentRef = useRef<HTMLTextAreaElement>(null);
  const submitDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(submitDialogRef, !!submitOpen);
  const isMac = useMemo(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent), []);

  // Close the shortcuts popover on Escape or a click outside it.
  useEffect(() => {
    if (!showShortcuts) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".review-shortcuts-wrap")) setShowShortcuts(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowShortcuts(false);
      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showShortcuts]);

  // "?" opens the panel from anywhere (closing lives in the effect above).
  useEffect(() => {
    if (showShortcuts || !shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showShortcuts, shortcuts]);

  // The dialog owns the keyboard while open (the views stop handling shortcuts behind it), so it
  // carries both of its own keys: Escape backs out, and ⌘⏎ — the key that opened it — confirms,
  // which is what its button advertises. Bound on the document rather than the dialog so ⌘⏎ still
  // submits from inside the overall-comment field.
  useEffect(() => {
    if (!submitOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancelSubmit?.();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (canSubmit) onConfirmSubmit?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submitOpen, canSubmit, onCancelSubmit, onConfirmSubmit]);

  // The overall comment is the one thing the dialog asks for that is not already on the page, so
  // the caret starts there — except on a touch device, where focus raises a keyboard over the
  // undecided list and Submit. `preventScroll` for the rest: the dialog is centred and the field is
  // already on screen, so scroll-into-view has nothing to correct and only pans the page.
  useEffect(() => {
    if (!submitOpen) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    overallCommentRef.current?.focus({ preventScroll: true });
  }, [submitOpen]);

  if (submitted) {
    // A saved review some of whose accepts did not land ends here too — on what did not, so the
    // reviewer reads it rather than pressing Submit again over a review already on disk.
    return (
      <div className="submit-success">
        <h2>{submittedTitle}</h2>
        {error ? (
          <>
            <p>Your review has been saved, but not every decision landed:</p>
            <pre className="submit-skipped">{error}</pre>
            <p>Fix what it names, then review those targets again. You can close this window.</p>
          </>
        ) : (
          <p>Your review has been saved. You can close this window.</p>
        )}
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button
            type="button"
            className="error-banner-dismiss"
            onClick={onDismissError}
            aria-label="Dismiss"
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
      <ChangesBanner summary={handoffSummary} unroutedNotes={unroutedHandoffNotes} />
      {actionsEl &&
        createPortal(
          <>
            {onToggleChangedOnly && (
              <label className="review-toggle">
                <input type="checkbox" checked={!!showChangedOnly} onChange={onToggleChangedOnly} />
                Needs review
              </label>
            )}
            <label className="review-toggle">
              <input type="checkbox" checked={hideStale} onChange={onToggleHideStale} />
              Hide stale notes
            </label>
            {shortcuts && (
              <div className="review-shortcuts-wrap">
                <button
                  type="button"
                  className={`ctrl-btn ctrl-btn--icon${showShortcuts ? " ctrl-btn--active" : ""}`}
                  onClick={() => setShowShortcuts((v) => !v)}
                  title="Keyboard shortcuts (?)"
                  aria-label="Keyboard shortcuts"
                >
                  <HelpIcon size={15} />
                </button>
                {showShortcuts && (
                  <div className="shortcuts-panel">
                    <div className="shortcuts-panel-title">Keyboard shortcuts</div>
                    <p className="shortcuts-panel-note">
                      These keys work anywhere in the review (except while typing in a text field).
                    </p>
                    {shortcuts.map(([keys, label]) => (
                      <div key={label} className="shortcut-row">
                        <span className="shortcut-keys">
                          {keys.map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </span>
                        <span className="shortcut-desc">{label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Where the bar breaks when it is too narrow to read as one row: the toggles state
                what the page shows, the buttons below them decide it. */}
            <div className="header-actions-break" aria-hidden="true" />
            {headerExtra}
          </>,
          actionsEl,
        )}
      {children}
      {onSubmit && (
        <div className="fab-submit-wrap">
          <button
            className="fab-submit"
            onClick={onSubmit}
            disabled={submitting}
            title={`Submit review (${isMac ? "⌘" : "Ctrl"}+⏎)`}
          >
            {submitting ? (
              "Submitting..."
            ) : (
              <>
                {/* The stylesheet drops "Review" where the button is too narrow to hold it. */}
                <span>
                  Submit<span className="fab-submit-word"> Review</span>
                </span>
                <kbd>{isMac ? "⌘" : "Ctrl"}+⏎</kbd>
              </>
            )}
          </button>
        </div>
      )}
      {submitOpen && (
        /* The one page every submit passes through: what this review carries, what it leaves
           undecided, and the word on the pass as a whole. A stray click outside must not dismiss
           it, so the backdrop is inert — Escape and "Go back" are the ways out. */
        <div className="submit-backdrop">
          <div
            ref={submitDialogRef}
            tabIndex={-1}
            className="submit-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Submit review"
          >
            <h2 className="submit-dialog-title">Submit review</h2>
            {undecided && undecided.length > 0 && (
              <>
                <p className="submit-dialog-note">
                  {undecided.length} {undecided.length === 1 ? "target was" : "targets were"}{" "}
                  neither accepted nor commented on.
                </p>
                <ul className="submit-dialog-list">
                  {undecided.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </>
            )}
            {regenerate && regenerate.length > 0 && (
              <>
                <p className="submit-dialog-note">
                  {(() => {
                    const n = regenerate.reduce((sum, r) => sum + 1 + r.with.length, 0);
                    return `${n} accepted ${n === 1 ? "target" : "targets"} will be regenerated after this review.`;
                  })()}
                </p>
                <ul className="submit-dialog-list">
                  {regenerate.map((row) => (
                    <li key={row.label} className="submit-dialog-regenerate">
                      <span>
                        {row.label}
                        {row.takes.length > 0 && (
                          <span className="submit-dialog-detail"> {row.takes.join(", ")}</span>
                        )}
                      </span>
                      {row.with.map((f) => (
                        <span key={f.label} className="submit-dialog-with">
                          with {f.label}
                          {f.takes.length > 0 && (
                            <span className="submit-dialog-detail"> {f.takes.join(", ")}</span>
                          )}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <label className="submit-dialog-field">
              <span className="submit-dialog-label">Overall comment</span>
              <textarea
                ref={overallCommentRef}
                className="submit-dialog-textarea"
                value={overallComment}
                onChange={(e) => onOverallCommentChange?.(e.target.value)}
                placeholder="What this pass is about, beyond any one target."
                rows={4}
              />
            </label>
            {!canSubmit && submitHint && <p className="submit-dialog-blocked">{submitHint}</p>}
            <div className="submit-dialog-actions">
              <button type="button" className="ctrl-btn" onClick={onCancelSubmit}>
                Go back <kbd>Esc</kbd>
              </button>
              <button
                type="button"
                className="fab-submit"
                onClick={onConfirmSubmit}
                disabled={!canSubmit || submitting}
                title={`Submit review (${isMac ? "⌘" : "Ctrl"}+⏎)`}
              >
                Submit Review <kbd>{isMac ? "⌘" : "Ctrl"}+⏎</kbd>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
