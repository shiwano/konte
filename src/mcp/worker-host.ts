import { type ChildProcess, spawn } from "node:child_process";
import { resolveTranspilerCachePath, TRANSPILER_CACHE_ENV } from "../cli/transpiler-cache.js";
import { environmentWithoutCredentials } from "../core/credentials.js";
import {
  claimDaemon,
  DAEMON_INSTANCE_ID,
  daemonIsAlive,
  type DaemonRecord,
  heartbeatDaemon,
  unregisterDaemonSync,
} from "../core/daemon-registry.js";
import { selfCommand } from "../core/self-command.js";
import type { McpLog } from "./mcp-log.js";
import {
  WORKER_INSTANCE_ENV,
  WORKER_RESTART_EXIT_CODE,
  WORKER_STOP_GRACE_MS,
  type WorkerMessage,
} from "./worker-protocol.js";

const WORKER_CHECK_MS = 5_000;
const IDENTITY_CHECK_MS = 60_000;
const STDERR_TAIL_BYTES = 4_096;

export type WorkerLogMessage = Extract<WorkerMessage, { type: "log" }>;

export interface WorkerHostStatus {
  workerPid: number | null;
  workerInstanceId: string | null;
  videos: string[];
}

export interface WorkerHost {
  /** Settles once the host has stopped: 0 on stop(), else the exit code of the worker it gave up on. */
  readonly exited: Promise<number>;
  status(): Promise<WorkerHostStatus>;
  /** The end of what the worker printed on stderr, when captured. */
  stderrTail(): string;
  /** Stops the worker, letting its in-flight submits commit, then releases the registration. */
  stop(): Promise<void>;
}

export interface WorkerHostOptions {
  log: McpLog;
  notify?: (message: WorkerLogMessage) => void;
  // A worker exiting other than to restart stops the host; without it, the host releases the
  // registration and claims it again on the next check.
  stopOnWorkerFailure?: boolean;
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
  const notify = opts.notify ?? (() => {});

  let worker: DaemonRecord | null = null;
  let child: ChildProcess | null = null;
  let childExited: Promise<void> = Promise.resolve();
  let videos: string[] = [];
  let tail = "";
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | null = null;
  let nextIdentityCheck = 0;
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (resolveExited = resolve));

  const onProcessExit = (): void => unregisterDaemonSync(workspaceRoot);
  process.on("exit", onProcessExit);

  const leading = (): boolean => worker?.instanceId === DAEMON_INSTANCE_ID;

  const relinquish = (): void => {
    worker = null;
    videos = [];
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const spawnWorker = (): void => {
    const workerArgs = ["--cwd", workspaceRoot, "mcp", "worker"];
    const [cmd, ...args] = opts.workerCommand ?? selfCommand(workerArgs);
    const proc = spawn(cmd!, args, {
      cwd: workspaceRoot,
      // Equal to what the worker's entry resolves: an entry that re-execs leaves the IPC channel
      // behind.
      env: {
        ...environmentWithoutCredentials(),
        [TRANSPILER_CACHE_ENV]: resolveTranspilerCachePath(workerArgs),
        [WORKER_INSTANCE_ENV]: DAEMON_INSTANCE_ID,
      },
      stdio: ["ignore", "ignore", opts.captureStderr ? "pipe" : "inherit", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child = proc;
    proc.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
    });
    proc.on("message", (message: WorkerMessage) => {
      if (message.type !== "videos") notify(message);
      // A worker that exited or no longer leads may still have one queued.
      else if (child === proc && leading()) videos = message.videos;
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
    videos = [];
    if (stopping || !leading()) return;
    if (code === WORKER_RESTART_EXIT_CODE) {
      spawnWorker();
      return;
    }
    log.write("error", { event: "worker_exited", code });
    if (opts.stopOnWorkerFailure) {
      void shutdown(code);
      return;
    }
    relinquish();
    unregisterDaemonSync(workspaceRoot);
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
    const data = { event: "worker_registration_lost" };
    log.write("info", data);
    notify({ type: "log", level: "info", data: { pid: process.pid, ...data } });
    relinquish();
    void stopWorker();
  };

  const ensureWorker = async (): Promise<void> => {
    if (stopping || leading() || child) return;
    try {
      if (
        worker !== null &&
        Date.now() < nextIdentityCheck &&
        (await daemonIsAlive(workspaceRoot, worker))
      )
        return;
      const next = await claimDaemon(workspaceRoot);
      nextIdentityCheck = Date.now() + IDENTITY_CHECK_MS;
      if (stopping) return;
      if (next.instanceId !== worker?.instanceId) {
        worker = next;
        log.write("info", {
          event: next.instanceId === DAEMON_INSTANCE_ID ? "worker_started" : "worker_standby",
          workerPid: next.pid,
          workerInstanceId: next.instanceId,
        });
      }
      if (next.instanceId !== DAEMON_INSTANCE_ID) return;
      heartbeatTimer = setInterval(() => {
        void heartbeatDaemon(workspaceRoot)
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
        unregisterDaemonSync(workspaceRoot);
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
      unregisterDaemonSync(workspaceRoot);
      process.off("exit", onProcessExit);
      resolveExited(code);
    })();
    return stopping;
  };

  return {
    exited,
    async status() {
      const current = worker;
      const alive = current !== null && (await daemonIsAlive(workspaceRoot, current));
      return {
        workerPid: alive ? current.pid : null,
        workerInstanceId: alive ? current.instanceId : null,
        videos,
      };
    },
    stderrTail: () => tail.trim(),
    stop: () => shutdown(0),
  };
}
