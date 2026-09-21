import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "./concurrency.js";
import { KonteError, errorMessage } from "./errors.js";
import { ffmpegBin, SINGLE_FRAME_INPUT_ARGS, SINGLE_FRAME_OUTPUT_ARGS } from "./ffmpeg-binary.js";
import { execFileAsync } from "./exec-file.js";

// A sheet exists to be Read by an agent, so its geometry is bounded by what a vision model keeps:
// past a ~1568px long edge or ~1.15M pixels the image is downscaled on the way in, shrinking every
// cell for nothing. Cells are sized to sit just inside both bounds.
const SHEET_MAX_EDGE = 1568;
const SHEET_MAX_PIXELS = 1_150_000;
const DEFAULT_CELL_ASPECT = 16 / 9;
const TILE_PADDING = 6;
const TILE_MARGIN = 6;
const BACKGROUND = "0x111111";

// At 16:9, 12 cells is a 3x4 grid of 402x226 — enough for character identity and prop placement.
// Detail finer than that is `cellWidth`'s to buy, one sheet at a time.
export const DEFAULT_MAX_CELLS = 12;

// Past this the cells are too small to read anything off, and the geometry stops being able to hold
// both bounds at once (rounding to even dimensions leaves the sheet over budget). Rejecting the
// input keeps the bounds above true for every layout this can produce.
export const MAX_CELLS_LIMIT = 100;

export interface ContactSheetCell {
  label: string;
  /** Absolute path to the image file this cell shows. */
  file: string;
  variantId?: string;
  /** konte's own content key for the source, when it has one — a stronger staleness signal. */
  outputHash?: string | null;
  /** The picture's width over its height, when known. */
  aspect?: number;
}

/**
 * The cell aspect a run lays out at: the one most of its pictures share. Pictures of any other aspect
 * are padded.
 */
export function sheetAspect(cells: readonly ContactSheetCell[]): number {
  const counts = new Map<string, { aspect: number; count: number }>();
  for (const { aspect } of cells) {
    if (aspect === undefined || !Number.isFinite(aspect) || aspect <= 0) continue;
    const key = aspect.toFixed(2);
    const entry = counts.get(key) ?? { aspect, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  let best: { aspect: number; count: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best?.aspect ?? DEFAULT_CELL_ASPECT;
}

interface ContactSheetLayout {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  sheetWidth: number;
  sheetHeight: number;
  /** Background-only cells padding the last row, so `tile` always gets columns*rows inputs. */
  blanks: number;
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function sheetSize(
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): { sheetWidth: number; sheetHeight: number } {
  return {
    sheetWidth: columns * cellWidth + (columns - 1) * TILE_PADDING + TILE_MARGIN * 2,
    sheetHeight: rows * cellHeight + (rows - 1) * TILE_PADDING + TILE_MARGIN * 2,
  };
}

// The largest `aspect` cell a `columns`x`rows` grid holds inside both vision-model bounds.
function fitCell(
  columns: number,
  rows: number,
  aspect: number,
): { cellWidth: number; cellHeight: number } {
  const widthCap = (SHEET_MAX_EDGE - TILE_MARGIN * 2 - TILE_PADDING * (columns - 1)) / columns;
  const heightCap =
    ((SHEET_MAX_EDGE - TILE_MARGIN * 2 - TILE_PADDING * (rows - 1)) / rows) * aspect;

  let cellWidth = even(Math.min(widthCap, heightCap));
  let cellHeight = even(cellWidth / aspect);

  // The edge caps ignore padding's contribution to area. Settle the pixel bound against the full
  // sheet: one proportional correction lands within a percent, then step down until the rounding
  // to even dimensions stops pushing it back over.
  const overBudget = (w: number, h: number): boolean => {
    const { sheetWidth, sheetHeight } = sheetSize(columns, rows, w, h);
    return (
      sheetWidth * sheetHeight > SHEET_MAX_PIXELS ||
      Math.max(sheetWidth, sheetHeight) > SHEET_MAX_EDGE
    );
  };
  if (overBudget(cellWidth, cellHeight)) {
    const { sheetWidth, sheetHeight } = sheetSize(columns, rows, cellWidth, cellHeight);
    cellWidth = even(
      cellWidth * Math.sqrt(Math.min(1, SHEET_MAX_PIXELS / (sheetWidth * sheetHeight))),
    );
    cellHeight = even(cellWidth / aspect);
    while (cellWidth > 2 && overBudget(cellWidth, cellHeight)) {
      cellWidth -= 2;
      cellHeight = even(cellWidth / aspect);
    }
  }
  return { cellWidth, cellHeight };
}

/**
 * Grid and cell geometry for a page of `count` cells, on a run capped at `maxCells` per sheet.
 *
 * Columns and cell size derive from `maxCells`, not from `count`, so every page of one run shares a
 * scale and the sheets read as one board — a short last page leaves blanks rather than blowing its
 * few cells up. (Callers pass `min(cap, total)`, so a run that fits on one page is not sized for
 * cells it does not have.) The column count is the one whose `aspect` cells come out largest inside
 * the edge and pixel bounds — the more columns on a tie.
 */
export function planContactSheetLayout(
  maxCells: number,
  count = maxCells,
  opts: { groupSize?: number; aspect?: number } = {},
): ContactSheetLayout {
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_CELLS_LIMIT) {
    throw new KonteError(
      "INVALID_OPTION",
      `--max-cells must be an integer in 1..${MAX_CELLS_LIMIT}, got ${maxCells}`,
    );
  }
  if (count < 1 || count > maxCells) {
    throw new KonteError("INVALID_OPTION", `A page holds 1..${maxCells} cells, got ${count}`);
  }
  const groupSize = opts.groupSize ?? 1;
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    throw new KonteError(
      "INVALID_OPTION",
      `groupSize must be a positive integer, got ${groupSize}`,
    );
  }
  if (count % groupSize !== 0) {
    throw new KonteError(
      "INVALID_OPTION",
      `A page of grouped cells holds whole groups of ${groupSize}, got ${count}`,
    );
  }
  const aspect = opts.aspect ?? DEFAULT_CELL_ASPECT;
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new KonteError("INVALID_OPTION", `aspect must be a positive number, got ${aspect}`);
  }
  let best: { columns: number; cellWidth: number; cellHeight: number } | undefined;
  // Consecutive cells that belong to one subject (a shot's in/out pair) are only readable as a
  // group while they sit on one row, so the column count is a whole number of groups.
  const widest = Math.ceil(maxCells / groupSize) * groupSize;
  for (let columns = groupSize; columns <= widest; columns += groupSize) {
    const rows = Math.ceil(maxCells / columns);
    const cell = fitCell(columns, rows, aspect);
    if (!best || cell.cellWidth * cell.cellHeight >= best.cellWidth * best.cellHeight) {
      best = { columns, ...cell };
    }
  }
  const { columns: fullColumns, cellWidth, cellHeight } = best!;

  const columns = Math.min(fullColumns, count);
  const rows = Math.ceil(count / columns);
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    blanks: columns * rows - count,
    ...sheetSize(columns, rows, cellWidth, cellHeight),
  };
}

/**
 * The most cells a sheet holds while each is at least `cellWidth` wide, or null when even one cell
 * cannot be — `widest` is the width a lone cell reaches.
 */
export function maxCellsForWidth(
  cellWidth: number,
  opts: { groupSize?: number; aspect?: number } = {},
): { maxCells: number | null; widest: number } {
  const groupSize = opts.groupSize ?? 1;
  const widest = planContactSheetLayout(groupSize, groupSize, opts).cellWidth;
  for (
    let n = Math.floor(MAX_CELLS_LIMIT / groupSize) * groupSize;
    n >= groupSize;
    n -= groupSize
  ) {
    if (planContactSheetLayout(n, n, opts).cellWidth >= cellWidth) return { maxCells: n, widest };
  }
  return { maxCells: null, widest };
}

/**
 * Pack cells into pages without splitting a group. `groups` is the cells each subject contributed,
 * in order — uniform on the video board (a shot's in/out pair), VARIABLE on the animatic's, where it
 * is the shot's keyframe count. Cells past the last group are packed as a final group of their own.
 *
 * A group larger than `maxCells` gets a page of its own rather than being cut; the caller reports
 * the sheet that came out wider than asked. Past `MAX_CELLS_LIMIT` it is split instead, since
 * `planContactSheetLayout` refuses a page beyond that outright.
 */
export function paginateGroupedCells<T>(
  cells: readonly T[],
  groups: readonly number[],
  maxCells: number,
): T[][] {
  if (maxCells < 1) {
    throw new KonteError("INVALID_OPTION", "--max-cells must be at least 1");
  }
  const pages: T[][] = [];
  let page: T[] = [];
  let at = 0;
  const push = (group: readonly T[]): void => {
    if (group.length === 0) return;
    if (group.length > MAX_CELLS_LIMIT) {
      if (page.length > 0) {
        pages.push(page);
        page = [];
      }
      for (let i = 0; i < group.length; i += MAX_CELLS_LIMIT) {
        pages.push(group.slice(i, i + MAX_CELLS_LIMIT));
      }
      return;
    }
    if (page.length > 0 && page.length + group.length > maxCells) {
      pages.push(page);
      page = [];
    }
    page.push(...group);
  };
  for (const size of groups) {
    push(cells.slice(at, at + size));
    at += Math.max(0, size);
  }
  push(cells.slice(at));
  if (page.length > 0) pages.push(page);
  return pages;
}

export function paginateCells<T>(cells: readonly T[], maxCells: number): T[][] {
  if (maxCells < 1) {
    throw new KonteError("INVALID_OPTION", "--max-cells must be at least 1");
  }
  const pages: T[][] = [];
  for (let i = 0; i < cells.length; i += maxCells) {
    pages.push(cells.slice(i, i + maxCells));
  }
  return pages;
}

// A filtergraph option value is parsed before drawtext ever sees it: `\` escapes, `:` ends the
// value, `'` ends the quoted run. Paths carry all three (a Windows `C:\…`, a POSIX tmpdir the user
// named). Escape them rather than trusting the temp path's shape.
export function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function runFfmpeg(args: string[], what: string): Promise<void> {
  const ffmpeg = await ffmpegBin();
  try {
    await execFileAsync(ffmpeg, args);
  } catch (err) {
    const message = errorMessage(err);
    throw new KonteError("FFMPEG_ERROR", `${what}: ${message}`);
  }
}

// Every cell is pinned to one pixel format. `tile` accumulates columns*rows frames before it emits,
// and a format change part-way through the image sequence reinitializes the filtergraph, discarding
// everything accumulated so far — so a sheet mixing a source-derived cell (yuvj444p from a PNG) with
// a generated blank (yuvj420p from lavfi) renders as the blanks alone.
const CELL_PIX_FMT = "yuvj420p";

export function cellFilters(layout: ContactSheetLayout, labelFile: string | null): string {
  const { cellWidth: w, cellHeight: h } = layout;
  const filters = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${BACKGROUND}`,
  ];
  if (labelFile) {
    // Bounded by height too: a 4:1 cell sized off its width alone buries the picture under its label.
    const fontsize = Math.max(11, Math.round(Math.min(w / 20, h / 8)));
    // Reading the label from a file with expansion off keeps the address's own `:`/`%`/`\` out of
    // the filtergraph and away from drawtext's strftime expansion.
    filters.push(
      `drawtext=textfile='${escapeFilterPath(labelFile)}':expansion=none:x=5:y=5:fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`,
    );
  }
  // Last, so it survives whatever the label burn-in negotiated.
  filters.push(`format=${CELL_PIX_FMT}`);
  return filters.join(",");
}

/**
 * Whether this ffmpeg can actually burn a label — the filter being compiled in says nothing about
 * a usable font being installed. Settled once against a synthetic source, before any cell is
 * rendered, so labelling is all-or-nothing: a mid-run discovery would leave a half-labelled sheet,
 * and a failure on a real cell cannot be told apart from that source being unreadable.
 */
async function canDrawText(layout: ContactSheetLayout, probeDir: string): Promise<boolean> {
  const labelFile = path.join(probeDir, "probe-label.txt");
  const outPath = path.join(probeDir, "probe.jpg");
  try {
    await fs.writeFile(labelFile, "probe", "utf-8");
    const ffmpeg = await ffmpegBin();
    await execFileAsync(ffmpeg, [
      "-y",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-f",
      "lavfi",
      "-i",
      `color=c=${BACKGROUND}:s=${layout.cellWidth}x${layout.cellHeight}`,
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-vf",
      cellFilters(layout, labelFile),
      "-frames:v",
      "1",
      outPath,
    ]);
    return existsSync(outPath);
  } catch {
    return false;
  } finally {
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

async function renderCell(
  cell: ContactSheetCell,
  outputPath: string,
  layout: ContactSheetLayout,
  labelFile: string | null,
): Promise<void> {
  await runFfmpeg(
    [
      "-y",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-i",
      cell.file,
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-vf",
      cellFilters(layout, labelFile),
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outputPath,
    ],
    `Failed to render contact sheet cell for ${cell.label}`,
  );
  if (!existsSync(outputPath)) {
    throw new KonteError("FFMPEG_ERROR", `ffmpeg produced no cell for ${cell.label}`);
  }
}

async function renderBlankCell(outputPath: string, layout: ContactSheetLayout): Promise<void> {
  await runFfmpeg(
    [
      "-y",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-f",
      "lavfi",
      "-i",
      `color=c=${BACKGROUND}:s=${layout.cellWidth}x${layout.cellHeight}`,
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-vf",
      `format=${CELL_PIX_FMT}`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outputPath,
    ],
    "Failed to render contact sheet padding",
  );
}

interface ContactSheetResult {
  path: string;
  layout: ContactSheetLayout;
  /** False when ffmpeg has no usable font — the sheet renders, but cells carry no address. */
  labelled: boolean;
  reused: boolean;
}

function contactSheetDir(videoRoot: string): string {
  return path.join(videoRoot, ".konte", "cache", "contact-sheets");
}

function pageBase(videoRoot: string, cacheKey: string, page: number): string {
  return path.join(contactSheetDir(videoRoot), `${cacheKey}-p${String(page).padStart(2, "0")}`);
}

/**
 * Drop pages left by an earlier, longer run under the same key — a scope that shrinks from three
 * sheets to one would otherwise strand the other two, which is exactly the accumulation the
 * argument-keyed path exists to avoid.
 */
export async function pruneContactSheetPages(
  videoRoot: string,
  cacheKey: string,
  keptPages: number,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(contactSheetDir(videoRoot));
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = entry.match(new RegExp(`^${cacheKey}-p(\\d+)\\.(jpg|json)$`));
    if (match && Number(match[1]) > keptPages) {
      await fs.rm(path.join(contactSheetDir(videoRoot), entry), { force: true }).catch(() => {});
    }
  }
}

/**
 * Render one labelled sheet from `cells` and return its path.
 *
 * The output path is keyed on `cacheKey` (the caller's arguments) rather than on content, and a
 * sidecar records what was rendered: an unchanged call returns the cached sheet, a changed one
 * overwrites in place. So a given invocation owns one file per page however often it is re-run —
 * a sheet spans many variants and no variant-scoped `clean` could reclaim per-content copies.
 *
 * Both files are written atomically, and the sidecar carries the digest of the image it describes.
 * Two runs sharing a key can still interleave their renames, so a cache hit is only honored when
 * the image on disk is the one the sidecar was written for.
 */
export async function renderContactSheet(opts: {
  videoRoot: string;
  cells: readonly ContactSheetCell[];
  maxCells: number;
  cacheKey: string;
  page: number;
  force?: boolean;
  /** Cells per subject, when consecutive cells group (see {@link planContactSheetLayout}). */
  groupSize?: number;
  /** Cell aspect, shared by every page of a run (see {@link sheetAspect}). */
  aspect?: number;
}): Promise<ContactSheetResult> {
  const { videoRoot, cells, maxCells, cacheKey, page, force, groupSize, aspect } = opts;
  if (cells.length === 0) {
    throw new KonteError("INVALID_OPTION", "A contact sheet needs at least one cell");
  }
  const layout = planContactSheetLayout(maxCells, cells.length, { groupSize, aspect });

  const base = pageBase(videoRoot, cacheKey, page);
  const outFile = `${base}.jpg`;
  const sidecarFile = `${base}.json`;

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ layout, cells: cells.map((c) => [c.label, c.file]) }))
    .digest("hex");
  // outputHash is konte's own content key and moves whenever the bytes do; size+mtime is the
  // fallback for a source that has none (a `file` asset whose target is edited outside konte).
  const sources = await Promise.all(
    cells.map(async (c) => {
      const st = await fs.stat(c.file).catch(() => null);
      if (!st) throw new KonteError("ASSET_NOT_FOUND", `Cell file not found on disk: ${c.file}`);
      return `${c.file}:${c.outputHash ?? ""}:${st.size}:${st.mtimeMs}`;
    }),
  );

  if (!force && existsSync(outFile) && existsSync(sidecarFile)) {
    try {
      const cached = JSON.parse(await fs.readFile(sidecarFile, "utf-8"));
      if (
        cached.fingerprint === fingerprint &&
        JSON.stringify(cached.sources) === JSON.stringify(sources) &&
        cached.outputSha ===
          createHash("sha256")
            .update(await fs.readFile(outFile))
            .digest("hex")
      ) {
        return { path: outFile, layout, labelled: cached.labelled !== false, reused: true };
      }
    } catch {
      // unreadable sidecar or image: re-render
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-sheet-"));
  try {
    const labelled = await canDrawText(layout, tmpDir);

    // Each cell is its own ffmpeg process writing its own file, so they run several at a time
    // rather than one after another — a full-timeline sheet is hundreds of them.
    await mapConcurrent(cells, FFMPEG_CONCURRENCY, async (cell, i) => {
      let labelFile: string | null = null;
      if (labelled) {
        labelFile = path.join(tmpDir, `label-${i}.txt`);
        await fs.writeFile(labelFile, cell.label, "utf-8");
      }
      await renderCell(
        cell,
        path.join(tmpDir, `cell-${String(i + 1).padStart(3, "0")}.jpg`),
        layout,
        labelFile,
      );
    });

    // `tile` consumes exactly columns*rows frames; a short last page supplies the remainder as
    // background so it renders at all, and so its cells keep the run's scale.
    await mapConcurrent(
      Array.from({ length: layout.blanks }, (_, i) => i),
      FFMPEG_CONCURRENCY,
      (i) =>
        renderBlankCell(
          path.join(tmpDir, `cell-${String(cells.length + i + 1).padStart(3, "0")}.jpg`),
          layout,
        ),
    );

    const tiled = path.join(tmpDir, "sheet.jpg");
    await runFfmpeg(
      [
        "-y",
        ...SINGLE_FRAME_INPUT_ARGS,
        "-framerate",
        "1",
        "-start_number",
        "1",
        "-i",
        path.join(tmpDir, "cell-%03d.jpg"),
        ...SINGLE_FRAME_OUTPUT_ARGS,
        "-vf",
        `tile=${layout.columns}x${layout.rows}:padding=${TILE_PADDING}:margin=${TILE_MARGIN}:color=${BACKGROUND}`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        tiled,
      ],
      "Failed to tile contact sheet",
    );

    const bytes = await fs.readFile(tiled);
    const outputSha = createHash("sha256").update(bytes).digest("hex");
    await writeFileAtomic(outFile, bytes);
    await writeFileAtomic(
      sidecarFile,
      JSON.stringify({ fingerprint, sources, labelled, outputSha }),
    );
    return { path: outFile, layout, labelled, reused: false };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
