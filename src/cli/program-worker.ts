import { requireWorkspaceRoot } from "./context.js";
import { exitWithError } from "./error-output.js";
import { applyCwdOption, enterScope } from "./startup.js";

interface WorkerProgram {
  cwd: string | undefined;
}

// `konte [--cwd <path>] job worker` exactly; anything else, `--help` included, is program.ts's.
export function workerProgramOf(args: readonly string[]): WorkerProgram | null {
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
  if (rest.length !== 2 || rest[0] !== "job" || rest[1] !== "worker") return null;
  return { cwd };
}

/**
 * Runs `job worker` without program.ts, whose static import graph holds every command. It is
 * workspace-scoped and skips the sync and the type-check.
 */
export async function runWorkerProgram(worker: WorkerProgram): Promise<void> {
  try {
    await applyCwdOption(worker.cwd);
    await enterScope("workspace");
    const { runWorker } = await import("../worker/worker.js");
    await runWorker(requireWorkspaceRoot());
  } catch (err) {
    exitWithError(err);
  }
}
