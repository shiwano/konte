import type { Command } from "commander";
import { listVideos, readCurrentVideo } from "../../../core/roots.js";
import { requireWorkspaceRoot } from "../../context.js";
import { declareScope } from "../../scope.js";

export function registerVideoListCommand(video: Command): void {
  declareScope(
    video
      .command("list")
      .description("List the videos in this workspace")
      .action(async () => {
        const workspace = requireWorkspaceRoot();
        const videos = await listVideos(workspace);
        const current = await readCurrentVideo(workspace);

        if (videos.length === 0) {
          console.log(`No videos yet. Run "konte video new <name>" to create one.`);
          return;
        }
        for (const name of videos) {
          console.log(`${name === current ? "*" : " "} ${name}`);
        }
      }),
    { scope: "workspace", skipTypeCheck: true },
  );
}
