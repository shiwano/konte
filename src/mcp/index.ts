import { type ChildProcess, spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
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
import { McpLog } from "./mcp-log.js";
import {
  WORKER_INSTANCE_ENV,
  WORKER_RESTART_EXIT_CODE,
  WORKER_STOP_GRACE_MS,
  type WorkerMessage,
} from "./worker-protocol.js";

const WORKER_CHECK_MS = 5_000;
const IDENTITY_CHECK_MS = 60_000;

const INSTRUCTIONS = `Per-workspace daemon running every video's generation jobs in the background, so "konte generate" and "konte export" return immediately. "konte job wait" blocks until the queue drains.`;

// An attached daemon leads a process group of its own (job-runner.ts). What it started — an
// ffmpeg mid-render — must not outlive it and race the worker that takes the job over.
function stopProcessGroup(): void {
  if (process.platform === "win32") return;
  try {
    process.kill(0, "SIGTERM");
  } catch {
    // Nothing left to signal.
  }
}

/**
 * The MCP server of one agent session. It never loads a definition: the elected one runs the
 * workspace's jobs in a worker process (worker.ts) and starts a fresh worker whenever its
 * definitions go stale.
 */
export async function startMcpServer(
  workspaceRoot: string,
  opts: { attached?: boolean; workerCommand?: readonly string[] } = {},
): Promise<void> {
  const attached = opts.attached === true;
  const startedAt = new Date().toISOString();
  const server = new McpServer(
    { name: "konte", version: pkg.version },
    {
      capabilities: { logging: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const log = new McpLog(workspaceRoot, { instanceId: DAEMON_INSTANCE_ID });
  log.write("info", {
    event: "daemon_started",
    version: pkg.version,
    workspace: workspaceRoot,
    ...(attached ? { attached } : {}),
  });

  let worker: DaemonRecord | null = null;
  let child: ChildProcess | null = null;
  let childExited: Promise<void> = Promise.resolve();
  let videos: string[] = [];
  let checkingWorker = false;
  let workerTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let nextIdentityCheck = 0;

  const notify = ({ level, data }: Extract<WorkerMessage, { type: "log" }>): void => {
    server.server.sendLoggingMessage({ level, logger: "konte", data }).catch(() => undefined);
  };

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
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      windowsHide: true,
    });
    child = proc;
    proc.on("message", (message: WorkerMessage) => {
      if (message.type !== "videos") notify(message);
      // A worker that exited or no longer leads may still have one queued.
      else if (child === proc && leading()) videos = message.videos;
    });
    childExited = new Promise((resolve) => {
      let done = false;
      const exited = (code: number): void => {
        if (done) return;
        done = true;
        onWorkerExit(proc, code);
        resolve();
      };
      proc.once("exit", (code, signal) => exited(code ?? (signal ? 1 : 0)));
      // Also emitted for a failed signal or IPC send to a worker that lives on; only a worker
      // that never started has no pid.
      proc.on("error", (error) => {
        log.write("error", { event: "worker_process_error", message: String(error) });
        if (proc.pid === undefined) exited(1);
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
    // An attached daemon exits with its worker; the `konte job wait` that started it counts each
    // exit against MAX_STARTS.
    if (attached) {
      stop("worker-exited", code);
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
    const timer = setTimeout(() => proc.kill("SIGKILL"), WORKER_STOP_GRACE_MS);
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
    if (stopping || leading() || child || checkingWorker) return;
    checkingWorker = true;
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
    } finally {
      checkingWorker = false;
    }
  };

  server.registerTool(
    "status",
    {
      description: "Daemon identity, worker identity and locally watched videos.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const current = worker;
      const alive = current !== null && (await daemonIsAlive(workspaceRoot, current));
      const status = {
        version: pkg.version,
        instanceId: log.instanceId,
        pid: process.pid,
        startedAt,
        workerPid: alive ? current.pid : null,
        workerInstanceId: alive ? current.instanceId : null,
        videos,
      };
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );

  // Registration and heartbeat hold until the worker has exited.
  const stop = (reason: string, exitCode = 0): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(workerTimer);
    void stopWorker()
      .then(() => {
        log.write("info", { event: "daemon_stopped", signal: reason });
        return log.flush();
      })
      .finally(() => {
        if (attached) stopProcessGroup();
        process.exit(exitCode);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => stop(signal));
  }
  process.on("exit", () => {
    clearInterval(workerTimer);
    clearInterval(heartbeatTimer);
    unregisterDaemonSync(workspaceRoot);
  });

  process.stdin.once("end", () => stop("stdin-closed"));
  process.stdin.once("close", () => stop("stdin-closed"));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const checkWorker = () =>
    ensureWorker().catch((error: unknown) => {
      log.write("error", { event: "worker_check_failed", message: String(error) });
    });
  workerTimer = setInterval(() => {
    void checkWorker();
  }, WORKER_CHECK_MS);
  await checkWorker();
}
