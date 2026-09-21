import type { Command } from "commander";
import { registerProbeAudioCommand } from "./audio.js";
import { registerProbeContactSheetCommand } from "./contact-sheet.js";
import { registerProbeCropCommand } from "./crop.js";
import { registerProbeExportCommand } from "./export.js";
import { registerProbeJsxCommand } from "./jsx.js";
import { registerProbeMotionCommand } from "./motion.js";
import { registerProbeThumbnailsCommand } from "./thumbnails.js";
import { registerProbeReelAudioCommand } from "./reel-audio.js";
import { registerProbeReelThumbnailsCommand } from "./reel-thumbnails.js";

export function registerProbeCommand(program: Command): void {
  const probe = program
    .command("probe")
    .description("Inspect a variant's, composition's or deliverable's media");

  registerProbeContactSheetCommand(probe);
  registerProbeCropCommand(probe);
  registerProbeJsxCommand(probe);
  registerProbeMotionCommand(probe);
  registerProbeAudioCommand(probe);
  registerProbeThumbnailsCommand(probe);
  registerProbeReelAudioCommand(probe);
  registerProbeReelThumbnailsCommand(probe);
  registerProbeExportCommand(probe);
}
