import { constants } from "node:os";
import pkg from "../../package.json" with { type: "json" };
import { WORKER_INSTANCE_ID, liveWorkers } from "../core/worker-registry.js";
import { KonteError } from "../core/errors.js";
import { WorkerLog } from "../worker/worker-log.js";
import { startWorkerHost } from "../worker/worker-host.js";

// A worker that dies this many times under one wait is not coming up.
const MAX_STARTS = 3;

/** The workspace's jobs run for one `konte job wait`. */
export interface AttachedRunner {
  /** Settles with the exit code of the worker given up on, or 0 once stopped. */
  readonly exited: Promise<number>;
  /** The end of what the worker printed on stderr, for a worker that would not stay up. */
  stderrTail(): string;
  stop(): Promise<void>;
}

export const jobRunnerHooks: { start: (workspaceRoot: string) => AttachedRunner } = {
  start: startAttachedRunner,
};

function startAttachedRunner(workspaceRoot: string): AttachedRunner {
  const log = new WorkerLog(workspaceRoot, { instanceId: WORKER_INSTANCE_ID });
  log.write("info", {
    event: "runner_started",
    version: pkg.version,
    workspace: workspaceRoot,
  });
  const host = startWorkerHost(workspaceRoot, { log, captureStderr: true });
  return {
    exited: host.exited,
    stderrTail: () => host.stderrTail(),
    async stop() {
      await host.stop();
      log.write("info", { event: "runner_stopped" });
      await log.flush();
    },
  };
}

/**
 * Keeps the workspace's jobs running for as long as a wait lasts: by the worker another wait hosts
 * when one is up, else by a worker this wait hosts. Checked on every pass, since a worker another
 * wait hosts goes away with that wait.
 */
export class JobRunnerGuard {
  private runner: AttachedRunner | null = null;
  private running = false;
  private starts = 0;
  private interrupted = false;
  private stopping: Promise<void> | null = null;

  // A first SIGINT/SIGTERM stops the worker it hosts, holding the registration through its drain;
  // a second leaves at once.
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    const code = 128 + (constants.signals[signal] ?? 0);
    if (this.interrupted) process.exit(code);
    this.interrupted = true;
    void this.stop().finally(() => process.exit(code));
  };

  constructor(private readonly workspaceRoot: string) {}

  async ensure(): Promise<void> {
    if (this.running || this.interrupted) return;
    if ((await liveWorkers(this.workspaceRoot)).length > 0) return;
    if (this.starts >= MAX_STARTS) {
      const tail = this.runner?.stderrTail();
      throw new KonteError(
        "JOB_RUNNER_EXITED",
        `The konte worker this wait started exited ${this.starts} times — no job is being run. ` +
          "Read `.konte/logs/worker.log` in the workspace to see why, then `konte job wait` again",
        tail ? tail.split("\n").map((l) => `  ${l}`) : [],
      );
    }
    this.starts++;
    if (!this.runner) {
      process.on("SIGINT", this.onSignal);
      process.on("SIGTERM", this.onSignal);
    }
    const runner = jobRunnerHooks.start(this.workspaceRoot);
    this.runner = runner;
    this.running = true;
    void runner.exited.then(() => {
      if (this.runner === runner) this.running = false;
    });
  }

  /** A stop while one is in flight joins it. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      const runner = this.runner;
      this.runner = null;
      this.running = false;
      await runner?.stop();
      if (!this.interrupted) {
        process.off("SIGINT", this.onSignal);
        process.off("SIGTERM", this.onSignal);
      }
      this.stopping = null;
    })();
    return this.stopping;
  }
}
