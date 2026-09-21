import { describe, expect, it } from "vitest";
import {
  comfyQueueAhead,
  computeJobTiming,
  diagnoseJob,
  jobStatusFlags,
} from "../job-diagnosis.js";
import type { JobStatBucket } from "../job-stats.js";
import type { ComfyModelDownloadJob, GenerationJob } from "../types/index.js";

const NOW = new Date("2026-01-01T06:00:00.000Z").getTime();
const iso = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;

function generationJob(patch: Partial<GenerationJob> = {}): GenerationJob {
  return {
    kind: "generation",
    id: "v-test0001",
    variantId: "v-test0001",
    address: "video:shot.01.motion",
    status: "running",
    backendKind: "comfy",
    backendJobId: "prompt-1",
    submissionStartedAt: null,
    dependsOnJobs: [],
    dependsOnAssets: [],
    outputFiles: [],
    provenance: {
      workflowHash: null,
      inputHash: null,
      resolvedDependencies: {},
      compositionCacheKeys: {},
    },
    lease: { owner: "w-alive", expiresAt: iso(-30_000) },
    progress: null,
    error: null,
    metadata: {},
    createdAt: iso(HOUR),
    startedAt: iso(HOUR),
    processingStartedAt: iso(59 * MIN),
    updatedAt: iso(MIN),
    completedAt: null,
    unconfirmedSince: null,
    sourceFingerprint: null,
    staleReleases: 0,
    ...patch,
  };
}

function modelDownloadJob(patch: Partial<ComfyModelDownloadJob> = {}): ComfyModelDownloadJob {
  const { kind: _kind, ...base } = generationJob();
  return {
    ...base,
    kind: "comfy-model-download",
    model: { filename: "krea2_turbo.safetensors", type: "diffusion_model", url: "https://x/m" },
    startedAt: iso(26 * MIN),
    processingStartedAt: null,
    ...patch,
  };
}

function bucket(patch: Partial<JobStatBucket> = {}): JobStatBucket {
  return {
    backendKind: "comfy",
    adapterKey: "animate.json",
    count: 10,
    p50Ms: 47_000,
    p90Ms: 109_000,
    meanMs: 78_000,
    lastRunAt: iso(HOUR),
    modes: null,
    ...patch,
  };
}

describe("computeJobTiming", () => {
  it("splits a comfy run into queue wait and execution time", () => {
    const timing = computeJobTiming(
      generationJob({ startedAt: iso(10 * MIN), processingStartedAt: iso(4 * MIN) }),
      NOW,
    );
    expect(timing.queuedMs).toBe(6 * MIN);
    expect(timing.elapsedMs).toBe(4 * MIN);
    expect(timing.elapsedFrom).toBe("execution");
  });

  it("measures from submit, and reports no queue wait, until execution starts", () => {
    const timing = computeJobTiming(
      generationJob({ startedAt: iso(10 * MIN), processingStartedAt: null }),
      NOW,
    );
    expect(timing.queuedMs).toBeNull();
    expect(timing.elapsedMs).toBe(10 * MIN);
    expect(timing.elapsedFrom).toBe("submit");
  });

  it("has no elapsed window while the job is still pending", () => {
    const timing = computeJobTiming(
      generationJob({ status: "pending", startedAt: null, processingStartedAt: null }),
      NOW,
    );
    expect(timing.elapsedMs).toBeNull();
    expect(timing.elapsedFrom).toBeNull();
    expect(timing.totalMs).toBe(HOUR);
  });
});

const has = (lines: string[], text: string) => lines.some((l) => l.includes(text));

describe("diagnoseJob", () => {
  it("says nothing about a job that is simply working", () => {
    const job = generationJob({ startedAt: iso(MIN), processingStartedAt: iso(40_000) });
    expect(diagnoseJob({ job, stats: bucket(), now: NOW })).toEqual([]);
  });

  // A serial queue explains the wait, however long it runs. A prompt ComfyUI actually lost is
  // failed by its waiter within a poll or two; one with no waiter is called `unwatched`.
  it("says nothing about a comfy prompt that is still waiting its turn", () => {
    const job = generationJob({ startedAt: iso(6 * HOUR), processingStartedAt: null });
    expect(diagnoseJob({ job, stats: bucket(), now: NOW })).toEqual([]);
  });

  // The wait measures the queue, not the model, so it must not be read as one endless run.
  it("does not call a queue wait an outlier run", () => {
    const job = generationJob({ startedAt: iso(6 * HOUR), processingStartedAt: null });
    expect(has(diagnoseJob({ job, stats: bucket(), now: NOW }), "far longer than this")).toBe(
      false,
    );
  });

  it("flags a run far past the adapter's p90", () => {
    const job = generationJob({ startedAt: iso(HOUR), processingStartedAt: iso(50 * MIN) });
    expect(has(diagnoseJob({ job, stats: bucket(), now: NOW }), "far longer than this")).toBe(true);
  });

  it("will not call an outlier without enough samples to have a p90", () => {
    const job = generationJob({ startedAt: iso(HOUR), processingStartedAt: iso(50 * MIN) });
    expect(has(diagnoseJob({ job, stats: bucket({ count: 2 }), now: NOW }), "far longer")).toBe(
      false,
    );
  });

  it("flags a running job whose run lease has lapsed as unattended", () => {
    const job = generationJob({ lease: { owner: "w-dead", expiresAt: iso(4 * HOUR) } });
    const found = diagnoseJob({ job, now: NOW });
    expect(has(found, "No worker holds this job's run lease")).toBe(true);
    expect(has(found, "4:00:00 ago")).toBe(true);
  });

  // A stranded submit is a lapsed lease too; it must not also produce the vaguer line.
  it("reports a stranded submit instead of a bare unattended lease", () => {
    const job = generationJob({ backendJobId: null, lease: null });
    const found = diagnoseJob({ job, now: NOW });
    expect(has(found, "next worker can retry")).toBe(true);
    expect(has(found, "No worker holds")).toBe(false);
  });

  it("refuses to promise resubmission when a remote acknowledgement was lost", () => {
    const job = generationJob({ backendJobId: null, lease: null, submissionStartedAt: iso(MIN) });
    expect(diagnoseJob({ job, now: NOW }).join(" ")).toContain("Automatic resubmission is refused");
  });

  it("names the jobs a pending job is waiting on", () => {
    const blocker = generationJob({ id: "cmd-abc", status: "running" });
    const job = generationJob({
      status: "pending",
      startedAt: null,
      processingStartedAt: null,
      dependsOnJobs: ["cmd-abc"],
    });
    const found = diagnoseJob({ job, dependencies: [blocker], now: NOW });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("waiting on 1 job(s): cmd-abc (running)");
  });

  it("flags a pending job whose dependency job no longer exists", () => {
    const job = generationJob({
      status: "pending",
      startedAt: null,
      processingStartedAt: null,
      dependsOnJobs: ["cmd-gone"],
    });
    // dependencies resolved to empty — the id didn't match any record (pruned).
    const found = diagnoseJob({ job, dependencies: [], now: NOW });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("cmd-gone");
    expect(found[0]).toContain("will never submit");
  });

  it("does not judge missing dependencies when the caller passed none to resolve", () => {
    const job = generationJob({
      status: "pending",
      startedAt: null,
      processingStartedAt: null,
      dependsOnJobs: ["cmd-gone"],
    });
    // No `dependencies` key at all → the caller didn't resolve them, so no missing-dep claim.
    expect(diagnoseJob({ job, now: NOW })).toEqual([]);
  });

  it("stays quiet once a pending job's dependencies are all terminal", () => {
    const blocker = generationJob({ id: "cmd-abc", status: "completed" });
    const job = generationJob({
      status: "pending",
      startedAt: null,
      processingStartedAt: null,
      dependsOnJobs: ["cmd-abc"],
    });
    expect(diagnoseJob({ job, dependencies: [blocker], now: NOW })).toEqual([]);
  });

  it("surfaces a backend that stopped answering status checks", () => {
    const job = generationJob({ unconfirmedSince: iso(20 * MIN) });
    expect(has(diagnoseJob({ job, now: NOW }), "Status checks against the backend")).toBe(true);
  });

  it("carries a failed job's error and drops the live-state checks", () => {
    const job = generationJob({
      status: "failed",
      error: "Prompt is absent from ComfyUI's queue and history",
      completedAt: iso(MIN),
      lease: { owner: "w-dead", expiresAt: iso(HOUR) },
    });
    expect(diagnoseJob({ job, now: NOW })).toEqual([
      "Prompt is absent from ComfyUI's queue and history",
    ]);
  });
});

describe("jobStatusFlags", () => {
  it("flags nothing on a job that is simply working", () => {
    const job = generationJob({ startedAt: iso(MIN), processingStartedAt: iso(40_000) });
    expect(jobStatusFlags({ job, stats: bucket(), now: NOW })).toEqual([]);
  });

  it("names every non-progressing state at once", () => {
    const job = generationJob({
      startedAt: iso(6 * HOUR),
      processingStartedAt: null,
      lease: { owner: "w-dead", expiresAt: iso(4 * HOUR) },
      unconfirmedSince: iso(20 * MIN),
    });
    expect(jobStatusFlags({ job, stats: bucket(), now: NOW })).toEqual([
      "unconfirmed",
      "unwatched",
    ]);
  });

  it("leaves a comfy prompt waiting its turn unflagged, however long the queue runs", () => {
    const job = generationJob({ startedAt: iso(6 * HOUR), processingStartedAt: null });
    expect(jobStatusFlags({ job, stats: bucket(), now: NOW })).toEqual([]);
  });

  it("leaves a long-running model download unflagged — it has no prompt to execute", () => {
    const job = modelDownloadJob();
    expect(jobStatusFlags({ job, now: NOW })).toEqual([]);
    expect(diagnoseJob({ job, now: NOW })).toEqual([]);
  });

  it("prefers the stranded call over the vaguer unwatched one", () => {
    const job = generationJob({ backendJobId: null, lease: null });
    expect(jobStatusFlags({ job, now: NOW })).toEqual(["stranded"]);
  });

  // Every flag reads the caller's clock, so a fixed `now` can't have one predicate judging the
  // same lease against the real one.
  it("judges a submit lease against the caller's clock, not the real one", () => {
    const live = generationJob({
      backendJobId: null,
      lease: { owner: "w-submitting", expiresAt: iso(-30_000) },
    });
    expect(jobStatusFlags({ job: live, now: NOW })).toEqual([]);

    const lapsed = generationJob({
      backendJobId: null,
      lease: { owner: "w-submitting", expiresAt: iso(1) },
    });
    expect(jobStatusFlags({ job: lapsed, now: NOW })).toEqual(["stranded"]);
  });

  // A run merely past its adapter's p90 is still progressing — `job show` is where that lives.
  it("does not flag a slow but live run", () => {
    const job = generationJob({ startedAt: iso(HOUR), processingStartedAt: iso(50 * MIN) });
    expect(jobStatusFlags({ job, stats: bucket(), now: NOW })).toEqual([]);
  });

  it("says nothing about a terminal job", () => {
    const job = generationJob({ status: "failed", completedAt: iso(MIN), lease: null });
    expect(jobStatusFlags({ job, now: NOW })).toEqual([]);
  });
});

describe("comfyQueueAhead", () => {
  const waiting = (id: string, enqueuedMsAgo: number) =>
    generationJob({ id, variantId: id, startedAt: iso(enqueuedMsAgo), processingStartedAt: null });

  it("counts the executing prompt plus every prompt enqueued earlier", () => {
    const executing = generationJob({
      id: "v-exec",
      variantId: "v-exec",
      startedAt: iso(30 * MIN),
      processingStartedAt: iso(MIN),
    });
    const first = waiting("v-first", 20 * MIN);
    const second = waiting("v-second", 10 * MIN);
    const peers = [executing, first, second];

    expect(comfyQueueAhead(executing, peers)).toBeNull();
    expect(comfyQueueAhead(first, peers)).toBe(1);
    expect(comfyQueueAhead(second, peers)).toBe(2);
  });

  it("gives a batch enqueued in the same millisecond distinct positions", () => {
    const a = waiting("v-aaa", 10 * MIN);
    const b = waiting("v-bbb", 10 * MIN);
    const c = waiting("v-ccc", 10 * MIN);
    const peers = [a, b, c];

    expect([a, b, c].map((j) => comfyQueueAhead(j, peers))).toEqual([0, 1, 2]);
  });

  it("has no position for a prompt that is not waiting on comfy's queue", () => {
    const peers = [waiting("v-first", 20 * MIN)];
    expect(comfyQueueAhead(generationJob({ backendKind: "fal" }), peers)).toBeNull();
    expect(comfyQueueAhead(modelDownloadJob(), peers)).toBeNull();
    expect(comfyQueueAhead(waiting("v-done", 20 * MIN), [])).toBe(0);
  });

  it("ignores terminal and not-yet-submitted peers — neither holds the queue", () => {
    const job = waiting("v-mine", 5 * MIN);
    const peers = [
      job,
      generationJob({ id: "v-done", variantId: "v-done", status: "completed" }),
      generationJob({
        id: "v-pending",
        variantId: "v-pending",
        status: "pending",
        startedAt: null,
        processingStartedAt: null,
      }),
    ];
    expect(comfyQueueAhead(job, peers)).toBe(0);
  });
});
