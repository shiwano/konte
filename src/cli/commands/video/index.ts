import type { Command } from "commander";
import { registerVideoCopyCommand } from "./copy.js";
import { registerVideoCurrentCommand } from "./current.js";
import { registerVideoListCommand } from "./list.js";
import { registerVideoNewCommand } from "./new.js";
import { registerVideoUseCommand } from "./use.js";

export function registerVideoCommand(program: Command): void {
  const video = program.command("video").description("Manage the workspace's videos");
  registerVideoCopyCommand(video);
  registerVideoNewCommand(video);
  registerVideoCurrentCommand(video);
  registerVideoListCommand(video);
  registerVideoUseCommand(video);

  video.addHelpText(
    "after",
    `
Commands that act on one video (generate, status, review, …) take the one --video <name> names,
else the one whose directory you are in, else the workspace's current video.

Examples:
  konte video list             List every video, marking the current one
  konte video use opening      Make "opening" the current video
  konte status --video ending  Show "ending" without switching to it
`,
  );
}
