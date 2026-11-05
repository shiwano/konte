import type React from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { CommentIcon } from "../components/icons.js";
import { NoteInput } from "../components/note-input.js";
import {
  type MarkRange,
  type Quote,
  type QuoteKind,
  type QuoteSpan,
  QUOTE_KINDS,
  isQuoteLine,
  quoteLines,
  uniqueQuote,
} from "./quote.js";

// Quotable text is a `data-quote-field` (its index within its kind) under a `data-quote-address`
// scope, tagged `data-quote-kind` unless its quotes go untagged.

const QUOTE_PANEL_WIDTH = 360;

// The comment panel a quote opens, placed under the selection and scrolling with the container. A
// panel holding nothing but quotes closes on a click elsewhere; one with words written stays, takes
// further quotes from its own address, and refuses quotes from any other.
export function useQuoteComposer(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onAddComment: (address: string, text: string) => void,
): {
  address: string | null;
  quotes: Quote[];
  accepts: (address: string) => boolean;
  quote: (address: string, quotes: readonly QuoteSpan[], anchor: { x: number; y: number }) => void;
  panel: React.ReactNode;
} {
  const [state, setState] = useState<{
    key: number;
    address: string;
    quotes: Quote[];
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
    (address: string, spans: readonly QuoteSpan[], anchor: { x: number; y: number }) => {
      const text = quoteLines(spans);
      const insert = { text, nonce: Date.now() };
      setState((prev) => {
        if (prev && written()) {
          if (prev.address !== address) return prev;
          return {
            ...prev,
            quotes: [...prev.quotes, ...spans.map(({ kind, text }) => ({ kind, text }))],
            insert,
          };
        }
        const box = containerRef.current?.getBoundingClientRect();
        if (!box) return prev;
        draft.current = "";
        return {
          key: insert.nonce,
          address,
          quotes: spans.map(({ kind, text }) => ({ kind, text })),
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
      if (panelRef.current?.contains(target) || target?.closest(".quote-tip")) return;
      if (!written()) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [state, close]);

  const panel = state && (
    <div
      ref={panelRef}
      className="quote-panel"
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

function kindOf(el: HTMLElement): QuoteKind | null {
  const kind = el.dataset.quoteKind;
  return kind && (QUOTE_KINDS as readonly string[]).includes(kind) ? (kind as QuoteKind) : null;
}

// What a selection quotes in each `data-quote-field` of a scope it crosses, each made to name one
// place among the scope's fields of its kind (see `uniqueQuote`).
function selectedQuotes(scope: HTMLElement, range: Range): QuoteSpan[] {
  const els = [...scope.querySelectorAll<HTMLElement>("[data-quote-field]")];
  const texts = new Map<QuoteKind | null, string[]>();
  for (const el of els) {
    const kind = kindOf(el);
    const group = texts.get(kind) ?? [];
    group[Number(el.dataset.quoteField)] = el.textContent ?? "";
    texts.set(kind, group);
  }
  const fields = new Map(
    [...texts].map(([kind, group]) => [kind, Array.from(group, (t) => t ?? "")]),
  );
  return els.flatMap((el) => {
    if (!range.intersectsNode(el)) return [];
    const offsetIn = (node: Node, offset: number) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.setEnd(node, offset);
      return r.toString().length;
    };
    const kind = kindOf(el);
    const field = Number(el.dataset.quoteField);
    const start = el.contains(range.startContainer)
      ? offsetIn(range.startContainer, range.startOffset)
      : 0;
    const end = el.contains(range.endContainer)
      ? offsetIn(range.endContainer, range.endOffset)
      : (el.textContent ?? "").length;
    const quote = uniqueQuote(fields, { kind, field, start, end });
    return quote ? [quote] : [];
  });
}

// The "Comment" button floated at a selection inside one scope's quotable text. Its own component,
// so a selection moving re-renders the button alone rather than the whole container.
export function QuoteTip({
  accepts,
  onQuote,
}: {
  accepts: (address: string) => boolean;
  onQuote: (address: string, quotes: QuoteSpan[], anchor: { x: number; y: number }) => void;
}): React.ReactElement | null {
  const [tip, setTip] = useState<{
    address: string;
    quotes: QuoteSpan[];
    key: string;
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
      const quotes = range && scope ? selectedQuotes(scope, range) : [];
      if (!range || !address || quotes.length === 0 || !acceptsRef.current(address)) {
        setTip(null);
        return;
      }
      const key = quoteLines(quotes);
      const rect = range.getBoundingClientRect();
      // Where the drag ended: under the selection's last line.
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? rect;
      setTip((prev) =>
        prev?.address === address &&
        prev.key === key &&
        prev.top === rect.top &&
        prev.left === rect.right
          ? prev
          : {
              address,
              quotes,
              key,
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
      className="quote-tip"
      style={{ top: tip.top, left: tip.left }}
      // Keeps the selection: the click that quotes it must not clear it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(tip.address, tip.quotes, tip.anchor);
        window.getSelection()?.removeAllRanges();
        setTip(null);
      }}
    >
      <CommentIcon size={13} /> Comment
    </button>
  );
}

// A field's text with the ranges quotes mark in it highlighted.
// A click that ends a drag is the selection's.
function selecting(): boolean {
  return !(window.getSelection()?.isCollapsed ?? true);
}

// `text` with its quoted `ranges` highlighted and each `heard` range — where the take is heard to
// say other than the line — underlined, a zero-width one drawn as a caret between two characters.
// `onPlay` plays a quoted range, `onClick` a heard one; neither adds to the text a selection reads.
export function Marked({
  text,
  ranges,
  heard = [],
  onPlay,
}: {
  text: string;
  ranges: readonly MarkRange[];
  heard?: readonly { range: MarkRange; onClick: () => void }[];
  onPlay?: (range: MarkRange) => void;
}): React.ReactElement {
  if (ranges.length === 0 && heard.length === 0) return <>{text}</>;
  const cuts = new Set([0, text.length]);
  for (const [start, end] of [...ranges, ...heard.map((h) => h.range)]) {
    cuts.add(Math.min(start, text.length));
    cuts.add(Math.min(end, text.length));
  }
  const bounds = [...cuts].sort((a, b) => a - b);
  const parts: React.ReactNode[] = [];
  const plays = (fn: () => void) => ({
    role: "button",
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      if (selecting()) return;
      e.stopPropagation();
      fn();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.stopPropagation();
      fn();
    },
  });
  bounds.forEach((at, i) => {
    heard.forEach((h, k) => {
      if (h.range[0] === at && h.range[1] === at) {
        parts.push(<span key={`i${k}`} className="heard-insert" {...plays(h.onClick)} />);
      }
    });
    const end = bounds[i + 1];
    if (end === undefined || end === at) return;
    const segment = text.slice(at, end);
    const mark = heard.find(
      (h) => h.range[0] <= at && end <= h.range[1] && h.range[0] < h.range[1],
    );
    const quoted = ranges.find(([s, e]) => s <= at && end <= e);
    let node: React.ReactNode = mark ? (
      <span className="heard-mark" {...plays(mark.onClick)}>
        {segment}
      </span>
    ) : (
      segment
    );
    if (quoted) {
      node = (
        <mark
          className={onPlay ? "quote-mark quote-mark--plays" : "quote-mark"}
          {...(onPlay ? plays(() => onPlay(quoted)) : {})}
        >
          {node}
        </mark>
      );
    }
    parts.push(<Fragment key={at}>{node}</Fragment>);
  });
  return <>{parts}</>;
}
