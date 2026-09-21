import { useEffect, useRef } from "react";

/** Handlers by `KeyboardEvent.key`; a lowercase letter matches its shifted form too. */
export type ShortcutHandlers = Record<string, (e: KeyboardEvent) => void>;

/**
 * The review pages' keyboard: ⌘/Ctrl+⏎ submits, every other bound key runs its handler with the
 * default prevented. Nothing fires while typing in a field, or while `blocked` — a modal owns the
 * keyboard while open, and a shortcut behind one would change a decision the reviewer cannot see.
 * The listener subscribes once and reads the latest options through a ref, so handlers that change
 * identity every render (they close over the session) cost no re-binding.
 */
export function useReviewShortcuts(opts: {
  blocked: boolean;
  onSubmit: () => void;
  handlers: ShortcutHandlers;
}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || e.target.closest("input, textarea, select"))
      )
        return;
      const { blocked, onSubmit, handlers } = optsRef.current;
      if (blocked) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onSubmit();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.key === " " || e.key === "Enter") &&
        e.target instanceof HTMLElement &&
        e.target.closest("button, a, summary, audio, video")
      )
        return;
      const key = Object.hasOwn(handlers, e.key) ? e.key : e.key.toLowerCase();
      const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
      if (!handler) return;
      e.preventDefault();
      handler(e);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
