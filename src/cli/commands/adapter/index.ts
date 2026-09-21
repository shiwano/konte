import type { Command } from "commander";
import { registerComfyCommand } from "../comfy.js";
import { registerAdapterListCommand } from "./list.js";
import { registerAdapterShowCommand } from "./show.js";

export function registerAdapterCommand(program: Command): void {
  const adapter = program.command("adapter").description("Manage adapters");
  registerAdapterListCommand(adapter);
  registerAdapterShowCommand(adapter);
  registerComfyCommand(adapter);
}
