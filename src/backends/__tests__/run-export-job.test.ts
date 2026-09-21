import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobIndex } from "../../core/job-index.js";
import { JobManager } from "../../core/job-manager.js";
import type { ExportJob, JobRecord, KonteState } from "../../core/types/index.js";
import { decideExportRender, evaluateExportJob } from "../run-export-job.js";

function exportJob(over: Partial<ExportJob> = {}): ExportJob {
  return {
    kind: "export",
    id: "exp-1",
    status: "pending",
    backendKind: "local",
    dependsOnAssets: [],
    dependsOnJobs: [],
    lease: null,
    outputDir: "dist/final",
    outputFile: null,
    allowUnaccepted: false,
    noDelivery: false,
    exportSignature: null,
    planDigest: null,
    progress: null,
    error: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    processingStartedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    unconfirmedSince: null,
    sourceFingerprint: null,
    staleReleases: 0,
    ...over,
  };
}

function stateWith(address: string, file: string | null): KonteState {
  return {
    schemaVersion: 3,
    assets: { [address]: { variants: { "v-1": { file } }, feedback: [] } },
  } as unknown as KonteState;
}

const DELIVERY = "video:shot.01.motion#delivery";

describe("evaluateExportJob", () => {
  it("runs when every dependency asset has a file", () => {
    const job = exportJob({ dependsOnAssets: [DELIVERY] });
    expect(evaluateExportJob(job, stateWith(DELIVERY, "assets/x.mp4"), new JobIndex([]))).toEqual({
      action: "run",
    });
  });

  it("waits when a dependency has no file but an active upscale job exists", () => {
    const job = exportJob({ dependsOnAssets: [DELIVERY] });
    const allJobs: JobRecord[] = [
      { kind: "generation", id: "v-1", address: DELIVERY, status: "running" } as JobRecord,
    ];
    expect(evaluateExportJob(job, stateWith(DELIVERY, null), new JobIndex(allJobs))).toEqual({
      action: "wait",
    });
  });

  it("fails when a dependency has no file and no active job", () => {
    const job = exportJob({ dependsOnAssets: [DELIVERY] });
    const result = evaluateExportJob(job, stateWith(DELIVERY, null), new JobIndex([]));
    expect(result.action).toBe("fail");
  });

  it("waits when a prerequisite job is still running", () => {
    const job = exportJob({ dependsOnJobs: ["v-up"] });
    const allJobs: JobRecord[] = [
      { kind: "generation", id: "v-up", status: "running" } as JobRecord,
    ];
    expect(evaluateExportJob(job, stateWith(DELIVERY, "f.mp4"), new JobIndex(allJobs))).toEqual({
      action: "wait",
    });
  });

  it("fails when a prerequisite job failed", () => {
    const job = exportJob({ dependsOnJobs: ["v-up"] });
    const allJobs: JobRecord[] = [
      { kind: "generation", id: "v-up", status: "failed", error: "boom" } as JobRecord,
    ];
    expect(evaluateExportJob(job, stateWith(DELIVERY, "f.mp4"), new JobIndex(allJobs)).action).toBe(
      "fail",
    );
  });

  it("fails when a prerequisite job is gone", () => {
    const job = exportJob({ dependsOnJobs: ["v-missing"] });
    expect(evaluateExportJob(job, stateWith(DELIVERY, "f.mp4"), new JobIndex([])).action).toBe(
      "fail",
    );
  });
});

describe("JobManager.createExportJob", () => {
  let tmpDir: string;
  let jobManager: JobManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-test-"));
    await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
    jobManager = new JobManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a pending export job with an exp- id and the given deps", async () => {
    const job = await jobManager.createExportJob({
      outputDir: "dist/final",
      allowUnaccepted: true,
      dependsOnAssets: [DELIVERY],
      dependsOnJobs: ["v-up"],
    });
    expect(job.kind).toBe("export");
    expect(job.id).toMatch(/^exp-[0-9A-Za-z]+$/);
    expect(job.status).toBe("pending");
    expect(job.dependsOnAssets).toEqual([DELIVERY]);
    expect(job.dependsOnJobs).toEqual(["v-up"]);
    expect(job.allowUnaccepted).toBe(true);
    expect(job.lease).toBeNull();

    const reread = await jobManager.getJob(job.id);
    expect(reread.kind).toBe("export");
  });
});

describe("JobManager run lease (multi-worker reclaim)", () => {
  let tmpDir: string;
  let jobManager: JobManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-test-"));
    await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
    jobManager = new JobManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function freshExport(): Promise<string> {
    const job = await jobManager.createExportJob({
      outputDir: "dist/final",
      allowUnaccepted: false,
    });
    return job.id;
  }

  it("lets one worker claim and refuses a second while the lease is valid", async () => {
    const id = await freshExport();
    const a = await jobManager.claimJobForRun(id, "A", 10_000);
    expect(a?.status).toBe("running");
    expect(a?.lease?.owner).toBe("A");

    const b = await jobManager.claimJobForRun(id, "B", 10_000);
    expect(b).toBeNull(); // A holds a live lease
  });

  it("lets another worker reclaim once the lease has expired (owner crashed)", async () => {
    const id = await freshExport();
    await jobManager.claimJobForRun(id, "A", 10_000);
    // Simulate A's death: force its lease into the past.
    await jobManager.updateJob(id, {
      lease: { owner: "A", expiresAt: "2000-01-01T00:00:00.000Z" },
    });

    const b = await jobManager.claimJobForRun(id, "B", 10_000);
    expect(b?.status).toBe("running");
    expect(b?.lease?.owner).toBe("B");
  });

  it("renews only for the owner and gates the terminal write on ownership", async () => {
    const id = await freshExport();
    await jobManager.claimJobForRun(id, "A", 10_000);

    expect(await jobManager.renewLease(id, "A", 10_000)).toBe(true);
    expect(await jobManager.renewLease(id, "B", 10_000)).toBe(false);

    // A stalled and was reclaimed by B; A's terminal write must be rejected.
    await jobManager.updateJob(id, {
      lease: { owner: "A", expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    await jobManager.claimJobForRun(id, "B", 10_000);
    expect(await jobManager.finishIfOwner(id, "A", { status: "completed" })).toBe(false);
    expect(await jobManager.finishIfOwner(id, "B", { status: "completed" })).toBe(true);
    expect((await jobManager.getJob(id)).status).toBe("completed");
  });
});

describe("decideExportRender", () => {
  const fresh = { planDigest: "plan-a", sourceFingerprint: "src-a", staleReleases: 0 };

  it("renders when the definition still says what it said at registration", () => {
    expect(decideExportRender(fresh, "plan-a", "src-a")).toBe("render");
    expect(decideExportRender(fresh, "plan-a", "src-b")).toBe("render");
  });

  it("renders a definition that changed after registration", () => {
    expect(decideExportRender(fresh, "plan-b", "src-b")).toBe("render");
  });

  it("steps aside once when the files are unchanged but its reload disagrees", () => {
    expect(decideExportRender(fresh, "plan-b", "src-a")).toBe("release");
    expect(decideExportRender({ ...fresh, staleReleases: 1 }, "plan-b", "src-a")).toBe("render");
  });

  it("renders a job registered without a digest", () => {
    expect(decideExportRender({ ...fresh, planDigest: null }, "plan-b", "src-a")).toBe("render");
  });
});
