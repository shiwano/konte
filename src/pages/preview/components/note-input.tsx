import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, XIcon } from "./icons.js";

export function NoteInput({
  initialText,
  placeholder,
  onSave,
  onCancel,
}: {
  initialText?: string;
  placeholder?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [text, setText] = useState(initialText ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME is mid-conversion: Enter commits the candidate, it does not save the note.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey && text.trim()) {
      e.preventDefault();
      onSave(text.trim());
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="note-input">
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Add a note..."}
      />
      <button
        type="button"
        className="note-input-btn note-input-btn--save"
        onClick={() => text.trim() && onSave(text.trim())}
        disabled={!text.trim()}
        title="Save"
        aria-label="Save"
      >
        <CheckIcon size={14} />
      </button>
      <button
        type="button"
        className="note-input-btn note-input-btn--cancel"
        onClick={onCancel}
        title="Cancel"
        aria-label="Cancel"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
