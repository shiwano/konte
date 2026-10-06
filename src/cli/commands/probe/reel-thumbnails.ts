import * as path from "node:path";
import type { Command } from "commander";
import {
  addressToCacheSegments,
  formatCompositionAddress,
  parseReelScope,
} from "../../../core/address.js";
import { errorMessage, KonteError } from "../../../core/errors.js";
import { buildShotCompositionHtml } from "../../../core/composition-builder.js";
import { compositionAnimates } from "../../../core/dsl/composition/animate.js";
import { StateManager } from "../../../core/state/index.js";
import {
  captureCompositionFrames,
  COMPOSITION_FRAME_FORMAT,
  COMPOSITION_FRAME_QUALITY,
  type CaptureCompositionOptions,
  type ThumbnailInfo,
} from "../../../core/thumbnail.js";
import type { StageDefinition } from "../../../core/types/index.js";
import { loadVideoAndAnimatic } from "../../load-definition.js";
import { requireVideoRoot } from "../../context.js";
import {
  addFrameCaptureOptions,
  compositionStage,
  type FrameCaptureOptions,
  parseFrameCaptureOptions,
  requireCompositionShot,
  withAbsoluteFiles,
} from "./shared.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";

async function shotAnimates(
  video: StageDefinition,
  manager: StateManager,
  shotId: string,
): Promise<boolean> {
  try {
    const { html } = await buildShotCompositionHtml({
      video,
      manager,
      shotId,
      allowNotReady: true,
      assetBaseUrl: "",
      withOverlay: true,
    });
    return compositionAnimates(html);
  } catch {
    return false;
  }
}

// The renderer can reject with a message-less Error, which reads as no failure at all.
function captureFailure(err: unknown): string {
  const message = errorMessage(err).trim();
  if (message) return message;
  return err instanceof Error ? err.name : String(err);
}

export function registerProbeReelThumbnailsCommand(program: Command): void {
  addFrameCaptureOptions(
    program
      .command("reel-thumbnails <shot>")
      .description("Capture one shot's composition frames")
      .option("--force", "Re-render even if cached frames already exist"),
  )
    .addHelpText(
      "after",
      `
Captures sampled frames of one shot's composition (the assembled build output), with the
timeline's overlay laid over its span as the render lays it — on either composition stage, so
the same command reads the board and the finished piece. Prints each frame's path.

  <stage>:shot.<id>          The shot to capture (stage: animatic or video)

A whole stage is refused: the whole piece is read on \`konte probe contact-sheet <stage>\`, one
sheet of every shot. A shot without a composition (an undeveloped pendingShot, or an aside on the
board) is refused, as are asset and timeline addresses.

By default frames are chosen by scene detection (--threshold, capped at --max-frames). Pass
--at to capture exact moments instead. Timecodes are comma-separated and mixed freely:

  90 / 90s             Seconds (decimals allowed: 2.5, 90.5s)
  1:30                 MM:SS (.5 fractional seconds allowed)
  00:01:30             HH:MM:SS

A shot carrying an <Animate> gets a Next steps line: its move, frame by frame over a window, is
\`probe motion <stage>:shot.<id>#composition --at <sec> --window <sec>\`.

Examples:
  konte probe reel-thumbnails video:shot.01                 Its scene-detected frames
  konte probe reel-thumbnails animatic:shot.03              One shot of the board
  konte probe reel-thumbnails video:shot.01 --at 0:30,1:00,1:30`,
    )
    .action(async (scope: string, opts: FrameCaptureOptions & { force?: boolean }) => {
      const { stage, shotId } = parseReelScope(scope);
      if (!shotId) {
        throw new KonteError(
          "INVALID_ADDRESS",
          `reel-thumbnails reads one shot — read the whole ${stage} with \`konte probe contact-sheet ${stage}\`, then name a shot here (${stage}:shot.<id>)`,
        );
      }

      const videoRoot = requireVideoRoot();
      const video = compositionStage(await loadVideoAndAnimatic(videoRoot), stage);
      requireCompositionShot(video, shotId);

      const manager = await StateManager.load(videoRoot);
      await applyResolutionDefinitions({ videoRoot, state: manager.getState() });

      const { threshold, maxFrames, timestamps } = parseFrameCaptureOptions(opts);
      const captureOptions: CaptureCompositionOptions = {
        sceneThreshold: threshold,
        maxFrames,
        format: COMPOSITION_FRAME_FORMAT,
        quality: COMPOSITION_FRAME_QUALITY,
        force: opts.force,
        pruneSuperseded: true,
        ...(timestamps ? { timestamps } : {}),
      };

      const address = formatCompositionAddress(stage, shotId);
      const outputDir = path.join(
        videoRoot,
        ".konte",
        "cache",
        "thumbnails",
        ...addressToCacheSegments(address),
      );
      let captured: ThumbnailInfo[];
      try {
        captured = await captureCompositionFrames({
          video,
          manager,
          shotId,
          videoRoot,
          outputDir,
          captureOptions,
        });
      } catch (err) {
        // Wrapped, because a bundled stack names no shot.
        if (err instanceof KonteError) throw err;
        throw new KonteError(
          "FRAME_CAPTURE_FAILED",
          `${address}: ${captureFailure(err)} — re-run with KONTE_DEBUG=1 for the renderer's own diagnostics`,
        );
      }
      const thumbnails = withAbsoluteFiles(videoRoot, captured);

      console.log(`${address}: ${thumbnails.length} frames captured`);
      for (const thumb of thumbnails) {
        console.log(`  ${thumb.file} (${thumb.timestamp.toFixed(2)}s)`);
      }

      // Sampled frames are too far apart to show how an <Animate> move travels.
      if (await shotAnimates(video, manager, shotId)) {
        console.log("\nNext steps:");
        console.log(
          `  konte probe motion ${address} --at <sec> --window <sec>   Read its <Animate> move frame by frame`,
        );
      }
    });
}
