import { requireWorkspaceRoot } from "./context.js";
import { exitWithError } from "./error-output.js";
import { applyCwdOption, enterScope } from "./startup.js";

interface McpProgram {
  command: "serve" | "worker";
  cwd: string | undefined;
}

// `konte [--cwd <path>] mcp serve|worker` exactly; anything else, `--help` included, is
// program.ts's.
export function mcpProgramOf(args: readonly string[]): McpProgram | null {
  let cwd: string | undefined;
  let i = 0;
  for (;;) {
    const arg = args[i];
    if (arg === "--cwd" && args[i + 1] !== undefined) {
      cwd = args[i + 1];
      i += 2;
    } else if (arg?.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length);
      i += 1;
    } else break;
  }
  const rest = args.slice(i);
  if (rest.length !== 2 || rest[0] !== "mcp") return null;
  if (rest[1] !== "serve" && rest[1] !== "worker") return null;
  return { command: rest[1], cwd };
}

/**
 * Runs `mcp serve` / `mcp worker` without program.ts, whose static import graph holds every
 * command. Both are workspace-scoped and skip the sync and the type-check.
 */
export async function runMcpProgram(mcp: McpProgram): Promise<void> {
  try {
    await applyCwdOption(mcp.cwd);
    await enterScope("workspace");
    const workspaceRoot = requireWorkspaceRoot();
    if (mcp.command === "serve") {
      const { startMcpServer } = await import("../mcp/index.js");
      await startMcpServer(workspaceRoot);
    } else {
      const { runMcpWorker } = await import("../mcp/worker.js");
      await runMcpWorker(workspaceRoot);
    }
  } catch (err) {
    exitWithError(err);
  }
}
