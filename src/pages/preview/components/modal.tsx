import type React from "react";
import { useEffect, useId, useRef } from "react";
import { useDialogFocus } from "../review/use-dialog-focus.js";
import { XIcon } from "./icons.js";

/**
 * The `.variant-modal-*` shell every overlay shares: a backdrop that closes on a click outside,
 * Escape to close, and the header — title, the view's own actions, the close button. `escape`
 * is "unless-typing" where the dialog holds a note composer (there Escape cancels the input),
 * "off" while another overlay stacked on top owns the key.
 */
export function Modal({
  className,
  title,
  actions,
  closeLabel = "Close",
  escape = "always",
  onClose,
  after,
  children,
}: {
  className: string;
  title: React.ReactNode;
  actions?: React.ReactNode;
  closeLabel?: string;
  escape?: "always" | "unless-typing" | "off";
  onClose: () => void;
  // Rendered inside the backdrop beside the dialog — an overlay stacked on this one.
  after?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(dialogRef);
  useEffect(() => {
    if (escape === "off") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (
        escape === "unless-typing" &&
        (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      )
        return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, escape]);

  return (
    <div
      className="variant-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`variant-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="variant-modal-header">
          <span id={titleId} className="variant-modal-title">
            {title}
          </span>
          <div className="variant-gallery-header-actions">
            {actions}
            <button
              type="button"
              className="variant-modal-close"
              onClick={onClose}
              aria-label={closeLabel}
            >
              <XIcon size={15} />
            </button>
          </div>
        </div>
        {children}
      </div>
      {after}
    </div>
  );
}
