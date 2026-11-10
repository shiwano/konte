import { type ChildProcess, spawn } from "node:child_process";
import { resolveTranspilerCachePath, TRANSPILER_CACHE_ENV } from "../cli/transpiler-cache.js";
import { environmentWithoutCredentials } from "../core/credentials.js";
import {
  claimWorker,
  WORKER_INSTANCE_ID,
  workerIsAlive,
  type WorkerRecord,
  heartbeatWorker,
  unregisterWorkerSync,
} from "../core/worker-registry.js";
import { selfCommand } from "../core/self-command.js";
import type { WorkerLog } from "./worker-log.js";
import {
  WORKER_INSTANCE_ENV,
  WORKER_RESTART_EXIT_CODE,
  WORKER_STOP_GRACE_MS,
} from "./worker-protocol.js";

const WORKER_CHECK_MS = 5_000;
const IDENTITY_CHECK_MS = 60_000;
const STDERR_TAIL_BYTES = 4_096;

interface WorkerHost {
  /** Settles once the host has stopped: 0 on stop(), else the exit code of the worker it gave up on. */
  readonly exited: Promise<number>;
  /** The end of what the worker printed on stderr, when captured. */
  stderrTail(): string;
  /** Stops the worker, letting its in-flight submits commit, then releases the registration. */
  stop(): Promise<void>;
}

interface WorkerHostOptions {
  log: WorkerLog;
  captureStderr?: boolean;
  workerCommand?: readonly string[];
  checkIntervalMs?: number;
}

// The worker leads a process group of its own; what it started — an ffmpeg mid-render — goes with
// it.
function signalWorkerGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && proc.pid !== undefined) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    // Nothing left to signal.
  }
}

/**
 * Takes part in the workspace's worker election and, once elected, runs the workspace's jobs in a
 * worker process (worker.ts), starting a fresh one whenever its definitions go stale.
 */
export function startWorkerHost(workspaceRoot: string, opts: WorkerHostOptions): WorkerHost {
  const { log } = opts;

  let worker: WorkerRecord | null = null;
  let child: ChildProcess | null = null;
  let childExited: Promise<void> = Promise.resolve();
  let tail = "";
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | null = null;
  let nextIdentityCheck = 0;
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (resolveExited = resolve));

  const onProcessExit = (): void => unregisterWorkerSync(workspaceRoot);
  process.on("exit", onProcessExit);

  const leading = (): boolean => worker?.instanceId === WORKER_INSTANCE_ID;

  const relinquish = (): void => {
    worker = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const spawnWorker = (): void => {
    const workerArgs = ["--cwd", workspaceRoot, "job", "worker"];
    const [cmd, ...args] = opts.workerCommand ?? selfCommand(workerArgs);
    const proc = spawn(cmd!, args, {
      cwd: workspaceRoot,
      // Equal to what the worker's entry resolves: an entry that re-execs leaves the IPC channel
      // behind.
      env: {
        ...environmentWithoutCredentials(),
        [TRANSPILER_CACHE_ENV]: resolveTranspilerCachePath(workerArgs),
        [WORKER_INSTANCE_ENV]: WORKER_INSTANCE_ID,
      },
      stdio: ["ignore", "ignore", opts.captureStderr ? "pipe" : "inherit", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
    });
    childExited = new Promise((resolve) => {
      let done = false;
      const exitedWith = (code: number): void => {
        if (done) return;
        done = true;
        signalWorkerGroup(proc, "SIGTERM");
        onWorkerExit(proc, code);
        resolve();
      };
      proc.once("exit", (code, signal) => exitedWith(code ?? (signal ? 1 : 0)));
      // Also emitted for a failed signal or IPC send to a worker that lives on; only a worker
      // that never started has no pid.
      proc.on("error", (error) => {
        log.write("error", { event: "worker_process_error", message: String(error) });
        tail += error.message;
        if (proc.pid === undefined) exitedWith(1);
      });
    });
  };

  const onWorkerExit = (proc: ChildProcess, code: number): void => {
    if (child !== proc) return;
    child = null;
    if (stopping || !leading()) return;
    if (code === WORKER_RESTART_EXIT_CODE) {
      spawnWorker();
      return;
    }
    log.write("error", { event: "worker_exited", code });
    void shutdown(code);
  };

  // Settles once the worker has let its in-flight submits commit and exited.
  const stopWorker = (): Promise<void> => {
    const proc = child;
    if (!proc) return Promise.resolve();
    if (proc.connected) proc.disconnect();
    else proc.kill("SIGTERM");
    const timer = setTimeout(() => signalWorkerGroup(proc, "SIGKILL"), WORKER_STOP_GRACE_MS);
    return childExited.finally(() => clearTimeout(timer));
  };

  const loseRegistration = (): void => {
    if (stopping || !leading()) return;
    log.write("info", { event: "worker_registration_lost" });
    relinquish();
    void stopWorker();
  };

  const ensureWorker = async (): Promise<void> => {
    if (stopping || leading() || child) return;
    try {
      if (
        worker !== null &&
        Date.now() < nextIdentityCheck &&
        (await workerIsAlive(workspaceRoot, worker))
      )
        return;
      const next = await claimWorker(workspaceRoot);
      nextIdentityCheck = Date.now() + IDENTITY_CHECK_MS;
      if (stopping) return;
      if (next.instanceId !== worker?.instanceId) {
        worker = next;
        log.write("info", {
          event: next.instanceId === WORKER_INSTANCE_ID ? "worker_started" : "worker_standby",
          workerPid: next.pid,
          workerInstanceId: next.instanceId,
        });
      }
      if (next.instanceId !== WORKER_INSTANCE_ID) return;
      heartbeatTimer = setInterval(() => {
        void heartbeatWorker(workspaceRoot)
          .then((owned) => {
            if (!owned) loseRegistration();
          })
          .catch((error: unknown) => {
            log.write("error", { event: "worker_heartbeat_failed", message: String(error) });
          });
      }, WORKER_CHECK_MS);
      spawnWorker();
    } catch (error) {
      if (leading() && !stopping) {
        relinquish();
        unregisterWorkerSync(workspaceRoot);
      }
      worker = null;
      throw error;
    }
  };

  // The one check in flight; a check while it runs joins it.
  let check: Promise<void> | null = null;
  const checkWorker = (): Promise<void> =>
    (check ??= ensureWorker()
      .catch((error: unknown) => {
        log.write("error", { event: "worker_check_failed", message: String(error) });
      })
      .finally(() => {
        check = null;
      }));
  const workerTimer = setInterval(() => {
    void checkWorker();
  }, opts.checkIntervalMs ?? WORKER_CHECK_MS);
  void checkWorker();

  // Registration and heartbeat hold until the worker has exited. A claim in flight settles first,
  // so a registration it takes is released too.
  const shutdown = (code: number): Promise<void> => {
    if (stopping) return stopping;
    clearInterval(workerTimer);
    stopping = (async () => {
      await check;
      await stopWorker();
      relinquish();
      unregisterWorkerSync(workspaceRoot);
      process.off("exit", onProcessExit);
      resolveExited(code);
    })();
    return stopping;
  };

  return {
    exited,
    stderrTail: () => tail.trim(),
    stop: () => shutdown(0),
  };
}
