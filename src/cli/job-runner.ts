import { spawn } from "node:child_process";
import { closeIdleDeployments } from "../comfy-api/deployment.js";
import { environmentWithoutCredentials } from "../core/credentials.js";
import { liveDaemons } from "../core/daemon-registry.js";
import { KonteError } from "../core/errors.js";
import { selfCommand } from "../core/self-command.js";
import { TRANSPILER_CACHE_ENV } from "./transpiler-cache.js";

// A daemon that dies this many times under one wait is not coming up.
const MAX_STARTS = 3;
// Past the daemon's own wait for in-flight submits (SUBMIT_DRAIN_MS).
const STOP_GRACE_MS = 65_000;
const STDERR_TAIL_BYTES = 4_096;

/** A daemon running for one `konte job wait`. */
export interface AttachedRunner {
  /** Settles with the exit code once the daemon is gone. */
  readonly exited: Promise<number>;
  /** The end of what it printed on stderr, for a daemon that would not stay up. */
  stderrTail(): string;
  stop(): Promise<void>;
}

export const jobRunnerHooks: { start: (workspaceRoot: string) => AttachedRunner } = {
  start: spawnAttachedDaemon,
};

function spawnAttachedDaemon(workspaceRoot: string): AttachedRunner {
  const [cmd, ...args] = selfCommand(["mcp", "serve", "--attached"]);
  const env = environmentWithoutCredentials();
  // Unset, the daemon's entry re-execs under its own supervisor, which restarts it on stale
  // definitions.
  delete env[TRANSPILER_CACHE_ENV];
  // Its own process group, which it ends on the way out, so nothing it started outlives it.
  const ownGroup = process.platform !== "win32";
  const child = spawn(cmd, args, {
    cwd: workspaceRoot,
    env,
    stdio: ["pipe", "ignore", "pipe"],
    detached: ownGroup,
  });
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (ownGroup && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
  });
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.once("error", (err) => {
      tail += err.message;
      resolve(1);
    });
  });
  return {
    exited,
    stderrTail: () => tail.trim(),
    async stop() {
      child.stdin?.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * Keeps a daemon running the workspace's jobs for as long as a wait lasts: the workspace's own when
 * one is up, else one this wait starts and stops. Checked on every pass, since a daemon another
 * wait started goes away with that wait.
 */
export class JobRunnerGuard {
  private runner: AttachedRunner | null = null;
  private running = false;
  private starts = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly onStart: () => void,
  ) {}

  async ensure(): Promise<void> {
    if (this.running) return;
    if ((await liveDaemons(this.workspaceRoot)).length > 0) return;
    if (this.starts >= MAX_STARTS) {
      const tail = this.runner?.stderrTail();
      throw new KonteError(
        "JOB_RUNNER_EXITED",
        `The konte daemon this wait started exited ${this.starts} times — no job is being run. ` +
          "Run `konte mcp serve` in the workspace to see why, or `konte job wait` again once fixed",
        tail ? tail.split("\n").map((l) => `  ${l}`) : [],
      );
    }
    this.starts++;
    const runner = jobRunnerHooks.start(this.workspaceRoot);
    this.runner = runner;
    this.running = true;
    void runner.exited.then(() => {
      if (this.runner === runner) this.running = false;
    });
    this.onStart();
  }

  async stop(): Promise<void> {
    const runner = this.runner;
    this.runner = null;
    this.running = false;
    await runner?.stop();
  }
}

/**
 * The end of a wait is one of the moments a deployment's idle time is judged — with no daemon
 * outliving it, the last one.
 */
export async function closeDeploymentsAfterWait(workspaceRoot: string): Promise<void> {
  await closeIdleDeployments({
    workspaceRoot,
    afterWait: true,
    log: (line) => console.log(line),
  }).catch(() => []);
}
