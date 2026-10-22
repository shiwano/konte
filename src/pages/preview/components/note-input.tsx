import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, XIcon } from "./icons.js";

export function NoteInput({
  initialText,
  insert,
  placeholder,
  onTextChange,
  onSave,
  onCancel,
}: {
  initialText?: string;
  // Text appended to the draft, once per `nonce`, leaving the cursor after it.
  insert?: { text: string; nonce: number };
  placeholder?: string;
  onTextChange?: (text: string) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [text, setText] = useState(initialText ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const insertedNonce = useRef<number | null>(null);
  const cursorToEnd = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    if (!insert || insertedNonce.current === insert.nonce) return;
    insertedNonce.current = insert.nonce;
    cursorToEnd.current = true;
    setText((prev) => (prev.trim() ? `${prev.replace(/\n*$/, "")}\n${insert.text}` : insert.text));
  }, [insert]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (cursorToEnd.current) {
      cursorToEnd.current = false;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [text]);

  useEffect(() => {
    onTextChange?.(text);
  }, [text, onTextChange]);

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
