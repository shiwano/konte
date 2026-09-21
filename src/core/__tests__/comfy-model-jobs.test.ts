import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerationBackend, GenerationRequest, WaitForCompletionResult } from "../backend.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineVideo } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { emptyAnimatic, emptyReference, shot, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";
import { ensureComfyModelJobs } from "../../cli/generate-orchestrator.js";
import { comfyModelJobId, JobManager } from "../job-manager.js";
import { submitReadyPendingJobs } from "../pending-jobs.js";
import { StateManager } from "../state/index.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";
import type { VideoRoots } from "../roots.js";
import type {
  AssetDefinition,
  BackendKind,
  ComfyModelDeclaration,
  VideoDefinition,
} from "../types/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

function buildVideo(): VideoDefinition {
  return defineVideo(
    testDirection({
      fps: 30,
      size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
    }),
    {
      timeline: () => {
        asset("character", imageComfy, { prompt: "a girl" });
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              asset("motion", imageComfy, { prompt: "move" });
              return el();
            },
          }),
        ]);
      },
    },
  );
}

const MODEL: ComfyModelDeclaration = {
  filename: "sd_xl_base_1.0.safetensors",
  type: "checkpoint",
  url: "https://example.com/sd_xl_base_1.0.safetensors",
};

const VAE: ComfyModelDeclaration = {
  filename: "vae.safetensors",
  type: "VAE",
  url: "https://example.com/vae.safetensors",
};

/** Backend that records every submit() call, keyed by variant. */
class CountingBackend implements GenerationBackend {
  constructor(private readonly counts: Map<string, number>) {}
  async submit(request: GenerationRequest): Promise<string> {
    const n = (this.counts.get(request.variantId) ?? 0) + 1;
    this.counts.set(request.variantId, n);
    return `fake-${request.variantId}-${n}`;
  }
  async waitForCompletion(): Promise<WaitForCompletionResult> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
}

let ws: Workspace;
let roots: VideoRoots;
let tmpDir: string;
let jobManager: JobManager;

beforeEach(async () => {
  ws = await makeWorkspace({ videos: ["v1"], seedState: false });
  roots = ws.videos.v1!;
  tmpDir = roots.video;
  await fs.mkdir(path.join(tmpDir, ".konte"), { recursive: true });
  jobManager = new JobManager(tmpDir);
});

afterEach(async () => {
  await ws.cleanup();
});

describe("comfyModelJobId", () => {
  it("is deterministic and keyed by install target (type, savePath, filename)", () => {
    expect(comfyModelJobId(MODEL)).toBe(comfyModelJobId(MODEL));
    expect(comfyModelJobId(MODEL)).toMatch(/^cmd-[0-9A-Za-z]{8}$/);
    // Same filename but a different type is a different model → different job.
    expect(comfyModelJobId(MODEL)).not.toBe(comfyModelJobId({ ...MODEL, type: "lora" }));
  });
});

describe("JobManager.ensureComfyModelDownloadJob", () => {
  it("creates one shared job and reuses it for the same model", async () => {
    const first = await jobManager.ensureComfyModelDownloadJob(MODEL);
    const second = await jobManager.ensureComfyModelDownloadJob(MODEL);

    expect(first.id).toBe(comfyModelJobId(MODEL));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const job = await jobManager.getJob(first.id);
    if (job.kind !== "comfy-model-download") throw new Error("expected a comfy-model-download job");
    expect(job.status).toBe("pending");
    expect(job.model.filename).toBe(MODEL.filename);
    expect(job.model.url).toBe(MODEL.url);
  });

  it("resets a previously failed model job to pending so it retries", async () => {
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await jobManager.updateJob(id, { status: "failed", error: "boom" });

    const again = await jobManager.ensureComfyModelDownloadJob(MODEL);
    expect(again.reset).toBe(true);

    const job = await jobManager.getJob(id);
    expect(job.status).toBe("pending");
    expect(job.error).toBeNull();
  });

  it("refreshes the stored declaration of a failed job so the retry uses the new url", async () => {
    // The job id keys the install target only, so a corrected url maps to the same job file;
    // the worker downloads from the stored declaration, not the caller's.
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await jobManager.updateJob(id, { status: "failed", error: "404" });

    const fixed = { ...MODEL, url: "https://example.com/fixed.safetensors" };
    const again = await jobManager.ensureComfyModelDownloadJob(fixed);
    expect(again.id).toBe(id);
    expect(again.reset).toBe(true);

    const job = await jobManager.getJob(id);
    if (job.kind !== "comfy-model-download") throw new Error("expected a comfy-model-download job");
    expect(job.status).toBe("pending");
    expect(job.model.url).toBe(fixed.url);
  });

  it("refreshes the stored declaration of a still-pending job", async () => {
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);

    const fixed = { ...MODEL, url: "https://example.com/fixed.safetensors" };
    await jobManager.ensureComfyModelDownloadJob(fixed);

    const job = await jobManager.getJob(id);
    if (job.kind !== "comfy-model-download") throw new Error("expected a comfy-model-download job");
    expect(job.model.url).toBe(fixed.url);
  });

  // A confirmed absence retires the record: no clean/prune/cancel path used to touch a standalone
  // job, so trusting it left the download unrecoverable short of deleting the file by hand.
  it("resets a completed job when the model's absence was confirmed", async () => {
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await jobManager.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

    const again = await jobManager.ensureComfyModelDownloadJob(
      { ...MODEL, url: "https://example.com/other" },
      { resetCompleted: true },
    );

    expect(again).toEqual({ id, created: false, reset: true });
    const job = await jobManager.getJob(id);
    if (job.kind !== "comfy-model-download") throw new Error("expected a comfy-model-download job");
    expect(job.status).toBe("pending");
    expect(job.completedAt).toBeNull();
    // The re-download reads the current declaration, not the one the stale record carried.
    expect(job.model.url).toBe("https://example.com/other");
  });

  // An unreachable ComfyUI reports every model missing. Retiring completed records on that would
  // churn the whole project's provisioning back to pending on any offline run.
  it("keeps a completed job when the absence was only assumed", async () => {
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await jobManager.updateJob(id, { status: "completed", completedAt: new Date().toISOString() });

    expect(await jobManager.ensureComfyModelDownloadJob(MODEL)).toEqual({
      id,
      created: false,
      reset: false,
    });
    expect((await jobManager.getJob(id)).status).toBe("completed");
  });

  it("leaves an in-flight job alone", async () => {
    const { id } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await jobManager.updateJob(id, { status: "running" });

    expect(await jobManager.ensureComfyModelDownloadJob(MODEL)).toEqual({
      id,
      created: false,
      reset: false,
    });
    expect((await jobManager.getJob(id)).status).toBe("running");
  });
});

describe("ensureComfyModelJobs", () => {
  const comfyWithModels: AssetDefinition = {
    kind: "comfy",
    workflow: "x.json",
    inputs: {},
    models: [MODEL, VAE],
  };

  it("creates download jobs only for missing models", async () => {
    const ids = await ensureComfyModelJobs(comfyWithModels, jobManager, {
      ids: new Set([comfyModelJobId(MODEL)]),
      confirmed: true,
    });

    expect(ids).toEqual([comfyModelJobId(MODEL)]);
    // The already-present model gets no job.
    await expect(jobManager.getJob(comfyModelJobId(VAE))).rejects.toThrow();
  });

  it("creates a job per install target when one filename repeats across savePaths", async () => {
    // A directory-shaped model carries the same filename at several savePaths; keying the sweep
    // by filename alone would collapse them into one download and leave the rest missing.
    const root = {
      filename: "config.json",
      type: "checkpoint",
      url: "https://h/c",
      savePath: "TTS/m",
    } as const;
    const nested = { ...root, savePath: "TTS/m/speech_tokenizer" };
    const def: AssetDefinition = {
      kind: "comfy",
      workflow: "x.json",
      inputs: {},
      models: [root, nested],
    };

    const ids = await ensureComfyModelJobs(def, jobManager, {
      ids: new Set([comfyModelJobId(root), comfyModelJobId(nested)]),
      confirmed: true,
    });

    expect(ids).toEqual([comfyModelJobId(root), comfyModelJobId(nested)]);
  });

  it("creates no jobs when no declared model is missing", async () => {
    const ids = await ensureComfyModelJobs(comfyWithModels, jobManager, {
      ids: new Set(),
      confirmed: true,
    });
    expect(ids).toEqual([]);
  });
});

describe("submitReadyPendingJobs with comfy model dependencies", () => {
  async function setup(): Promise<{
    video: VideoDefinition;
    modelId: string;
    counts: Map<string, number>;
  }> {
    const video = buildVideo();
    await StateManager.init(tmpDir);
    const { id: modelId } = await jobManager.ensureComfyModelDownloadJob(MODEL);
    await jobManager.createJob({
      address: "video:timeline.character",
      variantId: "v-gen00001",
      resolvedDeps: {},
      backendKind: "comfy",
      dependsOnJobs: [modelId],
    });
    return { video, modelId, counts: new Map<string, number>() };
  }

  async function runCascade(video: VideoDefinition, counts: Map<string, number>) {
    return submitReadyPendingJobs(
      jobManager,
      roots,
      new Map<BackendKind, GenerationBackend>(),
      async () => new CountingBackend(counts),
      async () => ({ video: video, animatic: emptyAnimatic(), reference: emptyReference() }),
    );
  }

  it("does not submit a generation job while its model job is pending", async () => {
    const { video, counts } = await setup();
    const res = await runCascade(video, counts);

    expect(res.submitted).toEqual([]);
    expect(counts.get("v-gen00001")).toBeUndefined();
    // The model-download job itself is never submitted to a backend.
    expect([...counts.keys()]).toEqual([]);
    expect((await jobManager.getJob("v-gen00001")).status).toBe("pending");
  });

  it("submits the generation job once its model job is ready", async () => {
    const { video, modelId, counts } = await setup();
    await jobManager.updateJob(modelId, { status: "completed" });

    const res = await runCascade(video, counts);

    expect(res.submitted).toEqual(["v-gen00001"]);
    expect(counts.get("v-gen00001")).toBe(1);
    expect((await jobManager.getJob("v-gen00001")).status).toBe("running");
  });

  it("fails the generation job when its model job failed", async () => {
    const { video, modelId, counts } = await setup();
    await jobManager.updateJob(modelId, { status: "failed", error: "download failed" });

    const res = await runCascade(video, counts);

    expect(res.failed).toEqual(["v-gen00001"]);
    expect(counts.get("v-gen00001")).toBeUndefined();
    expect((await jobManager.getJob("v-gen00001")).status).toBe("failed");
  });
});
