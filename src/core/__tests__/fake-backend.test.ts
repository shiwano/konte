import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest } from "../backend.js";
import { KonteError } from "../errors.js";
import { FakeBackend } from "../fake-backend.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-fake-backend-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    address: "video:shot.01.motion",
    assetDefinition: {
      kind: "comfy",
      workflow: "animate.json",
      inputs: { prompt: "test" },
    },
    variantId: "v001",
    outputDir: tmpDir,
    resolvedDependencies: {},
    ...overrides,
  };
}

describe("FakeBackend", () => {
  describe("generate", () => {
    it("generates a .mp4 file for comfy asset", async () => {
      const backend = new FakeBackend();
      const result = await backend.generate(makeRequest());

      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatch(/v001\.mp4$/);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata).toHaveProperty("jobId");

      const content = await fs.readFile(result.files[0]!, "utf-8");
      expect(content).toBe("fake-asset:video:shot.01.motion:v001");
    });

    it("uses custom default extension", async () => {
      const backend = new FakeBackend({ defaultExtension: ".png" });
      const result = await backend.generate(
        makeRequest({
          address: "video:shot.02.motion",
        }),
      );

      expect(result.files[0]).toMatch(/v001\.png$/);
    });

    it("throws GENERATION_FAILED when shouldFail is true", async () => {
      const backend = new FakeBackend({ shouldFail: true });

      await expect(backend.generate(makeRequest())).rejects.toThrow(KonteError);
      await expect(backend.generate(makeRequest())).rejects.toMatchObject({
        code: "GENERATION_FAILED",
      });
    });

    it("uses custom failMessage", async () => {
      const backend = new FakeBackend({
        shouldFail: true,
        failMessage: "GPU out of memory",
      });

      await expect(backend.generate(makeRequest())).rejects.toThrow("GPU out of memory");
    });

    it("respects delayMs", async () => {
      vi.useFakeTimers();
      try {
        const backend = new FakeBackend({ delayMs: 50 });
        const promise = backend.generate(makeRequest());
        await vi.advanceTimersByTimeAsync(50);
        const result = await promise;
        expect(result.files).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cancel", () => {
    it("removes the job", async () => {
      const backend = new FakeBackend();
      const result = await backend.generate(makeRequest());
      const jobId = result.metadata.jobId as string;

      await backend.cancel(jobId);
      // Cancelling again fails: the job is no longer tracked.
      await expect(backend.cancel(jobId)).rejects.toMatchObject({
        code: "JOB_NOT_FOUND",
      });
    });

    it("throws JOB_NOT_FOUND for unknown jobId", async () => {
      const backend = new FakeBackend();

      await expect(backend.cancel("nonexistent")).rejects.toThrow(KonteError);
      await expect(backend.cancel("nonexistent")).rejects.toMatchObject({
        code: "JOB_NOT_FOUND",
      });
    });
  });
});
