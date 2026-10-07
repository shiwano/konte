import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest } from "../../core/backend.js";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { GenerationJob } from "../../core/types/index.js";
import { ComfyApiBackend, describeJobError } from "../backend.js";
import { updateDeploymentState } from "../deploy-state.js";
import { KonteError } from "../../core/errors.js";
import { TransientHttpError } from "../../core/http-retry.js";
import { ComfyApiHttpError } from "../http.js";
import type { ComfyApiJob, ComfyApiOutput, ComfyApiRuntimeClient } from "../runtime-client.js";

const { submitOnMock } = vi.hoisted(() => ({ submitOnMock: vi.fn() }));
vi.mock("../deployment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deployment.js")>()),
  submitOnDeployment: submitOnMock,
}));
// A submit held back by a replacement waits between tries; no test waits that out.
vi.mock("../../core/sleep.js", () => ({ sleep: async () => {} }));

const WORKFLOW = {
  "10": { class_type: "LoadImage", inputs: { image: "__konte:reference:hero__" } },
  "9": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
};

let ws: Workspace;

beforeEach(async () => {
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

function backendWith(client: FakeClient): {
  backend: ComfyApiBackend;
  endpoints: string[];
} {
  const endpoints: string[] = [];
  const backend = new ComfyApiBackend(ws.videos.main!, {
    clientFactory: (endpoint) => {
      endpoints.push(endpoint);
      return client as unknown as ComfyApiRuntimeClient;
    },
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

// Bringing a deployment up is the bring-up's own subject (deployment.test.ts); here it is up.
async function readyDeployment(): Promise<void> {
  submitOnMock.mockImplementation(
    async (_ctx: unknown, _name: string, _jobId: string, submit: (e: string) => unknown) =>
      submit("https://dep.example"),
  );
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
      "comfyapi:main|job-7",
    );
    expect(endpoints).toEqual(["https://dep.example"]);
    // Submitted under the deployment's lock, recorded by the job it is for.
    expect(submitOnMock).toHaveBeenCalledWith(
      expect.anything(),
      "main",
      request().variantId,
      expect.any(Function),
    );
  });

  // A cancel while the submit was held back must not end in a paid job no one collects.
  it("sends nothing once its job is cancelled while held back", async () => {
    await readyDeployment();
    let cancelled = false;
    submitOnMock.mockImplementationOnce(async () => {
      cancelled = true;
      throw new KonteError("COMFY_API_DEPLOY_DEFERRED", "jobs are still running");
    });
    const client = fakeClient("deployment");
    const { backend } = backendWith(client);

    await expect(
      backend.submit(
        { ...request(), shouldCancel: async () => cancelled },
        jobRecord("comfyapi:main"),
        7,
      ),
    ).rejects.toMatchObject({ code: "COMFY_API_SUBMIT_CANCELLED" });
    expect(submitOnMock).toHaveBeenCalledTimes(1);
    expect(client.uploadInput).not.toHaveBeenCalled();
    expect(client.submitJob).not.toHaveBeenCalled();
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

  // A cancel during the bring-up itself, read once the deployment is ready.
  it("sends nothing when the job was cancelled during the bring-up", async () => {
    let cancelled = false;
    submitOnMock.mockImplementation(
      async (_ctx: unknown, _name: string, _jobId: string, submit: (e: string) => unknown) => {
        cancelled = true;
        return submit("https://dep.example");
      },
    );
    const client = fakeClient("deployment");
    const { backend } = backendWith(client);

    await expect(
      backend.submit(
        { ...request(), shouldCancel: async () => cancelled },
        jobRecord("comfyapi:main"),
        7,
      ),
    ).rejects.toMatchObject({ code: "COMFY_API_SUBMIT_CANCELLED" });
    expect(client.submitJob).not.toHaveBeenCalled();
  });

  // A replacement held back by other jobs on the deployment holds this submit back too; it is
  // never a failure of the job.
  it("waits out a deferred replacement, then submits", async () => {
    await readyDeployment();
    const deferred = new KonteError("COMFY_API_DEPLOY_DEFERRED", "jobs are still running");
    submitOnMock.mockRejectedValueOnce(deferred).mockRejectedValueOnce(deferred);
    const client = fakeClient("deployment");
    const { backend } = backendWith(client);

    expect(await backend.submit(request(), jobRecord("comfyapi:main"), 7)).toBe(
      "comfyapi:main|job-1",
    );
    expect(submitOnMock).toHaveBeenCalledTimes(3);
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
    await updateDeploymentState(ws.root, "main", () => ({ endpointUrl: "https://dep.example" }));
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
      backend.waitForCompletion("comfyapi:main|job-1", ws.videos.main!.video, {
        onLog: (l) => lines.push(l),
      }),
    ).rejects.toMatchObject({
      code: "COMFY_API_ERROR",
      message: "Comfy API job job-1 failed: node 4 CheckpointLoaderSimple: Value not in list (x)",
    });
    expect(lines).toContain("line two");
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
