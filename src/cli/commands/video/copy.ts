import * as path from "node:path";
import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { listVideos, VIDEOS_DIR, writeCurrentVideo } from "../../../core/roots.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";
import { COPY_STAGES, copyVideo, type CopyStage } from "../../video-copy.js";

export function registerVideoCopyCommand(video: Command): void {
  declareScope(
    video
      .command("copy <src> <dest>")
      .description("Copy a video through a stage, keeping only accepted assets")
      .requiredOption("--through <stage>", `Last stage to retain (${COPY_STAGES.join(", ")})`)
      .addHelpText(
        "after",
        `
Copies videos/<src>/ into videos/<dest>/ in this workspace and makes the destination current.
Retains definitions and accepted assets through the specified stage,
including direction acceptance. Later definitions reset to the blank template. Jobs,
caches, exports, reviews and patch history are cleared. Imported source modules are copied.

Examples:
  konte video copy original alternate --through direction    Start again from the direction
  konte video copy original alternate --through reference    Retain direction and accepted references
  konte video copy original alternate --through animatic     Start motion from the accepted board
  konte video copy original alternate --through video        Retain all stages and accepted assets`,
      )
      .action(async (src: string, dest: string, options: { through: string }) => {
        if (!COPY_STAGES.includes(options.through as CopyStage)) {
          throw new KonteError(
            "INVALID_OPTION",
            `Invalid --through "${options.through}". Use ${COPY_STAGES.join(", ")}.`,
          );
        }
        const workspace = requireWorkspaceRoot();
        if (!(await listVideos(workspace)).includes(src)) {
          throw new KonteError("VIDEO_NOT_FOUND", `No video named "${src}" in this workspace`);
        }
        const source = path.join(workspace, VIDEOS_DIR, src);
        const count = await copyVideo(workspace, source, dest, options.through as CopyStage);
        await writeCurrentVideo(workspace, dest);
        console.log(
          `Video "${dest}" copied from "${src}" through ${options.through} with ${count} accepted assets, and is now current.`,
        );
      }),
    { scope: "workspace" },
  );
}
