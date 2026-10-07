import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import { TransientHttpError } from "../../core/http-retry.js";
import { JobManager } from "../../core/job-manager.js";
import type { ComfyModelDeclaration, KonteConfig } from "../../core/types/index.js";
import { type ComfyAdapterDeclarations, workspaceComfyAdapters } from "../build-definition.js";
import { registerDaemon, unregisterDaemonSync } from "../../core/daemon-registry.js";
import { withFileLock } from "../../core/file-lock.js";
import { deploymentLockPath, loadDeploymentState, updateDeploymentState } from "../deploy-state.js";
import {
  closeIdleDeployments,
  type DeployContext,
  ensureDeploymentReady,
  submitOnDeployment,
} from "../deployment.js";
import { ComfyApiHttpError } from "../http.js";
import type { ComfyPlatformClient, PlatformDeployment } from "../platform-client.js";
import type { ComfyRouter } from "../routing.js";

// Reading the workspace's adapters imports their files; the adapters a Build holds are given here.
vi.mock("../build-definition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../build-definition.js")>();
  return { ...actual, workspaceComfyAdapters: vi.fn() };
});

const MINUTE = 60_000;

const flux: ComfyModelDeclaration = {
  filename: "flux.safetensors",
  type: "diffusion_model",
  url: "https://example.com/flux.safetensors",
};

function config(main: Record<string, unknown> = {}): KonteConfig {
  return {
    comfy: {
      adapters: { "*": ["comfyapi:main"] },
      comfyapi: { deployments: { main: { gpuClass: "L40S", region: "us-east", ...main } } },
    },
  } as KonteConfig;
}

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["main"], config: config() });
  await fs.mkdir(path.join(ws.root, ".konte"), { recursive: true });
  setAdapters([{ workflow: "image.json", models: [flux], nodes: [] }]);
  vi.stubEnv("COMFY_API_KEY", "key");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ws.cleanup();
});

function setAdapters(adapters: ComfyAdapterDeclarations[]): void {
  vi.mocked(workspaceComfyAdapters).mockResolvedValue(adapters);
}

// The platform's Builds, releases and deployments, kept in memory. A deployment goes through
// `statuses` on its reads after creation or start, ending on the last one.
function fakePlatform(statuses: string[] = ["ready"]) {
  const deployments = new Map<string, PlatformDeployment>();
  const reads = new Map<string, number>();
  const byKey = new Map<string, string>();
  let releases = 0;
  let created = 0;
  const platform = {
    createBuild: vi.fn(async (_name: string, _definition: unknown) => ({ id: "build-1" })),
    getBuild: vi.fn(async (id: string) => ({ id, updatedAt: "t0" })),
    updateBuild: vi.fn(async (id: string) => ({ id })),
    createRelease: vi.fn(async () => `rel-${++releases}`),
    getRelease: vi.fn(async () => ({ status: "complete", deployable: true })),
    getReleaseLog: vi.fn(async () => null),
    // Idempotent by key, as the platform is: a resend returns what the first made.
    createDeployment: vi.fn(async (releaseId: string, compute?: unknown, key?: string) => {
      const made = key ? byKey.get(key) : undefined;
      if (made && deployments.has(made)) return { ...deployments.get(made)! };
      const id = `dep-${++created}`;
      if (key) byKey.set(key, id);
      const deployment: PlatformDeployment = {
        id,
        status: "creating",
        releaseId,
        endpointUrl: `https://${id}`,
        ...(compute ? { computeConfig: compute as PlatformDeployment["computeConfig"] } : {}),
      };
      deployments.set(id, deployment);
      reads.set(id, 0);
      return deployment;
    }),
    getDeployment: vi.fn(async (id: string) => {
      const deployment = deployments.get(id);
      if (!deployment) return null;
      const n = reads.get(id) ?? 0;
      reads.set(id, n + 1);
      if (deployment.status !== "stopped") {
        deployment.status = statuses[Math.min(n, statuses.length - 1)]!;
      }
      return { ...deployment };
    }),
    updateDeployment: vi.fn(async () => {}),
    startDeployment: vi.fn(async (id: string) => {
      deployments.get(id)!.status = "starting";
      reads.set(id, 0);
    }),
    stopDeployment: vi.fn(async (id: string) => {
      deployments.get(id)!.status = "stopped";
    }),
    deleteDeployment: vi.fn(async (id: string) => {
      deployments.delete(id);
    }),
  };
  return { platform, deployments };
}

type FakePlatform = ReturnType<typeof fakePlatform>["platform"];

function ctx(platform: FakePlatform, overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    workspaceRoot: ws.root,
    config: config(),
    apiKey: "key",
    log: () => {},
    platform: platform as unknown as ComfyPlatformClient,
    router: {
      routeAdapter: async () => ({ kind: "routed", target: "comfyapi:main" }),
    } as unknown as ComfyRouter,
    resolvers: { latestComfyVersion: async () => "v0.4.0", registryVersion: async () => "1.0.0" },
    timing: { releasePollMs: 1, deploymentPollMs: 1 },
    ...overrides,
  };
}

const mutations = (platform: FakePlatform) =>
  [
    platform.createBuild,
    platform.updateBuild,
    platform.createRelease,
    platform.createDeployment,
    platform.updateDeployment,
    platform.startDeployment,
    platform.deleteDeployment,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);

describe("ensureDeploymentReady", () => {
  it("creates the Build, a release and a deployment, and records each", async () => {
    const { platform } = fakePlatform(["creating", "ready"]);

    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-1");

    expect(platform.createBuild.mock.calls[0]![1]).toEqual({
      baseComfyVersion: "v0.4.0",
      models: [{ type: "diffusion_models", filename: "flux.safetensors", sourceUri: flux.url }],
      customNodes: [],
    });
    expect(platform.createDeployment.mock.calls[0]!.slice(0, 2)).toEqual([
      "rel-1",
      { gpuClass: "L40S", region: "us-east", min: 0, max: 1 },
    ]);
    expect(await loadDeploymentState(ws.root, "main")).toMatchObject({
      buildId: "build-1",
      baseComfyVersion: "v0.4.0",
      releaseId: "rel-1",
      deploymentId: "dep-1",
      endpointUrl: "https://dep-1",
      gpuClass: "L40S",
      region: "us-east",
      max: 1,
      stopped: false,
      readyAt: expect.any(String),
    });
  });

  it("only reads what it recorded when nothing moved", async () => {
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");
    const before = mutations(platform);

    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-1");
    expect(mutations(platform)).toBe(before);
  });

  it("updates the Build and replaces the deployment when the definition moves", async () => {
    const { platform, deployments } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");

    setAdapters([
      { workflow: "image.json", models: [flux], nodes: [] },
      { workflow: "video.json", models: [], nodes: [{ id: "comfyui-kjnodes" }] },
    ]);
    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-2");

    expect(platform.createBuild).toHaveBeenCalledTimes(1);
    expect(platform.updateBuild).toHaveBeenCalledWith("build-1", expect.anything(), "t0");
    expect(platform.deleteDeployment).toHaveBeenCalledWith("dep-1");
    expect([...deployments.keys()]).toEqual(["dep-2"]);
    expect(await loadDeploymentState(ws.root, "main")).toMatchObject({
      releaseId: "rel-2",
      deploymentId: "dep-2",
      registryVersions: { "comfyui-kjnodes": "1.0.0" },
    });
  });

  it("replaces the deployment when its GPU moves", async () => {
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");

    await ensureDeploymentReady(ctx(platform, { config: config({ gpuClass: "H100" }) }), "main");
    expect(platform.deleteDeployment).toHaveBeenCalledWith("dep-1");
    expect(platform.createRelease).toHaveBeenCalledTimes(1);
    expect((await loadDeploymentState(ws.root, "main")).gpuClass).toBe("H100");
  });

  it("scales a deployment in place when only max moves", async () => {
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");

    await ensureDeploymentReady(ctx(platform, { config: config({ max: 3 }) }), "main");
    expect(platform.updateDeployment).toHaveBeenCalledWith("dep-1", {
      gpuClass: "L40S",
      region: "us-east",
      min: 0,
      max: 3,
    });
    expect(platform.deleteDeployment).not.toHaveBeenCalled();
  });

  it("starts a stopped deployment", async () => {
    const { platform } = fakePlatform(["ready"]);
    await ensureDeploymentReady(ctx(platform), "main");
    await platform.stopDeployment("dep-1");

    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-1");
    expect(platform.startDeployment).toHaveBeenCalledWith("dep-1");
    expect(platform.createDeployment).toHaveBeenCalledTimes(1);
  });

  it("fails a deployment that goes failed", async () => {
    const { platform } = fakePlatform(["creating", "failed"]);
    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toMatchObject({
      code: "COMFY_API_DEPLOY_FAILED",
    });
  });

  it("fails a release that built undeployable", async () => {
    const { platform } = fakePlatform();
    platform.getRelease.mockResolvedValue({ status: "complete", deployable: false });
    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toMatchObject({
      code: "COMFY_API_RELEASE_FAILED",
    });
    expect(platform.createDeployment).not.toHaveBeenCalled();
  });

  it("refuses a deployment no adapter routes to", async () => {
    const { platform } = fakePlatform();
    const router = {
      routeAdapter: async () => ({ kind: "routed", target: "comfyui" }),
    } as unknown as ComfyRouter;
    await expect(ensureDeploymentReady(ctx(platform, { router }), "main")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(platform.createBuild).not.toHaveBeenCalled();
  });
});

describe("ensureDeploymentReady recovery", () => {
  // A create whose answer was lost must not leave a second, untracked deployment behind.
  it("resends a create whose answer was lost, as it was sent", async () => {
    const { platform } = fakePlatform();
    const create = platform.createDeployment.getMockImplementation()!;
    platform.createDeployment.mockImplementationOnce(async () => {
      throw new TransientHttpError("socket hang up");
    });

    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toThrow("socket hang up");
    const kept = (await loadDeploymentState(ws.root, "main")).pendingCreate;
    expect(kept).toMatchObject({ releaseId: "rel-1", gpuClass: "L40S", max: 1 });

    platform.createDeployment.mockImplementation(create);
    await ensureDeploymentReady(ctx(platform), "main");
    expect(platform.createDeployment.mock.calls.map((c) => c[2])).toEqual([kept!.key, kept!.key]);
    expect((await loadDeploymentState(ws.root, "main")).pendingCreate).toBeNull();
  });

  // The create landed; only its answer was lost. The resend returns that deployment.
  it("takes back the deployment a create with a lost answer made", async () => {
    const { platform, deployments } = fakePlatform();
    const create = platform.createDeployment.getMockImplementation()!;
    platform.createDeployment.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new TransientHttpError("socket hang up");
    });

    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toThrow("socket hang up");
    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-1");
    expect([...deployments.keys()]).toEqual(["dep-1"]);
    expect(await loadDeploymentState(ws.root, "main")).toMatchObject({
      deploymentId: "dep-1",
      pendingCreate: null,
    });
  });

  // The recorded deployment was deleted on the platform, and the create replacing it lost its answer.
  it("resends the replacement's create when the deployment it replaces is gone", async () => {
    const { platform, deployments } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");
    deployments.delete("dep-1");
    const create = platform.createDeployment.getMockImplementation()!;
    platform.createDeployment.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new TransientHttpError("socket hang up");
    });

    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toThrow("socket hang up");
    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-2");
    const keys = platform.createDeployment.mock.calls.slice(1).map((c) => c[2]);
    expect(keys).toEqual([keys[0], keys[0]]);
    expect([...deployments.keys()]).toEqual(["dep-2"]);
  });

  // `comfyVersion` naming the tag already pinned moves the inputs but not the definition.
  it("keeps the pins under inputs that moved without moving the definition", async () => {
    setAdapters([{ workflow: "image.json", models: [flux], nodes: [{ id: "comfyui-kjnodes" }] }]);
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");
    await ensureDeploymentReady(
      ctx(platform, { config: config({ comfyVersion: "v0.4.0" }) }),
      "main",
    );

    // A pack released upstream since must not reach the Build on a run that changed nothing.
    const later = ctx(platform, {
      config: config({ comfyVersion: "v0.4.0" }),
      resolvers: { latestComfyVersion: async () => "v0.5.0", registryVersion: async () => "2.0.0" },
    });
    await ensureDeploymentReady(later, "main");
    expect(platform.updateBuild).not.toHaveBeenCalled();
    expect(platform.createRelease).toHaveBeenCalledTimes(1);
  });

  it("drops the key of a create the platform refused", async () => {
    const { platform } = fakePlatform();
    platform.createDeployment.mockImplementationOnce(async () => {
      throw new ComfyApiHttpError("COMFY_API_INSUFFICIENT_CREDITS", "no credit", {
        status: 402,
        serverCode: "PAYMENT_REQUIRED",
        body: "",
      });
    });

    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toMatchObject({
      code: "COMFY_API_INSUFFICIENT_CREDITS",
    });
    expect((await loadDeploymentState(ws.root, "main")).pendingCreate).toBeNull();
  });

  it("defers replacing a deployment while a job is still running on it", async () => {
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");
    const jobs = new JobManager(ws.videos.main!.video);
    await jobs.createJob({
      address: "video:shot.01.first",
      variantId: "v-onit",
      resolvedDeps: {},
      backendKind: "comfy-api",
      comfyTarget: "comfyapi:main",
    });
    await jobs.updateJob("v-onit", { status: "running", backendJobId: "comfyapi:main|job-1" });

    await expect(
      ensureDeploymentReady(ctx(platform, { config: config({ gpuClass: "H100" }) }), "main"),
    ).rejects.toMatchObject({ code: "COMFY_API_DEPLOY_DEFERRED" });
    expect(platform.deleteDeployment).not.toHaveBeenCalled();
    expect((await loadDeploymentState(ws.root, "main")).deploymentId).toBe("dep-1");
  });

  // Mid-submit: inputs uploading or the POST unanswered, so no backend id is recorded yet.
  // Sent under the lock, its backend id not yet on its record — or never, its sender having died
  // once the POST landed.
  it("defers replacing a deployment a job was sent to", async () => {
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");
    const jobs = new JobManager(ws.videos.main!.video);
    await jobs.createJob({
      address: "video:shot.01.first",
      variantId: "v-sent",
      resolvedDeps: {},
      backendKind: "comfy-api",
      comfyTarget: "comfyapi:main",
    });
    await jobs.updateJob("v-sent", {
      status: "running",
      submissionStartedAt: new Date().toISOString(),
    });
    await expect(
      submitOnDeployment(ctx(platform), "main", "v-sent", async () => {
        throw new Error("the sender died after the POST landed");
      }),
    ).rejects.toThrow("died");

    await expect(
      ensureDeploymentReady(ctx(platform, { config: config({ gpuClass: "H100" }) }), "main"),
    ).rejects.toMatchObject({ code: "COMFY_API_DEPLOY_DEFERRED" });
    expect(platform.deleteDeployment).not.toHaveBeenCalled();

    // Once it settles the replacement goes ahead.
    await jobs.updateJob("v-sent", { status: "failed" });
    await ensureDeploymentReady(ctx(platform, { config: config({ gpuClass: "H100" }) }), "main");
    expect(platform.deleteDeployment).toHaveBeenCalledWith("dep-1");
  });

  // Two such jobs counting each other would wait forever.
  it("does not count a job still waiting to submit", async () => {
    const { platform } = fakePlatform();
    await ensureDeploymentReady(ctx(platform), "main");
    const jobs = new JobManager(ws.videos.main!.video);
    await jobs.createJob({
      address: "video:shot.01.first",
      variantId: "v-waiting",
      resolvedDeps: {},
      backendKind: "comfy-api",
      comfyTarget: "comfyapi:main",
    });
    await jobs.updateJob("v-waiting", {
      status: "running",
      submissionStartedAt: new Date().toISOString(),
    });

    await ensureDeploymentReady(ctx(platform, { config: config({ gpuClass: "H100" }) }), "main");
    expect(platform.deleteDeployment).toHaveBeenCalledWith("dep-1");
  });

  // A `close: stop` still going through when the bring-up first read the deployment.
  it("starts a deployment that finishes stopping while it is awaited", async () => {
    const { platform } = fakePlatform(["ready", "stopping", "stopped", "ready"]);
    await ensureDeploymentReady(ctx(platform), "main");

    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-1");
    expect(platform.startDeployment).toHaveBeenCalledWith("dep-1");
  });

  it("defers replacing a broken deployment while a job is still running on it", async () => {
    const { platform } = fakePlatform(["ready", "unhealthy"]);
    await ensureDeploymentReady(ctx(platform), "main");
    const jobs = new JobManager(ws.videos.main!.video);
    await jobs.createJob({
      address: "video:shot.01.first",
      variantId: "v-onit",
      resolvedDeps: {},
      backendKind: "comfy-api",
      comfyTarget: "comfyapi:main",
    });
    await jobs.updateJob("v-onit", { status: "running", backendJobId: "comfyapi:main|job-1" });

    await expect(ensureDeploymentReady(ctx(platform), "main")).rejects.toMatchObject({
      code: "COMFY_API_DEPLOY_DEFERRED",
    });
    expect(platform.deleteDeployment).not.toHaveBeenCalled();
  });

  it("recreates a deployment that went failed instead of waiting on it again", async () => {
    const { platform } = fakePlatform(["ready", "failed"]);
    await ensureDeploymentReady(ctx(platform), "main");

    expect(await ensureDeploymentReady(ctx(platform), "main")).toBe("https://dep-2");
    expect(platform.deleteDeployment).toHaveBeenCalledWith("dep-1");
  });

  it("creates nothing once its job is cancelled", async () => {
    const { platform } = fakePlatform();
    await expect(
      ensureDeploymentReady(ctx(platform, { shouldCancel: async () => true }), "main"),
    ).rejects.toMatchObject({ code: "COMFY_API_DEPLOY_CANCELLED" });
    expect(mutations(platform)).toBe(0);
  });
});

describe("closeIdleDeployments", () => {
  const NOW = Date.parse("2026-10-07T12:00:00.000Z");
  const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

  async function openDeployment(readyMinutesAgo: number, main: Record<string, unknown> = {}) {
    await fs.writeFile(path.join(ws.root, "konte.config.json"), JSON.stringify(config(main)));
    const { platform } = fakePlatform();
    await platform.createDeployment("rel-1");
    await updateDeploymentState(ws.root, "main", () => ({
      deploymentId: "dep-1",
      endpointUrl: "https://dep-1",
      readyAt: ago(readyMinutesAgo),
    }));
    return platform;
  }

  async function addJob(variantId: string, comfyTarget: string, endedMinutesAgo?: number) {
    const jobs = new JobManager(ws.videos.main!.video);
    await jobs.createJob({
      address: "video:shot.01.first",
      variantId,
      resolvedDeps: {},
      backendKind: "comfy-api",
      comfyTarget,
    });
    if (endedMinutesAgo !== undefined) {
      await jobs.updateJob(variantId, { status: "completed", completedAt: ago(endedMinutesAgo) });
    }
  }

  function close(platform: FakePlatform, opts: { force?: boolean; afterWait?: boolean } = {}) {
    return closeIdleDeployments({
      workspaceRoot: ws.root,
      log: () => {},
      now: NOW,
      platform: platform as unknown as ComfyPlatformClient,
      ...opts,
    });
  }

  it("deletes a deployment idle for idleMinutes since it came up", async () => {
    const platform = await openDeployment(15);

    expect(await close(platform)).toEqual(["main"]);
    expect(platform.deleteDeployment).toHaveBeenCalledWith("dep-1");
    expect(await loadDeploymentState(ws.root, "main")).toMatchObject({
      deploymentId: null,
      endpointUrl: null,
      stopped: false,
    });
  });

  it("leaves one that came up more recently", async () => {
    const platform = await openDeployment(14);
    expect(await close(platform)).toEqual([]);
    expect(platform.deleteDeployment).not.toHaveBeenCalled();
  });

  it("counts idle time from the last job that ended on it", async () => {
    const platform = await openDeployment(60);
    await addJob("v-recent", "comfyapi:main", 5);
    await addJob("v-elsewhere", "comfycloud", 1);
    expect(await close(platform)).toEqual([]);

    expect(await close(platform, { force: true })).toEqual(["main"]);
  });

  it("closes nothing while a job of any video is still to run on it", async () => {
    const platform = await openDeployment(60);
    await addJob("v-queued", "comfyapi:main");

    expect(await close(platform, { force: true })).toEqual([]);
    expect(platform.deleteDeployment).not.toHaveBeenCalled();
  });

  it("closes one set to idleMinutes 0 only at the end of a wait", async () => {
    const platform = await openDeployment(60, { idleMinutes: 0 });

    expect(await close(platform)).toEqual([]);
    expect(await close(platform, { afterWait: true })).toEqual(["main"]);
  });

  // With no daemon alive, nothing would judge the idle time once the wait ends.
  it("closes at the end of a wait with no daemon alive, idle time or not", async () => {
    const platform = await openDeployment(1);

    expect(await close(platform)).toEqual([]);
    expect(await close(platform, { afterWait: true })).toEqual(["main"]);
  });

  it("leaves the idle time to a live daemon at the end of a wait", async () => {
    const platform = await openDeployment(1);
    await registerDaemon(ws.root);
    try {
      expect(await close(platform, { afterWait: true })).toEqual([]);
    } finally {
      unregisterDaemonSync(ws.root);
    }
  });

  it("closes nothing at the end of a wait while a job of any video is still to run", async () => {
    const platform = await openDeployment(1);
    await addJob("v-queued", "comfyapi:main");

    expect(await close(platform, { afterWait: true })).toEqual([]);
  });

  it("stops one set to close: stop, and leaves it alone after", async () => {
    const platform = await openDeployment(30, { close: "stop" });

    expect(await close(platform)).toEqual(["main"]);
    expect(platform.stopDeployment).toHaveBeenCalledWith("dep-1");
    expect(platform.deleteDeployment).not.toHaveBeenCalled();
    expect(await loadDeploymentState(ws.root, "main")).toMatchObject({
      deploymentId: "dep-1",
      stopped: true,
    });

    expect(await close(platform, { force: true })).toEqual([]);
  });

  // Another deployment on the same release — one this workspace did not create — is left alone.
  it("closes the deployment a create with a lost answer made, and only that one", async () => {
    await fs.writeFile(path.join(ws.root, "konte.config.json"), JSON.stringify(config()));
    const { platform } = fakePlatform();
    await platform.createDeployment("rel-1");
    const compute = { gpuClass: "L40S", region: "us-east", min: 0, max: 1 };
    await platform.createDeployment("rel-1", compute, "key-1");
    await updateDeploymentState(ws.root, "main", () => ({
      releaseId: "rel-1",
      pendingCreate: {
        key: "key-1",
        releaseId: "rel-1",
        gpuClass: "L40S",
        region: "us-east",
        max: 1,
      },
      readyAt: ago(60),
    }));

    expect(await close(platform)).toEqual(["main"]);
    expect(platform.deleteDeployment.mock.calls).toEqual([["dep-2"]]);
  });

  // A bring-up holds the lock while it records a create of its own; the close must not resend an
  // older one over it.
  it("leaves an unconfirmed create alone while a bring-up holds the lock", async () => {
    await fs.writeFile(path.join(ws.root, "konte.config.json"), JSON.stringify(config()));
    const { platform } = fakePlatform();
    await updateDeploymentState(ws.root, "main", () => ({
      releaseId: "rel-1",
      pendingCreate: {
        key: "key-1",
        releaseId: "rel-1",
        gpuClass: "L40S",
        region: "us-east",
        max: 1,
      },
    }));

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holding = withFileLock(deploymentLockPath(ws.root, "main"), () => held);
    await close(platform);
    release();
    await holding;

    expect(platform.createDeployment).not.toHaveBeenCalled();
    expect((await loadDeploymentState(ws.root, "main")).pendingCreate).not.toBeNull();
  });

  // A stop is accepted before it takes; one that did not (`stop_failed`) is closed again.
  it("stops again a deployment its stop did not take on", async () => {
    const platform = await openDeployment(30, { close: "stop" });
    await close(platform);
    platform.stopDeployment.mockClear();
    platform.getDeployment.mockResolvedValueOnce({
      id: "dep-1",
      status: "stop_failed",
      releaseId: "rel-1",
    });

    expect(await close(platform)).toEqual(["main"]);
    expect(platform.stopDeployment).toHaveBeenCalledWith("dep-1");
  });

  it("closes nothing without COMFY_API_KEY", async () => {
    const platform = await openDeployment(60);
    vi.stubEnv("COMFY_API_KEY", "");
    expect(await close(platform, { force: true })).toEqual([]);
  });
});
