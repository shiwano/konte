import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientHttpError } from "../../core/http-retry.js";
import { JobManager } from "../../core/job-manager.js";
import type { ComfyModelDeclaration } from "../../core/types/index.js";
import { runComfyModelDownloadJob } from "../run-comfy-install-job.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

const { installModelMock, backendClientIds } = vi.hoisted(() => ({
  installModelMock: vi.fn(),
  // client_id passed to each ComfyUIBackend construction, in order — lets tests assert the job's
  // persisted comfyClientId is set once and reused across a reclaim.
  backendClientIds: [] as (string | undefined)[],
}));

vi.mock("../../comfyui/config.js", () => ({
  resolveComfyUIConfig: async () => ({
    baseUrl: "http://127.0.0.1:8000",
    autoInstallModels: true,
    autoInstallNodes: true,
    autoRebootAfterNodeInstall: true,
  }),
}));
vi.mock("../../comfyui/backend.js", () => ({
  ComfyUIBackend: class {
    installModel = installModelMock;
    constructor(config: { clientId?: string }) {
      backendClientIds.push(config?.clientId);
    }
  },
}));

const MODEL: ComfyModelDeclaration = {
  filename: "model.safetensors",
  type: "checkpoint",
  url: "https://example.com/model.safetensors",
};

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let jobManager: JobManager;

beforeEach(async () => {
  installModelMock.mockReset();
  backendClientIds.length = 0;
  ws = await makeWorkspace({ videos: ["v1"] });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  jobManager = new JobManager(tmpDir);
});

afterEach(async () => {
  await ws.cleanup();
});

describe("runComfyModelDownloadJob", () => {
  it("claims, installs, and marks the job ready", async () => {
    installModelMock.mockResolvedValue({ kind: "installed" });
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    const started: string[] = [];
    const settled: string[] = [];
    const result = await runComfyModelDownloadJob(jobManager, roots, id, {
      onStarted: ({ label }) => started.push(label),
      onSettled: ({ status }) => settled.push(status),
    });

    expect(result.status).toBe("completed");
    expect(result.ranInstall).toBe(true);
    expect(started).toEqual([MODEL.filename]);
    expect(settled).toEqual(["completed"]);
    expect((await jobManager.getJob(id)).status).toBe("completed");
  });

  it("marks the job failed when the install throws", async () => {
    installModelMock.mockRejectedValue(new Error("network down"));
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    const result = await runComfyModelDownloadJob(jobManager, roots, id);

    expect(result.status).toBe("failed");
    const job = await jobManager.getJob(id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("network down");
  });

  it("leaves the job running (not failed) when the waiter times out", async () => {
    installModelMock.mockResolvedValue({ kind: "timedOut" });
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    const settled: string[] = [];
    const result = await runComfyModelDownloadJob(jobManager, roots, id, {
      onSettled: ({ status }) => settled.push(status),
    });

    expect(result.status).toBe("running");
    expect(settled).toEqual([]);
    const job = await jobManager.getJob(id);
    expect(job.status).toBe("running");
    expect(job.error).toBeNull();
  });

  it("leaves the job running (not failed) on a transient comms failure", async () => {
    installModelMock.mockRejectedValue(new TransientHttpError("HTTP 503", { status: 503 }));
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    const settled: string[] = [];
    const result = await runComfyModelDownloadJob(jobManager, roots, id, {
      onSettled: ({ status }) => settled.push(status),
    });

    expect(result.status).toBe("running");
    expect(settled).toEqual([]);
    const job = await jobManager.getJob(id);
    expect(job.status).toBe("running");
    expect(job.error).toBeNull();
  });

  it("respects a cancel that lands during the install (no ready overwrite)", async () => {
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    // Simulate `konte job cancel` landing mid-download: the install observes the
    // cancelled status via shouldCancel and returns cancelled.
    installModelMock.mockImplementation(
      async (_decl: unknown, _url: unknown, opts: { shouldCancel?: () => Promise<boolean> }) => {
        await jobManager.updateJob(id, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
        const cancelled = opts.shouldCancel ? await opts.shouldCancel() : false;
        return cancelled ? { kind: "cancelled" } : { kind: "installed" };
      },
    );

    const result = await runComfyModelDownloadJob(jobManager, roots, id);

    expect(result.status).toBe("cancelled");
    expect((await jobManager.getJob(id)).status).toBe("cancelled");
  });

  it("lets only one of two concurrent runners perform the install", async () => {
    installModelMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { kind: "installed" };
    });
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    const [a, b] = await Promise.all([
      runComfyModelDownloadJob(jobManager, roots, id),
      runComfyModelDownloadJob(jobManager, roots, id),
    ]);

    const ranInstall = [a, b].filter((r) => r.ranInstall);
    expect(ranInstall).toHaveLength(1);
    expect(installModelMock).toHaveBeenCalledTimes(1);
    expect((await jobManager.getJob(id)).status).toBe("completed");
  });

  it("persists a client_id on the job and builds the backend with it", async () => {
    installModelMock.mockResolvedValue({ kind: "installed" });
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    await runComfyModelDownloadJob(jobManager, roots, id);

    const clientId = (await jobManager.getJob(id)).metadata.comfyClientId;
    expect(typeof clientId).toBe("string");
    expect(backendClientIds).toEqual([clientId]); // backend built with the persisted id
  });

  it("reuses the persisted client_id when a reclaimer takes over", async () => {
    // First run times out (install left running server-side) — this persists the client_id and
    // leaves the job reclaimable.
    installModelMock.mockResolvedValue({ kind: "timedOut" });
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await runComfyModelDownloadJob(jobManager, roots, id);

    const clientId = (await jobManager.getJob(id)).metadata.comfyClientId;
    expect(typeof clientId).toBe("string");

    // Expire the lease so a fresh runner can reclaim, then run again.
    await jobManager.updateJob(id, {
      lease: { owner: "dead-worker", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    installModelMock.mockResolvedValue({ kind: "installed" });
    await runComfyModelDownloadJob(jobManager, roots, id);

    // No new id minted; both constructions used the same persisted client_id.
    expect((await jobManager.getJob(id)).metadata.comfyClientId).toBe(clientId);
    expect(backendClientIds).toEqual([clientId, clientId]);
  });
});
