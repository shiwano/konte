import type { Command } from "commander";
import {
  type FeedbackStaleness,
  feedbackStaleness,
  listAllFeedback,
} from "../../../core/feedback/index.js";
import { formatRelativeTime } from "../../../core/format-timestamp.js";
import { assertValidAddressScope } from "../../../core/address.js";
import {
  addListLimitOptions,
  applyListLimit,
  type ListLimitOptions,
  listMoreLine,
} from "../../format-list.js";
import { renderTable } from "../../table.js";
import { matchesAddressScope } from "../../../core/address.js";
import type { FeedbackAnnotation } from "../../../core/types/feedback.js";
import { loadFeedbackStaleContext } from "./stale-context.js";
import { requireVideoRoot } from "../../context.js";

interface FeedbackRow {
  address: string;
  id: string;
  text: string;
  staleness: FeedbackStaleness;
  annotation: FeedbackAnnotation | null;
  time?: number;
  shotTime?: number;
  displayedVariants: Record<string, string>;
  createdAt: string;
}

// The table truncates, which is right for a scan; --verbose is the read, so it prints each comment
// whole — every line of its text, the pin it points at and the time it sits at. The frame a comment
// stands on belongs to `review record show`, the one surface that renders one.
function formatDetail(row: FeedbackRow): string {
  const lines = [
    `[${row.id}] ${row.address}  ${formatRelativeTime(row.createdAt)}${row.staleness === "stale" ? "  [stale]" : row.staleness === "unknown" ? "  [unknown]" : ""}`,
  ];
  for (const line of row.text.trimEnd().split("\n")) lines.push(`  ${line}`);

  const meta: string[] = [];
  if (row.time !== undefined) {
    const local = row.shotTime !== undefined ? ` (shot-local: ${row.shotTime.toFixed(1)}s)` : "";
    meta.push(`time: ${row.time.toFixed(1)}s${local}`);
  }
  if (row.annotation?.kind === "pin") {
    meta.push(`pin: ${row.annotation.x.toFixed(2)}, ${row.annotation.y.toFixed(2)}`);
  }
  if (row.annotation?.kind === "arrow") {
    const { from, to } = row.annotation;
    meta.push(
      `arrow: ${from.x.toFixed(2)}, ${from.y.toFixed(2)} -> ${to.x.toFixed(2)}, ${to.y.toFixed(2)}`,
    );
  }
  if (meta.length > 0) lines.push(`  ${meta.join("  ")}`);

  return lines.join("\n");
}

export function registerFeedbackListCommand(program: Command): void {
  addListLimitOptions(
    program
      .command("list [address-scope]")
      .description("List the comments that still stand (newest first)"),
    "feedback",
  )
    .addHelpText(
      "after",
      `
A comment stops standing once it is stale — what it was written against changed, or an accept was
stamped over it — and drops out of this listing; --verbose keeps it, flagged. The review record
holds every comment as submitted either way (konte review record show).

The default table truncates each comment to a scannable line. --verbose prints them in full
instead: every line of the text, the pin coordinates and the playhead time. The frame a comment
stands on is printed by konte review record show.

The optional address-scope argument filters which comments are listed:
  omitted                  Every stage's comments
  <address-scope>          Only those matching the prefix

Examples:
  konte review feedback list                 Standing comments across every stage
  konte review feedback list video:shot.10   Standing comments on shot 10
  konte review feedback list --verbose       Every comment in full, stale ones included`,
    )
    .option("--verbose", "Show each comment in full, and the ones that no longer stand")
    .action(
      async (addressScope: string | undefined, opts: ListLimitOptions & { verbose?: boolean }) => {
        const videoRoot = requireVideoRoot();

        if (addressScope) assertValidAddressScope(addressScope);

        const { state, ctx } = await loadFeedbackStaleContext(videoRoot);
        const all = await listAllFeedback(videoRoot);
        const filtered = addressScope
          ? all.filter((f) => matchesAddressScope(f.address, addressScope))
          : all;

        // A stale comment is not advice any more, and read beside the standing ones it invites
        // acting on an instruction something already answered. Never lost: --verbose keeps it here,
        // and the review record holds it as submitted.
        const rowsOf = filtered.map(({ address, entry }) => ({
          address,
          id: entry.id,
          text: entry.text,
          staleness: feedbackStaleness(entry, address, state, ctx),
          annotation: entry.annotation,
          time: entry.time,
          shotTime: entry.shotTime,
          displayedVariants: entry.displayedVariants,
          createdAt: entry.createdAt,
        }));
        const allRows: FeedbackRow[] = opts.verbose
          ? rowsOf
          : rowsOf.filter((r) => r.staleness !== "stale");
        const hiddenStale = rowsOf.length - allRows.length;
        allRows.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
            a.id.localeCompare(b.id),
        );

        const { shown: rows, hidden } = applyListLimit(allRows, opts);

        if (allRows.length === 0) {
          console.log(
            hiddenStale > 0
              ? `No comment still stands (${hiddenStale} stale — use --verbose).`
              : "No feedback found.",
          );
          return;
        }

        if (opts.verbose) {
          console.log(rows.map(formatDetail).join("\n\n"));
        } else {
          const tableRows = rows.map((r) => ({
            ID: r.id,
            ADDRESS: r.address,
            TEXT: r.text.replace(/\s+/g, " ").trim(),
            STALE: r.staleness === "stale" ? "yes" : r.staleness === "unknown" ? "?" : "",
            CREATED: formatRelativeTime(r.createdAt),
          }));
          console.log(renderTable(tableRows, { maxWidths: { TEXT: 40 } }));
        }

        if (hidden > 0) console.log(`\n${listMoreLine(hidden)}`);
        if (hiddenStale > 0) {
          console.log(`\n... and ${hiddenStale} stale (use --verbose)`);
        }
      },
    );
}
