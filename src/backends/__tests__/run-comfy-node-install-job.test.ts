import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientHttpError } from "../../core/http-retry.js";
import { JobManager } from "../../core/job-manager.js";
import type { ComfyNodeDeclaration } from "../../core/types/index.js";
import { runComfyNodeInstallJob } from "../run-comfy-install-job.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

const { installNodeMock } = vi.hoisted(() => ({ installNodeMock: vi.fn() }));

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
    installNode = installNodeMock;
  },
}));

const NODE: ComfyNodeDeclaration = { id: "comfy-foo" };

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let jobManager: JobManager;

beforeEach(async () => {
  installNodeMock.mockReset();
  ws = await makeWorkspace({ videos: ["v1"] });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
  jobManager = new JobManager(tmpDir);
});

afterEach(async () => {
  await ws.cleanup();
});

describe("runComfyNodeInstallJob", () => {
  it("claims, installs, and marks the job ready", async () => {
    installNodeMock.mockResolvedValue({ kind: "installed" });
    const { id } = await jobManager.ensureComfyNodeInstallJob(NODE);

    const started: string[] = [];
    const settled: string[] = [];
    const result = await runComfyNodeInstallJob(jobManager, roots, id, {
      onStarted: ({ label }) => started.push(label),
      onSettled: ({ status }) => settled.push(status),
    });

    expect(result.status).toBe("completed");
    expect(result.ranInstall).toBe(true);
    expect(started).toEqual([NODE.id]);
    expect(settled).toEqual(["completed"]);
    expect((await jobManager.getJob(id)).status).toBe("completed");
  });

  it("marks the job failed when the install throws", async () => {
    installNodeMock.mockRejectedValue(new Error("registry down"));
    const { id } = await jobManager.ensureComfyNodeInstallJob(NODE);

    const result = await runComfyNodeInstallJob(jobManager, roots, id);

    expect(result.status).toBe("failed");
    const job = await jobManager.getJob(id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("registry down");
  });

  it("leaves the job running (not failed) when the waiter times out", async () => {
    installNodeMock.mockResolvedValue({ kind: "timedOut" });
    const { id } = await jobManager.ensureComfyNodeInstallJob(NODE);

    const settled: string[] = [];
    const result = await runComfyNodeInstallJob(jobManager, roots, id, {
      onSettled: ({ status }) => settled.push(status),
    });

    expect(result.status).toBe("running");
    expect(settled).toEqual([]);
    const job = await jobManager.getJob(id);
    expect(job.status).toBe("running");
    expect(job.error).toBeNull();
  });

  it("leaves the job running (not failed) on a transient comms failure", async () => {
    installNodeMock.mockRejectedValue(new TransientHttpError("HTTP 503", { status: 503 }));
    const { id } = await jobManager.ensureComfyNodeInstallJob(NODE);

    const settled: string[] = [];
    const result = await runComfyNodeInstallJob(jobManager, roots, id, {
      onSettled: ({ status }) => settled.push(status),
    });

    expect(result.status).toBe("running");
    expect(settled).toEqual([]);
    const job = await jobManager.getJob(id);
    expect(job.status).toBe("running");
    expect(job.error).toBeNull();
  });

  it("respects a cancel that lands during the install (no ready overwrite)", async () => {
    const { id } = await jobManager.ensureComfyNodeInstallJob(NODE);
    installNodeMock.mockImplementation(
      async (_decl: unknown, _repo: unknown, opts: { shouldCancel?: () => Promise<boolean> }) => {
        await jobManager.updateJob(id, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
        const cancelled = opts.shouldCancel ? await opts.shouldCancel() : false;
        return cancelled ? { kind: "cancelled" } : { kind: "installed" };
      },
    );

    const result = await runComfyNodeInstallJob(jobManager, roots, id);

    expect(result.status).toBe("cancelled");
    expect((await jobManager.getJob(id)).status).toBe("cancelled");
  });

  it("lets only one of two concurrent runners perform the install", async () => {
    installNodeMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { kind: "installed" };
    });
    const { id } = await jobManager.ensureComfyNodeInstallJob(NODE);

    const [a, b] = await Promise.all([
      runComfyNodeInstallJob(jobManager, roots, id),
      runComfyNodeInstallJob(jobManager, roots, id),
    ]);

    const ranInstall = [a, b].filter((r) => r.ranInstall);
    expect(ranInstall).toHaveLength(1);
    expect(installNodeMock).toHaveBeenCalledTimes(1);
    expect((await jobManager.getJob(id)).status).toBe("completed");
  });
});
