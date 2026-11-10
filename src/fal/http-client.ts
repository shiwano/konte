import { openAsBlob } from "node:fs";
import * as path from "node:path";
import {
  downloadToFile,
  guessContentType,
  parseApiResponse,
  sendOnce,
} from "../backends/http-util.js";
import { rejectedCredentialMessage } from "../core/credentials.js";
import { KonteError, type KonteErrorCode, errorMessage } from "../core/errors.js";
import { fetchWithRetry, mediaTransferTimeoutMs, TransientHttpError } from "../core/http-retry.js";
import { redactExternalBody } from "../core/redact.js";
import { backendCredential } from "../core/types/credentials.js";
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

const FAL_KEY = backendCredential("fal")!.key;

async function failureMessage(res: Response, what: string): Promise<string> {
  const body = redactExternalBody(await res.text().catch(() => ""), [`\${${FAL_KEY}}`]);
  return `${what} failed (${res.status}): ${body}`;
}

async function failure(res: Response, what: string, code: KonteErrorCode): Promise<KonteError> {
  const message = await failureMessage(res, what);
  if (res.status === 401 || res.status === 403) {
    return new KonteError("FAL_UNAUTHORIZED", `${message}. ${rejectedCredentialMessage(FAL_KEY)}`);
  }
  return new KonteError(code, message);
}

function send(url: string, init: RequestInit, what: string): Promise<Response> {
  return sendOnce(url, init, what, (res) => failureMessage(res, what));
}

// An upload or a cancel that could not be sent changes nothing on fal's side; only a submit's
// outcome is left unknown.
async function sendOrFail(
  url: string,
  init: RequestInit,
  what: string,
  code: KonteErrorCode,
): Promise<Response> {
  try {
    return await send(url, init, what);
  } catch (err) {
    if (err instanceof TransientHttpError) throw new KonteError(code, err.message);
    throw err;
  }
}

export class FalHttpClient {
  private readonly readKey: () => string;

  // Read per request: a key replaced while a job runs reaches its next status check.
  constructor(readKey: () => string) {
    this.readKey = readKey;
  }

  async submit(endpointId: string, inputs: Record<string, unknown>): Promise<FalSubmitResponse> {
    const what = "FAL submit";
    let res: Response;
    try {
      res = await send(
        `https://queue.fal.run/${endpointId}`,
        { method: "POST", headers: this.headers(), body: JSON.stringify(inputs) },
        what,
      );
    } catch (err) {
      if (!(err instanceof TransientHttpError)) throw err;
      throw new KonteError(
        "SUBMISSION_UNCONFIRMED",
        `The FAL submission's outcome is unknown (${err.message}). It may already be running; ` +
          `automatic resubmission stopped. Check the requests on the fal.ai dashboard before rerolling.`,
      );
    }
    if (!res.ok) throw await failure(res, what, "FAL_ERROR");
    try {
      return await parseApiResponse(res, FalSubmitResponseSchema, "FAL_ERROR", what);
    } catch (err) {
      throw new KonteError(
        "SUBMISSION_UNCONFIRMED",
        `fal accepted the submission (${res.status}) but its request id could not be read ` +
          `(${errorMessage(err)}). It is probably running; automatic resubmission stopped. ` +
          `Check the requests on the fal.ai dashboard before rerolling.`,
      );
    }
  }

  async getStatus(endpointId: string, requestId: string): Promise<FalStatusResponse> {
    const url = `https://queue.fal.run/${queueAppId(endpointId)}/requests/${requestId}/status?logs=1`;
    // Single attempt that classifies transient (throws TransientHttpError) vs permanent;
    // the poll loop in waitForCompletion owns the retry cadence and unconfirmed detection.
    const res = await fetchWithRetry(url, { headers: this.headers() }, { maxRetries: 0 });

    if (!res.ok) throw await failure(res, "FAL status check", "FAL_ERROR");

    return parseApiResponse(res, FalStatusResponseSchema, "FAL_ERROR", "FAL status check");
  }

  async getResult(endpointId: string, requestId: string): Promise<Record<string, unknown>> {
    const url = `https://queue.fal.run/${queueAppId(endpointId)}/requests/${requestId}`;
    const res = await fetchWithRetry(url, { headers: this.headers() });

    if (!res.ok) throw await failure(res, "FAL result fetch", "FAL_ERROR");

    return parseApiResponse(res, FalResultResponseSchema, "FAL_ERROR", "FAL result fetch");
  }

  async cancel(endpointId: string, requestId: string): Promise<void> {
    const url = `https://queue.fal.run/${queueAppId(endpointId)}/requests/${requestId}/cancel`;
    const res = await sendOrFail(
      url,
      { method: "PUT", headers: this.headers() },
      "FAL cancel",
      "FAL_ERROR",
    );
    if (!res.ok) throw await failure(res, "FAL cancel", "FAL_ERROR");
  }

  async uploadFile(filePath: string): Promise<{ accessUrl: string }> {
    const fileName = path.basename(filePath);
    const contentType = guessContentType(fileName);
    // A lazily-read Blob, not a Buffer: a `file` asset can be gigabytes, and reading it whole into
    // memory just to hand it to fetch is what an upload of one costs today.
    const fileData = await openAsBlob(filePath, { type: contentType });

    const tokenRes = await sendOrFail(
      "https://rest.alpha.fal.ai/storage/auth/token?storage_type=fal-cdn-v3",
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ content_type: contentType, file_name: fileName }),
      },
      "FAL upload token",
      "FAL_UPLOAD_FAILED",
    );
    if (!tokenRes.ok) throw await failure(tokenRes, "FAL upload token", "FAL_UPLOAD_FAILED");

    const tokenData = await parseApiResponse(
      tokenRes,
      FalUploadTokenResponseSchema,
      "FAL_UPLOAD_FAILED",
      "FAL upload token",
    );

    const uploadRes = await sendOrFail(
      `${tokenData.base_url}/files/upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.token}`,
          "Content-Type": contentType,
          "X-Fal-File-Name": fileName,
        },
        body: fileData,
        signal: AbortSignal.timeout(mediaTransferTimeoutMs(fileData.size)),
      },
      "FAL file upload",
      "FAL_UPLOAD_FAILED",
    );
    if (!uploadRes.ok) throw await failure(uploadRes, "FAL file upload", "FAL_UPLOAD_FAILED");

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
      const res = await fetchWithRetry(
        "https://queue.fal.run",
        { method: "HEAD", headers: this.headers() },
        { maxRetries: 0, timeoutMs: 5000 },
      );
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${this.readKey()}`,
      "Content-Type": "application/json",
    };
  }
}
