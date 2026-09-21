import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import {
  type ContactSheetCell,
  DEFAULT_MAX_CELLS,
  MAX_CELLS_LIMIT,
  paginateCells,
  pruneContactSheetPages,
  renderContactSheet,
} from "../../../core/contact-sheet.js";
import { errorMessage } from "../../../core/errors.js";
import { ensureFfmpeg } from "../../../core/ffmpeg.js";
import {
  formatReviewRecord,
  loadLatestReviewRecord,
  loadReviewRecordFile,
  type ReviewRecord,
  reviewNoteFrameTargets,
  toReviewFileId,
} from "../../../core/review-record.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { StateManager } from "../../../core/state/manager.js";
import { resolveShotFeedbackFrames } from "../../../core/thumbnail.js";
import { requireVideoRoot } from "../../context.js";
import { loadVideoAndAnimatic } from "../../load-definition.js";
import { parseNumberOption } from "../../parse-option.js";

/**
 * The frame each note stands on, resolved on demand: nothing is recorded about them, so a hit comes
 * off the composition-hash-keyed cache and a miss is rendered here. A note whose shot is gone from
 * the definition, or whose refs no longer resolve, simply has none — the record is older than the
 * piece, and still reads without it.
 *
 * `problems` is the other half: what a render actually failed on. Reported rather than folded into
 * "no frame", so a broken Chromium install does not read as a record that aged out. A definition
 * that will not load at all is one such problem, and leaves every note unresolved.
 */
async function resolveNoteFrames(
  videoRoot: string,
  record: ReviewRecord,
): Promise<{ frames: Map<string, string>; problems: string[] }> {
  const frames = new Map<string, string>();
  const problems: string[] = [];
  const targets = reviewNoteFrameTargets(record);
  if (targets.length === 0) return { frames, problems };

  let loaded: Awaited<ReturnType<typeof loadVideoAndAnimatic>>;
  try {
    loaded = await loadVideoAndAnimatic(videoRoot);
  } catch (err) {
    return { frames, problems: [`definitions did not load: ${errorMessage(err)}`] };
  }
  const manager = await StateManager.load(videoRoot);
  await applyResolutionDefinitions({ videoRoot, state: manager.getState() });

  // By shot, not by note: one capture session covers every note standing on the same shot, and the
  // notes of a review cluster on the few it flagged.
  const byShot = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = byShot.get(t.shotId);
    if (list) list.push(t);
    else byShot.set(t.shotId, [t]);
  }

  for (const [shotId, shotTargets] of byShot) {
    const results = await resolveShotFeedbackFrames({
      video: loaded.video,
      manager,
      videoRoot,
      shotId,
      notes: shotTargets.map((t) => ({
        feedbackId: t.id,
        localTime: t.localTime,
        annotation: t.annotation,
      })),
    });
    for (const [i, t] of shotTargets.entries()) {
      const result = results[i];
      if (result?.kind === "frame") frames.set(t.id, result.file);
      else if (result?.kind === "failed") problems.push(`${t.id}: ${result.message}`);
    }
  }
  return { frames, problems };
}

interface SheetInfo {
  path: string;
  page: number;
  cells: string[];
}

/**
 * A triage pass, not the evidence: a cell is a fraction of the frame's width, and the per-note
 * `[image: ...]` path in the listing is what a detail judgment has to be read off.
 *
 * Notes whose frame could not be resolved are skipped rather than fatal — the record is still worth
 * showing.
 */
async function renderNoteSheets(
  videoRoot: string,
  record: ReviewRecord,
  noteFrames: ReadonlyMap<string, string>,
  maxCells: number,
): Promise<{ sheets: SheetInfo[]; missing: number; captured: number }> {
  // Keyed on the invocation — this record, at this cell cap — and never on the frames it found,
  // which is `renderContactSheet`'s contract. Keying on the cells would strand a sheet still
  // showing a deleted frame, which no cleanup path could then find. The record's own file id, so
  // two spellings of one `<file>` argument do not each claim a set.
  const cacheKey = createHash("sha256")
    .update(JSON.stringify(["review-notes", toReviewFileId(record.createdAt), maxCells]))
    .digest("hex")
    .slice(0, 12);

  const targets = reviewNoteFrameTargets(record);
  const cells: ContactSheetCell[] = [];
  for (const target of targets) {
    const image = noteFrames.get(target.id);
    if (!image) continue;
    const file = path.resolve(videoRoot, image);
    if (existsSync(file)) cells.push({ label: target.label, file });
  }
  const missing = targets.length - cells.length;
  if (cells.length === 0) {
    // Every frame gone since the last run: drop the pages that still show them.
    await pruneContactSheetPages(videoRoot, cacheKey, 0);
    return { sheets: [], missing, captured: targets.length };
  }

  await ensureFfmpeg();

  const perSheet = Math.min(maxCells, cells.length);
  const pages = paginateCells(cells, perSheet);
  const sheets: SheetInfo[] = [];
  for (const [i, page] of pages.entries()) {
    const result = await renderContactSheet({
      videoRoot,
      cells: page,
      maxCells: perSheet,
      cacheKey,
      page: i + 1,
    });
    sheets.push({ path: result.path, page: i + 1, cells: page.map((c) => c.label) });
  }
  await pruneContactSheetPages(videoRoot, cacheKey, pages.length);
  return { sheets, missing, captured: targets.length };
}

export function registerReviewShowCommand(program: Command): void {
  program
    .command("show [file]")
    .description("Show the latest (or a specific) review session's decisions and feedback")
    .option("--last", "Show the most recent review (default)")
    .option("--verbose", "Also show the AI-authored handoff notes")
    .option("--contact-sheet", "Also tile every note's frame into one sheet to Read")
    .option("--max-cells <n>", `Cells per sheet (default ${DEFAULT_MAX_CELLS})`)
    .addHelpText(
      "after",
      `
Prints what one review session decided and every comment it carried, each video note naming the
frame it stands on ([image: ...]). Frames are rendered on demand from the shot's composition and
cached, so the first run over a review can take a moment; a note whose shot no longer composes, or
whose takes no longer resolve, is listed without one.

--contact-sheet tiles those frames into labelled sheets and prints their paths above the listing,
for a single Read that says which shots were flagged before drilling into any one frame. Cells are
captioned with the comment id and its shot-local time, and laid out in timeline order; the comment
text itself stays in the listing.

A review with more notes than one sheet holds (${DEFAULT_MAX_CELLS}, at 384x216 per cell) paginates,
printing one path per sheet; --max-cells (1..${MAX_CELLS_LIMIT}) trades cell size for fewer sheets.

Examples:
  konte review record show                                 The latest review
  konte review record show --contact-sheet                 ... plus a sheet of every flagged frame
  konte review record show --contact-sheet --max-cells 30  ... on one sheet, smaller cells
  konte review record show --verbose                       ... plus the handoff notes the AI wrote`,
    )
    .action(
      async (
        file: string | undefined,
        opts: {
          last?: boolean;
          verbose?: boolean;
          contactSheet?: boolean;
          maxCells?: string;
        },
      ) => {
        const videoRoot = requireVideoRoot();

        const maxCells =
          parseNumberOption("--max-cells", opts.maxCells, {
            integer: true,
            min: 1,
            max: MAX_CELLS_LIMIT,
          }) ?? DEFAULT_MAX_CELLS;

        const record = file
          ? await loadReviewRecordFile(videoRoot, file)
          : await loadLatestReviewRecord(videoRoot);

        const { frames: noteFrames, problems } = record
          ? await resolveNoteFrames(videoRoot, record)
          : { frames: new Map<string, string>(), problems: [] };
        // stderr, so a piped read of the record is unaffected by what could not be drawn for it.
        for (const problem of problems) console.warn(`Warning: note frame failed — ${problem}`);

        const sheetResult =
          opts.contactSheet && record
            ? await renderNoteSheets(videoRoot, record, noteFrames, maxCells)
            : null;

        if (!record) {
          console.log("No review found.");
          return;
        }

        // Above the listing, so a piped read keeps it.
        if (sheetResult) {
          if (sheetResult.sheets.length === 0) {
            console.log(
              sheetResult.captured > 0
                ? `Contact sheet: none of the ${sheetResult.captured} note frame(s) could be rendered.\n`
                : "Contact sheet: no note in this review can carry a frame.\n",
            );
          } else {
            const total = sheetResult.sheets.reduce((n, s) => n + s.cells.length, 0);
            const paged = sheetResult.sheets.length > 1;
            console.log(
              `Contact sheet (${total} frames${paged ? `, ${sheetResult.sheets.length} sheets` : ""}):`,
            );
            for (const sheet of sheetResult.sheets) {
              // Which sheet holds what, so a paginated run says where to look without opening each.
              const span = paged ? `  ${sheet.cells[0]} .. ${sheet.cells.at(-1)}` : "";
              console.log(`  ${sheet.path}${span}`);
            }
            if (sheetResult.missing > 0) {
              console.log(`  (${sheetResult.missing} frame(s) could not be rendered)`);
            }
            console.log();
          }
        }

        console.log(formatReviewRecord(record, { showHandoff: opts.verbose, noteFrames }));
      },
    );
}
