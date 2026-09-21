// Terminal display width (CJK/fullwidth count two columns, combining marks and
// ZWJ emoji sequences zero, ANSI escapes ignored). Bun's native implementation
// handles all of these — counting code units instead would misalign any table
// containing such text.
const stringWidth = (text: string): number => Bun.stringWidth(text);

// Cap `text` to `maxWidth` display columns, appending an ellipsis (which itself
// takes one column) when it overflows.
function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let width = 0;
  let result = "";
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w > maxWidth - 1) break;
    result += ch;
    width += w;
  }
  return `${result}…`;
}

// A borderless table: an uppercase header row, then rows whose cells are
// left-aligned and padded to the widest value in their column, measured in
// display columns so CJK/fullwidth text stays aligned. Columns are the union of
// all row keys (first-seen order). `maxWidths` caps a column's width (by display
// columns), truncating longer cells with an ellipsis. The output is read far more
// often by agents than by humans, so it carries no box-drawing characters and no
// trailing padding — both are pure token cost.
export function renderTable(
  rows: Record<string, string>[],
  options?: { maxWidths?: Record<string, number> },
): string {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const cell = (row: Record<string, string>, col: string): string => {
    const raw = row[col] ?? "";
    const max = options?.maxWidths?.[col];
    return max === undefined ? raw : truncateToWidth(raw, max);
  };

  const widths = columns.map((col) =>
    Math.max(stringWidth(col), ...rows.map((row) => stringWidth(cell(row, col)))),
  );

  const pad = (text: string, width: number): string =>
    text + " ".repeat(Math.max(0, width - stringWidth(text)));

  const renderRow = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]!)))
      .join("  ")
      .trimEnd();

  return [
    renderRow(columns),
    ...rows.map((row) => renderRow(columns.map((col) => cell(row, col)))),
  ].join("\n");
}
