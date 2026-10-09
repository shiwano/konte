import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { getAssetEntry } from "../../../core/address.js";
import {
  type ContactSheetCell,
  DEFAULT_MAX_CELLS,
  pruneContactSheetPages,
  renderContactSheet,
} from "../../../core/contact-sheet.js";
import { definitionForAddress } from "../../../core/definition-hashes.js";
import { KonteError, errorMessage } from "../../../core/errors.js";
import { ensureFfmpeg } from "../../../core/ffmpeg.js";
import {
  ffmpegBin,
  SINGLE_FRAME_INPUT_ARGS,
  SINGLE_FRAME_OUTPUT_ARGS,
} from "../../../core/ffmpeg-binary.js";
import { cropWindowOf } from "../../../core/graph.js";
import { inferMediaType } from "../../../core/media-type.js";
import type { StateManager } from "../../../core/state/index.js";
import { probeMediaInfo } from "../../../core/video-probe.js";
import { openProbeTargets } from "./resolve-arg.js";
import { execFileAsync } from "../../../core/exec-file.js";

const BOX_COLORS = ["red", "lime", "cyan", "yellow", "magenta", "orange", "white", "dodgerblue"];

interface Window {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  percent?: string;
}

interface Rect {
  label: string;
  given: string;
  parts: { value: number; percent: boolean }[];
}

function collectRect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseRect(value: string, index: number): Rect {
  const parts = value
    .trim()
    .split(",")
    .map((part) => part.trim().match(/^(\d+(?:\.\d+)?)(%?)$/));
  if (parts.length !== 4 || parts.some((m) => !m || (!m[2] && m[1]!.includes(".")))) {
    throw new KonteError(
      "INVALID_OPTION",
      `--rect takes x,y,width,height in source pixels or percent (4%,23.6%,92%,9%), got "${value}"`,
    );
  }
  return {
    label: String(index + 1),
    given: value.trim(),
    parts: parts.map((m) => ({ value: Number(m![1]), percent: m![2] === "%" })),
  };
}

export function resolveRect(rect: Rect, size: { width: number; height: number }): Window {
  const [x, y, width, height] = rect.parts.map(({ value, percent }, i) =>
    percent ? Math.round(((i % 2 === 0 ? size.width : size.height) * value) / 100) : value,
  ) as [number, number, number, number];
  if (width < 1 || height < 1) {
    throw new KonteError("INVALID_OPTION", `--rect "${rect.given}" has no area`);
  }
  const percent = rect.parts.some((p) => p.percent) ? rect.given : undefined;
  return { label: rect.label, x, y, width, height, ...(percent && { percent }) };
}

async function imageSize(
  manager: StateManager,
  variantId: string,
  address: string,
  file: string,
): Promise<{ width: number; height: number }> {
  const media = manager.getAssetState(address).variants?.[variantId]?.media;
  if (media?.kind === "image") return media;
  const probed = await probeMediaInfo(file).catch(() => null);
  if (probed?.kind !== "image") {
    throw new KonteError("FFMPEG_ERROR", `Could not measure ${address} (${variantId})`);
  }
  return probed;
}

async function runFfmpeg(args: string[], what: string): Promise<void> {
  try {
    await execFileAsync(await ffmpegBin(), args);
  } catch (err) {
    throw new KonteError("FFMPEG_ERROR", `${what}: ${errorMessage(err)}`);
  }
}

function describeWindow(w: Window): string {
  const px = `x=${w.x} y=${w.y} ${w.width}x${w.height}`;
  return w.percent ? `${px} (${w.percent})` : px;
}

export function registerProbeCropCommand(program: Command): void {
  program
    .command("crop <image>")
    .description("Try crop windows on an image before writing them into an imageCrop")
    .option(
      "--rect <x,y,w,h>",
      "A window to try, in source pixels or percent (repeatable)",
      collectRect,
      [],
    )
    .option("--force", "Re-render even if the crops are cached")
    .addHelpText(
      "after",
      `
Renders two sheets and prints their paths — Read both. The first is the source with every window
outlined in its own color; the second is each window as imageCrop would render it, scaled to the
output size, its cell naming its color and geometry. Writes nothing to the definition or state.

<image> is a variant id (v-…) or an address, resolved like konte ref. When it is an imageCrop asset
(a plate cut from a master), its master is the source, its own window is shown as "current", and
every --rect is on the master and rendered at that asset's output size. Otherwise the image
itself is the source and each window is rendered at the animatic's canvas (the video's, with no
animatic). A window whose aspect differs from the output's is reported: imageCrop stretches it.

Each --rect value is source pixels or, with %, a percent of the source's width (x, width) or height
(y, height).

Examples:
  konte probe crop animatic:plate.deskMedium --rect 0,480,1760,440
                                                   The current window beside a lower one
  konte probe crop reference:studio --rect 3160,430,640,160 --rect 2800,300,1280,320
                                                   Two candidate windows on the master`,
    )
    .action(async (image: string, opts: { rect: string[]; force?: boolean }) => {
      const rects = opts.rect.map(parseRect);
      const { videoRoot, manager, definitions, variantIds, multi } = await openProbeTargets(
        [image],
        { mediaKinds: ["image"], definitions: true },
      );
      if (multi) {
        throw new KonteError(
          "INVALID_OPTION",
          `"${image}" is a scope — probe crop takes one image, a variant id or an address`,
        );
      }
      const variantId = variantIds[0]!;
      const address = manager.resolveVariantAddress(variantId);
      const variant = manager.getAssetState(address).variants?.[variantId];
      if (!variant?.file || inferMediaType(variant.file) !== "image") {
        throw new KonteError(
          "INVALID_ASSET_TYPE",
          `${address} (${variantId}) is not a still image — probe crop cuts stills`,
        );
      }

      let own: ReturnType<typeof cropWindowOf> = null;
      const definition = definitions && definitionForAddress(definitions, address);
      if (definition) {
        try {
          const entry = getAssetEntry(definition, address);
          if (entry.kind === "local" && entry.operation === "crop")
            own = cropWindowOf(entry.inputs);
        } catch {
          // An address no loaded stage declares has no window of its own.
        }
      }

      let source: { address: string; variantId: string; file: string };
      let output: { width: number; height: number } | null;
      const windows: Window[] = [];
      if (own) {
        const master = manager.resolveReference(own.image, { includeStale: true });
        if (!master) {
          throw new KonteError(
            "VARIANT_NOT_FOUND",
            `${address} cuts ${own.image}, which has no ready take to crop`,
          );
        }
        source = { address: own.image, variantId: master.variantId, file: master.file };
        output = { width: own.outWidth, height: own.outHeight };
        windows.push({ ...own, label: "current" });
      } else {
        if (rects.length === 0) {
          throw new KonteError(
            "INVALID_OPTION",
            `${address} is not an imageCrop, so it has no window of its own — pass --rect x,y,width,height`,
          );
        }
        source = { address, variantId, file: variant.file };
        output = definitions?.animatic?.format.size ?? definitions?.video?.format.size ?? null;
      }
      const sourceFile = path.resolve(videoRoot, source.file);
      const size = await imageSize(manager, source.variantId, source.address, sourceFile);
      windows.push(...rects.map((rect) => resolveRect(rect, size)));
      if (windows.length > DEFAULT_MAX_CELLS) {
        throw new KonteError(
          "INVALID_OPTION",
          `Try at most ${DEFAULT_MAX_CELLS} windows at once, got ${windows.length}`,
        );
      }

      const outside = windows.filter(
        (w) => w.x + w.width > size.width || w.y + w.height > size.height,
      );
      if (outside.length > 0) {
        throw new KonteError(
          "INVALID_OPTION",
          `${source.address} is ${size.width}x${size.height}; outside it: ` +
            outside.map((w) => `${w.label} (${describeWindow(w)})`).join(", "),
        );
      }

      await ensureFfmpeg();

      const sourceHash = manager.getAssetState(source.address).variants?.[source.variantId]
        ?.outputHash;
      const digest = (value: unknown): string =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
      // One directory and one pair of sheets per image argument.
      const key = digest(address);
      const cropDir = path.join(videoRoot, ".konte", "cache", "crops", key);
      await fs.mkdir(cropDir, { recursive: true });
      const sourceKey = [source.variantId, sourceHash ?? null];
      // A hashless source can change under the same path, so its crops are never trusted.
      const reuse = !opts.force && Boolean(sourceHash);

      const thickness = Math.max(2, Math.round(Math.max(size.width, size.height) / 400));
      const colored = windows.map((w, i) => ({ ...w, color: BOX_COLORS[i % BOX_COLORS.length]! }));
      const overviewFile = path.join(
        cropDir,
        `overview-${digest([sourceKey, colored, thickness])}.png`,
      );
      if (!reuse || !existsSync(overviewFile)) {
        const boxes = colored
          .map(
            (w) =>
              `drawbox=x=${w.x}:y=${w.y}:w=${w.width}:h=${w.height}:color=${w.color}:t=${thickness}`,
          )
          .join(",");
        await runFfmpeg(
          [
            "-y",
            ...SINGLE_FRAME_INPUT_ARGS,
            "-i",
            sourceFile,
            ...SINGLE_FRAME_OUTPUT_ARGS,
            "-vf",
            boxes,
            "-frames:v",
            "1",
            overviewFile,
          ],
          `Failed to outline the windows on ${source.address}`,
        );
      }

      const crops = await Promise.all(
        colored.map(async (w) => {
          const out = output ?? { width: w.width, height: w.height };
          const file = path.join(
            cropDir,
            `window-${digest([sourceKey, w.x, w.y, w.width, w.height, out])}.png`,
          );
          if (!reuse || !existsSync(file)) {
            // The filtergraph imageCrop runs.
            await runFfmpeg(
              [
                "-y",
                ...SINGLE_FRAME_INPUT_ARGS,
                "-i",
                sourceFile,
                ...SINGLE_FRAME_OUTPUT_ARGS,
                "-vf",
                `crop=${w.width}:${w.height}:${w.x}:${w.y},scale=${out.width}:${out.height}`,
                "-frames:v",
                "1",
                file,
              ],
              `Failed to crop window ${w.label}`,
            );
          }
          return { ...w, output: out, file };
        }),
      );

      const kept = new Set(
        [overviewFile, ...crops.map((c) => c.file)].map((f) => path.basename(f)),
      );
      for (const entry of await fs.readdir(cropDir)) {
        if (!kept.has(entry)) await fs.rm(path.join(cropDir, entry), { force: true });
      }

      const sheetKey = `crop-${key}`;
      const overviewCell: ContactSheetCell = {
        label: `${source.address} ${size.width}x${size.height}`,
        file: overviewFile,
        aspect: size.width / size.height,
      };
      const windowCells: ContactSheetCell[] = crops.map((c) => ({
        label: `${c.label} (${c.color}) ${describeWindow(c)}`,
        file: c.file,
        aspect: c.output.width / c.output.height,
      }));
      const overviewSheet = await renderContactSheet({
        videoRoot,
        cells: [overviewCell],
        maxCells: 1,
        cacheKey: sheetKey,
        page: 1,
        force: opts.force,
        aspect: overviewCell.aspect,
      });
      const windowSheet = await renderContactSheet({
        videoRoot,
        cells: windowCells,
        maxCells: windowCells.length,
        cacheKey: sheetKey,
        page: 2,
        force: opts.force,
        aspect: windowCells[0]!.aspect,
      });
      await pruneContactSheetPages(videoRoot, sheetKey, 2);

      const stretched = crops.filter(
        (c) => Math.abs(c.width / c.height / (c.output.width / c.output.height) - 1) > 0.01,
      );

      console.log(overviewSheet.path);
      console.log(windowSheet.path);
      for (const c of crops) {
        console.error(
          `${c.label} (${c.color}): ${describeWindow(c)} -> ${c.output.width}x${c.output.height}`,
        );
      }
      for (const c of stretched) {
        console.error(
          `warning: window ${c.label} is ${(c.width / c.height).toFixed(2)}:1 and its output ` +
            `${(c.output.width / c.output.height).toFixed(2)}:1 — imageCrop stretches it to fit`,
        );
      }
      if (!overviewSheet.labelled || !windowSheet.labelled) {
        console.error("warning: ffmpeg has no usable font — cells are unlabelled");
      }
      if (own) {
        console.error(
          `To take a window, set x/y/width/height on ${address}'s imageCrop to its values.`,
        );
      }
    });
}
