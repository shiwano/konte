import { describe, expect, it } from "vitest";
import { ADAPTER_KEY_METADATA_KEY } from "../adapter-key.js";
import type { GenerationBackend, GenerationRequest } from "../backend.js";
import { seed } from "../dsl/shot-context.js";
import type { JobManager } from "../job-manager.js";
import { submitToBackend } from "../submit-generation.js";
import type { GenerationJob } from "../types/index.js";

function fakeJob(): GenerationJob {
  return {
    id: "v-test",
    variantId: "v-test",
    backendKind: "local",
    lease: { owner: "w-test" },
  } as unknown as GenerationJob;
}

function fakeRequest(): GenerationRequest {
  return {
    address: "animatic:shot.01.key",
    assetDefinition: { kind: "local", operation: "resize", mediaType: "image", inputs: {} },
    variantId: "v-test",
    outputDir: "/tmp/out",
    resolvedDependencies: {},
  };
}

function fakeJobManager(logs: string[]): JobManager {
  return {
    beginSubmission: async () => {},
    appendLog: (_id: string, line: string) => {
      logs.push(line);
    },
  } as unknown as JobManager;
}

describe("submitToBackend", () => {
  it("stamps adapterKey for every submitted generation job", async () => {
    const backend = {
      submit: async () => "backend-123",
    } as unknown as GenerationBackend;

    const { backendJobId, metadata } = await submitToBackend(
      fakeJobManager([]),
      backend,
      fakeJob(),
      fakeRequest(),
    );

    expect(backendJobId).toBe("backend-123");
    expect(metadata[ADAPTER_KEY_METADATA_KEY]).toBe("resize");
    expect(metadata.comfyClientId).toBeUndefined();
  });

  it("records the seed passed to submit when the definition uses a seed placeholder", async () => {
    let seenSeed: number | undefined;
    const backend = {
      submit: async (_req: GenerationRequest, _job: GenerationJob, s: number) => {
        seenSeed = s;
        return "backend-seed";
      },
    } as unknown as GenerationBackend;

    const request = fakeRequest();
    request.assetDefinition = {
      kind: "fal",
      endpointId: "fal-ai/x",
      mediaType: "image",
      inputs: { prompt: "a cat", seed: seed() },
    };

    const { metadata } = await submitToBackend(fakeJobManager([]), backend, fakeJob(), request);

    expect(typeof seenSeed).toBe("number");
    expect(metadata.seed).toBe(seenSeed);
  });

  it("omits the seed for a definition with no seed placeholder", async () => {
    const backend = { submit: async () => "backend-noseed" } as unknown as GenerationBackend;

    const { metadata } = await submitToBackend(
      fakeJobManager([]),
      backend,
      fakeJob(),
      fakeRequest(),
    );

    expect(metadata.seed).toBeUndefined();
  });

  it("logs the backend submission", async () => {
    const logs: string[] = [];
    const backend = {
      submit: async () => "backend-456",
    } as unknown as GenerationBackend;

    await submitToBackend(fakeJobManager(logs), backend, fakeJob(), fakeRequest());

    expect(logs).toEqual(["Submitted to local (backendJobId: backend-456)"]);
  });
});
