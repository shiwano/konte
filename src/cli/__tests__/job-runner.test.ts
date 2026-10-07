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
