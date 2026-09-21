import { spawn } from "node:child_process";
import type { Command } from "commander";
import { ensureTsc } from "../../core/tsc.js";
import { declareScope } from "../scope.js";

export function registerLspCommand(program: Command): void {
  const lsp = program
    .command("lsp")
    .description("LSP server")
    .action(async () => {
      const tscBin = await ensureTsc();
      const child = spawn(tscBin, ["--lsp", "-stdio"], { stdio: "inherit" });

      const forward = (signal: NodeJS.Signals) => {
        if (!child.killed) child.kill(signal);
      };
      process.on("SIGINT", forward);
      process.on("SIGTERM", forward);

      await new Promise<void>((resolve) => {
        const cleanup = () => {
          process.off("SIGINT", forward);
          process.off("SIGTERM", forward);
          resolve();
        };
        child.on("exit", (code, signal) => {
          process.exitCode = signal ? 1 : (code ?? 0);
          cleanup();
        });
        child.on("error", () => {
          process.exitCode = 1;
          cleanup();
        });
      });
    });

  // An editor launches the LSP from wherever the file lives, which need not be a konte workspace.
  declareScope(lsp, { scope: "none" });
}
