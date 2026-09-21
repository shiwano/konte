import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobManager } from "../../../core/job-manager.js";
import { StateManager } from "../../../core/state/index.js";
import { cascadeFailPendingJobs } from "../clean-utils.js";

describe("cascadeFailPendingJobs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("skips bare shot-level feedback targets instead of throwing INVALID_ADDRESS", async () => {
    // A feedback-only target (no asset name) can't parse as an asset path; with no pending jobs
    // to cascade, this returns before touching the filesystem or job manager.
    const result = await cascadeFailPendingJobs(tmpDir, ["video:shot.02"], [], {} as JobManager, {
      dryRun: true,
    });
    expect(result).toEqual([]);
  });

  it("still cascade-fails a real removed dependency alongside a feedback-only target", async () => {
    await StateManager.init(tmpDir);
    const jobManager = new JobManager(tmpDir);
    const job = await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-motion",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:shot.01.motion"],
    });
    expect(job.status).toBe("pending");

    const result = await cascadeFailPendingJobs(
      tmpDir,
      ["video:shot.02", "video:shot.01.motion"],
      [job],
      jobManager,
      { dryRun: true },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.variantId).toBe("v-motion");
    expect(result[0]?.address).toBe("video:shot.01.motion");
  });

  it("leaves a job the watcher submitted after the snapshot alone (it holds a live backend job)", async () => {
    await StateManager.init(tmpDir);
    const jobManager = new JobManager(tmpDir);
    const snapshot = await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-motion",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:shot.01.motion"],
    });
    // While the user reads the confirmation prompt, the watcher submits it to the backend.
    await jobManager.updateJob("v-motion", { status: "running", backendJobId: "comfy-1" });

    const result = await cascadeFailPendingJobs(
      tmpDir,
      ["video:shot.01.motion"],
      [snapshot],
      jobManager,
      { dryRun: false },
    );

    expect(result).toEqual([]);
    const job = await jobManager.getJob("v-motion");
    expect(job.status).toBe("running");
    expect(job.kind === "generation" && job.backendJobId).toBe("comfy-1");
  });

  it("leaves a job the watcher completed after the snapshot alone (no failed-over-completed)", async () => {
    await StateManager.init(tmpDir);
    const jobManager = new JobManager(tmpDir);
    // The snapshot `clean` took before its confirmation prompt: still pending.
    const snapshot = await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-motion",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:shot.01.motion"],
    });
    // While the user reads the prompt, the watcher submits and completes it.
    await jobManager.updateJob("v-motion", {
      status: "completed",
      outputFiles: ["out/motion.mp4"],
      completedAt: new Date().toISOString(),
    });

    const result = await cascadeFailPendingJobs(
      tmpDir,
      ["video:shot.01.motion"],
      [snapshot],
      jobManager,
      { dryRun: false },
    );

    expect(result).toEqual([]);
    const job = await jobManager.getJob("v-motion");
    expect(job.status).toBe("completed");
    expect(job.kind === "generation" && job.outputFiles).toEqual(["out/motion.mp4"]);
  });
});
