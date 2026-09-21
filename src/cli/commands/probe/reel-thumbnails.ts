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
      .command("reel-thumbnails <address-scope>")
      .description("Capture composition thumbnails for a shot or a whole reel")
      .option("--force", "Re-render even if cached frames already exist"),
  )
    .addHelpText(
      "after",
      `
Captures sampled frames of a shot's composition (the assembled build output) — on either
composition stage, so the same command reads the board and the finished piece. Composition
is a per-shot concept, so the address-scope targets a whole reel or a single shot of one; an
individual asset address is rejected so the caller never gets frames it did not intend.

  animatic | video           Capture every shot of that stage that has a composition
  <stage>:shot.<id>          Capture a single shot

Shots without a composition (an undeveloped pendingShot, or an aside on the board that never
carries one) are skipped when capturing a whole reel, and rejected with an error when named
directly. A shot whose capture fails is reported by address and stepped over the same way: the
failures are listed and the exit code is 1. Asset (video:shot.<id>.<asset>)
and timeline scopes are rejected.

By default frames are chosen by scene detection (--threshold, capped at --max-frames). Pass
--at to capture exact moments instead. Timecodes are comma-separated and mixed freely:

  90 / 90s             Seconds (decimals allowed: 2.5, 90.5s)
  1:30                 MM:SS (.5 fractional seconds allowed)
  00:01:30             HH:MM:SS

A shot carrying an <Animate> gets a Next steps line: its move, frame by frame over a window, is
\`probe motion <stage>:shot.<id>#composition --at <sec> --window <sec>\`.

Examples:
  konte probe reel-thumbnails video                Capture every finished shot
  konte probe reel-thumbnails animatic             Capture the board, shot by shot
  konte probe reel-thumbnails video:shot.01 --at 0:30,1:00,1:30`,
    )
    .action(async (addressScope: string, opts: FrameCaptureOptions & { force?: boolean }) => {
      const { stage, shotId } = parseReelScope(addressScope);

      const videoRoot = requireVideoRoot();
      const video = compositionStage(await loadVideoAndAnimatic(videoRoot), stage);

      let shotIds: string[];
      if (shotId) {
        requireCompositionShot(video, shotId);
        shotIds = [shotId];
      } else {
        shotIds = video.shots.filter((s) => s.shotFn).map((s) => s.id);
        if (shotIds.length === 0) {
          throw new KonteError("SHOT_NOT_FOUND", "No shots with a composition found");
        }
      }

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

      const results: { shotId: string; thumbnails: ThumbnailInfo[] }[] = [];
      const failed: { shotId: string; address: string; error: string }[] = [];
      // The first shot the renderer itself dropped — its rejection says next to nothing, and the
      // one thing that reads it is behind KONTE_DEBUG.
      let rendererFailed: string | null = null;
      const animated: string[] = [];
      for (const [i, id] of shotIds.entries()) {
        const address = formatCompositionAddress(stage, id);
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
            shotId: id,
            videoRoot,
            outputDir,
            captureOptions,
          });
        } catch (err) {
          const message = captureFailure(err);
          // A shot named outright IS the command, so its failure fails it — wrapped, because a
          // bundled stack names no shot. A sweep steps over it instead.
          if (shotId) {
            if (err instanceof KonteError) throw err;
            throw new KonteError(
              "FRAME_CAPTURE_FAILED",
              `${address}: ${message} — re-run with KONTE_DEBUG=1 for the renderer's own diagnostics`,
            );
          }
          if (!(err instanceof KonteError)) rendererFailed ??= id;
          failed.push({ shotId: id, address, error: message });
          console.error(`${address}: capture failed — ${message}`);
          continue;
        }
        const thumbnails = withAbsoluteFiles(videoRoot, captured);
        results.push({ shotId: id, thumbnails });
        if (await shotAnimates(video, manager, id)) animated.push(address);

        if (i > 0) console.log("");
        console.log(`${address}: ${thumbnails.length} frames captured`);
        for (const thumb of thumbnails) {
          console.log(`  ${thumb.file} (${thumb.timestamp.toFixed(2)}s)`);
        }
      }

      // Sampled frames are too far apart to show how an <Animate> move travels.
      if (animated.length > 0) {
        console.log("\nNext steps:");
        for (const address of animated) {
          console.log(
            `  konte probe motion ${address} --at <sec> --window <sec>   Read its <Animate> move frame by frame`,
          );
        }
      }

      if (failed.length > 0) {
        console.error(
          `\n${results.length} of ${shotIds.length} shots captured; failed: ${failed
            .map((f) => f.address)
            .join(", ")}`,
        );
        if (rendererFailed) {
          console.error(
            "Read the renderer's own diagnostics with: " +
              `KONTE_DEBUG=1 konte probe reel-thumbnails ${stage}:shot.${rendererFailed} --force`,
          );
        }
      }
      if (failed.length > 0) process.exitCode = 1;
    });
}
