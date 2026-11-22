import type React from "react";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ResetIcon } from "./icons.js";
import { Modal } from "./modal.js";

// "Next" with the count of what still needs a verdict — the same progress signal on every review
// page (remaining, not a fraction). Un-accepting raises it.
type NextToReview = { count: number; onClick: () => void } & ({ noun: string } | { title: string });

export function NextUnreviewedButton(next: NextToReview): React.ReactElement {
  const { count, onClick } = next;
  return (
    <button
      type="button"
      className="ctrl-btn vp-next-unreviewed"
      onClick={onClick}
      disabled={count === 0}
      title={
        "title" in next ? next.title : `Jump to the next ${next.noun} you haven't accepted yet (N)`
      }
    >
      Next to review
      {count > 0 && <span className="vp-shots-action-count">{count}</span>}
    </button>
  );
}

/**
 * The header's review actions: Next (optional — the video review seats it in its shot list),
 * Accept one, Accept all, Reset. Nothing persists until Submit, so Accept all takes no confirm
 * dialog — each mark stays individually reversible, and Reset drops the lot after a confirm.
 */
export function ReviewHeaderActions({
  next,
  acceptCurrent,
  acceptAll,
  reset,
}: {
  next?: NextToReview;
  // The one thing the page is pointed at. The full-screen review has no shot list beside the
  // frame to reach for, so its verdict is taken here — what the A key signs off, as a button.
  acceptCurrent?: {
    accepted: boolean;
    what: string;
    disabled?: boolean;
    disabledTitle?: string;
    onClick: () => void;
  };
  acceptAll?: { done: boolean; what: string; onClick: () => void };
  reset: ResetAction;
}): React.ReactElement {
  return (
    <>
      {next && <NextUnreviewedButton {...next} />}
      {acceptAll && (
        <button
          type="button"
          className={`ctrl-btn${acceptAll.done ? " ctrl-btn--accepted" : ""}`}
          onClick={acceptAll.onClick}
          title={`Mark ${acceptAll.what} to accept. Nothing persists until Submit; un-accept any that need work`}
        >
          <CheckIcon size={13} /> {acceptAll.done ? "All accepted" : "Accept all"}
        </button>
      )}
      <ResetButton reset={reset} />
      {acceptCurrent && (
        <button
          type="button"
          className={`ctrl-btn vp-accept-current${acceptCurrent.accepted ? " ctrl-btn--accepted" : ""}`}
          onClick={acceptCurrent.onClick}
          disabled={acceptCurrent.disabled}
          title={
            acceptCurrent.disabled
              ? (acceptCurrent.disabledTitle ?? `${acceptCurrent.what}: nothing to accept`)
              : acceptCurrent.accepted
                ? `${acceptCurrent.what}: marked to accept (click to clear)`
                : `Mark ${acceptCurrent.what} to accept (A)`
          }
        >
          <CheckIcon size={13} /> {acceptCurrent.accepted ? "Accepted" : "Accept"}
        </button>
      )}
    </>
  );
}

export interface ResetAction {
  disabled: boolean;
  discards?: string;
  onClick: () => void;
}

export function ResetButton({ reset }: { reset: ResetAction }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const discards = reset.discards ?? "every accept mark, take switch, and draft note";
  return (
    <>
      <button
        type="button"
        className="ctrl-btn vp-reset"
        onClick={() => setConfirming(true)}
        disabled={reset.disabled}
        title={`Discard ${discards}: back to how this review opened`}
      >
        <ResetIcon size={13} /> Reset
      </button>
      {confirming && (
        <ResetConfirmModal
          discards={discards}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            reset.onClick();
          }}
        />
      )}
    </>
  );
}

function ResetConfirmModal({
  discards,
  onCancel,
  onConfirm,
}: {
  discards: string;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <Modal className="reset-modal" title="Reset this review?" onClose={onCancel}>
      <p className="keep-modal-note">Discards {discards}: back to how this review opened.</p>
      <div className="keep-modal-actions">
        <button type="button" className="ctrl-btn" onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button
          type="button"
          className="ctrl-btn ctrl-btn--primary"
          onClick={onConfirm}
          ref={confirmRef}
        >
          <ResetIcon size={13} /> Reset
        </button>
      </div>
    </Modal>
  );
}
