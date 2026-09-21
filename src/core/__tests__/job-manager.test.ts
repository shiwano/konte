import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JobManager, jobsDbPath } from "../job-manager.js";
import type { JobRecord } from "../types/index.js";

let tmpDir: string;
let manager: JobManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-test-"));
  await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
  manager = new JobManager(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A row written past the manager's validation, as a crafted or damaged database would hold.
function insertRaw(id: string, data: string): void {
  const db = new Database(jobsDbPath(tmpDir));
  db.run(
    "INSERT INTO jobs (id, kind, status, address, created_at, data) VALUES (?, ?, ?, ?, ?, ?)",
    [id, "generation", "queued", null, "2026-01-01T00:00:00.000Z", data],
  );
  db.close();
}

describe("ensureDirs", () => {
  it("creates the jobs database and the logs directory", async () => {
    await manager.ensureDirs();

    await fs.access(jobsDbPath(tmpDir));
    await fs.access(path.join(tmpDir, ".konte", "logs"));
  });
});

describe("Job CRUD", () => {
  it("creates a job keyed by variant ID", async () => {
    const job = await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    expect(job.address).toBe("video:shot.01.motion");
    expect(job.variantId).toBe("v-abc12345");
    expect(job.status).toBe("queued");
    expect(job.backendJobId).toBeNull();

    expect((await manager.getJob("v-abc12345")).id).toBe("v-abc12345");
  });

  it("creates a pending job with dependsOnAssets", async () => {
    const job = await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "fal",
      dependsOnAssets: ["video:shot.01.image"],
      metadata: { definitionHash: "abc123" },
    });

    expect(job.status).toBe("pending");
    expect(job.dependsOnAssets).toEqual(["video:shot.01.image"]);
    expect(job.metadata).toEqual({ definitionHash: "abc123" });
    expect(job.provenance.resolvedDependencies).toEqual({});
  });

  it("throws when job file already exists for variant", async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    await expect(
      manager.createJob({
        address: "video:shot.01.motion",
        variantId: "v-abc12345",
        resolvedDeps: {},
        backendKind: "comfy",
      }),
    ).rejects.toMatchObject({ code: "STATE_ALREADY_EXISTS" });
  });

  it("updates a job", async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    const updated = await manager.updateJob("v-abc12345", {
      status: "running",
      backendJobId: "prompt-123",
      progress: 50,
    });

    expect(updated.status).toBe("running");
    expect(updated.kind).toBe("generation");
    if (updated.kind !== "generation") throw new Error("expected generation job");
    expect(updated.backendJobId).toBe("prompt-123");
    expect(updated.progress).toBe(50);
  });

  it("stamps processingStartedAt once and never overwrites it", async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-proc1234",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    const first = await manager.updateJob("v-proc1234", {
      processingStartedAt: "2026-01-01T00:08:00.000Z",
    });
    expect(first.processingStartedAt).toBe("2026-01-01T00:08:00.000Z");

    // A later observation (e.g. a lease reclaimer) must not clobber the earlier true start.
    const second = await manager.updateJob("v-proc1234", {
      processingStartedAt: "2026-01-01T00:09:00.000Z",
    });
    expect(second.processingStartedAt).toBe("2026-01-01T00:08:00.000Z");

    // An unrelated update leaves the stamp intact.
    const third = await manager.updateJob("v-proc1234", { progress: 50 });
    expect(third.processingStartedAt).toBe("2026-01-01T00:08:00.000Z");
  });

  it("lists jobs with filter", async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-aaa11111",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-bbb22222",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await manager.updateJob("v-aaa11111", { status: "completed" });

    const allJobs = await manager.listJobs();
    expect(allJobs).toHaveLength(2);

    const readyJobs = await manager.listJobs({ status: "completed" });
    expect(readyJobs).toHaveLength(1);
    const readyJob = readyJobs[0]!;
    if (readyJob.kind !== "generation") throw new Error("expected generation job");
    expect(readyJob.variantId).toBe("v-aaa11111");

    const queuedJobs = await manager.listJobs({ status: "queued" });
    expect(queuedJobs).toHaveLength(1);
    const queuedJob = queuedJobs[0]!;
    if (queuedJob.kind !== "generation") throw new Error("expected generation job");
    expect(queuedJob.variantId).toBe("v-bbb22222");
  });

  it("skips a row that is not a job record instead of crashing", async () => {
    await manager.ensureDirs();
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-live1234",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    // A row whose payload does not parse must be skipped like an invalid record, not surface as
    // a crash that takes down status/clean/prune/job list.
    insertRaw("v-gone9999", "not json");

    const jobs = await manager.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("v-live1234");
  });

  it("stamps startedAt on the first transition to running and keeps it after", async () => {
    const created = await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    expect(created.startedAt).toBeNull();

    const running = await manager.updateJob("v-abc12345", { status: "running" });
    expect(running.startedAt).not.toBeNull();

    const later = await manager.updateJob("v-abc12345", { progress: 50 });
    expect(later.startedAt).toBe(running.startedAt);

    const done = await manager.updateJob("v-abc12345", { status: "completed" });
    expect(done.startedAt).toBe(running.startedAt);
  });

  it("rejects a variant id that is not a single path-safe segment", async () => {
    await expect(
      manager.createJob({
        address: "video:shot.01.motion",
        variantId: "../../tmp/evil",
        resolvedDeps: {},
        backendKind: "comfy",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await manager.listJobs()).toHaveLength(0);
  });

  it("rejects a malformed id on lookup rather than reporting it missing", async () => {
    await expect(manager.getJob("../../etc/passwd")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("throws JOB_NOT_FOUND for non-existent job", async () => {
    await expect(manager.getJob("v-nonexist")).rejects.toMatchObject({
      code: "JOB_NOT_FOUND",
    });
  });

  it("rejects a crafted job record whose ids/outputDir would traverse outside the project", async () => {
    await manager.ensureDirs();
    const base = {
      kind: "export",
      status: "pending",
      backendKind: "local",
      dependsOnJobs: [],
      dependsOnAssets: [],
      lease: null,
      outputDir: "dist/final",
      outputFile: null,
      allowUnaccepted: false,
      progress: null,
      error: null,
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      unconfirmedSince: null,
      sourceFingerprint: null,
      staleReleases: 0,
    };

    const cases = [
      { id: "exp-trav", outputDir: "../../etc" }, // traversal in outputDir
      { id: "exp-abs", outputDir: "/etc/cron.d" }, // absolute outputDir
      { id: "exp-evil", outputDir: "dist/final", evilId: "../../../../tmp/evil" }, // traversal in id
    ];

    for (const c of cases) {
      const record = { ...base, id: c.evilId ?? c.id, outputDir: c.outputDir };
      insertRaw(c.id, JSON.stringify(record));
      await expect(manager.getJob(c.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }

    // listJobs silently skips invalid records rather than surfacing them.
    expect(await manager.listJobs()).toHaveLength(0);
  });
});

describe("ensureComfyNodeInstallJob", () => {
  const NODE = { id: "comfyui-kjnodes" };

  it("resets a failed job so the retry reuses the same file", async () => {
    const { id } = await manager.ensureComfyNodeInstallJob(NODE);
    await manager.updateJob(id, { status: "failed", error: "boom" });

    const again = await manager.ensureComfyNodeInstallJob(NODE);
    expect(again.id).toBe(id);
    expect(again.reset).toBe(true);

    const job = await manager.getJob(id);
    expect(job.status).toBe("pending");
    expect(job.error).toBeNull();
  });

  // A confirmed absence retires the record; see the model equivalent for why that matters.
  it("resets a completed job when the pack's absence was confirmed", async () => {
    const { id } = await manager.ensureComfyNodeInstallJob(NODE);
    await manager.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

    const again = await manager.ensureComfyNodeInstallJob(NODE, { resetCompleted: true });

    expect(again).toEqual({ id, created: false, reset: true });
    const job = await manager.getJob(id);
    expect(job.status).toBe("pending");
    expect(job.completedAt).toBeNull();
  });

  // An unreachable Manager reports every pack missing — not grounds for a reinstall sweep.
  it("keeps a completed job when the absence was only assumed", async () => {
    const { id } = await manager.ensureComfyNodeInstallJob(NODE);
    await manager.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

    expect(await manager.ensureComfyNodeInstallJob(NODE)).toEqual({
      id,
      created: false,
      reset: false,
    });
    expect((await manager.getJob(id)).status).toBe("completed");
  });

  it("leaves an in-flight job alone", async () => {
    const { id } = await manager.ensureComfyNodeInstallJob(NODE);
    await manager.updateJob(id, { status: "running" });

    expect(await manager.ensureComfyNodeInstallJob(NODE)).toEqual({
      id,
      created: false,
      reset: false,
    });
    expect((await manager.getJob(id)).status).toBe("running");
  });
});

describe("ensureComfyNodeActivateJob", () => {
  const ARGS = { dependsOnJobs: ["cni-a", "cni-b"], cnrIds: ["pack-a", "pack-b"] };

  it("converges every asset of a run on one job, whatever order they name the packs in", async () => {
    const first = await manager.ensureComfyNodeActivateJob(ARGS);
    const second = await manager.ensureComfyNodeActivateJob({
      dependsOnJobs: [...ARGS.dependsOnJobs].reverse(),
      cnrIds: [...ARGS.cnrIds].reverse(),
    });

    expect(first).toMatchObject({ created: true, reset: false });
    expect(second).toEqual({ id: first.id, created: false, reset: false });
    const activates = (await manager.listJobs()).filter((j) => j.kind === "comfy-node-activate");
    expect(activates).toHaveLength(1);
  });

  it("gives a different pack set its own job", async () => {
    const { id } = await manager.ensureComfyNodeActivateJob(ARGS);
    const other = await manager.ensureComfyNodeActivateJob({
      dependsOnJobs: ["cni-c"],
      cnrIds: ["pack-c"],
    });

    expect(other.id).not.toBe(id);
  });

  it("resets a failed job so the next run retries the reboot", async () => {
    const { id } = await manager.ensureComfyNodeActivateJob(ARGS);
    await manager.updateJob(id, {
      status: "failed",
      error: "ComfyUI did not come back",
      completedAt: new Date().toISOString(),
    });

    const again = await manager.ensureComfyNodeActivateJob(ARGS);

    expect(again).toEqual({ id, created: false, reset: true });
    const job = await manager.getJob(id);
    expect(job.status).toBe("pending");
    expect(job.error).toBeNull();
    expect(job.completedAt).toBeNull();
  });

  it("leaves a completed job alone while its installs are completed", async () => {
    const installs = await Promise.all(
      ARGS.cnrIds.map((cnrId) => manager.ensureComfyNodeInstallJob({ id: cnrId })),
    );
    for (const { id } of installs) await manager.updateJob(id, { status: "completed" });
    const args = { dependsOnJobs: installs.map((i) => i.id), cnrIds: ARGS.cnrIds };
    const { id } = await manager.ensureComfyNodeActivateJob(args);
    await manager.updateJob(id, { status: "completed" });

    const again = await manager.ensureComfyNodeActivateJob(args);

    expect(again).toEqual({ id, created: false, reset: false });
    expect((await manager.getJob(id)).status).toBe("completed");
  });

  // Left completed, it would let the generation jobs depending on it submit into a ComfyUI whose
  // node classes are being reinstalled underneath them. Read from the dependency's live state, so
  // it holds for a process that did not itself perform the reset.
  it("resets a completed job when an install it depends on went back to pending", async () => {
    const install = await manager.ensureComfyNodeInstallJob({ id: "pack-a" });
    await manager.updateJob(install.id, { status: "completed" });
    const args = { dependsOnJobs: [install.id], cnrIds: ["pack-a"] };
    const { id } = await manager.ensureComfyNodeActivateJob(args);
    await manager.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

    // Another process reinstalls the pack; this one only observes the dependency already pending.
    await manager.updateJob(install.id, { status: "pending", completedAt: null });
    const again = await manager.ensureComfyNodeActivateJob(args);

    expect(again).toEqual({ id, created: false, reset: true });
    expect((await manager.getJob(id)).status).toBe("pending");
  });

  it("resets a completed job whose install record was deleted outright", async () => {
    const args = { dependsOnJobs: ["cni-gone"], cnrIds: ["pack-a"] };
    const { id } = await manager.ensureComfyNodeActivateJob(args);
    await manager.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

    expect(await manager.ensureComfyNodeActivateJob(args)).toEqual({
      id,
      created: false,
      reset: true,
    });
  });
});

describe("finishIfOwner", () => {
  async function runningJobOwnedBy(workerId: string): Promise<void> {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await manager.updateJob("v-abc12345", {
      status: "running",
      lease: { owner: workerId, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
  }

  it("commits a terminal update for the lease owner", async () => {
    await runningJobOwnedBy("worker-1");

    const committed = await manager.finishIfOwner("v-abc12345", "worker-1", {
      status: "completed",
    });

    expect(committed).toBe(true);
    expect((await manager.getJob("v-abc12345")).status).toBe("completed");
  });

  it("refuses to commit when the worker no longer owns the lease", async () => {
    await runningJobOwnedBy("worker-1");

    const committed = await manager.finishIfOwner("v-abc12345", "worker-2", {
      status: "completed",
    });

    expect(committed).toBe(false);
    expect((await manager.getJob("v-abc12345")).status).toBe("running");
  });

  it("does not clobber a concurrent cancel back to ready", async () => {
    await runningJobOwnedBy("worker-1");

    // `job cancel` flips the status without touching the lease, so the owner still passes the
    // ownership check — finishIfOwner must honor the terminal cancelled state regardless.
    await manager.updateJob("v-abc12345", { status: "cancelled" });

    const committed = await manager.finishIfOwner("v-abc12345", "worker-1", {
      status: "completed",
    });

    expect(committed).toBe(false);
    expect((await manager.getJob("v-abc12345")).status).toBe("cancelled");
  });
});

describe("updateIfNotTerminal", () => {
  async function runningJob(): Promise<void> {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    await manager.updateJob("v-abc12345", { status: "running" });
  }

  it("applies the update and returns the record when the job is not terminal", async () => {
    await runningJob();

    const updated = await manager.updateIfNotTerminal("v-abc12345", {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    expect(updated?.status).toBe("cancelled");
    expect((await manager.getJob("v-abc12345")).status).toBe("cancelled");
  });

  it("returns null and leaves a terminal job untouched", async () => {
    await runningJob();
    await manager.updateJob("v-abc12345", { status: "completed" });

    const updated = await manager.updateIfNotTerminal("v-abc12345", {
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect((await manager.getJob("v-abc12345")).status).toBe("completed");
  });
});

describe("Logs", () => {
  it("appends and reads log lines", { timeout: 15_000 }, async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-abc12345",
      resolvedDeps: {},
      backendKind: "comfy",
    });

    manager.appendLog("v-abc12345", "Starting generation");
    manager.appendLog("v-abc12345", "Progress: 50%");
    manager.appendLog("v-abc12345", "Done");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const log = await manager.readLog("v-abc12345");
    const lines = log.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[.+\] Starting generation$/);
    expect(lines[1]).toMatch(/^\[.+\] Progress: 50%$/);
    expect(lines[2]).toMatch(/^\[.+\] Done$/);
  });

  it("throws LOG_NOT_FOUND for non-existent log", async () => {
    await expect(manager.readLog("v-nonexist")).rejects.toMatchObject({
      code: "LOG_NOT_FOUND",
    });
  });
});

describe("releaseIfOwner", () => {
  it("hands a claimed job back to the queue and counts the release", async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-rel00001",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:timeline.character"],
    });
    expect(await manager.claimForSubmission("v-rel00001", "w-1", 60_000)).not.toBeNull();
    expect(await manager.releaseIfOwner("v-rel00001", "w-1")).toBe(true);
    const job = await manager.getJob("v-rel00001");
    expect(job.status).toBe("pending");
    expect(job.lease).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.staleReleases).toBe(1);
    // Claimable again, by anyone.
    expect(await manager.claimForSubmission("v-rel00001", "w-2", 60_000)).not.toBeNull();
  });

  it("refuses a worker that does not hold the lease, and a job past its claim", async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-rel00002",
      resolvedDeps: {},
      backendKind: "comfy",
    });
    expect(await manager.releaseIfOwner("v-rel00002", "w-none")).toBe(false);
    expect(await manager.claimForSubmission("v-rel00002", "w-1", 60_000)).not.toBeNull();
    expect(await manager.releaseIfOwner("v-rel00002", "w-other")).toBe(false);
    await manager.updateJob("v-rel00002", { status: "completed" });
    expect(await manager.releaseIfOwner("v-rel00002", "w-1")).toBe(false);
    expect((await manager.getJob("v-rel00002")).staleReleases).toBe(0);
  });
});

describe("claimForSubmission across processes", () => {
  // The lease's mutual exclusion is a property of the database, not of one process's connection —
  // so the contenders here are separate Bun processes on the same file.
  it("lets exactly one of N processes win", { timeout: 30_000 }, async () => {
    await manager.createJob({
      address: "video:shot.01.motion",
      variantId: "v-race0001",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnAssets: ["video:timeline.character"],
    });
    const modulePath = new URL("../job-manager.ts", import.meta.url).pathname;
    const script = `
      const { JobManager } = await import(${JSON.stringify(modulePath)});
      const jm = new JobManager(${JSON.stringify(tmpDir)});
      const claimed = await jm.claimForSubmission("v-race0001", process.argv[1], 60_000);
      console.log(claimed ? "won" : "lost");
    `;
    const outputs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        promisify(execFile)("bun", ["-e", script, `w-${i}`], { encoding: "utf8" }),
      ),
    );
    const verdicts = outputs.map((o) => o.stdout.trim());
    expect(verdicts.filter((v) => v === "won")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "lost")).toHaveLength(3);

    const job = await manager.getJob("v-race0001");
    expect(job.status).toBe("running");
    expect(job.lease?.owner).toMatch(/^w-\d$/);
  });
});

describe("deleteJobIf", () => {
  const NODE = { id: "comfyui-kjnodes" };

  it("keeps a settled job a non-terminal dependent still names, and drops it once none does", async () => {
    const install = await manager.ensureComfyNodeInstallJob(NODE);
    await manager.updateJob(install.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    const activate = await manager.ensureComfyNodeActivateJob({
      dependsOnJobs: [install.id],
      cnrIds: [NODE.id],
    });
    const spent = (job: JobRecord, active: () => JobRecord[]) =>
      job.status === "completed" &&
      !active().some((j) => (j.dependsOnJobs ?? []).includes(install.id));

    expect(await manager.deleteJobIf(install.id, spent)).toBe(false);
    await manager.getJob(install.id);

    await manager.updateJob(activate.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    expect(await manager.deleteJobIf(install.id, spent)).toBe(true);
    await expect(manager.getJob(install.id)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    expect(await manager.deleteJobIf(install.id, spent)).toBe(false);
  });
});
