import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { ensureFfprobe } from "../../../core/ffmpeg.js";
import { inferMediaType } from "../../../core/media-type.js";
import {
  ensureVariantThumbnails,
  readVariantThumbnails,
  variantThumbnailDir,
} from "../../../core/variant-thumbnails.js";
import { extractFrameAt, type ThumbnailInfo } from "../../../core/frame-extract.js";
import { hashFile } from "../../../core/content-hash.js";
import { encodeWithGrid } from "../../../core/image-probe.js";
import { openProbeTargets } from "./resolve-arg.js";
import {
  addFrameCaptureOptions,
  type FrameCaptureOptions,
  GRID_OPTION,
  parseFrameCaptureOptions,
  parseGrid,
  warnUnlabelledGrid,
  probeEach,
  withAbsoluteFiles,
} from "./shared.js";
import { formatSeconds } from "../../../core/format-duration.js";

function printThumbnails(thumbnails: ThumbnailInfo[]): void {
  for (const thumb of thumbnails) {
    console.log(`  ${thumb.file} (${formatSeconds(thumb.timestamp, 2)})`);
  }
}

export function registerProbeThumbnailsCommand(program: Command): void {
  addFrameCaptureOptions(
    program
      .command("thumbnails <variantOrScope...>")
      .description("Capture thumbnails from a variant video file")
      .option("--force", "Re-extract even if thumbnails already exist")
      .option(...GRID_OPTION),
  )
    .addHelpText(
      "after",
      `
Takes a variant id (v-…), an address (the take it resolves to, then every ready take awaiting a
verdict beside it), or an address-scope. A container scope (stage, shot, timeline) sweeps every
visual source under it (audio-only sources are skipped); a patch chain's steps are swept only by a patch scope (<stage>:patch…). Several of any of
those can be passed at once — they are probed in argument order, each variant once.

Examples:
  konte probe thumbnails v-iuQeCrR2                   Scene-detected frames for that variant
  konte probe thumbnails video:shot.01.motion         The take the address resolves to, and any undecided beside it
  konte probe thumbnails video                        Every visual source in the video stage
  konte probe thumbnails video:shot.01                Every visual source under shot 01
  konte probe thumbnails video:shot.01 video:shot.04  Just those two shots
  konte probe thumbnails v-iuQeCrR2 --at 1:30         Capture the frame at a specific timecode
  konte probe thumbnails v-iuQeCrR2 --at 2 --grid 5   Measure where a <Screen>'s corners go

--grid labels each line with its percent of the source.`,
    )
    .action(
      async (
        variantOrScopes: string[],
        opts: FrameCaptureOptions & { force?: boolean; grid?: string | true },
      ) => {
        const grid = parseGrid(opts.grid);
        let unlabelled = false;
        const targets = await openProbeTargets(variantOrScopes, { mediaKinds: ["video", "image"] });
        const { videoRoot, manager } = targets;

        await ensureFfprobe();

        const { threshold, maxFrames, timestamps } = parseFrameCaptureOptions(opts);
        const gridded = async (
          frames: ThumbnailInfo[],
          address: string,
          variantId: string,
          file: string,
          outputHash: string | null | undefined,
        ): Promise<ThumbnailInfo[]> => {
          if (!grid) return frames;
          const hash = outputHash ?? (await hashFile(path.resolve(videoRoot, file)));
          const dir = variantThumbnailDir(videoRoot, address, variantId, hash);
          return Promise.all(
            frames.map(async (frame) => {
              const output = path.join(
                dir,
                `${path.basename(frame.file, path.extname(frame.file))}-grid${grid}.jpg`,
              );
              if (!opts.force && existsSync(output)) return { ...frame, file: output };
              const drawn = await encodeWithGrid(frame.file, frame.file, output, grid);
              if (!drawn.labelled) unlabelled = true;
              return { ...frame, file: drawn.path };
            }),
          );
        };

        await probeEach(targets, async (variantId) => {
          const address = manager.resolveVariantAddress(variantId);
          const assetState = manager.getAssetState(address);
          const variant = assetState.variants?.[variantId];

          if (!variant) {
            throw new KonteError("VARIANT_NOT_FOUND", `Variant ${variantId} not found`);
          }
          if (!variant.file) {
            throw new KonteError("VARIANT_NOT_FOUND", `Variant ${variantId} has no file`);
          }

          // The manifest cache only covers the default scene-detected set — the canonical
          // preview consumed by `preview` and `inspect`. --at is a cherry-pick: it must not
          // read that set (so it never returns the wrong frames) nor write it (so it never
          // pollutes the canonical preview). --at caches against the files on disk instead.
          if (!timestamps && !opts.force) {
            const existingThumbnails = readVariantThumbnails(
              videoRoot,
              address,
              variantId,
              variant.outputHash,
              variant.file,
            );
            if (existingThumbnails.length > 0) {
              const absThumbnails = await gridded(
                withAbsoluteFiles(videoRoot, existingThumbnails),
                address,
                variantId,
                variant.file,
                variant.outputHash,
              );
              console.log(`${variantId}: ${existingThumbnails.length} frames captured (cached)`);
              printThumbnails(absThumbnails);
              return;
            }
          }

          let thumbnails: ThumbnailInfo[];
          let cachedCount = 0;

          if (timestamps) {
            const absFile = path.resolve(videoRoot, variant.file);
            const mediaType = inferMediaType(variant.file);

            if (mediaType === "image") {
              thumbnails = [{ file: variant.file, timestamp: 0 }];
            } else {
              if (!variant.outputHash) {
                throw new KonteError(
                  "VARIANT_NOT_FOUND",
                  `Variant ${variantId} has no output hash (source file missing)`,
                );
              }
              const thumbnailDir = variantThumbnailDir(
                videoRoot,
                address,
                variantId,
                variant.outputHash,
              );
              thumbnails = [];
              for (const ts of timestamps) {
                const filename = `at-${String(Math.round(ts * 1000)).padStart(8, "0")}ms.jpg`;
                const outputPath = path.join(thumbnailDir, filename);
                if (existsSync(outputPath) && !opts.force) {
                  cachedCount++;
                } else {
                  await extractFrameAt(absFile, ts, outputPath);
                }
                thumbnails.push({
                  file: path.relative(videoRoot, outputPath),
                  timestamp: ts,
                });
              }
            }
          } else {
            thumbnails = await ensureVariantThumbnails(
              videoRoot,
              address,
              variantId,
              variant.outputHash,
              variant.file,
              {
                threshold,
                maxFrames,
                force: opts.force,
              },
            );
          }

          const absThumbnails = await gridded(
            withAbsoluteFiles(videoRoot, thumbnails),
            address,
            variantId,
            variant.file,
            variant.outputHash,
          );
          const suffix =
            cachedCount === 0
              ? ""
              : cachedCount === thumbnails.length
                ? " (cached)"
                : ` (${cachedCount} cached)`;
          console.log(`${variantId}: ${thumbnails.length} frames captured${suffix}`);
          printThumbnails(absThumbnails);
        });
        if (unlabelled) warnUnlabelledGrid(grid!);
      },
    );
}
