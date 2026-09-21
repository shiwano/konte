import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KonteError } from "../../core/errors.js";
import { JobManager } from "../../core/job-manager.js";
import type { ComfyNodeDeclaration } from "../../core/types/index.js";
import { runComfyNodeActivateJob } from "../run-comfy-node-activate-job.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { VideoRoots } from "../../core/roots.js";

const { activateNodesMock, getQueueMock } = vi.hoisted(() => ({
  activateNodesMock: vi.fn(),
  getQueueMock: vi.fn(),
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
    activateNodes = activateNodesMock;
    httpClient = { getQueue: getQueueMock };
  },
}));

/** An idle server: nothing running, nothing pending. */
function idleQueue(): void {
  getQueueMock.mockResolvedValue({ queue_running: [], queue_pending: [] });
}

const NODE: ComfyNodeDeclaration = { id: "comfy-foo" };

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let jobManager: JobManager;

beforeEach(async () => {
  activateNodesMock.mockReset();
  getQueueMock.mockReset();
  idleQueue();
  ws = await makeWorkspace({ videos: ["v1", "v2"] });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
  jobManager = new JobManager(tmpDir);
});

/** An activate job whose single install dependency is already done — ready to run but for the gate. */
async function makeReadyActivateJob(): Promise<string> {
  const install = await jobManager.ensureComfyNodeInstallJob(NODE);
  await jobManager.updateJob(install.id, { status: "completed" });
  const activate = await jobManager.ensureComfyNodeActivateJob({
    dependsOnJobs: [install.id],
    cnrIds: [NODE.id],
  });
  return activate.id;
}

async function makeGenerationJob(
  manager: JobManager,
  opts: {
    variantId: string;
    backendKind: "comfy" | "fal";
    status: "running" | "completed";
    // Omitted = claimed for submission but no prompt id committed yet.
    backendJobId?: string;
  },
): Promise<void> {
  await manager.createJob({
    address: `video:shot.01.${opts.variantId}`,
    variantId: opts.variantId,
    resolvedDeps: {},
    backendKind: opts.backendKind,
  });
  await manager.updateJob(opts.variantId, {
    status: opts.status,
    backendJobId: opts.backendJobId ?? null,
  });
}

afterEach(async () => {
  await ws.cleanup();
});

describe("runComfyNodeActivateJob", () => {
  it("stays pending until its install dependency is ready", async () => {
    const install = await jobManager.ensureComfyNodeInstallJob(NODE);
    const activate = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [install.id],
      cnrIds: [NODE.id],
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activate.id);

    expect(result.status).toBe("pending");
    expect(activateNodesMock).not.toHaveBeenCalled();
  });

  it("activates once its install dependency is ready", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    const install = await jobManager.ensureComfyNodeInstallJob(NODE);
    await jobManager.updateJob(install.id, { status: "completed" });
    const activate = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [install.id],
      cnrIds: [NODE.id],
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activate.id);

    expect(result.status).toBe("completed");
    expect(activateNodesMock).toHaveBeenCalledWith([NODE.id], expect.anything());
    expect((await jobManager.getJob(activate.id)).status).toBe("completed");
  });

  it("fails when its install dependency failed", async () => {
    const install = await jobManager.ensureComfyNodeInstallJob(NODE);
    await jobManager.updateJob(install.id, { status: "failed", error: "install broke" });
    const activate = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [install.id],
      cnrIds: [NODE.id],
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activate.id);

    expect(result.status).toBe("failed");
    expect((await jobManager.getJob(activate.id)).error).toContain("install broke");
  });

  it("fails (degrades) when activation needs a manual restart", async () => {
    activateNodesMock.mockRejectedValue(
      new KonteError("COMFY_NODE_RESTART_REQUIRED", "restart ComfyUI"),
    );
    const install = await jobManager.ensureComfyNodeInstallJob(NODE);
    await jobManager.updateJob(install.id, { status: "completed" });
    const activate = await jobManager.ensureComfyNodeActivateJob({
      dependsOnJobs: [install.id],
      cnrIds: [NODE.id],
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activate.id);

    expect(result.status).toBe("failed");
    expect((await jobManager.getJob(activate.id)).error).toContain("restart ComfyUI");
  });

  // The server's queue is the authority on what a reboot would destroy — and the only source that
  // can see a prompt konte did not create (another workspace, or someone using the ComfyUI UI).
  it("holds off rebooting while ComfyUI's own queue is not empty", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    getQueueMock.mockResolvedValue({
      queue_running: [[0, "prompt-from-somewhere-else"]],
      queue_pending: [],
    });
    const activateId = await makeReadyActivateJob();

    const onDeferred = vi.fn();
    const result = await runComfyNodeActivateJob(jobManager, roots, activateId, { onDeferred });

    expect(result.status).toBe("pending");
    expect(result.pendingReason).toContain("1 prompt(s) in ComfyUI's queue");
    expect(onDeferred).toHaveBeenCalledWith({ id: activateId, reason: result.pendingReason });
    expect(activateNodesMock).not.toHaveBeenCalled();
    // Left claimable, not half-claimed: a later pass must be able to pick it up.
    expect((await jobManager.getJob(activateId)).status).toBe("pending");
  });

  // Not in the queue yet, but about to be — the one gap the server cannot report.
  it("holds off for a job claimed for submission but not yet queued", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    const activateId = await makeReadyActivateJob();
    await makeGenerationJob(jobManager, {
      variantId: "v-submitting",
      backendKind: "comfy",
      status: "running",
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activateId);

    expect(result.status).toBe("pending");
    expect(result.pendingReason).toContain("v1/video:shot.01.v-submitting");
    expect(activateNodesMock).not.toHaveBeenCalled();
  });

  it("holds off for a mid-submit job in a sibling video of the same workspace", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    const activateId = await makeReadyActivateJob();
    await makeGenerationJob(new JobManager(ws.videos.v2!.video), {
      variantId: "v-sibling",
      backendKind: "comfy",
      status: "running",
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activateId);

    expect(result.status).toBe("pending");
    expect(result.pendingReason).toContain("v2/video:shot.01.v-sibling");
  });

  // A record left "running" by a waiter that died says nothing about the server. Trusting it over
  // the queue is what could block activation forever with the daemon down.
  it("reboots past a stale running record whose prompt is no longer queued", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    const activateId = await makeReadyActivateJob();
    await makeGenerationJob(new JobManager(ws.videos.v2!.video), {
      variantId: "v-stale",
      backendKind: "comfy",
      status: "running",
      backendJobId: "prompt-long-gone",
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activateId);

    expect(result.status).toBe("completed");
    expect(activateNodesMock).toHaveBeenCalledWith([NODE.id], expect.anything());
  });

  // A server answering nothing holds nothing a reboot could destroy, so the gate must not treat an
  // unreadable queue as "busy" — that would never resolve, and a `job wait` with no ComfyUI
  // running would spin forever. Refusing to reboot an uninspectable server belongs to
  // activateNodes, which fails with a reason (see the ComfyUIBackend.activateNodes tests).
  it("does not spin on a server whose queue it cannot read", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    getQueueMock.mockRejectedValue(new Error("connection refused"));
    const activateId = await makeReadyActivateJob();

    const result = await runComfyNodeActivateJob(jobManager, roots, activateId);

    expect(result.status).not.toBe("pending");
    expect(activateNodesMock).toHaveBeenCalled();
  });

  it("reboots despite a non-comfy job in flight — a reboot cannot disturb it", async () => {
    activateNodesMock.mockResolvedValue({ rebooted: true });
    const activateId = await makeReadyActivateJob();
    await makeGenerationJob(jobManager, {
      variantId: "v-fal",
      backendKind: "fal",
      status: "running",
    });
    await makeGenerationJob(jobManager, {
      variantId: "v-done",
      backendKind: "comfy",
      status: "completed",
    });

    const result = await runComfyNodeActivateJob(jobManager, roots, activateId);

    expect(result.status).toBe("completed");
    expect(activateNodesMock).toHaveBeenCalledWith([NODE.id], expect.anything());
  });

  it("returns a job it already claimed to pending when work appears before the reboot", async () => {
    const activateId = await makeReadyActivateJob();
    activateNodesMock.mockImplementation(() => {
      throw new Error("must not reboot");
    });

    // The pre-claim gate saw an idle server; work lands while the reboot lock is being acquired.
    // Keyed on the job having been claimed ("running") rather than on a call count, so it pins the
    // behaviour — a re-check after the claim — and not the number of reads that get there.
    const realListJobs = JobManager.prototype.listJobs;
    let injected = false;
    const spy = vi
      .spyOn(JobManager.prototype, "listJobs")
      .mockImplementation(async function (this: JobManager, filter) {
        if (!injected && (await jobManager.getJob(activateId)).status === "running") {
          injected = true;
          await makeGenerationJob(jobManager, {
            variantId: "v-late",
            backendKind: "comfy",
            status: "running",
          });
        }
        return realListJobs.call(this, filter);
      });

    const result = await runComfyNodeActivateJob(jobManager, roots, activateId).finally(() =>
      spy.mockRestore(),
    );

    expect(injected).toBe(true);

    expect(result.status).toBe("pending");
    expect(result.pendingReason).toContain("v-late");
    expect(activateNodesMock).not.toHaveBeenCalled();
    expect((await jobManager.getJob(activateId)).status).toBe("pending");
    expect((await jobManager.getJob(activateId)).lease).toBeNull();
  });
});
