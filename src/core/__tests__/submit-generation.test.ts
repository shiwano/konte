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
    metadata: {},
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
    beginSubmission: async (_id: string, _owner: string, attempt: unknown) => attempt,
    appendLog: (_id: string, line: string) => {
      logs.push(line);
    },
  } as unknown as JobManager;
}

describe("submitToBackend", () => {
  it("records the site the backend chooses before sending there", async () => {
    let sentTo: string | null | undefined;
    const backend = {
      chooseSubmissionSite: async () => "dep-1",
      submit: async (req: GenerationRequest) => {
        sentTo = req.submissionSite;
        return { backendJobId: "backend-site" };
      },
    } as unknown as GenerationBackend;
    const begun: unknown[] = [];
    const jobManager = {
      ...fakeJobManager([]),
      beginSubmission: async (_id: string, _owner: string, attempt: unknown) => {
        begun.push(attempt);
        return attempt;
      },
    } as unknown as JobManager;

    await submitToBackend(jobManager, backend, fakeJob(), fakeRequest());

    expect(begun).toMatchObject([{ site: "dep-1" }]);
    expect(sentTo).toBe("dep-1");
  });

  it("keeps a resubmission on the first attempt's site without choosing again", async () => {
    let chosen = 0;
    let sentTo: string | null | undefined;
    const backend = {
      chooseSubmissionSite: async () => {
        chosen++;
        return "dep-new";
      },
      submit: async (req: GenerationRequest) => {
        sentTo = req.submissionSite;
        return { backendJobId: "backend-site" };
      },
    } as unknown as GenerationBackend;
    const first = { seed: 1, resolvedDependencies: {}, site: "dep-old" };
    const job = { ...fakeJob(), metadata: { submissionAttempt: first } } as GenerationJob;
    const jobManager = {
      ...fakeJobManager([]),
      beginSubmission: async () => first,
    } as unknown as JobManager;

    await submitToBackend(jobManager, backend, job, fakeRequest());

    expect(chosen).toBe(0);
    expect(sentTo).toBe("dep-old");
  });

  it("stamps adapterKey for every submitted generation job", async () => {
    const backend = {
      submit: async () => ({ backendJobId: "backend-123" }),
    } as unknown as GenerationBackend;

    const { backendJobId, metadata } = await submitToBackend(
      fakeJobManager([]),
      backend,
      fakeJob(),
      fakeRequest(),
    );

    expect(backendJobId).toBe("backend-123");
    expect(metadata[ADAPTER_KEY_METADATA_KEY]).toBe("resize");
  });

  it("carries what the backend's submit recorded into the job's metadata", async () => {
    const backend = {
      submit: async () => ({
        backendJobId: "backend-meta",
        metadata: { comfyClientId: "client-1", [ADAPTER_KEY_METADATA_KEY]: "spoofed" },
      }),
    } as unknown as GenerationBackend;

    const { metadata } = await submitToBackend(
      fakeJobManager([]),
      backend,
      fakeJob(),
      fakeRequest(),
    );

    expect(metadata.comfyClientId).toBe("client-1");
    expect(metadata[ADAPTER_KEY_METADATA_KEY]).toBe("resize");
  });

  it("records the seed passed to submit when the definition uses a seed placeholder", async () => {
    let seenSeed: number | undefined;
    const backend = {
      submit: async (_req: GenerationRequest, _job: GenerationJob, s: number) => {
        seenSeed = s;
        return { backendJobId: "backend-seed" };
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
    const backend = {
      submit: async () => ({ backendJobId: "backend-noseed" }),
    } as unknown as GenerationBackend;

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
      submit: async () => ({ backendJobId: "backend-456" }),
    } as unknown as GenerationBackend;

    await submitToBackend(fakeJobManager(logs), backend, fakeJob(), fakeRequest());

    expect(logs).toEqual(["Submitted to local (backendJobId: backend-456)"]);
  });
});
