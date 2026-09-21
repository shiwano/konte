import type { Command } from "commander";
import { formatRelativeTime } from "../../../core/format-timestamp.js";
import {
  countReviewAssets,
  countReviewFeedback,
  loadAllReviewRecords,
  reviewStage,
} from "../../../core/review-record.js";
import {
  addListLimitOptions,
  applyListLimit,
  type ListLimitOptions,
  listMoreLine,
} from "../../format-list.js";
import { renderTable } from "../../table.js";
import { requireVideoRoot } from "../../context.js";

export function registerReviewListCommand(program: Command): void {
  addListLimitOptions(
    program.command("list").description("List saved review sessions (newest first)"),
    "reviews",
  ).action(async (opts: ListLimitOptions & { json?: boolean }) => {
    const videoRoot = requireVideoRoot();
    const all = await loadAllReviewRecords(videoRoot);
    const { shown, hidden } = applyListLimit(all, opts);

    const rows = shown.map(({ file, record }) => ({
      file,
      createdAt: record.createdAt,
      mode: record.mode,
      stage: reviewStage(record),
      shots: record.context.shots.length,
      assets: countReviewAssets(record),
      feedback: countReviewFeedback(record),
      handoff: Boolean(record.handoffSummary) || (record.handoffNotes?.length ?? 0) > 0,
    }));

    if (all.length === 0) {
      console.log("No reviews found.");
      return;
    }

    console.log(
      renderTable(
        rows.map((r) => ({
          FILE: r.file,
          STAGE: r.stage,
          SHOTS: String(r.shots),
          ASSETS: String(r.assets),
          FB: String(r.feedback),
          HANDOFF: r.handoff ? "yes" : "",
          CREATED: formatRelativeTime(r.createdAt),
        })),
      ),
    );

    if (hidden > 0) console.log(`\n${listMoreLine(hidden)}`);
  });
}
