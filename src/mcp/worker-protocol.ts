import type { McpLogLevel } from "./mcp-log.js";

// The exit status of a worker that has proven its loaded definitions older than the files on disk
// (see definition-source.ts); the daemon starts a fresh one in its place.
export const WORKER_RESTART_EXIT_CODE = 75;

// The daemon's instance id, which tags the worker's lines in mcp.log.
export const WORKER_INSTANCE_ENV = "KONTE_DAEMON_INSTANCE_ID";

// How long a stopping worker waits for a submit already sent to commit its backend job id.
export const SUBMIT_DRAIN_MS = 60_000;

// How long a stopping daemon waits for its worker before killing it: past the worker's drain.
export const WORKER_STOP_GRACE_MS = SUBMIT_DRAIN_MS + 5_000;

export type WorkerMessage =
  | { type: "log"; level: McpLogLevel; data: object }
  | { type: "videos"; videos: string[] };
