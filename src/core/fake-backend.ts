import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  GenerationBackend,
  GenerationRequest,
  GenerationResult,
  WaitForCompletionResult,
  WaitOptions,
} from "./backend.js";
import { KonteError } from "./errors.js";
import type { JobRecord } from "./types/index.js";
import { sleep } from "./sleep.js";

interface FakeBackendOptions {
  delayMs?: number;
  shouldFail?: boolean;
  failMessage?: string;
  defaultExtension?: string;
}

export class FakeBackend implements GenerationBackend {
  private readonly delayMs: number;
  private readonly shouldFail: boolean;
  private readonly failMessage: string;
  private readonly defaultExtension: string;
  private readonly activeJobs = new Set<string>();
  private nextJobId = 1;

  constructor(options: FakeBackendOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.shouldFail = options.shouldFail ?? false;
    this.failMessage = options.failMessage ?? "Simulated generation failure";
    this.defaultExtension = options.defaultExtension ?? ".mp4";
  }

  private outputExtension(_assetDefinition: GenerationRequest["assetDefinition"]): string {
    return this.defaultExtension;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const jobId = `fake-job-${this.nextJobId++}`;
    this.activeJobs.add(jobId);

    const start = performance.now();

    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    if (this.shouldFail) {
      throw new KonteError("GENERATION_FAILED", this.failMessage);
    }

    const ext = this.outputExtension(request.assetDefinition);
    const fileName = `${request.variantId}${ext}`;
    const filePath = path.join(request.outputDir, fileName);

    await fs.mkdir(request.outputDir, { recursive: true });
    const content = `fake-asset:${request.address}:${request.variantId}`;
    await fs.writeFile(filePath, content, "utf-8");

    return {
      files: [filePath],
      metadata: { jobId },
      durationMs: Math.round(performance.now() - start),
    };
  }

  async submit(_request: GenerationRequest, _jobRecord: JobRecord): Promise<string> {
    const jobId = `fake-job-${this.nextJobId++}`;
    this.activeJobs.add(jobId);
    return jobId;
  }

  async waitForCompletion(
    backendJobId: string,
    outputDir: string,
    _options?: WaitOptions,
  ): Promise<WaitForCompletionResult> {
    const start = performance.now();

    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    if (this.shouldFail) {
      throw new KonteError("GENERATION_FAILED", this.failMessage);
    }

    const ext = this.defaultExtension;
    const fileName = `output${ext}`;
    const filePath = path.join(outputDir, fileName);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(filePath, `fake-asset:${backendJobId}`, "utf-8");

    return {
      kind: "done",
      result: {
        files: [filePath],
        metadata: { jobId: backendJobId },
        durationMs: Math.round(performance.now() - start),
      },
    };
  }

  async cancel(jobId: string): Promise<void> {
    if (!this.activeJobs.has(jobId)) {
      throw new KonteError("JOB_NOT_FOUND", `Job "${jobId}" not found`);
    }
    this.activeJobs.delete(jobId);
  }
}
