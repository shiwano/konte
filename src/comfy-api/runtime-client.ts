import { createReadStream, openAsBlob } from "node:fs";
import * as path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { z } from "zod";
import { guessContentType, parseApiResponse, saveDownloadResponse } from "../backends/http-util.js";
import { KonteError } from "../core/errors.js";
import {
  fetchWithRetry,
  MEDIA_TRANSFER_TIMEOUT_MS,
  mediaTransferTimeoutMs,
  TransientHttpError,
} from "../core/http-retry.js";
import { redactUrlSecret } from "../core/redact-url.js";
import {
  type ComfyApiAuth,
  ComfyApiHttpError,
  readJson,
  sendIdempotent,
  sendOnce,
  toHttpError,
} from "./http.js";

export const ComfyApiJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "canceling",
  "canceled",
  "failed",
  "expired",
]);
export type ComfyApiJobStatus = z.infer<typeof ComfyApiJobStatusSchema>;

const NodeErrorSchema = z
  .object({
    class_type: z.string().optional(),
    errors: z
      .array(
        z
          .object({ type: z.string(), message: z.string(), details: z.string().optional() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const JobErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    node_id: z.string().nullable().optional(),
    class_type: z.string().nullable().optional(),
    traceback: z.string().nullable().optional(),
    node_errors: z.record(z.string(), NodeErrorSchema).optional(),
  })
  .passthrough();
export type ComfyApiJobError = z.infer<typeof JobErrorSchema>;

const OutputSchema = z
  .object({
    node_id: z.string(),
    name: z.string(),
    type: z.string(),
    id: z.string(),
  })
  .passthrough();
export type ComfyApiOutput = z.infer<typeof OutputSchema>;

export const ComfyApiJobSchema = z
  .object({
    id: z.string(),
    status: ComfyApiJobStatusSchema,
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    progress: z
      .object({
        value: z.number(),
        current_node: z.string().nullable().optional(),
        current_node_class: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    outputs: z.array(OutputSchema).default([]),
    error: JobErrorSchema.nullable().optional(),
    idempotency_key: z.string().nullable().optional(),
  })
  .passthrough();
export type ComfyApiJob = z.infer<typeof ComfyApiJobSchema>;

const AssetSchema = z.object({ id: z.string() }).passthrough();

const JobListSchema = z.union([
  z.array(ComfyApiJobSchema),
  z.object({ jobs: z.array(ComfyApiJobSchema) }).passthrough(),
]);

const LogsSchema = z.object({ text: z.string() }).passthrough();

// The surfaces differ (cloud vs. deployment); `tags` is the one an upload depends on.
export type ComfyApiSurface = "cloud" | "deployment";

export async function blake3File(filePath: string): Promise<string> {
  const hasher = blake3.create();
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk as Uint8Array);
  return `blake3:${Buffer.from(hasher.digest()).toString("hex")}`;
}

/** The v2 runtime API, shared by Comfy Cloud and a deployment's endpoint. */
export class ComfyApiRuntimeClient {
  readonly apiBase: string;
  readonly origin: string;
  readonly surface: ComfyApiSurface;
  private readonly auth: ComfyApiAuth;

  constructor(endpoint: string, apiKey: string, surface: ComfyApiSurface) {
    const trimmed = endpoint.replace(/\/+$/, "");
    this.apiBase = trimmed.endsWith("/api/v2") ? trimmed : `${trimmed}/api/v2`;
    this.origin = new URL(this.apiBase).origin;
    this.surface = surface;
    this.auth = { scheme: "bearer", key: apiKey };
  }

  /** The asset id a workflow refers this file by, uploading it only when the platform lacks it. */
  async uploadInput(absPath: string): Promise<string> {
    const hash = await blake3File(absPath);
    const fileName = path.basename(absPath);
    const head = await sendIdempotent(
      `${this.apiBase}/assets/by-hash/${encodeURIComponent(hash)}`,
      {
        method: "HEAD",
        auth: this.auth,
      },
    );
    if (head.ok) {
      const res = await sendOnce(
        `${this.apiBase}/assets/from-hash`,
        {
          method: "POST",
          auth: this.auth,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash, file_path: fileName, tags: ["input"] }),
        },
        "Comfy API asset from hash",
      );
      // A blob the HEAD saw may age out before the mint; upload it instead.
      if (res.ok) {
        return (await parseApiResponse(res, AssetSchema, "COMFY_API_ERROR", "asset from hash")).id;
      }
      if (res.status !== 404) throw await toHttpError(res, "Comfy API asset from hash");
    } else if (head.status !== 404) {
      throw await toHttpError(head, "Comfy API asset lookup");
    }

    const contentType = guessContentType(fileName);
    const blob = await openAsBlob(absPath, { type: contentType });
    const form = new FormData();
    form.append("file", blob, fileName);
    form.append("content_type", contentType);
    form.append("file_path", fileName);
    form.append("expected_hash", hash);
    form.append("tags", this.surface === "cloud" ? JSON.stringify(["input"]) : "input");
    const res = await sendOnce(
      `${this.apiBase}/assets`,
      {
        method: "POST",
        auth: this.auth,
        body: form,
        signal: AbortSignal.timeout(mediaTransferTimeoutMs(blob.size)),
      },
      "Comfy API asset upload",
    );
    if (!res.ok) throw await toHttpError(res, "Comfy API asset upload");
    return (await parseApiResponse(res, AssetSchema, "COMFY_API_ERROR", "asset upload")).id;
  }

  /**
   * Submit a workflow. A transient failure means the job may or may not exist — the caller decides
   * how to find out. A validation failure still answers 201 and goes `failed` right after.
   */
  async submitJob(workflow: Record<string, unknown>, idempotencyKey: string): Promise<ComfyApiJob> {
    const res = await sendOnce(
      `${this.apiBase}/jobs`,
      {
        method: "POST",
        auth: this.auth,
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ workflow }),
      },
      "Comfy API job submit",
    );
    // 429 is the deployment still warming up or a full queue: back off and resubmit.
    if (res.status === 429) {
      const err = await toHttpError(res, "Comfy API job submit");
      throw new TransientHttpError(err.message, { status: 429 });
    }
    if (!res.ok) throw await toHttpError(res, "Comfy API job submit");
    return parseApiResponse(res, ComfyApiJobSchema, "COMFY_API_ERROR", "Comfy API job submit");
  }

  /** One status read; a transient failure is thrown for the poll loop to ride out. */
  async getJob(jobId: string): Promise<ComfyApiJob> {
    const res = await sendIdempotent(
      `${this.apiBase}/jobs/${encodeURIComponent(jobId)}`,
      { auth: this.auth },
      { maxRetries: 0 },
    );
    if (!res.ok) throw await toHttpError(res, "Comfy API job status");
    return parseApiResponse(res, ComfyApiJobSchema, "COMFY_API_ERROR", "Comfy API job status");
  }

  /** The newest jobs on a deployment. Cloud answers 405. */
  async listJobs(limit: number): Promise<ComfyApiJob[]> {
    const res = await sendIdempotent(`${this.apiBase}/jobs?limit=${limit}`, { auth: this.auth });
    if (!res.ok) throw await toHttpError(res, "Comfy API job list");
    const body = await parseApiResponse(
      res,
      JobListSchema,
      "COMFY_API_ERROR",
      "Comfy API job list",
    );
    return Array.isArray(body) ? body : body.jobs;
  }

  /** What the run printed, or null when the surface kept none (204). */
  async getLogs(jobId: string): Promise<string | null> {
    const res = await sendIdempotent(`${this.apiBase}/jobs/${encodeURIComponent(jobId)}/logs`, {
      auth: this.auth,
    });
    if (res.status === 204) return null;
    if (!res.ok) throw await toHttpError(res, "Comfy API job logs");
    const text = (await readJson<unknown>(res, "Comfy API job logs")) ?? {};
    const parsed = LogsSchema.safeParse(text);
    return parsed.success ? parsed.data.text : null;
  }

  async cancelJob(jobId: string): Promise<void> {
    const res = await sendIdempotent(`${this.apiBase}/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      auth: this.auth,
    });
    if (!res.ok) throw await toHttpError(res, "Comfy API job cancel");
  }

  /**
   * Save one output. `content` answers with a redirect to a signed URL, which is followed without
   * the key: the signature is the credential there, and storage refuses a second one.
   */
  async downloadOutput(output: ComfyApiOutput, outputPath: string): Promise<void> {
    const url = `${this.apiBase}/assets/${encodeURIComponent(output.id)}/content`;
    const res = await sendIdempotent(
      url,
      { auth: this.auth, redirect: "manual" },
      { timeoutMs: MEDIA_TRANSFER_TIMEOUT_MS },
    );
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new KonteError("COMFY_API_ERROR", `Output ${output.name} redirected nowhere`);
      }
      const signed = new URL(location, this.origin).toString();
      const file = await fetchWithRetry(signed, undefined, {
        timeoutMs: MEDIA_TRANSFER_TIMEOUT_MS,
      });
      if (!file.ok) {
        throw new KonteError(
          "COMFY_API_ERROR",
          `Failed to download ${output.name} (${file.status}): ${redactUrlSecret(signed)}`,
        );
      }
      await saveDownloadResponse(file, outputPath);
      return;
    }
    if (!res.ok) throw await toHttpError(res, `Comfy API download of ${output.name}`);
    await saveDownloadResponse(res, outputPath);
  }
}

export function isComfyApiNotFound(err: unknown): boolean {
  return err instanceof ComfyApiHttpError && err.status === 404;
}
