import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import {
  addressToCacheSegments,
  assertValidAddressScope,
  formatCompositionAddress,
  formatShotAddress,
  isCompositionAddress,
  matchesAddressScope,
  parseAddress,
  parseReelScope,
  type ShotStage,
} from "../../../core/address.js";
import {
  type ContactSheetCell,
  DEFAULT_MAX_CELLS,
  MAX_CELLS_LIMIT,
  maxCellsForWidth,
  paginateCells,
  paginateGroupedCells,
  pruneContactSheetPages,
  renderContactSheet,
  sheetAspect,
} from "../../../core/contact-sheet.js";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "../../../core/concurrency.js";
import { KonteError } from "../../../core/errors.js";
import { ensureFfmpeg } from "../../../core/ffmpeg.js";
import { syncFileAssets } from "../../../core/file-sync.js";
import { inferMediaType } from "../../../core/media-type.js";
import { StateManager } from "../../../core/state/index.js";
import {
  captureCompositionFrames,
  COMPOSITION_FRAME_FORMAT,
  COMPOSITION_FRAME_QUALITY,
  compositionSampleTimes,
  extractFrameAt,
  panelSampleTime,
} from "../../../core/thumbnail.js";
import { probeMediaInfo } from "../../../core/video-probe.js";
import { unresolvedPictureRefs } from "../../../core/composition-resource.js";
import { buildAssetStatus, needsReviewItems } from "../../asset-status.js";
import { loadStageDefinitions, loadVideoAndAnimatic } from "../../load-definition.js";
import { parseNumberOption } from "../../parse-option.js";
import { requireVideoRoot } from "../../context.js";
import { resolveProbeTargets } from "./resolve-arg.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

// Two cells per shot: a cut is read on the outgoing frame against the next shot's incoming one.
const DEFAULT_FRAMES_PER_SHOT = 2;
// Past this a shot's own cells crowd out its neighbours, and the sheet stops being a board of the
// piece and becomes a strip of one shot.
const MAX_FRAMES_PER_SHOT = 12;

// A sweep resolves addresses in plain lexical order, which puts shot.10 before shot.2 whenever the
// author did not zero-pad. A board read out of shot order is worse than no board, so compare digit
// runs numerically. Ids that carry no number keep lexical order — pass them as separate arguments,
// which are laid out in the order written, when that is not the reading order.
function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// `<stage>` / `<stage>:shot.<id>` name shots, whose board is their compositions over time;
// everything else names variants. A variant id is checked first — `parseReelScope` would reject it
// with a message about address-scopes that has nothing to do with what was passed.
function isCompositionScope(arg: string): boolean {
  if (arg.startsWith("v-")) return false;
  try {
    parseReelScope(arg);
    return true;
  } catch {
    return false;
  }
}

// One board per kind of argument, in the order each kind first appears. Stills, the animatic's
// compositions and the video's never share a sheet: a reel groups its cells per shot, and the two
// stages' shot ids coincide.
type Board = { kind: "stills" | ShotStage; args: string[] };

function splitBoards(args: readonly string[]): Board[] {
  const boards: Board[] = [];
  for (const arg of args) {
    const kind = isCompositionScope(arg) ? parseReelScope(arg).stage : "stills";
    const board = boards.find((b) => b.kind === kind);
    if (board) board.args.push(arg);
    else boards.push({ kind, args: [arg] });
  }
  return boards;
}

/**
 * Cells for the shot compositions named by `args`, in argument order (the whole-stage scope
 * expanding in shot order): one cell per `<Panel>` on the board, `framesPerShot` evenly-spaced
 * cells per shot on the video.
 *
 * Never goes through `resolveProbeTargets` — a composition is not a variant until it is accepted,
 * so this walks the definition the way `probe reel-thumbnails` does.
 */
async function buildCompositionCells(
  args: readonly string[],
  videoRoot: string,
  opts: { framesPerShot: number; framesPerShotExplicit?: boolean; force?: boolean },
): Promise<{ cells: ContactSheetCell[]; skipped: string[]; groups: number[] }> {
  const loaded = await loadVideoAndAnimatic(videoRoot);
  const stage = parseReelScope(args[0]!).stage;
  const video = stage === "animatic" ? loaded.animatic : loaded.video;
  const manager = await StateManager.load(videoRoot);
  await applyResolutionDefinitions({ videoRoot, state: manager.getState() });

  const ordered: { id: string; named: boolean }[] = [];
  const seen = new Map<string, { id: string; named: boolean }>();
  for (const arg of args) {
    const { shotId } = parseReelScope(arg);
    if (shotId) {
      if (!video.shots.some((s) => s.id === shotId)) {
        throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found`);
      }
      // Naming a shot the sweep already picked up upgrades it to named — a dedup that dropped the
      // second argument would answer `video video:shot.02` and `video:shot.02` two different ways.
      const existing = seen.get(shotId);
      if (existing) {
        existing.named = true;
        continue;
      }
      const entry = { id: shotId, named: true };
      seen.set(shotId, entry);
      ordered.push(entry);
      continue;
    }
    for (const shot of video.shots) {
      if (seen.has(shot.id)) continue;
      const entry = { id: shot.id, named: false };
      seen.set(shot.id, entry);
      ordered.push(entry);
    }
  }

  // A shot named outright must produce cells or say why; one picked up by the stage sweep is
  // reported and stepped over, so an undeveloped shot does not fail the whole board.
  const skipped: string[] = [];
  const targets: { id: string; named: boolean }[] = [];
  for (const { id, named } of ordered) {
    const shot = video.shots.find((s) => s.id === id)!;
    if (shot.shotFn) {
      targets.push({ id, named });
    } else if (named) {
      throw new KonteError(
        "SHOT_NOT_FOUND",
        shot.aside
          ? `Shot "${id}" is an aside the board does not draw — konte fills its span with a slug, so there is no take to read here. Its picture is on the video.`
          : `Shot "${id}" has no composition to capture`,
      );
    } else {
      skipped.push(id);
    }
  }
  if (targets.length === 0) {
    throw new KonteError("SHOT_NOT_FOUND", "No shots with a composition to tile");
  }

  const cells: ContactSheetCell[] = [];
  // What each shot actually contributed. On the board that is its panel count, which varies from
  // shot to shot, so pagination packs by these rather than assuming `framesPerShot`.
  const groups: number[] = [];
  for (const { id: shotId, named } of targets) {
    const shot = video.shots.find((s) => s.id === shotId)!;
    const address = formatCompositionAddress(stage, shotId);
    const shotAddress = formatShotAddress(stage, shotId);
    // On the board the cut points are declared, so the sheet tiles the KEYFRAMES: one cell per
    // `<Panel>`, on the frame that shows it — a cutin's among the shot's own, in time order, one cell
    // where two frames cut on the same moment. An explicit --frames-per-shot overrides it.
    const keyframes = stage === "animatic" && opts.framesPerShotExplicit !== true;
    const panels = keyframes
      ? [...(shot.panels ?? []), ...(shot.cutin?.panels ?? [])].sort((a, b) => a.start - b.start)
      : [];
    if (keyframes && panels.length === 0 && shot.graphic === true) {
      const why = "a graphic shot with no keyframe — watch it in `konte preview animatic`";
      if (named) throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" is ${why}`);
      skipped.push(`${shotAddress} (${why})`);
      continue;
    }
    // A panel whose window holds no frame of the grid never reaches the screen, so it has no cell.
    const sampled: { panel: { assetName: string }; time: number }[] = [];
    for (const p of panels) {
      const time = panelSampleTime(p.start, p.duration, video.format.fps);
      if (time === null) {
        skipped.push(`${shotAddress} ${p.assetName} (holds for less than a frame)`);
        continue;
      }
      const same = sampled.find((c) => c.time === time);
      if (same) same.panel = { assetName: `${same.panel.assetName}+${p.assetName}` };
      else sampled.push({ panel: { assetName: p.assetName }, time });
    }
    // A board shot whose every keyframe fell out has nothing left to tile. `panels.length === 0`
    // is the other case: the video board, or an explicit --frames-per-shot, where the even sampler
    // IS the rule.
    if (panels.length > 0 && sampled.length === 0) continue;
    const panelCells = sampled.length > 0 ? sampled : null;
    const timestamps = panelCells
      ? panelCells.map((c) => c.time)
      : compositionSampleTimes(shot.duration, video.format.fps, opts.framesPerShot);
    // Drawn from whatever resolves, so a layer with no take leaves a hole. Say which, or the cell
    // reads as the shot composing to that.
    const blank = unresolvedPictureRefs(manager, shot);
    if (blank.length > 0) {
      skipped.push(`${shotAddress} (drawn without ${blank.join(", ")} — no take resolves)`);
    }
    let frames: Awaited<ReturnType<typeof captureCompositionFrames>>;
    try {
      frames = await captureCompositionFrames({
        video,
        manager,
        shotId,
        videoRoot,
        outputDir: path.join(
          videoRoot,
          ".konte",
          "cache",
          "thumbnails",
          ...addressToCacheSegments(address),
        ),
        captureOptions: {
          timestamps,
          format: COMPOSITION_FRAME_FORMAT,
          quality: COMPOSITION_FRAME_QUALITY,
          force: opts.force,
          pruneSuperseded: true,
        },
      });
    } catch (err) {
      // A shot the sweep picked up is reported and stepped over; a shot named outright still fails.
      // A capture that failed still fails the command once the rest of the board is tiled.
      if (
        named ||
        !(err instanceof KonteError) ||
        (err.code !== "COMPOSITION_BUILD_FAILED" && err.code !== "FRAME_CAPTURE_FAILED")
      )
        throw err;
      if (err.code === "FRAME_CAPTURE_FAILED") process.exitCode = 1;
      skipped.push(`${shotAddress} (${err.message})`);
      continue;
    }
    for (const [i, frame] of frames.entries()) {
      // The shot's address, not the composition's: `#composition` is the same on every cell of the
      // board, and at the longest labels it costs the timestamp its last character.
      //
      // The sampled moment is on the cell because the out frame is not the last one (see
      // compositionSampleTimes). On the board a cell IS a keyframe, so it carries the panel's part
      // name; elsewhere in/out mark the pair a cut is read on.
      const marker = panelCells
        ? `${panelCells[i]?.panel.assetName ?? ""} `
        : frames.length > 1
          ? i === 0
            ? "in "
            : i === frames.length - 1
              ? "out "
              : ""
          : "";
      cells.push({
        label: `${shotAddress} ${marker}@${frame.timestamp.toFixed(2)}s`,
        file: path.resolve(videoRoot, frame.file),
        aspect: video.format.size.width / video.format.size.height,
      });
    }
    groups.push(frames.length);
  }
  // Every shot in scope dropped out: the reasons say more than an empty sheet would.
  if (cells.length === 0) {
    throw new KonteError(
      "SHOT_NOT_FOUND",
      `No keyframe in scope reaches a frame of the composition:\n${skipped.map((r) => `  ${r}`).join("\n")}`,
    );
  }
  return { cells, skipped, groups };
}

// Cells per clip on the needs-review board — the composition board's in/out pair.
const DEFAULT_FRAMES_PER_TAKE = 2;
const MAX_FRAMES_PER_TAKE = 12;

/**
 * Cells for everything `konte status` reports under "Needs review" — generated and not yet judged.
 *
 * Cells flow rather than aligning per take: a needs-review set mixes stills (one cell) with clips
 * (`framesPerTake`), and no column count groups both.
 */
async function buildNeedsReviewCells(
  videoRoot: string,
  scope: string | undefined,
  opts: { framesPerTake: number; force?: boolean },
): Promise<{ cells: ContactSheetCell[]; skipped: string[] }> {
  if (scope !== undefined) assertValidAddressScope(scope);
  const { video, animatic, reference } = await loadStageDefinitions(videoRoot);
  // The same sync `status` runs before its own report: an edited `file` asset moves its content
  // hash, which stales the takes built on it. Skipping it would put a take on this sheet that
  // `status` reports as work to redo.
  const manager = await StateManager.withLock(videoRoot, async (m) => {
    await syncFileAssets({ reference, animatic, video }, m);
    return m;
  });
  const { report } = await buildAssetStatus({
    videoRoot,
    manager,
    video,
    animatic,
    reference,
  });

  const items = needsReviewItems(report).filter(
    (item) => scope === undefined || matchesAddressScope(item.address, scope),
  );
  if (items.length === 0) {
    throw new KonteError(
      "VARIANT_NOT_FOUND",
      scope === undefined
        ? "Nothing is waiting on a review — every take that has landed is accepted"
        : `Nothing under "${scope}" is waiting on a review`,
    );
  }

  const cells: ContactSheetCell[] = [];
  const skipped: string[] = [];
  let audio = 0;
  for (const item of items) {
    // The detail says why the take is outstanding (undecided beside the accept, "patched").
    const suffix = item.detail ? ` (${item.detail})` : "";

    if (!item.variantId) {
      // A materialized leaf has no variant until it is accepted, so its picture is rendered live.
      // Only a composition has one to render; a stem is audio.
      if (!isCompositionAddress(item.address)) {
        audio++;
        continue;
      }
      const parsed = parseAddress(item.address);
      // Rendered from the stage the address names. Both composition stages have this leaf and their
      // shot ids coincide, so reading the video definition drew the delivered picture in the
      // board's place — and skipped the board's shot whenever the video's was still undeveloped.
      const leafStage = parsed.stage === "animatic" ? animatic : video;
      const shot =
        parsed.kind === "shot" ? leafStage?.shots.find((s) => s.id === parsed.shotId) : undefined;
      if (!leafStage || !shot?.shotFn) {
        skipped.push(`${item.address} (no composition)`);
        continue;
      }
      const frames = await captureCompositionFrames({
        video: leafStage,
        manager,
        shotId: shot.id,
        videoRoot,
        outputDir: path.join(
          videoRoot,
          ".konte",
          "cache",
          "thumbnails",
          ...addressToCacheSegments(item.address),
        ),
        captureOptions: {
          timestamps: compositionSampleTimes(
            shot.duration,
            leafStage.format.fps,
            opts.framesPerTake,
          ),
          format: COMPOSITION_FRAME_FORMAT,
          quality: COMPOSITION_FRAME_QUALITY,
          force: opts.force,
          pruneSuperseded: true,
        },
      });
      for (const frame of frames) {
        cells.push({
          label: `${formatShotAddress(leafStage.stage, shot.id)}#composition @${frame.timestamp.toFixed(2)}s${suffix}`,
          file: path.resolve(videoRoot, frame.file),
          aspect: leafStage.format.size.width / leafStage.format.size.height,
        });
      }
      continue;
    }

    const variant = manager.getAssetState(item.address).variants?.[item.variantId];
    if (!variant?.file) {
      skipped.push(`${item.address} (${item.variantId} has no file)`);
      continue;
    }
    const absFile = path.resolve(videoRoot, variant.file);
    const mediaType = inferMediaType(variant.file);
    const label = `${item.address} ${item.variantId}${suffix}`;

    if (mediaType === "image") {
      cells.push({
        label,
        variantId: item.variantId,
        file: absFile,
        outputHash: variant.outputHash,
        aspect:
          variant.media?.kind === "image" ? variant.media.width / variant.media.height : undefined,
      });
      continue;
    }
    if (mediaType === "audio") {
      audio++;
      continue;
    }
    if (mediaType !== "video") {
      skipped.push(`${item.address} (unknown media — nothing to tile)`);
      continue;
    }

    // The clip's own measurements — the stage's format need not match the file.
    const media =
      variant.media?.kind === "video"
        ? variant.media
        : await probeMediaInfo(absFile).catch(() => null);
    if (media?.kind !== "video") {
      skipped.push(`${item.address} (${item.variantId} could not be measured)`);
      continue;
    }
    const timestamps = compositionSampleTimes(media.durationSec, media.fps, opts.framesPerTake);
    // Keyed by the variant's own content hash, so a re-take never reads a previous one's frames.
    const frameDir = path.join(
      videoRoot,
      ".konte",
      "cache",
      "contact-sheets",
      "takes",
      item.variantId,
      variant.outputHash ?? "live",
    );
    for (const ts of timestamps) {
      const framePath = path.join(
        frameDir,
        `at-${String(Math.round(ts * 1000)).padStart(8, "0")}ms.jpg`,
      );
      // A hashless variant has nothing to key a cache hit on — its bytes can move under the same
      // path — so re-extract rather than trust what is there.
      if (opts.force || !variant.outputHash || !existsSync(framePath)) {
        await extractFrameAt(absFile, ts, framePath);
      }
      cells.push({
        label: `${label} @${ts.toFixed(2)}s`,
        variantId: item.variantId,
        file: framePath,
        outputHash: variant.outputHash,
        aspect: media.width / media.height,
      });
    }
  }

  if (cells.length === 0) {
    throw new KonteError(
      "VARIANT_NOT_FOUND",
      skipped.length === 0 && audio > 0
        ? "Everything waiting on a review is audio — review it in `konte preview`"
        : `Nothing waiting on a review has a still to tile (${skipped.length} skipped)`,
    );
  }
  return { cells, skipped };
}

async function buildStillCells(
  args: readonly string[],
  videoRoot: string,
): Promise<ContactSheetCell[]> {
  const manager = await StateManager.load(videoRoot);
  await applyResolutionDefinitions({ videoRoot, state: manager.getState() });

  const toCell = (variantId: string): ContactSheetCell => {
    const address = manager.resolveVariantAddress(variantId);
    const variant = manager.getAssetState(address).variants?.[variantId];
    if (!variant?.file) {
      throw new KonteError("VARIANT_NOT_FOUND", `Variant ${variantId} has no file`);
    }
    // A scope drops non-images on the way in, but a named variant id or address skips that
    // filter — so catch it here rather than handing ffmpeg a clip and tiling its first frame.
    if (inferMediaType(variant.file) !== "image") {
      throw new KonteError(
        "INVALID_ASSET_TYPE",
        `${address} (${variantId}) is not a still image — a contact sheet tiles stills`,
      );
    }
    return {
      label: address,
      variantId,
      file: path.resolve(videoRoot, variant.file),
      outputHash: variant.outputHash,
      aspect:
        variant.media?.kind === "image" ? variant.media.width / variant.media.height : undefined,
    };
  };

  // Resolve one argument at a time and sort within it: a scope's own sweep needs the shot
  // order, but the order the arguments were written in is the caller's, and it is the only
  // way to lay out ids that carry no number. Sorting the whole set would discard it.
  const cells: ContactSheetCell[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    const { variantIds } = resolveProbeTargets(manager, [arg], { mediaKinds: ["image"] });
    const group = variantIds.filter((id) => !seen.has(id));
    for (const id of group) seen.add(id);
    cells.push(...group.map(toCell).sort((a, b) => compareNatural(a.label, b.label)));
  }

  // Two variants of one address (comparing rerolls) would otherwise carry the same label and
  // be unattributable in the image.
  const labelCounts = new Map<string, number>();
  for (const cell of cells) labelCounts.set(cell.label, (labelCounts.get(cell.label) ?? 0) + 1);
  for (const cell of cells) {
    if ((labelCounts.get(cell.label) ?? 0) > 1) cell.label = `${cell.label} ${cell.variantId}`;
  }
  return cells;
}

interface RenderedSheets {
  results: Awaited<ReturnType<typeof renderContactSheet>>[];
  pages: ContactSheetCell[][];
}

interface SheetPlan {
  pages: ContactSheetCell[][];
  cacheKey: string;
  perSheet: number;
  groupSize: number;
  aspect: number;
  note: string | null;
}

/**
 * Lays out one board without writing anything, so every board of a call is validated before any
 * sheet is rendered. `groups` is the cells each shot contributed on a reel board, null where cells
 * flow.
 */
async function planSheets(
  cells: ContactSheetCell[],
  opts: {
    args: readonly string[];
    groups: number[] | null;
    framesPerTake: number | null;
    maxCells: number;
    cellWidth?: number;
  },
): Promise<SheetPlan> {
  const { groups } = opts;
  // A still landed before its media was recorded carries no dimensions.
  await mapConcurrent(
    cells.filter((cell) => cell.aspect === undefined),
    FFMPEG_CONCURRENCY,
    async (cell) => {
      const media = await probeMediaInfo(cell.file).catch(() => null);
      if (media && media.kind !== "audio") cell.aspect = media.width / media.height;
    },
  );
  const aspect = sheetAspect(cells);
  // Rows group a subject's cells only while every subject contributes the same number — the
  // video board's in/out pair does, the animatic's keyframe count need not. Mixed, the cells
  // flow and the layout groups nothing.
  const groupSize = groups && new Set(groups).size === 1 ? groups[0]! : 1;
  let maxCells = opts.maxCells;
  if (opts.cellWidth !== undefined) {
    const fit = maxCellsForWidth(opts.cellWidth, { aspect, groupSize });
    if (fit.maxCells === null) {
      throw new KonteError(
        "INVALID_OPTION",
        `--cell-width ${opts.cellWidth} is wider than a sheet holds at this aspect — at most ${fit.widest}`,
      );
    }
    maxCells = fit.maxCells;
  }

  // One key per distinct invocation, so re-running a scope overwrites its sheets instead of
  // accumulating a copy per render.
  const cacheKey = createHash("sha256")
    .update(JSON.stringify([opts.args, maxCells, groups, opts.framesPerTake]))
    .digest("hex")
    .slice(0, 12);

  // Pages are packed by whole shots, so a shot's cells never split across sheets.
  const pages = groups
    ? paginateGroupedCells(cells, groups, maxCells)
    : paginateCells(cells, Math.min(maxCells, cells.length) || 1);
  // Pages share a scale so a run reads as one board, but a run that fits on one page has no
  // sibling to match — sizing it for the cap would hold space open for cells that do not
  // exist. Cap by what is actually there.
  const perSheet = Math.max(1, ...pages.map((p) => p.length));
  const widest = Math.max(0, ...(groups ?? []));
  const note =
    widest > MAX_CELLS_LIMIT
      ? `Note: one shot contributes ${widest} cells, past the ${MAX_CELLS_LIMIT} a sheet can ` +
        `lay out — that shot is split across sheets.`
      : perSheet > maxCells
        ? `Note: one shot contributes ${perSheet} cells, over the ${maxCells} a sheet holds — its ` +
          `sheet holds them all rather than cutting the shot in half, at smaller cells.`
        : null;
  return { pages, cacheKey, perSheet, groupSize, aspect, note };
}

async function renderSheets(
  videoRoot: string,
  plan: SheetPlan,
  force: boolean | undefined,
): Promise<RenderedSheets> {
  const results = [];
  for (const [i, page] of plan.pages.entries()) {
    results.push(
      await renderContactSheet({
        videoRoot,
        cells: page,
        maxCells: plan.perSheet,
        cacheKey: plan.cacheKey,
        page: i + 1,
        force,
        groupSize: plan.groupSize,
        aspect: plan.aspect,
      }),
    );
  }
  await pruneContactSheetPages(videoRoot, plan.cacheKey, plan.pages.length);
  return { results, pages: plan.pages };
}

// The sheet is the judgment: paths alone on stdout, so the caller can pipe or Read them.
// Everything else is context for a human and belongs on stderr.
function reportSheets(
  { results }: RenderedSheets,
  cellCount: number,
  opts: { prefix: string; cellWidth?: number; skipped: string | null },
): void {
  for (const result of results) console.log(result.path);
  const { layout } = results[0]!;
  console.error(
    `${opts.prefix}${cellCount} cells, ${results.length} sheet(s), ${layout.cellWidth}x${layout.cellHeight} per cell` +
      (opts.cellWidth === undefined ? " (--cell-width <px> for larger cells)" : ""),
  );
  const reused = results.filter((r) => r.reused).length;
  if (reused > 0) {
    console.error(
      `${opts.prefix}${reused} of ${results.length} sheet(s) unchanged since the last run ` +
        `(each address shows its accepted take, else its newest ready one)`,
    );
  }
  if (opts.skipped) console.error(`${opts.prefix}${opts.skipped}`);
  if (!results.every((r) => r.labelled)) {
    console.error(`${opts.prefix}warning: ffmpeg has no usable font — cells are unlabelled`);
  }
}

export function registerProbeContactSheetCommand(program: Command): void {
  program
    .command("contact-sheet [variantOrScope...]")
    .description("Tile stills, or a shot's composition over time, into one labelled sheet")
    .option("--needs-review", "Tile everything awaiting a review instead, whatever stage it is in")
    .option("--max-cells <n>", `Cells per sheet (default ${DEFAULT_MAX_CELLS})`)
    .option("--cell-width <px>", "Make every cell at least this wide, fitting fewer per sheet")
    .option(
      "--frames-per-shot <n>",
      `Cells per shot on a video scope (default ${DEFAULT_FRAMES_PER_SHOT})`,
    )
    .option(
      "--frames-per-take <n>",
      `Cells per clip with --needs-review (default ${DEFAULT_FRAMES_PER_TAKE})`,
    )
    .option("--force", "Re-render even if a matching sheet is cached")
    .addHelpText(
      "after",
      `
Tiles frames into one sheet and prints its path — Read it to judge the shots against each other:
character consistency, screen direction, palette drift.

Takes one or more (in any mix) of a variant id (v-…), an address (resolved to its canonical variant,
like konte ref), or an address-scope that sweeps every still under it. Stills only: a scope skips
non-image variants, and a named variant id or address that is not one is rejected. A patch chain's
steps are swept only by a patch scope (<stage>:patch…).

A reel scope (animatic, video, <stage>:shot.<id>) instead tiles the shots' COMPOSITIONS — rendered
live from the definition, accepted at <address>#composition. On the ANIMATIC each shot contributes
one cell per <Panel>, taken just inside its window, so every keyframe is on the sheet. On the VIDEO
each shot contributes ${DEFAULT_FRAMES_PER_SHOT} cells, its in and out frames, so a cut can be read
across the boundary; --frames-per-shot (1..${MAX_FRAMES_PER_SHOT}) samples more, evenly spaced, on
either stage. The out frame sits a few frames short of the shot's end, where a generative model has
usually degraded — so every cell carries the moment it was taken at, and a tail artifact is judged on
the clip itself (probe motion), not here. Shots with no composition are skipped with a note; named
outright, they error. A shot whose media fails to load is skipped the same way and exits 1. Stills, animatic reel scopes and video reel scopes passed together each tile
on their own sheets, printed in the order each kind first appears.

--needs-review tiles what \`konte status\` reports under "Needs review" — every take that has landed
and nobody has judged, across all three stages, plus a fresh take beside an accepted one and a
patch awaiting a verdict. Takes no argument, or one address-scope to narrow it. Each cell carries
its VARIANT ID and why it is outstanding. A clip contributes ${DEFAULT_FRAMES_PER_TAKE} cells
(--frames-per-take, 1..${MAX_FRAMES_PER_TAKE}) and a still one, so cells flow rather than aligning
per take. Audio takes and stems are left off — review those in \`konte preview\`.

Cells carry their address (plus the variant id where one address contributes several). Each argument
is laid out in the order written, and sorted within itself by address, digit runs compared
numerically (so unpadded shot.2 precedes shot.10) — pass separate arguments to order ids that carry
no number. A video scope keeps shot order and is not re-sorted.

Cells take the aspect most of the pictures share (a 4:1 board gets 4:1 cells), and a sheet stays
inside what a vision model reads without downscaling. Sheets hold ${DEFAULT_MAX_CELLS} cells (402x226
each at 16:9, 600x150 at 4:1). A longer run paginates, printing one path per sheet. Where the detail
you are judging does not read (a hand, a small prop), pass --cell-width <px>: each sheet then holds
only as many cells as fit at that width. --max-cells (1..${MAX_CELLS_LIMIT}) sets the count instead.
On a video scope both the grid and the pagination round to whole shots, so a shot's cells never
straddle a row or a sheet.

Examples:
  konte probe contact-sheet --needs-review             Every take waiting on a verdict, any stage
  konte probe contact-sheet --needs-review video       ... narrowed to the video stage
  konte probe contact-sheet animatic                 The whole board, paginated
  konte probe contact-sheet animatic:shot.01         One shot's panels
  konte probe contact-sheet animatic:timeline        Every timeline-level still (setup plates)
  konte probe contact-sheet reference                  Every shared reference still
  konte probe contact-sheet video                      Every shot's composition, in and out
  konte probe contact-sheet video:shot.02              One shot's composition, in and out
  konte probe contact-sheet video --frames-per-shot 3  Add a mid frame to each shot
  konte probe contact-sheet animatic --max-cells 30  One sheet, smaller cells
  konte probe contact-sheet animatic:shot.04 animatic:shot.09 --cell-width 1200
                                                       Two shots' panels, large enough for a hand
  konte probe contact-sheet animatic:plate.front animatic:shot.05
                                                       A plate's sheet, then the shot's panels`,
    )
    .action(
      async (
        variantOrScopes: string[],
        opts: {
          needsReview?: boolean;
          maxCells?: string;
          cellWidth?: string;
          framesPerShot?: string;
          framesPerTake?: string;
          force?: boolean;
        },
      ) => {
        const videoRoot = requireVideoRoot();

        if (!opts.needsReview && variantOrScopes.length === 0) {
          throw new KonteError(
            "INVALID_OPTION",
            "Pass a variant id, address or address-scope to tile, or --needs-review to tile " +
              "everything awaiting a verdict",
          );
        }
        if (opts.needsReview && variantOrScopes.length > 1) {
          throw new KonteError(
            "INVALID_OPTION",
            "--needs-review takes at most one address-scope to narrow it",
          );
        }

        const boards = opts.needsReview ? [] : splitBoards(variantOrScopes);
        const composition = boards.some((board) => board.kind !== "stills");

        if (opts.maxCells !== undefined && opts.cellWidth !== undefined) {
          throw new KonteError(
            "INVALID_OPTION",
            "--max-cells and --cell-width both set how many cells a sheet holds — pass one",
          );
        }
        const maxCells =
          parseNumberOption("--max-cells", opts.maxCells, {
            integer: true,
            min: 1,
            max: MAX_CELLS_LIMIT,
          }) ?? DEFAULT_MAX_CELLS;
        const cellWidth = parseNumberOption("--cell-width", opts.cellWidth, {
          integer: true,
          min: 2,
        });
        const framesPerShot =
          parseNumberOption("--frames-per-shot", opts.framesPerShot, {
            integer: true,
            min: 1,
            max: MAX_FRAMES_PER_SHOT,
          }) ?? DEFAULT_FRAMES_PER_SHOT;
        const framesPerTake =
          parseNumberOption("--frames-per-take", opts.framesPerTake, {
            integer: true,
            min: 1,
            max: MAX_FRAMES_PER_TAKE,
          }) ?? DEFAULT_FRAMES_PER_TAKE;
        if (!composition && opts.framesPerShot !== undefined) {
          throw new KonteError(
            "INVALID_OPTION",
            "--frames-per-shot applies to a reel scope (animatic, video, <stage>:shot.<id>) only",
          );
        }
        if (!opts.needsReview && opts.framesPerTake !== undefined) {
          throw new KonteError(
            "INVALID_OPTION",
            "--frames-per-take applies to --needs-review only",
          );
        }
        // Only the explicit options can be checked up front; the board's panel count is not known
        // until the cells are built, and is reported (not refused) where it overruns.
        if (
          composition &&
          opts.framesPerShot !== undefined &&
          cellWidth === undefined &&
          framesPerShot > maxCells
        ) {
          throw new KonteError(
            "INVALID_OPTION",
            `--max-cells (${maxCells}) must hold at least one shot's --frames-per-shot (${framesPerShot})`,
          );
        }

        await ensureFfmpeg();

        if (opts.needsReview) {
          const { cells, skipped } = await buildNeedsReviewCells(videoRoot, variantOrScopes[0], {
            framesPerTake,
            force: opts.force,
          });
          const plan = await planSheets(cells, {
            args: variantOrScopes,
            groups: null,
            framesPerTake,
            maxCells,
            cellWidth,
          });
          const sheets = await renderSheets(videoRoot, plan, opts.force);
          reportSheets(sheets, cells.length, {
            prefix: "",
            cellWidth,
            skipped: skipped.length > 0 ? `skipped: ${skipped.join(", ")}` : null,
          });
          return;
        }

        // Every board is built and laid out before any is rendered, so a bad argument or option
        // fails the call before a sheet is written.
        const built = [];
        for (const board of boards) {
          if (board.kind === "stills") {
            built.push({
              board,
              cells: await buildStillCells(board.args, videoRoot),
              skipped: [],
              groups: null,
            });
            continue;
          }
          const { cells, skipped, groups } = await buildCompositionCells(board.args, videoRoot, {
            framesPerShotExplicit: opts.framesPerShot !== undefined,
            framesPerShot,
            force: opts.force,
          });
          built.push({ board, cells, skipped, groups });
        }
        const prefixed = built.length > 1;
        const planned = [];
        for (const entry of built) {
          const plan = await planSheets(entry.cells, {
            args: entry.board.args,
            groups: entry.groups,
            framesPerTake: null,
            maxCells,
            cellWidth,
          });
          planned.push({ ...entry, plan, prefix: prefixed ? `${entry.board.kind}: ` : "" });
        }
        const rendered = [];
        for (const entry of planned) {
          if (entry.plan.note) console.error(`${entry.prefix}${entry.plan.note}`);
          rendered.push({
            ...entry,
            sheets: await renderSheets(videoRoot, entry.plan, opts.force),
          });
        }

        for (const { cells, skipped, sheets, prefix } of rendered) {
          reportSheets(sheets, cells.length, {
            prefix,
            cellWidth,
            skipped: skipped.length > 0 ? `skipped: ${skipped.join(", ")}` : null,
          });
        }
      },
    );
}
