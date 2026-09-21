import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIBackend } from "../../comfyui/backend.js";
import { JobManager } from "../../core/job-manager.js";
import type { JobRecord } from "../../core/types/index.js";
import { StateManager } from "../../core/state/manager.js";
import { useTempWorkspace, initWithTestVideo, run, runCapture } from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("job wait command", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createFailedJob(error: string): Promise<string> {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.createJob({
      address,
      variantId: "v-fail0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob(job.variantId, {
      status: "failed",
      error,
      completedAt: new Date().toISOString(),
    });
    return job.variantId;
  }

  // A model download carries no variant, so it is the one class of work the wait drives without
  // a result of its own. Left out, a run whose only failure was a multi-GB download reports
  // "no running, queued, or pending jobs" and exits 0.
  it("reports a standalone model-download job it drove to failure (no ids)", async () => {
    // What fails the install is not the subject — that the wait drives it and reports the failure
    // is. Stub it, because the honest failure needs a ComfyUI to reach: an unreachable one is
    // deliberately transient (the job stays re-observable, see ComfyUIManagerClient.isAvailable),
    // so a wait driving a real download would never settle here.
    vi.spyOn(ComfyUIBackend.prototype, "installModel").mockRejectedValue(
      new Error("HTTP 404 Not Found"),
    );

    const jobManager = new JobManager(projectDir);
    const { id } = await jobManager.ensureComfyModelDownloadJob({
      type: "checkpoint",
      filename: "nonexistent.safetensors",
      url: "https://models.example/nonexistent.safetensors",
    });

    const err = (await run(["job", "wait"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };

    expect(err.stdout).toContain(`Job nonexistent.safetensors (${id}): failed`);
    expect(err.stdout).toContain("1 job(s) settled: 0 completed, 1 failed");
    expect(err.code).toBe(1);
  });

  // --timeout is a deadline on the command, not a budget handed to each waiter. A foreign-owned
  // export never settles here, so without one this wait would block forever.
  it("gives up on the deadline and names what is still in flight (no ids)", async () => {
    const { id } = await createForeignOwnedExport();

    const startedAt = Date.now();
    const err = (await run(["job", "wait", "--timeout", "2"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    const elapsed = Date.now() - startedAt;

    expect(err.stdout).toContain(`Job ${id}: still running (stopped waiting — timeout reached)`);
    expect(err.stdout).toContain("1 still running");
    expect(err.code).toBe(1);
    // Bounded by the deadline, not by however many cascade passes it took.
    expect(elapsed).toBeLessThan(15_000);
  });

  it("does not re-report jobs that already failed before the wait (no ids)", async () => {
    await createFailedJob("Backend rejected: bad node");

    // A pre-wait failure is prior history: it was reported by the wait that observed it, and
    // re-printing it on every later wait reads as "still broken". Exit 0 — nothing failed here.
    const { stdout } = await run(["job", "wait"], projectDir);

    expect(stdout).toContain("No running, queued, or pending jobs");
  });

  it("notes prior failures in the human-readable output instead of listing them (no ids)", async () => {
    await createFailedJob("Backend rejected: bad node");

    const { stdout } = await run(["job", "wait"], projectDir);

    expect(stdout).toContain(
      "No running, queued, or pending jobs, 1 failed before this wait — run `konte status`",
    );
    expect(stdout).not.toContain("Job video:shot.01.motion (v-fail0001): failed");
  });

  it("still reports an empty result when there are genuinely no jobs (no ids)", async () => {
    const { stdout } = await run(["job", "wait"], projectDir);
    expect(stdout).toContain("No running, queued, or pending jobs");
    expect(stdout).not.toContain("failed before this wait");
  });

  it("exits 1 on a job that already failed, named by id", async () => {
    // Same gate as the bare wait: `konte generate && konte job wait <id> && konte export` must
    // not run export over a failed job.
    const variantId = await createFailedJob("Backend rejected: bad node");

    const err = (await run(["job", "wait", variantId], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    expect(err.code).toBe(1);

    expect(err.stdout).toContain(`(${variantId}): failed`);
    expect(err.stdout).toContain("1 job(s) settled: 0 completed, 1 failed");
  });

  // A submitter killed mid-transaction leaves a "running" job with no backendJobId and
  // no lease (a stranded submit). It has no backend job to observe, so a single-id wait
  // must report it (pointing at the bare wait) rather than loop forever waiting for an id that
  // no one in this process will commit.
  async function createStrandedSubmit(
    variantId: string,
    dependsOnAssets?: string[],
  ): Promise<void> {
    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({
      address,
      variantId,
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets,
    });
    // running, but backendJobId still null and no lease — the crashed-mid-submit shape.
    await jobManager.updateJob(variantId, { status: "running" });
  }

  it("reports a stranded submit instead of hanging (single id)", { timeout: 20000 }, async () => {
    await createStrandedSubmit("v-strand01");

    const { stdout } = await run(["job", "wait", "v-strand01"], projectDir);

    expect(stdout).toContain(
      "Job v-strand01: not submitted yet (submit in progress or interrupted)",
    );
  });

  // An export rendered by another live worker (the MCP watcher) holds a valid run lease, so
  // `job wait` cannot claim it. It must POLL that running export to completion rather than
  // report "nothing to do" — the bug was the wait exiting immediately while the watcher rendered.
  async function createForeignOwnedExport(): Promise<{ jobManager: JobManager; id: string }> {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.createExportJob({
      outputDir: "dist/video/main",
      allowUnaccepted: true,
      dependsOnAssets: [],
      dependsOnJobs: [],
    });
    // Claim under a foreign worker with a live lease so this process can't take it.
    await jobManager.claimJobForRun(job.id, "w-foreignlive", 60_000);
    return { jobManager, id: job.id };
  }

  // Let the foreign worker "finish" exactly when the waiter has observed the job and been
  // refused the claim (its lease is live) — the point the wait is committed to polling. A
  // wall-clock delay races the waiter's own startup: fire too early and the job is already
  // terminal when the wait begins, so it correctly reports nothing to do and the test fails.
  function settleOnRefusedClaim(
    jobManager: JobManager,
    id: string,
    patch: Parameters<JobManager["updateJob"]>[1],
  ): Promise<void> {
    const claimForRun = JobManager.prototype.claimJobForRun;
    let fired = false;
    let observed!: () => void;
    const settled = new Promise<void>((resolve) => {
      observed = resolve;
    });
    vi.spyOn(JobManager.prototype, "claimJobForRun").mockImplementation(async function (
      this: JobManager,
      jobId: string,
      workerId: string,
      leaseMs: number,
    ) {
      const claimed = await claimForRun.call(this, jobId, workerId, leaseMs);
      if (!claimed && jobId === id && !fired) {
        fired = true;
        await jobManager.updateJob(id, patch);
        observed();
      }
      return claimed;
    });
    return settled;
  }

  it("waits for an export rendered by another worker instead of reporting empty (no ids)", async () => {
    const { jobManager, id } = await createForeignOwnedExport();
    const settle = settleOnRefusedClaim(jobManager, id, {
      status: "completed",
      progress: 100,
      outputFile: "dist/video/main/out.mp4",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(["job", "wait"], projectDir);
    await settle;

    expect(stdout).not.toContain("No running, queued, or pending jobs");
    expect(stdout).toContain("1 job(s) settled: 1 completed");
  });

  // The wait's own output is the whole report of the batch: what broke, then one last line
  // carrying the outcome and the step — 60 "completed" lines would bury the two that did not.
  it("summarizes a finished batch instead of listing each completion (no ids)", async () => {
    const { jobManager, id } = await createForeignOwnedExport();
    const settle = settleOnRefusedClaim(jobManager, id, {
      status: "completed",
      progress: 100,
      outputFile: "dist/video/main/out.mp4",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(["job", "wait"], projectDir);
    await settle;

    expect(stdout).toContain("1 job(s) settled: 1 completed");
    expect(stdout).not.toContain(`Job ${id}: completed`);
    expect(stdout).toContain(`Export ${id}: dist/video/main/out.mp4`);
    expect(stdout).toContain("run `konte status`");
  });

  it("names the failure, then lands the outcome and the step on one line (no ids)", async () => {
    const { jobManager, id } = await createForeignOwnedExport();
    const settle = settleOnRefusedClaim(jobManager, id, {
      status: "failed",
      error: "ffmpeg exited 1",
      completedAt: new Date().toISOString(),
    });

    const err = (await run(["job", "wait"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    await settle;

    expect(err.code).toBe(1);
    expect(err.stdout).toContain(`Job ${id}: failed`);
    // The outcome and the step share the LAST line: a caller piping through `tail -1` keeps both.
    const lines = err.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toContain("1 job(s) settled: 0 completed, 1 failed");
    expect(lines.at(-1)).toContain("run `konte status`");
    // `status` branches on what broke and offers the per-job commands; this hop does not.
    expect(err.stdout).not.toContain(`konte job show ${id}`);
  });

  it("waits for an export rendered by another worker (single id)", async () => {
    const { jobManager, id } = await createForeignOwnedExport();
    const settle = settleOnRefusedClaim(jobManager, id, {
      status: "completed",
      progress: 100,
      outputFile: "dist/video/main/out.mp4",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(["job", "wait", id], projectDir);
    await settle;

    expect(stdout).toContain(`Job ${id}: completed`);
    expect(stdout).toContain(`Export ${id}: dist/video/main/out.mp4`);
    expect(stdout).toContain("1 job(s) settled: 1 completed");
  });

  it("waits for a node-activate rendered by another worker (single id)", async () => {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.ensureComfyNodeActivateJob({ dependsOnJobs: [], cnrIds: [] });
    await jobManager.claimJobForRun(job.id, "w-foreignlive", 60_000);
    const settle = settleOnRefusedClaim(jobManager, job.id, {
      status: "completed",
      progress: 100,
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(["job", "wait", job.id], projectDir);
    await settle;

    expect(stdout).toContain(`Job ${job.id}: completed`);
    expect(stdout).toContain("1 job(s) settled: 1 completed");
  });

  it("resolves a stranded submit via the cascade instead of deadlocking (no ids)", async () => {
    // Dep has no ready variant and no active job, so the reclaim fails it deterministically
    // (no backend needed). The point is that the wait terminates rather than blocking on the
    // stranded job in the wait set.
    await createStrandedSubmit("v-strand02", ["video:timeline.character"]);

    // The stranded job fails deterministically, so the cascade terminates AND exits non-zero.
    const err = (await run(["job", "wait"], projectDir).catch((e) => e)) as {
      code: number;
      stdout: string;
    };
    expect(err.code).toBe(1);
    expect(err.stdout).toContain("v-strand02): failed");
  });
});

describe("job cancel command", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  async function createRunningJob(variantId: string): Promise<void> {
    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({
      address,
      variantId,
      resolvedDeps: {},
      backendKind: "comfy",
    });
    // running, but backendJobId stays null — no backend prompt to interrupt, so cancel
    // flips the record without needing a live backend.
    await jobManager.updateJob(variantId, { status: "running" });
  }

  it("cancels multiple jobs in one invocation", async () => {
    await createRunningJob("v-cancel001");
    await createRunningJob("v-cancel002");

    const { stdout } = await run(
      ["job", "cancel", "v-cancel001", "v-cancel002", "--yes"],
      projectDir,
    );

    expect(stdout.trim().split("\n")).toEqual([
      "Generation job v-cancel001 cancelled.",
      "Generation job v-cancel002 cancelled.",
    ]);

    const jobManager = new JobManager(projectDir);
    expect((await jobManager.getJob("v-cancel001")).status).toBe("cancelled");
    expect((await jobManager.getJob("v-cancel002")).status).toBe("cancelled");
  });

  it("is best-effort: skips already-terminal jobs while cancelling the rest", async () => {
    await createRunningJob("v-cancel003");
    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({
      address,
      variantId: "v-cancel004",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-cancel004", {
      status: "failed",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await run(
      ["job", "cancel", "v-cancel003", "v-cancel004", "--yes"],
      projectDir,
    );

    expect(stdout).toContain("Generation job v-cancel003 cancelled.");
    expect(stdout).toContain("Skipped v-cancel004:");
    expect((await jobManager.getJob("v-cancel003")).status).toBe("cancelled");
  });

  it("reports a missing job as failed and exits non-zero", async () => {
    await createRunningJob("v-cancel005");

    const { stdout } = await runCapture(
      ["job", "cancel", "v-cancel005", "v-missing999", "--yes"],
      projectDir,
    );

    expect(stdout).toContain("Generation job v-cancel005 cancelled.");
    expect(stdout).toContain("Skipped v-missing999:");
  });

  it("does not resurrect a pruned asset's state when cancelling its job", async () => {
    // A job whose asset was already pruned has no state entry; cancel must not re-create one.
    await createRunningJob("v-cancel006");
    expect((await StateManager.load(projectDir)).tryGetAssetState(address)).toBeUndefined();

    await run(["job", "cancel", "v-cancel006", "--yes"], projectDir);

    expect((await StateManager.load(projectDir)).tryGetAssetState(address)).toBeUndefined();
  });
});

describe("job logs command", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  it("falls back to the job record error when no log file exists", async () => {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.createJob({
      address,
      variantId: "v-fail0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob(job.variantId, {
      status: "failed",
      error: "Backend rejected: bad node",
      completedAt: new Date().toISOString(),
    });

    const { stdout, stderr } = await run(["job", "logs", job.variantId], projectDir);

    expect(stderr).toContain("Backend rejected: bad node");
    expect(stdout).not.toContain("No logs available for this job.");
  });

  it("reports no logs when there is neither a log file nor an error", async () => {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.createJob({
      address,
      variantId: "v-pend0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    const { stdout } = await run(["job", "logs", job.variantId], projectDir);

    expect(stdout).toContain("No logs available for this job.");
  });

  // The case that motivated the fallback becoming unconditional: a job can fail with a log
  // file that says nothing about why, and the reason lives only on the record.
  it("prints the job record error even when a log file exists", async () => {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.createJob({
      address,
      variantId: "v-fail0002",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    jobManager.appendLog(job.variantId, "Waiting for prompt abc123");
    await jobManager.flushLogs();
    await jobManager.updateJob(job.variantId, {
      status: "failed",
      error: "Prompt abc123 is absent from ComfyUI's queue and history",
      completedAt: new Date().toISOString(),
    });

    const { stdout, stderr } = await run(["job", "logs", job.variantId], projectDir);

    expect(stdout).toContain("Waiting for prompt abc123");
    expect(stderr).toContain("absent from ComfyUI's queue and history");
  });

  it("--follow drains lines appended after the initial dump, then stops at the terminal state", async () => {
    const jobManager = new JobManager(projectDir);
    const job = await jobManager.createJob({
      address,
      variantId: "v-follow01",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob(job.variantId, { status: "running" });
    jobManager.appendLog(job.variantId, "before follow");

    const following = run(["job", "logs", job.variantId, "--follow"], projectDir);

    // Appended while the follow loop is polling: it must reach stdout, and the terminal
    // transition must then end the loop on its own (an agent has no TTY to Ctrl+C with).
    jobManager.appendLog(job.variantId, "during follow");
    await jobManager.updateJob(job.variantId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    const { stdout } = await following;
    expect(stdout).toContain("before follow");
    expect(stdout).toContain("during follow");
  });
});

describe("job show command", () => {
  let projectDir: string;
  const address = "video:shot.01.motion";

  beforeEach(async () => {
    projectDir = await initWithTestVideo();
  });

  // A running fixture carries a backendJobId and a live lease: without them the job is a
  // stranded submit / unattended one, which is its own (correct) diagnosis and would drown
  // out the one under test.
  async function seedJob(
    variantId: string,
    patch: Parameters<JobManager["updateJob"]>[1] = {},
  ): Promise<JobManager> {
    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({ address, variantId, resolvedDeps: {}, backendKind: "comfy" });
    if (Object.keys(patch).length > 0) {
      await jobManager.updateJob(variantId, {
        backendJobId: "prompt-1",
        lease: { owner: "w-alive", expiresAt: new Date(Date.now() + 60_000).toISOString() },
        ...patch,
      });
    }
    return jobManager;
  }

  // `startedAt` is set-once by JobManager (stamped at the transition into "running"), so a
  // backdated fixture has to be written onto the record whole.
  async function backdate(variantId: string, fields: Record<string, unknown>): Promise<void> {
    const jm = new JobManager(projectDir);
    const job = await jm.getJob(variantId);
    await jm.putJob({ ...job, ...fields } as JobRecord);
  }

  it("separates queue wait from execution time", async () => {
    await seedJob("v-show0001", { status: "running" });
    await backdate("v-show0001", {
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      processingStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    });

    const { stdout } = await run(["job", "show", "v-show0001"], projectDir);

    expect(stdout).toMatch(/ {2}executing {2}.* — 6:00 queued/);
    expect(stdout).toContain("  elapsed    4:00 executing");
  });

  // The case `job list` could not answer: 5h "running" with no progress reads the same as a slow
  // model. The missing execution start tells the two apart, and the queue says why it is missing.
  it("says where in ComfyUI's queue a prompt that never started is waiting", async () => {
    await seedJob("v-show0002", { status: "running" });
    await backdate("v-show0002", {
      startedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });

    const { stdout } = await run(["job", "show", "v-show0002"], projectDir);

    expect(stdout).toContain("executing  not started — next in ComfyUI's queue");
    // Waiting its turn is not a finding — a lost prompt is failed by its waiter instead.
    expect(stdout).not.toContain("Diagnosis:");
  });

  it("carries no diagnosis for a job that is simply working", async () => {
    await seedJob("v-show0003", {
      status: "running",
      processingStartedAt: new Date(Date.now() - 20_000).toISOString(),
    });

    const { stdout } = await run(["job", "show", "v-show0003"], projectDir);

    expect(stdout).not.toContain("Diagnosis:");
  });

  it("names the jobs a pending job is waiting on", async () => {
    const jobManager = await seedJob("v-show0004", { status: "running" });
    await jobManager.createJob({
      address: "video:shot.02.motion",
      variantId: "v-show0005",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnJobs: ["v-show0004"],
    });

    const { stdout } = await run(["job", "show", "v-show0005"], projectDir);

    expect(stdout).toContain("Depends on jobs:");
    expect(stdout).toContain(`  v-show0004  running  ${address}`);
    expect(stdout).toContain("waiting on 1 job(s): v-show0004 (running)");
  });

  it("flags a pending job whose dependency was pruned", async () => {
    const jobManager = new JobManager(projectDir);
    await jobManager.createJob({
      address: "video:shot.03.motion",
      variantId: "v-show0007",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnJobs: ["v-ghost999"],
    });

    const { stdout } = await run(["job", "show", "v-show0007"], projectDir);

    expect(stdout).toContain("Missing dependency jobs: v-ghost999");
    expect(stdout).toContain("will never submit");
  });

  it("fails with JOB_NOT_FOUND for an unknown id", async () => {
    await expect(run(["job", "show", "v-nosuchjob"], projectDir)).rejects.toMatchObject({
      stderr: expect.stringContaining("JOB_NOT_FOUND"),
    });
  });
});
