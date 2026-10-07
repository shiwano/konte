import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest } from "../../core/backend.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { GenerationJob } from "../../core/types/index.js";
import { ComfyApiBackend, describeJobError } from "../backend.js";
import { updateDeploymentState } from "../deploy-state.js";
import { TransientHttpError } from "../../core/http-retry.js";
import { ComfyApiHttpError } from "../http.js";
import type { ComfyApiJob, ComfyApiOutput, ComfyApiRuntimeClient } from "../runtime-client.js";

import type { ComfyPlatformClient, PlatformDeployment } from "../platform-client.js";

// A 429 backoff waits between tries; no test waits that out.
vi.mock("../../core/sleep.js", () => ({ sleep: async () => {} }));

const WORKFLOW = {
  "10": { class_type: "LoadImage", inputs: { image: "__konte:reference:hero__" } },
  "9": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
};

let ws: Workspace;

beforeEach(async () => {
  deployments = [];
  ws = await makeWorkspace({ videos: ["main"] });
  await fs.mkdir(path.join(ws.root, "adapters", "comfy"), { recursive: true });
  await fs.writeFile(
    path.join(ws.root, "adapters", "comfy", "image.json"),
    JSON.stringify(WORKFLOW),
  );
  await fs.mkdir(path.join(ws.videos.main!.video, "assets"), { recursive: true });
  await fs.writeFile(path.join(ws.videos.main!.video, "assets", "hero.png"), "png");
  vi.stubEnv("COMFY_API_KEY", "key");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ws.cleanup();
});

function job(overrides: Partial<ComfyApiJob> = {}): ComfyApiJob {
  return { id: "job-1", status: "queued", outputs: [], ...overrides };
}

type FakeClient = {
  surface: "cloud" | "deployment";
  origin: string;
  uploadInput: ReturnType<typeof vi.fn>;
  submitJob: ReturnType<typeof vi.fn>;
  listJobs: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  downloadOutput: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
};

function fakeClient(surface: "cloud" | "deployment"): FakeClient {
  return {
    surface,
    origin: surface === "cloud" ? "https://cloud.comfy.org" : "https://dep.example",
    uploadInput: vi.fn(async () => "asset-1"),
    submitJob: vi.fn(async () => job()),
    listJobs: vi.fn(async () => []),
    getJob: vi.fn(async () => job()),
    getLogs: vi.fn(async () => null),
    downloadOutput: vi.fn(async (_output: ComfyApiOutput, outputPath: string) => {
      await fs.writeFile(outputPath, "bytes");
    }),
    cancelJob: vi.fn(async () => {}),
  };
}

// The deployments the human made on the platform.
let deployments: PlatformDeployment[] = [];

function backendWith(client: FakeClient): {
  backend: ComfyApiBackend;
  endpoints: string[];
} {
  const endpoints: string[] = [];
  const platform = {
    listDeployments: async () => deployments,
    getDeployment: async (id: string) => deployments.find((d) => d.id === id) ?? null,
  };
  const backend = new ComfyApiBackend(ws.videos.main!, {
    clientFactory: (endpoint) => {
      endpoints.push(endpoint);
      return client as unknown as ComfyApiRuntimeClient;
    },
    platformFactory: () => platform as unknown as ComfyPlatformClient,
  });
  return { backend, endpoints };
}

function request(): GenerationRequest {
  return {
    address: "video:shot.01.first",
    assetDefinition: {
      kind: "comfy",
      workflow: "image.json",
      inputs: {},
      outputNodeId: "9",
    },
    variantId: "v-abc",
    outputDir: ws.videos.main!.video,
    resolvedDependencies: { "reference:hero": "assets/hero.png" },
  };
}

function jobRecord(comfyTarget: string | null): GenerationJob {
  const now = new Date().toISOString();
  return {
    kind: "generation",
    id: "v-abc",
    address: "video:shot.01.first",
    variantId: "v-abc",
    status: "queued",
    backendKind: "comfy-api",
    backendJobId: null,
    comfyTarget,
    submissionStartedAt: null,
    progress: null,
    error: null,
    outputFiles: [],
    metadata: {},
    dependsOnAssets: [],
    dependsOnJobs: [],
    lease: null,
    provenance: {
      workflowHash: null,
      inputHash: null,
      resolvedDependencies: {},
      compositionCacheKeys: {},
    },
    createdAt: now,
    startedAt: null,
    processingStartedAt: null,
    updatedAt: now,
    completedAt: null,
    reportedAt: null,
    unconfirmedSince: null,
    sourceFingerprint: null,
    staleReleases: 0,
  } as GenerationJob;
}

const keyReuse = () =>
  new ComfyApiHttpError("COMFY_API_ERROR", "Comfy API job submit failed (409)", {
    status: 409,
    serverCode: "idempotency_key_reuse",
    body: "",
  });

// `konte adapter comfy build` cut rel-1, and the human deployed it.
async function readyDeployment(): Promise<void> {
  await updateDeploymentState(ws.root, "main", () => ({ releaseId: "rel-1" }));
  deployments = [
    { id: "dep-old", status: "ready", releaseId: "rel-0", endpointUrl: "https://old.example" },
    { id: "dep-1", status: "ready", releaseId: "rel-1", endpointUrl: "https://dep.example" },
  ];
}

describe("submit", () => {
  it("uploads each dependency and refers to it as a core/ASSET", async () => {
    const client = fakeClient("cloud");
    const { backend, endpoints } = backendWith(client);

    const id = await backend.submit(request(), jobRecord("comfycloud"), 7);

    expect(id).toBe("comfycloud|job-1");
    expect(endpoints).toEqual(["https://cloud.comfy.org"]);
    expect(client.uploadInput).toHaveBeenCalledWith(
      path.join(ws.videos.main!.video, "assets", "hero.png"),
    );
    const [graph, key] = client.submitJob.mock.calls[0]!;
    expect(key).toBe("v-abc");
    expect(graph["10"].inputs.image).toEqual({
      __type: "core/ASSET",
      info: { id: "asset-1", file_path: "hero.png" },
    });
  });

  it("refuses a job with no Comfy API target", async () => {
    const client = fakeClient("cloud");
    const { backend } = backendWith(client);

    for (const target of [null, "comfyui"]) {
      await expect(backend.submit(request(), jobRecord(target), 7)).rejects.toMatchObject({
        code: "COMFY_API_ERROR",
      });
    }
    expect(client.submitJob).not.toHaveBeenCalled();
  });

  it("stops on a reused key on Cloud, which lists no jobs", async () => {
    const client = fakeClient("cloud");
    client.submitJob.mockRejectedValue(keyReuse());
    const { backend } = backendWith(client);

    await expect(backend.submit(request(), jobRecord("comfycloud"), 7)).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
    });
    expect(client.listJobs).not.toHaveBeenCalled();
  });

  it("recovers a reused key from a deployment's job list", async () => {
    await readyDeployment();
    const client = fakeClient("deployment");
    client.submitJob.mockRejectedValue(keyReuse());
    client.listJobs.mockResolvedValue([
      job({ id: "other", idempotency_key: "v-other" }),
      job({ id: "job-7", idempotency_key: "v-abc" }),
    ]);
    const { backend, endpoints } = backendWith(client);

    expect(await backend.submit(request(), jobRecord("comfyapi:main"), 7)).toBe(
      "comfyapi:main|dep-1|job-7",
    );
    expect(endpoints).toEqual(["https://dep.example"]);
  });

  it("chooses the ready deployment of the recorded release as the site", async () => {
    await readyDeployment();
    const { backend } = backendWith(fakeClient("deployment"));
    expect(await backend.chooseSubmissionSite(request(), jobRecord("comfyapi:main"))).toBe("dep-1");
    expect(await backend.chooseSubmissionSite(request(), jobRecord("comfycloud"))).toBeNull();
  });

  // A resubmission must reach the deployment its first attempt went to, or its Idempotency-Key
  // finds nothing and the job runs twice.
  it("sends a resubmission to its recorded site, not the newest deployment", async () => {
    await readyDeployment();
    const client = fakeClient("deployment");
    const { backend, endpoints } = backendWith(client);

    expect(
      await backend.submit(
        { ...request(), submissionSite: "dep-old" },
        jobRecord("comfyapi:main"),
        7,
      ),
    ).toBe("comfyapi:main|dep-old|job-1");
    expect(endpoints).toEqual(["https://old.example"]);
  });

  it("refuses a deployment whose release has no ready deployment", async () => {
    await readyDeployment();
    deployments = deployments.filter((d) => d.id !== "dep-1");
    const client = fakeClient("deployment");
    const { backend } = backendWith(client);

    await expect(backend.submit(request(), jobRecord("comfyapi:main"), 7)).rejects.toMatchObject({
      code: "COMFY_API_DEPLOYMENT_NOT_READY",
    });
    expect(client.uploadInput).not.toHaveBeenCalled();
  });

  // A 429 backoff can outlast a `job cancel`; the resend would create a job no one collects.
  it("does not resend after a cancel during a 429 backoff", async () => {
    let cancelled = false;
    const client = fakeClient("cloud");
    client.submitJob.mockImplementationOnce(async () => {
      cancelled = true;
      throw new TransientHttpError("queue_full", { status: 429 });
    });
    const { backend } = backendWith(client);

    await expect(
      backend.submit(
        { ...request(), shouldCancel: async () => cancelled },
        jobRecord("comfycloud"),
        7,
      ),
    ).rejects.toMatchObject({ code: "COMFY_API_SUBMIT_CANCELLED" });
    expect(client.submitJob).toHaveBeenCalledTimes(1);
  });

  it("does not send after a cancel during the uploads", async () => {
    let cancelled = false;
    const client = fakeClient("cloud");
    client.uploadInput.mockImplementation(async () => {
      cancelled = true;
      return "asset-1";
    });
    const { backend } = backendWith(client);

    await expect(
      backend.submit(
        { ...request(), shouldCancel: async () => cancelled },
        jobRecord("comfycloud"),
        7,
      ),
    ).rejects.toMatchObject({ code: "COMFY_API_SUBMIT_CANCELLED" });
    expect(client.submitJob).not.toHaveBeenCalled();
  });

  it("stops when a deployment's job list does not hold the key", async () => {
    await readyDeployment();
    const client = fakeClient("deployment");
    client.submitJob.mockRejectedValue(keyReuse());
    const { backend } = backendWith(client);

    await expect(backend.submit(request(), jobRecord("comfyapi:main"), 7)).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
    });
  });

  it("surfaces any other refusal as it is", async () => {
    const client = fakeClient("cloud");
    client.submitJob.mockRejectedValue(
      new ComfyApiHttpError("COMFY_API_INSUFFICIENT_CREDITS", "no credits", {
        status: 402,
        serverCode: null,
        body: "",
      }),
    );
    const { backend } = backendWith(client);

    await expect(backend.submit(request(), jobRecord("comfycloud"), 7)).rejects.toMatchObject({
      code: "COMFY_API_INSUFFICIENT_CREDITS",
    });
  });
});

describe("waitForCompletion", () => {
  const outputs: ComfyApiOutput[] = [
    { node_id: "10", name: "hero.png", type: "image", id: "a-preview" },
    { node_id: "9", name: "result.png", type: "image", id: "a-result" },
    { node_id: "12", name: "meta.json", type: "text", id: "a-text" },
  ];

  it("downloads the adapter's output node's files", async () => {
    const client = fakeClient("cloud");
    client.getJob.mockResolvedValue(job({ status: "succeeded", outputs }));
    const { backend } = backendWith(client);
    backend.setOutputNodeId("comfycloud|job-1", "9");

    const result = await backend.waitForCompletion("comfycloud|job-1", ws.videos.main!.video);

    expect(result).toMatchObject({
      kind: "done",
      result: {
        files: [path.join(ws.videos.main!.video, "result.png")],
        metadata: { comfyApiJobId: "job-1", comfyTarget: "comfycloud" },
      },
    });
    expect(client.downloadOutput).toHaveBeenCalledTimes(1);
  });

  it("takes every media output when no node is named", async () => {
    const client = fakeClient("cloud");
    client.getJob.mockResolvedValue(job({ status: "succeeded", outputs }));
    const { backend } = backendWith(client);

    const result = await backend.waitForCompletion("comfycloud|job-1", ws.videos.main!.video);

    expect(result.kind === "done" && result.result.files.map((f) => path.basename(f))).toEqual([
      "hero.png",
      "result.png",
    ]);
  });

  it("fails naming the node errors, with a deployment's run log in the job log", async () => {
    await readyDeployment();
    const client = fakeClient("deployment");
    client.getJob.mockResolvedValue(
      job({
        status: "failed",
        error: {
          code: "validation",
          message: "Prompt outputs failed validation",
          node_errors: {
            "4": {
              class_type: "CheckpointLoaderSimple",
              errors: [{ type: "value_not_in_list", message: "Value not in list", details: "x" }],
            },
          },
        },
      }),
    );
    client.getLogs.mockResolvedValue("line one\nline two");
    const { backend } = backendWith(client);
    const lines: string[] = [];

    await expect(
      backend.waitForCompletion("comfyapi:main|dep-1|job-1", ws.videos.main!.video, {
        onLog: (l) => lines.push(l),
      }),
    ).rejects.toMatchObject({
      code: "COMFY_API_ERROR",
      message: "Comfy API job job-1 failed: node 4 CheckpointLoaderSimple: Value not in list (x)",
    });
    expect(lines).toContain("line two");
  });

  it("reads a job on the deployment it was sent to", async () => {
    await readyDeployment();
    const client = fakeClient("deployment");
    client.getJob.mockResolvedValue(job({ status: "succeeded", outputs }));
    const { backend, endpoints } = backendWith(client);

    await backend.waitForCompletion("comfyapi:main|dep-old|job-1", ws.videos.main!.video);
    expect(endpoints).toEqual(["https://old.example"]);
  });

  it("fails a job whose deployment is gone", async () => {
    const { backend } = backendWith(fakeClient("deployment"));
    await expect(
      backend.waitForCompletion("comfyapi:main|dep-1|job-1", ws.videos.main!.video),
    ).rejects.toMatchObject({ code: "COMFY_API_ERROR" });
  });
});

describe("describeJobError", () => {
  it("says nothing without an error", () => {
    expect(describeJobError(null)).toBe("");
  });

  it("joins each node's reasons", () => {
    expect(
      describeJobError({
        code: "validation",
        message: "failed",
        node_errors: {
          "3": {
            errors: [
              { type: "a", message: "one" },
              { type: "b", message: "two" },
            ],
          },
          "5": { class_type: "KSampler", errors: [{ type: "c", message: "three" }] },
        },
      }),
    ).toBe("node 3: one; two | node 5 KSampler: three");
  });

  it("falls back to the message and where it happened", () => {
    expect(
      describeJobError({
        code: "execution",
        message: "CUDA out of memory",
        node_id: "8",
        class_type: "VAEDecode",
      }),
    ).toBe("CUDA out of memory at node 8 VAEDecode");
    expect(describeJobError({ code: "execution", message: "boom" })).toBe("boom");
  });
});
