import type { Command } from "commander";
import { parsePositiveInt } from "./parse-option.js";

// The default number of list items shown before the rest fold into a "… and N
// more (use -v)" line. The fold line names the flag: an agent reads the output of
// the command it just ran, not `--help`. Keeps agent-facing output from scaling
// linearly with project size.
export const DEFAULT_LIST_CAP = 10;

// Cap a list to the first `cap` items, reporting how many were hidden. `verbose`
// disables the cap entirely.
export function capList<T>(
  items: readonly T[],
  opts?: { cap?: number; verbose?: boolean },
): { shown: T[]; hidden: number } {
  const cap = opts?.verbose ? Number.POSITIVE_INFINITY : (opts?.cap ?? DEFAULT_LIST_CAP);
  if (items.length <= cap) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, cap), hidden: items.length - cap };
}

// The fold line under a capped list. `flag` lifts the cap; null when the line after it names the
// full view instead.
export function moreLine(hidden: number, opts?: { flag?: string | null; what?: string }): string {
  const flag = opts?.flag === undefined ? "-v" : opts.flag;
  const line = `… and ${hidden} ${opts?.what ?? "more"}`;
  return flag ? `${line} (use ${flag})` : line;
}

// `items` capped and joined on one line, the rest folded into a "(+N more)" suffix.
export function capInline(
  items: readonly string[],
  opts?: { cap?: number; verbose?: boolean },
): string {
  const { shown, hidden } = capList(items, opts);
  const joined = shown.join(", ");
  return hidden > 0 ? `${joined} (+${hidden} more)` : joined;
}

// Print `items` capped, one indented line each, then the fold line.
export function printCapped<T>(
  items: readonly T[],
  format: (item: T) => string,
  opts?: { cap?: number; verbose?: boolean },
): void {
  const { shown, hidden } = capList(items, opts);
  for (const item of shown) console.log(`  ${format(item)}`);
  if (hidden > 0) console.log(`  ${moreLine(hidden)}`);
}

// The list-command contract: newest-first rows, `--limit <n>` (default 50) and `--all`.
const DEFAULT_LIST_LIMIT = 50;

export interface ListLimitOptions {
  limit: string;
  all?: boolean;
}

export function addListLimitOptions(command: Command, noun: string): Command {
  return command
    .option(
      "--limit <n>",
      `Max rows to show (default: ${DEFAULT_LIST_LIMIT})`,
      String(DEFAULT_LIST_LIMIT),
    )
    .option("--all", `Show all ${noun}, ignoring --limit`);
}

export function applyListLimit<T>(
  items: readonly T[],
  opts: ListLimitOptions,
): { shown: T[]; hidden: number } {
  return capList(items, { verbose: opts.all, cap: parsePositiveInt(opts.limit, "--limit") });
}

export function listMoreLine(hidden: number): string {
  return moreLine(hidden, { flag: "--all" });
}
