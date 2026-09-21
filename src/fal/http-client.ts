import { openAsBlob } from "node:fs";
import * as path from "node:path";
import { downloadToFile, guessContentType, parseApiResponse } from "../backends/http-util.js";
import { KonteError } from "../core/errors.js";
import {
  API_REQUEST_TIMEOUT_MS,
  fetchWithRetry,
  mediaTransferTimeoutMs,
} from "../core/http-retry.js";
import { redactErrorBody } from "../core/redact-url.js";
import {
  type FalStatusResponse,
  type FalSubmitResponse,
  FalResultResponseSchema,
  FalStatusResponseSchema,
  FalSubmitResponseSchema,
  FalUploadResponseSchema,
  FalUploadTokenResponseSchema,
} from "./types.js";

// A request is addressed under its app (`owner/app`), never the endpoint's subpath — the queue
// answers `owner/app/<subpath>/requests/…` with 405.
function queueAppId(endpointId: string): string {
  return endpointId.split("/").slice(0, 2).join("/");
}

export class FalHttpClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async submit(endpointId: string, inputs: Record<string, unknown>): Promise<FalSubmitResponse> {
    const url = `https://queue.fal.run/${endpointId}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = redactErrorBody(await res.text().catch(() => ""));
      throw new KonteError("FAL_ERROR", `FAL submit failed (${res.status}): ${body}`);
    }

    return parseApiResponse(res, FalSubmitResponseSchema, "FAL_ERROR", "FAL submit");
  }

  async getStatus(endpointId: string, requestId: string): Promise<FalStatusResponse> {
    const url = `https://queue.fal.run/${queueAppId(endpointId)}/requests/${requestId}/status?logs=1`;
    // Single attempt that classifies transient (throws TransientHttpError) vs permanent;
    // the poll loop in waitForCompletion owns the retry cadence and unconfirmed detection.
    const res = await fetchWithRetry(url, { headers: this.headers() }, { maxRetries: 0 });

    if (!res.ok) {
      const body = redactErrorBody(await res.text().catch(() => ""));
      throw new KonteError("FAL_ERROR", `FAL status check failed (${res.status}): ${body}`);
    }

    return parseApiResponse(res, FalStatusResponseSchema, "FAL_ERROR", "FAL status check");
  }

  async getResult(endpointId: string, requestId: string): Promise<Record<string, unknown>> {
    const url = `https://queue.fal.run/${queueAppId(endpointId)}/requests/${requestId}`;
    const res = await fetchWithRetry(url, { headers: this.headers() });

    if (!res.ok) {
      const body = redactErrorBody(await res.text().catch(() => ""));
      throw new KonteError("FAL_ERROR", `FAL result fetch failed (${res.status}): ${body}`);
    }

    return parseApiResponse(res, FalResultResponseSchema, "FAL_ERROR", "FAL result fetch");
  }

  async cancel(endpointId: string, requestId: string): Promise<void> {
    const url = `https://queue.fal.run/${queueAppId(endpointId)}/requests/${requestId}/cancel`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.headers(),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = redactErrorBody(await res.text().catch(() => ""));
      throw new KonteError("FAL_ERROR", `FAL cancel failed (${res.status}): ${body}`);
    }
  }

  async uploadFile(filePath: string): Promise<{ accessUrl: string }> {
    const fileName = path.basename(filePath);
    const contentType = guessContentType(fileName);
    // A lazily-read Blob, not a Buffer: a `file` asset can be gigabytes, and reading it whole into
    // memory just to hand it to fetch is what an upload of one costs today.
    const fileData = await openAsBlob(filePath, { type: contentType });

    const tokenRes = await fetch(
      "https://rest.alpha.fal.ai/storage/auth/token?storage_type=fal-cdn-v3",
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          content_type: contentType,
          file_name: fileName,
        }),
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      },
    );

    if (!tokenRes.ok) {
      const body = redactErrorBody(await tokenRes.text().catch(() => ""));
      throw new KonteError(
        "FAL_UPLOAD_FAILED",
        `FAL upload token failed (${tokenRes.status}): ${body}`,
      );
    }

    const tokenData = await parseApiResponse(
      tokenRes,
      FalUploadTokenResponseSchema,
      "FAL_UPLOAD_FAILED",
      "FAL upload token",
    );

    const uploadRes = await fetch(`${tokenData.base_url}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.token}`,
        "Content-Type": contentType,
        "X-Fal-File-Name": fileName,
      },
      body: fileData,
      signal: AbortSignal.timeout(mediaTransferTimeoutMs(fileData.size)),
    });

    if (!uploadRes.ok) {
      const body = redactErrorBody(await uploadRes.text().catch(() => ""));
      throw new KonteError(
        "FAL_UPLOAD_FAILED",
        `FAL file upload failed (${uploadRes.status}): ${body}`,
      );
    }

    const uploadData = await parseApiResponse(
      uploadRes,
      FalUploadResponseSchema,
      "FAL_UPLOAD_FAILED",
      "FAL file upload",
    );
    return { accessUrl: uploadData.access_url };
  }

  async downloadFile(url: string, outputPath: string): Promise<void> {
    await downloadToFile(url, outputPath, "FAL_ERROR");
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch("https://queue.fal.run", {
        method: "HEAD",
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}
