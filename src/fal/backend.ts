import * as path from "node:path";
import type {
  GenerationBackend,
  GenerationRequest,
  WaitForCompletionResult,
  WaitOptions,
} from "../core/backend.js";
import { prepareBackendInputs } from "../backends/prepare-inputs.js";
import { KonteError } from "../core/errors.js";
import { pollUntilTerminal } from "../core/poll-until-terminal.js";
import type { FalAssetDefinition, JobRecord } from "../core/types/index.js";
import type { FalConfig } from "./config.js";
import { FalHttpClient } from "./http-client.js";
import { type FalOutputMedia, FalOutputMediaSchema } from "./types.js";

export function encodeBackendJobId(endpointId: string, requestId: string): string {
  return `${endpointId}|${requestId}`;
}

export function decodeBackendJobId(backendJobId: string): {
  endpointId: string;
  requestId: string;
} {
  const idx = backendJobId.indexOf("|");
  if (idx === -1) {
    throw new KonteError("FAL_ERROR", `Invalid FAL backend job ID: ${backendJobId}`);
  }
  return {
    endpointId: backendJobId.slice(0, idx),
    requestId: backendJobId.slice(idx + 1),
  };
}

export class FalBackend implements GenerationBackend {
  readonly httpClient: FalHttpClient;
  readonly videoRoot: string;

  constructor(config: FalConfig, videoRoot: string) {
    this.videoRoot = videoRoot;
    this.httpClient = new FalHttpClient(config.apiKey);
  }

  async submit(request: GenerationRequest, _jobRecord: JobRecord, seed: number): Promise<string> {
    if (request.assetDefinition.kind !== "fal") {
      throw new KonteError(
        "INVALID_ASSET_TYPE",
        `Expected fal asset, got "${request.assetDefinition.kind}"`,
      );
    }

    const falDef = request.assetDefinition as FalAssetDefinition;
    const inputs = await this.prepareInputs(falDef.inputs, request.resolvedDependencies, seed);

    const submitRes = await this.httpClient.submit(falDef.endpointId, inputs);
    return encodeBackendJobId(falDef.endpointId, submitRes.request_id);
  }

  async waitForCompletion(
    backendJobId: string,
    outputDir: string,
    options?: WaitOptions,
  ): Promise<WaitForCompletionResult> {
    // Two clocks: `deadline` is compared against the wall clock, while an elapsed time
    // must not go backwards when that clock is corrected mid-wait.
    const start = Date.now();
    const startMark = performance.now();
    const { endpointId, requestId } = decodeBackendJobId(backendJobId);

    // getStatus throws TransientHttpError on a transient comms failure; pollUntilTerminal
    // keeps waiting on that, surfaces a real error, and times out non-terminally.
    const poll = await pollUntilTerminal(
      async () => {
        const status = await this.httpClient.getStatus(endpointId, requestId);
        if (status.error) {
          throw new KonteError("FAL_ERROR", `FAL job failed: ${status.error}`);
        }
        if (status.status === "COMPLETED") {
          return { state: "done", result: undefined };
        }
        const progress =
          status.status === "IN_QUEUE"
            ? { value: 0, max: 100 }
            : status.status === "IN_PROGRESS"
              ? { value: 50, max: 100 }
              : undefined;
        return { state: "pending", progress };
      },
      {
        deadline: options?.timeoutMs ? start + options.timeoutMs : undefined,
        unconfirmedThresholdMs: options?.unconfirmedThresholdMs,
        onProgress: options?.onProgress,
        onLog: options?.onLog,
        onUnconfirmedChange: options?.onUnconfirmedChange,
        label: `request ${requestId}`,
      },
    );
    if (poll.kind !== "done") return { kind: "timedOut" };

    const result = await this.httpClient.getResult(endpointId, requestId);
    const files = await this.downloadResults(result, outputDir);

    return {
      kind: "done",
      result: {
        files,
        metadata: { requestId, endpointId },
        durationMs: Math.round(performance.now() - startMark),
      },
    };
  }

  async cancel(jobId: string): Promise<void> {
    const { endpointId, requestId } = decodeBackendJobId(jobId);
    await this.httpClient.cancel(endpointId, requestId);
  }

  private prepareInputs(
    inputs: Record<string, unknown>,
    resolvedDependencies: Record<string, string>,
    seed: number,
  ): Promise<Record<string, unknown>> {
    return prepareBackendInputs(
      inputs,
      resolvedDependencies,
      this.videoRoot,
      (absPath) => this.httpClient.uploadFile(absPath).then((r) => r.accessUrl),
      seed,
    );
  }

  private async downloadResults(
    result: Record<string, unknown>,
    outputDir: string,
  ): Promise<string[]> {
    const files: string[] = [];
    const outputPathFor = (name: string): string => {
      const base = path.basename(name);
      let candidate = path.join(outputDir, base);
      for (let suffix = 1; files.includes(candidate); suffix++) {
        candidate = path.join(outputDir, `${suffix}-${base}`);
      }
      return candidate;
    };

    const mediaFields = ["video", "image", "audio", "output"];
    for (const field of mediaFields) {
      const media = asOutputMedia(result[field]);
      if (media) {
        const fileName = media.file_name || `${field}${guessExtension(media.content_type)}`;
        // basename guards against a third-party app returning a traversal in file_name.
        const outputPath = outputPathFor(fileName);
        await this.httpClient.downloadFile(media.url, outputPath);
        files.push(outputPath);
      }
    }

    const arrayFields = ["images", "videos", "audios"];
    for (const field of arrayFields) {
      const items = result[field];
      if (Array.isArray(items)) {
        for (let i = 0; i < items.length; i++) {
          const media = asOutputMedia(items[i]);
          if (media) {
            const fileName =
              media.file_name || `${field}_${i}${guessExtension(media.content_type)}`;
            // basename guards against a third-party app returning a traversal in file_name.
            const outputPath = outputPathFor(fileName);
            await this.httpClient.downloadFile(media.url, outputPath);
            files.push(outputPath);
          }
        }
      }
    }

    if (files.length === 0) {
      throw new KonteError(
        "FAL_ERROR",
        "FAL job succeeded but returned no downloadable output files",
      );
    }

    return files;
  }
}

// A media field is present only if it carries a usable url; a model whose output field holds
// something else (a bare string, a nested object) simply contributes no file here.
function asOutputMedia(value: unknown): FalOutputMedia | null {
  const parsed = FalOutputMediaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function guessExtension(contentType: string | null | undefined): string {
  if (!contentType) return "";
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
  };
  return map[contentType] ?? "";
}
