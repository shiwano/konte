// A comment quotes the words it is about as `> ` lines in its own text, so the quote is read by
// whoever reads the comment and needs no field of its own. Where the quoted words still stand on the
// page is derived at render time: a text edited past them simply stops highlighting.

const QUOTE_PREFIX = "> ";

export const QUOTE_KINDS = ["script", "acting", "blocking", "camera", "handoff"] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

// Quoted words and the kind of text they are from, written `> <kind>: <text>`. The direction's are
// untagged (null): each of its fields routes to a target of its own.
export interface Quote {
  kind: QuoteKind | null;
  text: string;
}

// The quotable text of one container, grouped by the kind a quote of it carries. A field's index is
// its position in its group.
export type QuoteFields = ReadonlyMap<QuoteKind | null, readonly string[]>;

// A selection inside one field: the field's kind and index, and the selected [start, end).
export interface FieldSelection {
  kind: QuoteKind | null;
  field: number;
  start: number;
  end: number;
}

// A quote and the [start, end) it stands at in its field.
export type QuoteSpan = Quote & FieldSelection;

// Quoted words as a comment's opening quote, one `> ` line each, with the cursor line after them.
export function quoteLines(quotes: readonly Quote[]): string {
  return (
    quotes
      .map((q) => `${QUOTE_PREFIX}${q.kind === null ? "" : `${q.kind}: `}${q.text}`)
      .join("\n") + "\n"
  );
}

// The words a selection quotes, widened a character at a time on both sides until they occur once
// across the fields of its kind — so the quote alone names which of several equal words it is
// about, for the highlight and for whoever reads the comment. Null when the selection is only
// whitespace. Words a whole field repeats elsewhere stay ambiguous; the highlight then takes the
// first.
export function uniqueQuote(fields: QuoteFields, sel: FieldSelection): QuoteSpan | null {
  const group = fields.get(sel.kind) ?? [];
  const text = group[sel.field] ?? "";
  let start = Math.max(0, sel.start);
  let end = Math.min(text.length, sel.end);
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (start === end) return null;
  while (occurrences(group, text.slice(start, end)) > 1 && (start > 0 || end < text.length)) {
    if (start > 0) start--;
    if (end < text.length) end++;
  }
  while (/\s/.test(text[start]!)) start++;
  while (/\s/.test(text[end - 1]!)) end--;
  return { kind: sel.kind, field: sel.field, start, end, text: text.slice(start, end) };
}

function occurrences(fields: readonly string[], fragment: string): number {
  let n = 0;
  for (const field of fields) {
    for (let at = field.indexOf(fragment); at >= 0; at = field.indexOf(fragment, at + 1)) n++;
  }
  return n;
}

export function isQuoteLine(line: string): boolean {
  return line.startsWith(QUOTE_PREFIX);
}

const KIND_TAG = new RegExp(`^(${QUOTE_KINDS.join("|")}): `);

// A quote line's words and kind; null when the line is no quote or quotes nothing. Only a page whose
// quotes carry a kind (`tagged`) reads one off the line: a direction quote is the words alone.
export function parseQuoteLine(line: string, tagged: boolean): Quote | null {
  if (!isQuoteLine(line)) return null;
  const body = line.slice(QUOTE_PREFIX.length);
  const tag = tagged ? KIND_TAG.exec(body) : null;
  const text = (tag ? body.slice(tag[0].length) : body).trim();
  if (text.length === 0) return null;
  return { kind: tag ? (tag[1] as QuoteKind) : null, text };
}

// Every quote across the given comment texts.
export function quotedFragments(texts: readonly string[], tagged: boolean): Quote[] {
  return texts.flatMap((t) =>
    t.split("\n").flatMap((l) => {
      const q = parseQuoteLine(l, tagged);
      return q ? [q] : [];
    }),
  );
}

export type MarkRange = readonly [start: number, end: number];

// For each field of each kind, the ranges the quotes mark in it: a quote marks its first occurrence
// in the first field of its own kind holding it, and overlapping ranges merge.
export function markFragments(
  fields: QuoteFields,
  quotes: readonly Quote[],
): Map<QuoteKind | null, MarkRange[][]> {
  const out = new Map<QuoteKind | null, MarkRange[][]>();
  for (const [kind, group] of fields) {
    const marks: MarkRange[][] = group.map(() => []);
    for (const q of quotes) {
      if (q.kind !== kind) continue;
      for (let i = 0; i < group.length; i++) {
        const at = group[i]!.indexOf(q.text);
        if (at < 0) continue;
        marks[i]!.push([at, at + q.text.length]);
        break;
      }
    }
    out.set(kind, marks.map(mergeRanges));
  }
  return out;
}

function mergeRanges(ranges: MarkRange[]): MarkRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
