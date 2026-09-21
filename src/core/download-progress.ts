/**
 * A `downloadFile` progress callback that redraws a single stderr line. TTY-only: a piped stderr
 * (a log file, the MCP server's stream) gets nothing rather than a flood of carriage returns.
 * Pair every reporter with `endProgress()` once the download settles.
 */
export function progressReporter(label: string): (received: number, total: number | null) => void {
  return (received, total) => {
    if (!process.stderr.isTTY) return;
    const pct = total ? ` ${Math.floor((received / total) * 100)}%` : "";
    const mb = (received / 1048576).toFixed(1);
    process.stderr.write(`\rkonte: downloading ${label}${pct} (${mb} MB)\x1b[K`);
  };
}

export function endProgress(): void {
  if (process.stderr.isTTY) process.stderr.write("\n");
}
