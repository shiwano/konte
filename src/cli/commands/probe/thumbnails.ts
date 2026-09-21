import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { ffprobeBin } from "../../../core/ffmpeg-binary.js";
import { inferMediaType } from "../../../core/media-type.js";
import {
  ensureVariantThumbnails,
  extractFrameAt,
  readVariantThumbnails,
  type ThumbnailInfo,
  variantThumbnailDir,
} from "../../../core/thumbnail.js";
import { openProbeTargets } from "./resolve-arg.js";
import {
  addFrameCaptureOptions,
  type FrameCaptureOptions,
  parseFrameCaptureOptions,
  probeEach,
  withAbsoluteFiles,
} from "./shared.js";

function printThumbnails(thumbnails: ThumbnailInfo[]): void {
  for (const thumb of thumbnails) {
    console.log(`  ${thumb.file} (${thumb.timestamp.toFixed(2)}s)`);
  }
}

export function registerProbeThumbnailsCommand(program: Command): void {
  addFrameCaptureOptions(
    program
      .command("thumbnails <variantOrScope...>")
      .description("Capture thumbnails from a variant video file")
      .option("--force", "Re-extract even if thumbnails already exist"),
  )
    .addHelpText(
      "after",
      `
Takes a variant id (v-…), an address (resolved to its canonical variant, like konte ref), or an
address-scope. A container scope (stage, shot, timeline) sweeps every visual source under it
(audio-only sources are skipped), so one command replaces looping over each address; a patch chain's
steps are swept only by a patch scope (<stage>:patch…). Several of any of those can be passed at
once — they are probed in argument order, each variant once.

Examples:
  konte probe thumbnails v-iuQeCrR2                   Scene-detected frames for that variant
  konte probe thumbnails video:shot.01.motion         Resolve the address to its canonical variant, then probe
  konte probe thumbnails video                        Every visual source in the video stage
  konte probe thumbnails video:shot.01                Every visual source under shot 01
  konte probe thumbnails video:shot.01 video:shot.04  Just those two shots
  konte probe thumbnails v-iuQeCrR2 --at 1:30         Capture the frame at a specific timecode`,
    )
    .action(async (variantOrScopes: string[], opts: FrameCaptureOptions & { force?: boolean }) => {
      const targets = await openProbeTargets(variantOrScopes, { mediaKinds: ["video", "image"] });
      const { videoRoot, manager } = targets;

      await ffprobeBin();

      const { threshold, maxFrames, timestamps } = parseFrameCaptureOptions(opts);

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
            const absThumbnails = withAbsoluteFiles(videoRoot, existingThumbnails);
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

        const absThumbnails = withAbsoluteFiles(videoRoot, thumbnails);
        const suffix =
          cachedCount === 0
            ? ""
            : cachedCount === thumbnails.length
              ? " (cached)"
              : ` (${cachedCount} cached)`;
        console.log(`${variantId}: ${thumbnails.length} frames captured${suffix}`);
        printThumbnails(absThumbnails);
      });
    });
}
