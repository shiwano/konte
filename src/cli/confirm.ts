import * as readline from "node:readline";
import { KonteError } from "../core/errors.js";
import { formatBytes } from "./commands/clean-utils.js";
import { currentInvocation } from "./context.js";

function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./#-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function rerunWithYes(args: readonly string[]): string {
  return ["konte", ...args, "--yes"].map(shellQuote).join(" ");
}

// A multi-line consequence on the one line an error is printed on.
function oneLine(text: string): string {
  const flat = text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line !== "")
    .reduce((out, line) => (out === "" ? line : `${out}${out.endsWith(":") ? " " : "; "}${line}`));
  return /[.!?]$/.test(flat) ? flat : `${flat}.`;
}

// `consequence` states what proceeding does; the question is asked here.
export async function confirmAction(
  consequence: string,
  opts: { yes?: boolean; no?: boolean },
): Promise<boolean> {
  if (opts.yes) return true;
  if (opts.no) return false;
  if (!process.stdin.isTTY) {
    throw new KonteError(
      "CONFIRMATION_REQUIRED",
      `${oneLine(consequence)} Not run without a TTY to confirm on — to proceed: ${rerunWithYes(currentInvocation())}`,
    );
  }
  return confirmPrompt(`${consequence.trim()}\nContinue? [y/N] `);
}

type DeletionBreakdown = { label: string; count: number }[];

// One indented `<label>  <count>` line per non-zero item, labels and counts aligned.
export function formatBreakdown(breakdown: DeletionBreakdown): string[] {
  const items = breakdown.filter((item) => item.count > 0);
  if (items.length === 0) return [];
  const labelWidth = Math.max(...items.map((item) => item.label.length));
  const countWidth = Math.max(...items.map((item) => String(item.count).length));
  return items.map(
    (item) => `  ${item.label.padEnd(labelWidth)}  ${String(item.count).padStart(countWidth)}`,
  );
}

function formatDeletionSummary(opts: {
  subjects: string[];
  totalSize: number;
  breakdown?: DeletionBreakdown;
  note?: string;
}): string {
  const note = opts.note ? `, ${opts.note}` : "";
  const head = `${opts.subjects.join(" and ")} (${formatBytes(opts.totalSize)} total${note}) will be deleted`;
  const lines = formatBreakdown(opts.breakdown ?? []);
  if (lines.length === 0) return `${head}.`;
  return [`${head}:`, ...lines].join("\n");
}

// The shared deletion prompt for clean/prune/patch remove: "<subjects> (<size> total) will be
// deleted", optionally itemized.
export function confirmDeletion(opts: {
  subjects: string[];
  totalSize: number;
  breakdown?: DeletionBreakdown;
  note?: string;
  yes?: boolean;
  no?: boolean;
}): Promise<boolean> {
  const summary = formatDeletionSummary(opts);
  // --yes waives the question, not the disclosure.
  if (opts.yes) {
    console.log(summary);
    return Promise.resolve(true);
  }
  return confirmAction(summary, { yes: opts.yes, no: opts.no });
}

// The uniform abort output shared by every confirming command.
export function printAborted(): void {
  console.log("Aborted.");
}
