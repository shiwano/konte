// A comment quotes the words it is about as `> ` lines in its own text, so the quote is read by
// whoever reads the comment and needs no field of its own. Where the quoted words still stand on the
// page is derived at render time: a direction edited past them simply stops highlighting.

const QUOTE_PREFIX = "> ";

// Quoted words as a comment's opening quote, one `> ` line each, with the cursor line after them.
export function quoteLines(lines: readonly string[]): string {
  return lines.map((l) => `${QUOTE_PREFIX}${l}`).join("\n") + "\n";
}

// A selection inside one field: the field's index and the selected [start, end).
export interface FieldSelection {
  field: number;
  start: number;
  end: number;
}

// The words a selection quotes, widened a character at a time on both sides until they occur once
// across all the fields — so the quote alone names which of several equal words it is about, for the
// highlight and for whoever reads the comment. Null when the selection is only whitespace. Words a
// whole field repeats elsewhere stay ambiguous; the highlight then takes the first.
export function uniqueQuote(fields: readonly string[], sel: FieldSelection): string | null {
  const text = fields[sel.field] ?? "";
  let start = sel.start;
  let end = sel.end;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (start === end) return null;
  while (occurrences(fields, text.slice(start, end)) > 1 && (start > 0 || end < text.length)) {
    if (start > 0) start--;
    if (end < text.length) end++;
  }
  return text.slice(start, end).trim();
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

// Every quoted line across the given comment texts, unprefixed.
export function quotedFragments(texts: readonly string[]): string[] {
  return texts.flatMap((t) =>
    t
      .split("\n")
      .filter(isQuoteLine)
      .map((l) => l.slice(QUOTE_PREFIX.length).trim())
      .filter((l) => l.length > 0),
  );
}

export type MarkRange = readonly [start: number, end: number];

// For each field, the ranges the fragments mark in it: a fragment marks its first occurrence in the
// first field holding it, and overlapping ranges merge.
export function markFragments(
  fields: readonly string[],
  fragments: readonly string[],
): MarkRange[][] {
  const out: MarkRange[][] = fields.map(() => []);
  for (const fragment of fragments) {
    for (let i = 0; i < fields.length; i++) {
      const at = fields[i]!.indexOf(fragment);
      if (at < 0) continue;
      out[i]!.push([at, at + fragment.length]);
      break;
    }
  }
  return out.map(mergeRanges);
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
