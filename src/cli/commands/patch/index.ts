import type { Command } from "commander";
import { registerPatchApplyCommand } from "./apply.js";
import { registerPatchListCommand } from "./list.js";
import { registerPatchNewCommand } from "./new.js";
import { registerPatchRemoveCommand } from "./remove.js";

export function registerPatchCommand(program: Command): void {
  const patch = program.command("patch").description("Correct a single generated variant");
  registerPatchNewCommand(patch);
  registerPatchApplyCommand(patch);
  registerPatchRemoveCommand(patch);
  registerPatchListCommand(patch);
}
