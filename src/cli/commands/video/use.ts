import type { Command } from "commander";
import { KonteError } from "../../../core/errors.js";
import { listVideos, writeCurrentVideo } from "../../../core/roots.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";

export function registerVideoUseCommand(video: Command): void {
  declareScope(
    video
      .command("use <name>")
      .description("Set the workspace's current video")
      .action(async (name: string) => {
        const workspace = requireWorkspaceRoot();
        const videos = await listVideos(workspace);
        if (!videos.includes(name)) {
          throw new KonteError(
            "VIDEO_NOT_FOUND",
            videos.length === 0
              ? `No video named "${name}". This workspace has no videos yet — run "konte video new <name>".`
              : `No video named "${name}". Available: ${videos.join(", ")}`,
          );
        }
        await writeCurrentVideo(workspace, name);
        console.log(`Current video: ${name}`);
      }),
    { scope: "workspace" },
  );
}
