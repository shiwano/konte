import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { type AttachedRunner, JobRunnerGuard, jobRunnerHooks } from "../job-runner.js";

let ws: Workspace;
const original = jobRunnerHooks.start;

beforeEach(async () => {
  ws = await makeWorkspace();
});

afterEach(async () => {
  jobRunnerHooks.start = original;
  await ws.cleanup();
});

function fakeRunner(exitAtOnce: boolean): AttachedRunner & { stopped: boolean } {
  let exit: (code: number) => void = () => {};
  const runner = {
    exited: new Promise<number>((resolve) => (exit = resolve)),
    stderrTail: () => "Error: broken",
    stopped: false,
    async stop() {
      runner.stopped = true;
      exit(0);
    },
  };
  if (exitAtOnce) exit(1);
  return runner;
}

it("starts one daemon, keeps it while it runs, and stops it", async () => {
  const started: ReturnType<typeof fakeRunner>[] = [];
  jobRunnerHooks.start = () => {
    const r = fakeRunner(false);
    started.push(r);
    return r;
  };
  let notices = 0;
  const guard = new JobRunnerGuard(ws.root, () => notices++);
  await guard.ensure();
  await guard.ensure();
  expect(started).toHaveLength(1);
  expect(notices).toBe(1);

  await guard.stop();
  expect(started[0]!.stopped).toBe(true);
});

it("refuses once the daemon it starts keeps exiting", async () => {
  jobRunnerHooks.start = () => fakeRunner(true);
  const guard = new JobRunnerGuard(ws.root, () => {});
  const settle = () => new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 3; i++) {
    await guard.ensure();
    await settle();
  }
  await expect(guard.ensure()).rejects.toMatchObject({
    code: "JOB_RUNNER_EXITED",
    items: ["  Error: broken"],
  });
});

it.skipIf(process.platform === "win32")(
  "stops the worker it hosts before leaving on a signal",
  async () => {
    const runnerModule = new URL("../job-runner.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    import { JobRunnerGuard, jobRunnerHooks } from ${JSON.stringify(runnerModule)};
    jobRunnerHooks.start = () => ({
      exited: new Promise(() => {}),
      stderrTail: () => "",
      async stop() {
        await Bun.sleep(200);
        await Bun.write("stopped", "");
      },
    });
    await new JobRunnerGuard(process.cwd(), () => {}).ensure();
    await Bun.write("started", "");
    setInterval(() => {}, 1000);
  `,
      ],
      { cwd: ws.root, stdio: "ignore" },
    );
    let exitCode: number | null | undefined;
    child.once("exit", (code) => {
      exitCode = code;
    });
    const exists = (file: string) =>
      fs.access(`${ws.root}/${file}`).then(
        () => true,
        () => false,
      );
    try {
      await expect.poll(() => exists("started"), { timeout: 5_000 }).toBe(true);
      child.kill("SIGTERM");
      await expect.poll(() => exitCode, { timeout: 5_000 }).toBe(143);
      expect(await exists("stopped")).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  },
);

it.skipIf(process.platform === "win32")(
  "lets a signal during a stop wait for that stop",
  async () => {
    const runnerModule = new URL("../job-runner.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    import { JobRunnerGuard, jobRunnerHooks } from ${JSON.stringify(runnerModule)};
    jobRunnerHooks.start = () => ({
      exited: new Promise(() => {}),
      stderrTail: () => "",
      async stop() {
        await Bun.write("stopping", "");
        await Bun.sleep(300);
        await Bun.write("stopped", "");
      },
    });
    const guard = new JobRunnerGuard(process.cwd(), () => {});
    await guard.ensure();
    await guard.stop();
    setInterval(() => {}, 1000);
  `,
      ],
      { cwd: ws.root, stdio: "ignore" },
    );
    let exitCode: number | null | undefined;
    child.once("exit", (code) => {
      exitCode = code;
    });
    const exists = (file: string) =>
      fs.access(`${ws.root}/${file}`).then(
        () => true,
        () => false,
      );
    try {
      await expect.poll(() => exists("stopping"), { timeout: 5_000 }).toBe(true);
      child.kill("SIGTERM");
      await expect.poll(() => exitCode, { timeout: 5_000 }).toBe(143);
      expect(await exists("stopped")).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  },
);
