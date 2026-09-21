import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitForJobResult } from "../../backends/wait-for-job.js";
import { JobManager } from "../../core/job-manager.js";
import type { JobRecord } from "../../core/types/index.js";
import { JobWatcher } from "../job-watcher.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

// Mock the two modules processJob reaches before its submitPending guard, so the
// guard can be exercised without a real video.tsx or a 5s id-wait. loadDefinitions
// must succeed; waitForJob's result is supplied per-test.
const { waitForJobMock, submitReadyPendingJobsMock } = vi.hoisted(() => ({
  waitForJobMock: vi.fn(),
  submitReadyPendingJobsMock: vi.fn(
    async (): Promise<{ submitted: string[]; failed: string[] }> => ({
      submitted: [],
      failed: [],
    }),
  ),
}));
vi.mock("../../backends/wait-for-job.js", () => ({ waitForJob: waitForJobMock }));
vi.mock("../../core/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/loader.js")>()),
  reloadVideoDefinition: vi.fn(async () => ({ profiles: {}, shots: [] })),
  loadAnimatic: vi.fn(async () => ({ stage: "animatic", shots: [] })),
  loadReference: vi.fn(async () => ({ stage: "reference", shots: [] })),
}));
vi.mock("../../core/pending-jobs.js", () => ({
  submitReadyPendingJobs: submitReadyPendingJobsMock,
}));

type LoggedEvent = { level: string; data: Record<string, unknown> };

function makeFakeServer(): { server: { server: unknown }; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  const inner = {
    sendLoggingMessage(msg: LoggedEvent) {
      events.push(msg);
    },
  };
  return { server: { server: inner }, events };
}

// The daemon keeps no completion buffer of its own.
function completions(events: LoggedEvent[]): Array<Record<string, unknown>> {
  return events.filter((e) => e.data.event === "job_completed").map((e) => e.data);
}

// processJob's loadDefinitions needs no video.tsx here: maybeNotifyTerminal emits without
// loading definitions, and handleJobCompleted's cascade swallows the missing video.tsx error.
type TerminalNotifier = {
  maybeNotifyTerminal(id: string): Promise<boolean>;
};

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let jobManager: JobManager;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"] });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  jobManager = new JobManager(tmpDir);
});

afterEach(async () => {
  waitForJobMock.mockReset();
  submitReadyPendingJobsMock.mockReset();
  submitReadyPendingJobsMock.mockResolvedValue({ submitted: [], failed: [] });
  await ws.cleanup();
});

type ExportNotifier = {
  emitExportJobCompleted(
    id: string,
    status: "completed" | "failed" | "cancelled",
    outputFile: string | null,
  ): Promise<void>;
};

describe("JobWatcher export-job completion", () => {
  it("emits the export as a first-class completion", async () => {
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");

    await (watcher as unknown as ExportNotifier).emitExportJobCompleted(
      "exp-abc123",
      "completed",
      "dist/final/20260101T000000000/video.mp4",
    );

    // The deliverable stays video-root-relative, exactly as state stores it.
    const completed = completions(fake.events);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      variantId: "exp-abc123",
      kind: "export",
      status: "completed",
      outputFile: "dist/final/20260101T000000000/video.mp4",
    });
  });

  it("dedups a repeated export completion", async () => {
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const notifier = watcher as unknown as ExportNotifier;

    await notifier.emitExportJobCompleted("exp-dup", "completed", "dist/final/x/video.mp4");
    await notifier.emitExportJobCompleted("exp-dup", "completed", "dist/final/x/video.mp4");

    expect(completions(fake.events)).toHaveLength(1);
  });
});

describe("JobWatcher terminal observation", () => {
  it("emits once for a job that completed out from under us", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-term0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-term0001", {
      status: "completed",
      outputFiles: ["out/shot01.mp4"],
      completedAt: new Date().toISOString(),
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const notifier = watcher as unknown as TerminalNotifier;

    expect(await notifier.maybeNotifyTerminal("v-term0001")).toBe(true);

    expect(completions(fake.events)).toHaveLength(1);
    expect(completions(fake.events)[0]).toMatchObject({
      variantId: "v-term0001",
      status: "completed",
    });
  });

  it("does not re-emit on a second call (dedup)", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-term0002",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-term0002", {
      status: "failed",
      error: "boom",
      completedAt: new Date().toISOString(),
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const notifier = watcher as unknown as TerminalNotifier;

    await notifier.maybeNotifyTerminal("v-term0002");
    await notifier.maybeNotifyTerminal("v-term0002");

    expect(completions(fake.events)).toHaveLength(1);
    expect(completions(fake.events)[0]!.status).toBe("failed");
  });

  it("does not emit a false completion for a job still mid-submit", async () => {
    // The reported bug: a job claimed "running" with no backendJobId yet (submit in flight) must
    // never surface as a completion with "No backend job ID" as its error.
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-mid00001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-mid00001", { status: "running" }); // backendJobId still null

    waitForJobMock.mockResolvedValue({
      variantId: "v-mid00001",
      kind: "generation",
      address: "video:shot.01.motion",
      status: "running",
      outputFiles: [],
      thumbnails: [],
      error: null,
      alreadyTerminal: false,
      submitPending: true,
    } satisfies WaitForJobResult);

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const internals = watcher as unknown as {
      watchingVariants: Set<string>;
      processJob(id: string): Promise<void>;
    };
    internals.watchingVariants.add("v-mid00001");

    await internals.processJob("v-mid00001");

    // Nothing emitted — not a completion. And the variant is un-watched so a later scan
    // re-attempts once the backendJobId commits (dedup is not poisoned).
    expect(completions(fake.events)).toEqual([]);
    expect(internals.watchingVariants.has("v-mid00001")).toBe(false);
  });

  it("reports a watch that could not attach, once per distinct error", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-broke001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-broke001", { status: "running", backendJobId: "prompt-1" });

    // A broken video.tsx surfaces here: processJob throws before it can wait on anything, and the
    // 5s poll re-attempts forever — silently, until this warning.
    waitForJobMock.mockRejectedValue(new Error("video.tsx failed to load"));

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const internals = watcher as unknown as {
      watchingVariants: Set<string>;
      processJob(id: string): Promise<void>;
    };

    for (let i = 0; i < 3; i++) {
      internals.watchingVariants.add("v-broke001");
      await internals.processJob("v-broke001");
    }

    const failures = fake.events.filter((e) => e.data.event === "job_watch_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.level).toBe("warning");
    expect(failures[0]!.data).toMatchObject({
      variantId: "v-broke001",
      error: "video.tsx failed to load",
    });
    expect(completions(fake.events)).toEqual([]);
    expect(internals.watchingVariants.has("v-broke001")).toBe(false);
  });

  it("keeps one job's failure standing while another job attaches fine", async () => {
    // Watches run concurrently: a working job's success must not clear a broken job's still-
    // standing failure, or the 5s poll re-reports it forever.
    for (const id of ["v-broke002", "v-fine0001"]) {
      await jobManager.createJob({
        address: "video:shot.01.motion",
        variantId: id,
        resolvedDeps: {},
        backendKind: "comfy",
      });
      await jobManager.updateJob(id, { status: "running", backendJobId: `prompt-${id}` });
    }

    waitForJobMock.mockImplementation(async (_jm: unknown, variantId: string) => {
      if (variantId === "v-broke002") throw new Error("FAL_KEY is not set");
      return {
        variantId,
        kind: "generation",
        address: "video:shot.01.motion",
        status: "running",
        outputFiles: [],
        thumbnails: [],
        error: null,
        alreadyTerminal: false,
        submitPending: true,
      } satisfies WaitForJobResult;
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const internals = watcher as unknown as {
      watchingVariants: Set<string>;
      processJob(id: string): Promise<void>;
    };

    for (let i = 0; i < 3; i++) {
      internals.watchingVariants.add("v-broke002");
      internals.watchingVariants.add("v-fine0001");
      await Promise.all([internals.processJob("v-broke002"), internals.processJob("v-fine0001")]);
    }

    expect(fake.events.filter((e) => e.data.event === "job_watch_failed")).toHaveLength(1);
  });

  it("skips non-terminal jobs without emitting", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-term0003",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-term0003", { status: "running" });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const notifier = watcher as unknown as TerminalNotifier;

    expect(await notifier.maybeNotifyTerminal("v-term0003")).toBe(false);
    expect(completions(fake.events)).toEqual([]);
  });
});

describe("JobWatcher startup", () => {
  it("does not emit for a job that was already terminal before start", async () => {
    // A completion that landed while the daemon was down belongs to `konte status`.
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-pre00001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-pre00001", {
      status: "completed",
      outputFiles: ["out/shot01.mp4"],
      completedAt: "2026-07-12T10:00:00.000Z",
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start();
    watcher.stop();

    expect(completions(fake.events)).toEqual([]);
  });

  it("does not emit for a failure that predates start", async () => {
    await jobManager.createJob({
      address: "video:shot.03.motion",
      variantId: "v-prefail1",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-prefail1", {
      status: "failed",
      error: "boom",
      completedAt: "2026-07-12T10:00:00.000Z",
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start();
    watcher.stop();

    expect(completions(fake.events)).toEqual([]);
  });
});

describe("JobWatcher live terminal observation", () => {
  type Scanner = { scanForNewJobs(): Promise<void> };

  it("emits for a job first observed terminal during the session", async () => {
    // Never caught running/queued by this watcher (e.g. finished by a concurrent `konte job wait`
    // before a waiter attached). The scan is the only path that can still emit it, so it must.
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start(); // no jobs yet → empty startup baseline

    await jobManager.createJob({
      address: "video:shot.03.motion",
      variantId: "v-race0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-race0001", {
      status: "failed",
      error: "boom",
      completedAt: new Date().toISOString(),
    });

    await (watcher as unknown as Scanner).scanForNewJobs();
    watcher.stop();

    expect(completions(fake.events)).toHaveLength(1);
    expect(completions(fake.events)[0]).toMatchObject({
      variantId: "v-race0001",
      status: "failed",
    });
  });

  it("stays silent for a terminal job that predates the session across later scans", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-base0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-base0001", {
      status: "failed",
      error: "old boom",
      completedAt: new Date().toISOString(),
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start(); // v-base0001 terminal at startup → baselined
    await (watcher as unknown as Scanner).scanForNewJobs();
    watcher.stop();

    expect(completions(fake.events)).toEqual([]);
  });
});

describe("JobWatcher cascade readiness pre-check", () => {
  function watcher(): { hasActionablePendingJob(jobs: JobRecord[]): boolean } {
    return new JobWatcher(makeFakeServer().server as never, roots, "v1") as unknown as {
      hasActionablePendingJob(jobs: JobRecord[]): boolean;
    };
  }

  const modelJob = (status: JobRecord["status"]): JobRecord =>
    ({ kind: "comfy-model-download", id: "cmd-x", status }) as unknown as JobRecord;
  const dependentJob = (): JobRecord =>
    ({
      kind: "generation",
      id: "v-dep0001",
      status: "pending",
      dependsOnJobs: ["cmd-x"],
    }) as unknown as JobRecord;

  it("is not actionable while the prerequisite job is still in flight", () => {
    expect(watcher().hasActionablePendingJob([modelJob("running"), dependentJob()])).toBe(false);
  });

  it("becomes actionable once the prerequisite job settles", () => {
    expect(watcher().hasActionablePendingJob([modelJob("completed"), dependentJob()])).toBe(true);
  });

  it("is not actionable when there are no pending generation jobs", () => {
    expect(watcher().hasActionablePendingJob([modelJob("running")])).toBe(false);
  });

  it("is actionable when a failed prerequisite precedes an in-flight one (fail path is due now)", () => {
    // evaluateJob returns on the FIRST non-completed dep, so [failed, running] is a fail, not a
    // wait — the pre-check must not defer the failure until the unrelated in-flight dep settles.
    const jobs: JobRecord[] = [
      { kind: "comfy-model-download", id: "cmd-bad", status: "failed" } as unknown as JobRecord,
      { kind: "comfy-node-activate", id: "cna-run", status: "running" } as unknown as JobRecord,
      {
        kind: "generation",
        id: "v-dep0002",
        status: "pending",
        dependsOnJobs: ["cmd-bad", "cna-run"],
      } as unknown as JobRecord,
    ];
    expect(watcher().hasActionablePendingJob(jobs)).toBe(true);
  });

  it("is actionable when a prerequisite job has gone missing (fail path is due now)", () => {
    const jobs: JobRecord[] = [
      {
        kind: "generation",
        id: "v-dep0003",
        status: "pending",
        dependsOnJobs: ["cmd-gone"],
      } as unknown as JobRecord,
    ];
    expect(watcher().hasActionablePendingJob(jobs)).toBe(true);
  });
});

describe("JobWatcher dedup pruning", () => {
  it("forgets a handled id once its job is reset to a non-terminal state, so it can re-record", async () => {
    // A deterministic model/node id is reset in place on retry: the stale "handled" mark must not
    // suppress the eventual completion.
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-reset001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-reset001", { status: "pending" });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const internals = watcher as unknown as {
      handledJobs: Set<string>;
      loggedSubmissions: Set<string>;
      pruneDedupState(jobs: JobRecord[]): void;
    };
    internals.handledJobs.add("v-reset001");
    internals.loggedSubmissions.add("v-reset001");

    internals.pruneDedupState(await jobManager.listJobs());

    expect(internals.handledJobs.has("v-reset001")).toBe(false);
    expect(internals.loggedSubmissions.has("v-reset001")).toBe(false);
  });

  it("keeps a handled id while its job stays terminal", async () => {
    await jobManager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-keep0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jobManager.updateJob("v-keep0001", {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    const internals = watcher as unknown as {
      handledJobs: Set<string>;
      pruneDedupState(jobs: JobRecord[]): void;
    };
    internals.handledJobs.add("v-keep0001");

    internals.pruneDedupState(await jobManager.listJobs());

    expect(internals.handledJobs.has("v-keep0001")).toBe(true);
  });
});
