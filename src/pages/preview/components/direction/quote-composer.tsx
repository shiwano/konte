import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isQuoteLine, quoteLines, quotedFragments, uniqueQuote } from "../../review/quote.js";
import { CommentIcon } from "../icons.js";
import { NoteInput } from "../note-input.js";

const QUOTE_PANEL_WIDTH = 360;

// The comment panel a quote opens, placed under the selection and scrolling with the script. A panel
// holding nothing but quotes closes on a click elsewhere; one with words written stays, takes further
// quotes from its own shot, and refuses quotes from any other.
export function useQuoteComposer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onAddComment: (address: string, text: string) => void,
): {
  address: string | null;
  quotes: string[];
  accepts: (address: string) => boolean;
  quote: (address: string, text: string, anchor: { x: number; y: number }) => void;
  panel: React.ReactNode;
} {
  const [state, setState] = useState<{
    key: number;
    address: string;
    quotes: string[];
    insert: { text: string; nonce: number };
    top: number;
    left: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draft = useRef("");
  const written = () => draft.current.split("\n").some((l) => l.trim() && !isQuoteLine(l));

  const close = useCallback(() => {
    draft.current = "";
    setState(null);
  }, []);

  const accepts = useCallback(
    (address: string) => !(state && state.address !== address && written()),
    [state],
  );

  const quote = useCallback(
    (address: string, text: string, anchor: { x: number; y: number }) => {
      const insert = { text, nonce: Date.now() };
      setState((prev) => {
        if (prev && written()) {
          if (prev.address !== address) return prev;
          return { ...prev, quotes: [...prev.quotes, ...quotedFragments([text])], insert };
        }
        const box = containerRef.current?.getBoundingClientRect();
        if (!box) return prev;
        draft.current = "";
        return {
          key: insert.nonce,
          address,
          quotes: quotedFragments([text]),
          insert,
          top: anchor.y - box.top,
          left: Math.max(0, Math.min(anchor.x - box.left, box.width - QUOTE_PANEL_WIDTH)),
        };
      });
    },
    [containerRef],
  );

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (panelRef.current?.contains(target) || target?.closest(".dir-sc-quote-tip")) return;
      if (!written()) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [state, close]);

  const panel = state && (
    <div
      ref={panelRef}
      className="dir-sc-quote-panel"
      style={{ top: state.top, left: state.left, width: QUOTE_PANEL_WIDTH }}
    >
      <NoteInput
        key={state.key}
        insert={state.insert}
        placeholder="Comment on the quoted words…"
        onTextChange={(text) => {
          draft.current = text;
        }}
        onSave={(text) => {
          onAddComment(state.address, text);
          close();
        }}
        onCancel={close}
      />
    </div>
  );

  return {
    address: state?.address ?? null,
    quotes: state?.quotes ?? [],
    accepts,
    quote,
    panel,
  };
}

// What a selection quotes in each `data-quote-field` of a part it crosses, each made to name one
// place in the part (see `uniqueQuote`). A field's index is its position in `markFragments`' fields.
function selectedQuotes(scope: HTMLElement, range: Range): string[] {
  const els = [...scope.querySelectorAll<HTMLElement>("[data-quote-field]")];
  const texts: string[] = [];
  for (const el of els) texts[Number(el.dataset.quoteField)] = el.textContent ?? "";
  const fields = Array.from(texts, (t) => t ?? "");
  return els.flatMap((el) => {
    if (!range.intersectsNode(el)) return [];
    const offsetIn = (node: Node, offset: number) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(node, offset);
      return r.toString().length;
    };
    const field = Number(el.dataset.quoteField);
    const start = el.contains(range.startContainer)
      ? offsetIn(range.startContainer, range.startOffset)
      : 0;
    const end = el.contains(range.endContainer)
      ? offsetIn(range.endContainer, range.endOffset)
      : (fields[field] ?? "").length;
    const quote = uniqueQuote(fields, { field, start, end });
    return quote ? [quote] : [];
  });
}

// The "Comment" button floated at a selection inside one part's quotable text. Its own component, so
// a selection moving re-renders the button alone rather than every shot.
export function QuoteTip({
  accepts,
  onQuote,
}: {
  accepts: (address: string) => boolean;
  onQuote: (address: string, quote: string, anchor: { x: number; y: number }) => void;
}): React.ReactElement | null {
  const [tip, setTip] = useState<{
    address: string;
    quote: string;
    top: number;
    left: number;
    anchor: { x: number; y: number };
  } | null>(null);
  const acceptsRef = useRef(accepts);
  acceptsRef.current = accepts;

  useEffect(() => {
    const read = () => {
      const sel = window.getSelection();
      const range = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const node = range?.commonAncestorContainer;
      const el = node instanceof Element ? node : node?.parentElement;
      const scope = el?.closest<HTMLElement>("[data-quote-address]");
      const address = scope?.dataset.quoteAddress;
      const lines = range && scope ? selectedQuotes(scope, range) : [];
      if (!range || !address || lines.length === 0 || !acceptsRef.current(address)) {
        setTip(null);
        return;
      }
      const quote = quoteLines(lines);
      const rect = range.getBoundingClientRect();
      // Where the drag ended: under the selection's last line.
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? rect;
      setTip((prev) =>
        prev?.address === address &&
        prev.quote === quote &&
        prev.top === rect.top &&
        prev.left === rect.right
          ? prev
          : {
              address,
              quote,
              top: rect.top,
              left: rect.right,
              anchor: { x: last.right - 24, y: last.bottom + 6 },
            },
      );
    };
    // A touch selection ends with no mouseup, so a selection left still for a moment is read too.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onSelectionChange = () => {
      clearTimeout(settle);
      if (window.getSelection()?.isCollapsed ?? true) setTip(null);
      else settle = setTimeout(read, 400);
    };
    const hide = () => setTip(null);
    document.addEventListener("mouseup", read);
    document.addEventListener("keyup", read);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimeout(settle);
      document.removeEventListener("mouseup", read);
      document.removeEventListener("keyup", read);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  if (!tip) return null;
  return (
    <button
      type="button"
      className="dir-sc-quote-tip"
      style={{ top: tip.top, left: tip.left }}
      // Keeps the selection: the click that quotes it must not clear it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(tip.address, tip.quote, tip.anchor);
        window.getSelection()?.removeAllRanges();
        setTip(null);
      }}
    >
      <CommentIcon size={13} /> Comment
    </button>
  );
}
