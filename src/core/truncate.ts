export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Collapse internal whitespace to single spaces and cap to `width` with an
// ellipsis.
export function truncateSingleLine(text: string, width: number): string {
  const oneLine = singleLine(text);
  return oneLine.length > width ? `${oneLine.slice(0, width - 1)}…` : oneLine;
}

// Width for the one-line error peeks shown by `status` and `job list`, kept here
// so both read the same.
export const ERROR_GLIMPSE_WIDTH = 60;
