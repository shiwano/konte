import { useEffect, type RefObject } from "react";

export function useDialogFocus(ref: RefObject<HTMLDivElement | null>, open = true): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement;
    dialog.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key !== "Tab" || !dialog) return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button, a[href], input, textarea, select, summary, [tabindex], audio[controls], video[controls]",
        ),
      ).filter(
        (item) =>
          item.tabIndex >= 0 && !item.matches(":disabled") && item.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (current === first || !items.includes(current as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !items.includes(current as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [ref, open]);
}
