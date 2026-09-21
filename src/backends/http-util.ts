import * as path from "node:path";
import { z } from "zod";
import { streamToFileAtomic, writeFileAtomic } from "../core/atomic-write.js";
import { KonteError, type KonteErrorCode } from "../core/errors.js";
import {
  MEDIA_TRANSFER_TIMEOUT_MS,
  fetchWithRetry,
  TransientHttpError,
} from "../core/http-retry.js";
import { redactUrlSecret } from "../core/redact-url.js";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export function guessContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// A third-party API's JSON body is untrusted input. Validate it at the client boundary so a
// shape drift fails here with a typed error instead of surfacing as an `undefined` field deep
// in the job pipeline. Schemas cover only the fields konte consumes; unknown keys are stripped.
export async function parseApiResponse<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  errorCode: KonteErrorCode,
  what: string,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) {
      throw new TransientHttpError(`${what} response interrupted`, { cause });
    }
    throw new KonteError(errorCode, `${what} returned a non-JSON response`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new KonteError(
      errorCode,
      `${what} returned an unexpected shape: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

// Zod's own message embeds the received value (an unexpected enum member, a bad literal), and this
// message is persisted into the job record and log — a body that echoes a credentialed URL back
// into a validated field would land on disk. So report only where and what was expected.
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      const expected = "expected" in issue ? ` (expected ${String(issue.expected)})` : "";
      return `${at}: ${issue.code}${expected}`;
    })
    .join("; ");
}

// Download a delivery URL to disk (retried transient failures, per-attempt timeout, atomic
// write). The URL carries a signed token in its query; on failure log only host+path so the
// credential isn't persisted when the error reaches the job/log.
export async function downloadToFile(
  url: string,
  outputPath: string,
  errorCode: KonteErrorCode,
): Promise<void> {
  // A result video can be hundreds of MB; use the generous media-transfer per-attempt deadline
  // rather than the default so a slow-but-live download isn't aborted mid-stream.
  const res = await fetchWithRetry(url, undefined, { timeoutMs: MEDIA_TRANSFER_TIMEOUT_MS });
  if (!res.ok) {
    throw new KonteError(
      errorCode,
      `Failed to download file (${res.status}): ${redactUrlSecret(url)}`,
    );
  }

  await saveDownloadResponse(res, outputPath);
}

export async function saveDownloadResponse(res: Response, outputPath: string): Promise<void> {
  if (res.body) {
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (cause) {
          controller.error(new TransientHttpError("Result download interrupted", { cause }));
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    try {
      await streamToFileAtomic(body, outputPath);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    await writeFileAtomic(outputPath, Buffer.alloc(0));
  }
}
