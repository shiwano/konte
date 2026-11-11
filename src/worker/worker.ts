import { KonteError } from "../core/errors.js";
import { drainSubmissions } from "../core/submission-drain.js";
import { WorkerLog } from "./worker-log.js";
import { VideoRegistry } from "./video-registry.js";
import {
  SUBMIT_DRAIN_MS,
  WORKER_INSTANCE_ENV,
  WORKER_RESTART_EXIT_CODE,
} from "./worker-protocol.js";

/**
 * Runs every video's jobs for the process that spawned this one, over its IPC channel. Stops
 * when the channel closes or on SIGINT/SIGTERM, letting a submit already sent commit first.
 */
export async function runWorker(workspaceRoot: string): Promise<void> {
  if (!process.send) {
    throw new KonteError(
      "WORKER_UNSUPERVISED",
      "`konte job worker` runs only under `konte job run`",
    );
  }
  const log = new WorkerLog(workspaceRoot, { instanceId: process.env[WORKER_INSTANCE_ENV] });

  // The worker leads a process group of its own (worker-host.ts); what it started — an ffmpeg
  // mid-render — ends with it, whether or not its host is still there.
  const leave = (code: number): never => {
    if (process.platform !== "win32") {
      try {
        process.kill(-process.pid, "SIGTERM");
      } catch {
        // Not a group leader, or nothing left to signal.
      }
    }
    return process.exit(code);
  };

  let exiting = false;
  const exit = (code: number): void => {
    if (exiting) return;
    exiting = true;
    void registry.stop();
    void drainSubmissions(SUBMIT_DRAIN_MS)
      .then(() => registry.releaseLeases())
      .then(() => log.flush())
      .finally(() => leave(code));
  };

  const registry = new VideoRegistry(workspaceRoot, {
    log,
    onStaleDefinitions: (video, info) => {
      log.write("info", { video, event: "stale_definitions_restart", ...info });
      exit(WORKER_RESTART_EXIT_CODE);
    },
  });

  process.once("disconnect", () => exit(0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => exit(0));
  }

  try {
    await registry.start();
  } catch (error) {
    if (exiting) return;
    exiting = true;
    await registry.stop();
    log.write("error", { event: "worker_start_failed", message: String(error) });
    process.stderr.write(`${String(error)}\n`);
    await log.flush();
    leave(1);
  }
}
