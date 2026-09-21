import * as fs from "node:fs/promises";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager, jobsDbPath } from "../../core/job-manager.js";
import { JobWatcher } from "../job-watcher.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

function makeFakeServer(): { server: { server: unknown } } {
  const inner = {
    sendLoggingMessage() {},
  };
  return { server: { server: inner } };
}

// The daemon exposes nothing to call, so both counters are read off its internals.
function watching(watcher: JobWatcher): string[] {
  return [...(watcher as unknown as { watchingVariants: Set<string> }).watchingVariants];
}

function countActive(watcher: JobWatcher): Promise<number> {
  return (watcher as unknown as { countActiveJobs(): Promise<number> }).countActiveJobs();
}

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"] });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
});

afterEach(async () => {
  await ws.cleanup();
});

describe("JobWatcher active job counting", () => {
  it("reports no activity for an empty project", async () => {
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");

    expect(await countActive(watcher)).toBe(0);
    expect(watching(watcher)).toEqual([]);
  });

  it("counts queued/running jobs as active", async () => {
    const manager = new JobManager(tmpDir);
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-Aaaaaaaa",
      resolvedDeps: {},
      backendKind: "fal",
    });
    await manager.createJob({
      address: "video:shot.02.motion",
      variantId: "v-Bbbbbbbb",
      resolvedDeps: {},
      backendKind: "fal",
    });

    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");

    expect(await countActive(watcher)).toBe(2);
    expect(watching(watcher)).toEqual([]);
  });
});

describe("watcher startup creates its watched directory", () => {
  // A freshly-init'd project has no .konte; the watcher must create it (and the jobs database)
  // on start so fs.watch can attach (otherwise watch() throws and the first jobs are missed).
  it("JobWatcher.start creates .konte/jobs.db", async () => {
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start();
    watcher.stop();

    await fs.access(jobsDbPath(roots.video));
    expect(watching(watcher)).toEqual([]);
  });
});

describe("JobWatcher poll reconcile", () => {
  // The safety-net poll calls scanForNewJobs; it must pick up a running job even when
  // fs.watch delivered no event for it (the WSL2 / late-attach failure mode).
  it("starts waiting on a running job that fs.watch did not deliver", async () => {
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start();
    expect(watching(watcher)).toEqual([]);

    // Simulate `generate` writing a job the watcher never got an fs event for.
    const jm = new JobManager(tmpDir);
    await jm.createJob({
      address: "video:shot.01.motion",
      variantId: "v-poll0001",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await jm.updateJob("v-poll0001", { status: "running", backendJobId: "x" });

    // What a poll tick does:
    await (watcher as unknown as { scanForNewJobs(): Promise<void> }).scanForNewJobs();
    watcher.stop();

    expect(watching(watcher)).toContain("v-poll0001");
  });
});

describe("JobWatcher fs.watch fast path", () => {
  // A write from another process lands in the WAL sidecar, not the database file itself — the
  // watch on .konte has to fire on that. The row is inserted through a separate connection so the
  // in-process one cannot be what wakes the watcher; the 5s reconcile poll is well outside the wait.
  it("rescans when another connection writes the database", async () => {
    const fake = makeFakeServer();
    const watcher = new JobWatcher(fake.server as never, roots, "v1");
    await watcher.start();
    const scans = vi.spyOn(
      watcher as unknown as { scanForNewJobs(): Promise<void> },
      "scanForNewJobs",
    );

    const now = new Date().toISOString();
    const db = new Database(jobsDbPath(tmpDir));
    db.run(
      "INSERT INTO jobs (id, kind, status, address, created_at, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "v-evt00001",
        "generation",
        "queued",
        "video:shot.01.motion",
        now,
        JSON.stringify({
          kind: "generation",
          id: "v-evt00001",
          address: "video:shot.01.motion",
          variantId: "v-evt00001",
          status: "queued",
          dependsOnAssets: [],
          backendKind: "comfy",
          backendJobId: null,
          progress: null,
          error: null,
          outputFiles: [],
          metadata: {},
          provenance: { workflowHash: null, inputHash: null, resolvedDependencies: {} },
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        }),
      ],
    );
    db.close();

    try {
      await vi.waitFor(() => expect(scans).toHaveBeenCalled(), { timeout: 3000, interval: 50 });
    } finally {
      watcher.stop();
    }
  });
});
