import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { ComfyModelDeclaration, KonteConfig } from "../../core/types/index.js";
import { type ComfyAdapterDeclarations, workspaceComfyAdapters } from "../build-definition.js";
import { loadDeploymentState } from "../deploy-state.js";
import { buildDeployment, deploymentReadiness, routedDeploymentNames } from "../deployment.js";
import { ComfyApiHttpError } from "../http.js";
import type { ComfyPlatformClient, PlatformDeployment } from "../platform-client.js";
import type { ComfyRouter } from "../routing.js";

// Reading the workspace's adapters imports their files; the adapters a Build holds are given here.
vi.mock("../build-definition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../build-definition.js")>();
  return { ...actual, workspaceComfyAdapters: vi.fn() };
});

const flux: ComfyModelDeclaration = {
  filename: "flux.safetensors",
  type: "diffusion_model",
  url: "https://example.com/flux.safetensors",
};

function config(comfyVersion = "v0.4.0"): KonteConfig {
  return {
    comfy: {
      adapters: { "*": ["comfyapi:main"] },
      comfyapi: { deployments: { main: { comfyVersion } } },
    },
  } as KonteConfig;
}

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["main"], config: config() });
  await fs.mkdir(path.join(ws.root, ".konte"), { recursive: true });
  setAdapters([{ workflow: "image.json", models: [flux], nodes: [] }]);
});

afterEach(async () => {
  await ws.cleanup();
});

function setAdapters(adapters: ComfyAdapterDeclarations[]): void {
  vi.mocked(workspaceComfyAdapters).mockResolvedValue(adapters);
}

// The platform's Builds and releases, kept in memory; its deployments are whatever the human made.
function fakePlatform() {
  let releases = 0;
  const deployments: PlatformDeployment[] = [];
  const platform = {
    createBuild: vi.fn(async (_name: string, _definition: unknown) => ({ id: "build-1" })),
    getBuild: vi.fn(async (id: string) => ({ id, updatedAt: "t0" })),
    updateBuild: vi.fn(async (id: string, _definition: unknown) => ({ id })),
    createRelease: vi.fn(async () => `rel-${++releases}`),
    getRelease: vi.fn(async () => ({ status: "complete", deployable: true })),
    getReleaseLog: vi.fn(async () => null),
    listDeployments: vi.fn(async () => deployments.map((d) => ({ ...d }))),
  };
  return { platform, deployments };
}

type FakePlatform = ReturnType<typeof fakePlatform>["platform"];

const routedToMain = {
  routeAdapter: async () => ({ kind: "routed", target: "comfyapi:main" }),
} as unknown as ComfyRouter;

function ctx(
  platform: FakePlatform,
  overrides: { router?: ComfyRouter; config?: KonteConfig } = {},
) {
  return {
    workspaceRoot: ws.root,
    config: config(),
    apiKey: "key",
    log: () => {},
    platform: platform as unknown as ComfyPlatformClient,
    router: routedToMain,
    resolvers: { registryVersion: async () => "1.0.0" },
    timing: { releasePollMs: 1 },
    ...overrides,
  };
}

function deployment(id: string, releaseId: string, status = "ready"): PlatformDeployment {
  return { id, status, releaseId, endpointUrl: `https://${id}` };
}

describe("buildDeployment", () => {
  it("creates the Build and a release, and records each", async () => {
    const { platform } = fakePlatform();

    expect(await buildDeployment(ctx(platform), "main")).toEqual({
      buildId: "build-1",
      releaseId: "rel-1",
      deployment: null,
      outdated: [],
    });
    expect(platform.createBuild.mock.calls[0]![1]).toEqual({
      baseComfyVersion: "v0.4.0",
      models: [{ type: "diffusion_models", filename: "flux.safetensors", sourceUri: flux.url }],
      customNodes: [],
    });
    expect(await loadDeploymentState(ws.root, "main")).toMatchObject({
      buildId: "build-1",
      releaseId: "rel-1",
      pastReleaseIds: [],
    });
  });

  it("finds the human's ready deployment of the release", async () => {
    const { platform, deployments } = fakePlatform();
    deployments.push(deployment("dep-0", "rel-other"), deployment("dep-1", "rel-1"));

    expect((await buildDeployment(ctx(platform), "main")).deployment?.id).toBe("dep-1");
  });

  it("does not take a deployment of the release that is not ready", async () => {
    const { platform, deployments } = fakePlatform();
    deployments.push(deployment("dep-1", "rel-1", "stopped"));

    expect((await buildDeployment(ctx(platform), "main")).deployment).toBeNull();
  });

  it("changes nothing when nothing moved", async () => {
    const { platform } = fakePlatform();
    await buildDeployment(ctx(platform), "main");
    await buildDeployment(ctx(platform), "main");

    expect(platform.createBuild).toHaveBeenCalledTimes(1);
    expect(platform.updateBuild).not.toHaveBeenCalled();
    expect(platform.createRelease).toHaveBeenCalledTimes(1);
  });

  it("updates the Build, cuts a release, and names the deployment of the earlier one", async () => {
    const { platform, deployments } = fakePlatform();
    await buildDeployment(ctx(platform), "main");
    deployments.push(deployment("dep-1", "rel-1"));

    setAdapters([
      { workflow: "image.json", models: [flux], nodes: [] },
      { workflow: "video.json", models: [], nodes: [{ id: "comfyui-kjnodes" }] },
    ]);
    const result = await buildDeployment(ctx(platform), "main");

    expect(platform.updateBuild).toHaveBeenCalledWith("build-1", expect.anything(), "t0");
    expect(result).toMatchObject({ releaseId: "rel-2", deployment: null });
    expect(result.outdated.map((d) => d.id)).toEqual(["dep-1"]);
  });

  it("updates the Build to a new comfyVersion", async () => {
    const { platform } = fakePlatform();
    await buildDeployment(ctx(platform), "main");
    await buildDeployment(ctx(platform, { config: config("v0.5.0") }), "main");

    expect(platform.updateBuild.mock.calls[0]![1]).toMatchObject({ baseComfyVersion: "v0.5.0" });
    expect(platform.createRelease).toHaveBeenCalledTimes(2);
  });

  it("fails a release that built undeployable", async () => {
    const { platform } = fakePlatform();
    platform.getRelease.mockResolvedValue({ status: "complete", deployable: false });
    await expect(buildDeployment(ctx(platform), "main")).rejects.toMatchObject({
      code: "COMFY_API_RELEASE_FAILED",
    });
  });

  it("names a refused release as a release failure", async () => {
    const { platform } = fakePlatform();
    platform.createRelease.mockRejectedValue(
      new ComfyApiHttpError("COMFY_API_ERROR", "gated", {
        status: 400,
        serverCode: null,
        body: "",
      }),
    );
    await expect(buildDeployment(ctx(platform), "main")).rejects.toMatchObject({
      code: "COMFY_API_RELEASE_FAILED",
    });
  });

  it("refuses a deployment no adapter routes to", async () => {
    const { platform } = fakePlatform();
    const router = {
      routeAdapter: async () => ({ kind: "routed", target: "comfyui" }),
    } as unknown as ComfyRouter;
    await expect(buildDeployment(ctx(platform, { router }), "main")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(platform.createBuild).not.toHaveBeenCalled();
  });
});

describe("deploymentReadiness", () => {
  it("is unbuilt before any build", async () => {
    const { platform } = fakePlatform();
    expect(await deploymentReadiness(ctx(platform), "main")).toEqual({ kind: "unbuilt" });
  });

  it("is undeployed until the release has a ready deployment, then ready", async () => {
    const { platform, deployments } = fakePlatform();
    await buildDeployment(ctx(platform), "main");
    expect(await deploymentReadiness(ctx(platform), "main")).toEqual({
      kind: "undeployed",
      buildId: "build-1",
      releaseId: "rel-1",
    });

    deployments.push(deployment("dep-1", "rel-1"));
    expect(await deploymentReadiness(ctx(platform), "main")).toMatchObject({
      kind: "ready",
      endpointUrl: "https://dep-1",
    });
  });

  it("is unbuilt again once the adapters routed to it move", async () => {
    const { platform, deployments } = fakePlatform();
    await buildDeployment(ctx(platform), "main");
    deployments.push(deployment("dep-1", "rel-1"));

    platform.listDeployments.mockClear();

    setAdapters([{ workflow: "image.json", models: [], nodes: [] }]);
    expect(await deploymentReadiness(ctx(platform), "main")).toEqual({ kind: "unbuilt" });
    expect(platform.listDeployments).not.toHaveBeenCalled();
  });
});

describe("routedDeploymentNames", () => {
  it("names a declared deployment only while an adapter routes to it", async () => {
    const cfg = config();
    expect(await routedDeploymentNames(ws.root, cfg, routedToMain)).toEqual(["main"]);
    const toComfyui = {
      routeAdapter: async () => ({ kind: "routed", target: "comfyui" }),
    } as unknown as ComfyRouter;
    expect(await routedDeploymentNames(ws.root, cfg, toComfyui)).toEqual([]);
  });
});
