import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KonteError } from "../../core/errors.js";
import { JobManager } from "../../core/job-manager.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { DeployContext } from "../../comfy-api/deployment.js";
import { runComfyApiDeployJob } from "../run-comfy-api-deploy-job.js";

const { ensureMock } = vi.hoisted(() => ({ ensureMock: vi.fn() }));

vi.mock("../../comfy-api/deployment.js", () => ({ ensureDeploymentReady: ensureMock }));
// The deferral holds the job before handing it back; no test waits that out.
vi.mock("../../core/sleep.js", () => ({ sleep: async () => {} }));

let ws: Workspace;
let jobManager: JobManager;

beforeEach(async () => {
  ensureMock.mockReset();
  vi.stubEnv("COMFY_API_KEY", "key");
  ws = await makeWorkspace({ videos: ["main"] });
  jobManager = new JobManager(ws.videos.main!.video);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runComfyApiDeployJob", () => {
  it("completes once the deployment is up", async () => {
    ensureMock.mockResolvedValue("https://dep-1");
    const { id } = await jobManager.ensureComfyApiDeployJob("main");

    expect(await runComfyApiDeployJob(jobManager, ws.videos.main!, id)).toMatchObject({
      status: "completed",
      ran: true,
    });
  });

  it("goes back to pending when the replacement has to wait for running jobs", async () => {
    ensureMock.mockRejectedValue(new KonteError("COMFY_API_DEPLOY_DEFERRED", "jobs running"));
    const { id } = await jobManager.ensureComfyApiDeployJob("main");

    expect(await runComfyApiDeployJob(jobManager, ws.videos.main!, id)).toMatchObject({
      status: "pending",
    });
    expect(await jobManager.getJob(id)).toMatchObject({ status: "pending", lease: null });
  });

  // `job cancel` only marks the record; the bring-up must read it and stop, and the runner must not
  // then report the job as completed.
  it("stops a bring-up its job was cancelled under, leaving it cancelled", async () => {
    const { id } = await jobManager.ensureComfyApiDeployJob("main");
    ensureMock.mockImplementation(async (ctx: DeployContext) => {
      await jobManager.updateJob(id, { status: "cancelled" });
      expect(await ctx.shouldCancel!()).toBe(true);
      throw new KonteError("COMFY_API_DEPLOY_CANCELLED", "cancelled");
    });

    expect(await runComfyApiDeployJob(jobManager, ws.videos.main!, id)).toMatchObject({
      status: "cancelled",
    });
    expect((await jobManager.getJob(id)).status).toBe("cancelled");
  });

  it("reports the cancel rather than completion when the job was cancelled at the last step", async () => {
    const { id } = await jobManager.ensureComfyApiDeployJob("main");
    ensureMock.mockImplementation(async () => {
      await jobManager.updateJob(id, { status: "cancelled" });
      return "https://dep-1";
    });

    expect(await runComfyApiDeployJob(jobManager, ws.videos.main!, id)).toMatchObject({
      status: "cancelled",
    });
  });
});
