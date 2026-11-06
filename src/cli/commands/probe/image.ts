import type { Command } from "commander";
import { FFMPEG_CONCURRENCY, mapConcurrent } from "../../../core/concurrency.js";
import { KonteError } from "../../../core/errors.js";
import { probeImage } from "../../../core/image-probe.js";
import { inferMediaType } from "../../../core/media-type.js";
import { openProbeTargets } from "./resolve-arg.js";
import { GRID_OPTION, parseGrid, warnUnlabelledGrid } from "./shared.js";

export function registerProbeImageCommand(program: Command): void {
  program
    .command("image <variantOrScope...>")
    .description("Create compact still images for visual inspection")
    .option(...GRID_OPTION)
    .option("--force", "Rebuild cached inspection images")
    .addHelpText(
      "after",
      `
Takes variant ids, addresses or address-scopes. An address gives the take it resolves to, then every
ready take awaiting a verdict beside it; scopes keep only still images. Prints one absolute JPEG path
per variant, in argument order, each variant once; with several, each path follows its address and
variant id on stderr.
Images fit within 1280px on the longest edge and 512 KiB, with transparency over light gray.
Cached by source content; originals and acceptance state are unchanged. Use probe crop for detail.
--grid labels each line with its percent of the source.

Examples:
  konte probe image reference:mother   Inspect the resolved character image
  konte probe image reference         Inspect every ready reference image
  konte probe image v-iuQeCrR2         Inspect a specific take
  konte probe image reference:appHome --grid 5
                                       Measure where a box over a screenshot goes`,
    )
    .action(async (args: string[], opts: { grid?: string | true; force?: boolean }) => {
      const grid = parseGrid(opts.grid);
      const { videoRoot, manager, variantIds, multi } = await openProbeTargets(args, {
        mediaKinds: ["image"],
      });
      const targets = variantIds.map((variantId) => {
        const address = manager.resolveVariantAddress(variantId);
        const variant = manager.getAssetState(address).variants?.[variantId];
        if (!variant?.file) {
          throw new KonteError("VARIANT_NOT_FOUND", `Variant ${variantId} has no file`);
        }
        if (inferMediaType(variant.file) !== "image") {
          throw new KonteError("INVALID_ASSET_TYPE", `${variantId} is not a still image`);
        }
        return { address, variantId, file: variant.file, outputHash: variant.outputHash };
      });
      const probes = await mapConcurrent(targets, FFMPEG_CONCURRENCY, (target) =>
        probeImage({ videoRoot, ...target, grid, force: opts.force }),
      );
      targets.forEach((target, i) => {
        if (multi) console.error(`${target.address} (${target.variantId})`);
        console.log(probes[i]!.path);
      });
      if (probes.some((p) => !p.labelled)) warnUnlabelledGrid(grid!);
    });
}
