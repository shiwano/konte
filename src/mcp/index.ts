import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import {
  claimDaemon,
  DAEMON_INSTANCE_ID,
  daemonIsAlive,
  type DaemonRecord,
  heartbeatDaemon,
  unregisterDaemonSync,
} from "../core/daemon-registry.js";
import { RESTART_EXIT_CODE } from "../core/process-restart.js";
import { drainSubmissions } from "../core/submission-drain.js";
import { McpLog } from "./mcp-log.js";
import type { VideoRegistry } from "./video-registry.js";

// How long a stopping daemon waits for a submit already sent to commit its backend job id.
export const SUBMIT_DRAIN_MS = 60_000;
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

export async function startMcpServer(
  workspaceRoot: string,
  opts: { attached?: boolean } = {},
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

  let registry: VideoRegistry | undefined;
  let worker: DaemonRecord | null = null;
  let checkingWorker = false;
  let workerTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let restarting = false;
  let nextIdentityCheck = 0;

  const restart = (data: { event: string; [key: string]: unknown }): void => {
    if (stopping || restarting) return;
    restarting = true;
    clearInterval(workerTimer);
    void registry?.stop();
    log.write("info", data);
    server.server
      .sendLoggingMessage({ level: "info", logger: "konte", data: { pid: process.pid, ...data } })
      .catch(() => undefined)
      .then(() => drainSubmissions(SUBMIT_DRAIN_MS))
      .then(() => log.flush())
      .finally(() => {
        if (!stopping) process.exit(RESTART_EXIT_CODE);
      });
  };

  const ensureWorker = async (): Promise<void> => {
    if (stopping || restarting) return;
    if (registry) return;
    if (checkingWorker) return;
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
      if (stopping) {
        return;
      }
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
            if (!owned) restart({ event: "worker_registration_lost" });
          })
          .catch((error: unknown) => {
            log.write("error", { event: "worker_heartbeat_failed", message: String(error) });
          });
      }, WORKER_CHECK_MS);

      const { VideoRegistry } = await import("./video-registry.js");
      if (stopping) return;
      registry = new VideoRegistry(server, workspaceRoot, {
        log,
        onStaleDefinitions: (video, info) => {
          restart({ video, event: "stale_definitions_restart", ...info });
        },
      });
      await registry.start();
      if (stopping || restarting) void registry.stop();
    } catch (error) {
      await registry?.stop();
      registry = undefined;
      worker = null;
      if (!stopping && !restarting) {
        clearInterval(heartbeatTimer);
        unregisterDaemonSync(workspaceRoot);
      }
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
        videos: registry?.videos() ?? [],
      };
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );

  const cleanup = () => {
    clearInterval(workerTimer);
    void registry?.stop();
  };
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    cleanup();
    void drainSubmissions(SUBMIT_DRAIN_MS)
      .then(() => {
        log.write("info", { event: "daemon_stopped", signal: reason });
        return log.flush();
      })
      .finally(() => {
        if (attached) stopProcessGroup();
        process.exit(0);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => stop(signal));
  }
  process.on("exit", () => {
    cleanup();
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
