import { createHash } from "node:crypto";
import { streamToFileAtomic } from "./atomic-write.js";
import { KonteError, errorMessage } from "./errors.js";
import { fetchWithRetry, MEDIA_TRANSFER_TIMEOUT_MS } from "./http-retry.js";
import { toolChecksum } from "./tool-checksums.js";

// Download a managed-tool artifact from `url` to `dest` (transient failures retried, redirects
// followed), streaming to disk via a temp + rename so a mid-download failure never leaves a partial
// file at the final path. The bytes are hashed as they stream and checked against the pinned
// SHA-256 for `url` before the rename, so an artifact konte has no checksum for — or one whose
// content has moved — never lands in the tool cache.
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const expected = toolChecksum(url);
  try {
    const res = await fetchWithRetry(url, undefined, { timeoutMs: MEDIA_TRANSFER_TIMEOUT_MS });
    if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
    let body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    if (onProgress) {
      const lenHeader = res.headers.get("content-length");
      const total = lenHeader ? Number.parseInt(lenHeader, 10) : Number.NaN;
      let received = 0;
      body = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength;
            onProgress(received, Number.isFinite(total) ? total : null);
            controller.enqueue(chunk);
          },
        }),
      );
    }
    const hash = createHash("sha256");
    body = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hash.update(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
    await streamToFileAtomic(body, dest, () => {
      const actual = hash.digest("hex");
      if (actual !== expected) {
        throw new KonteError(
          "CHECKSUM_MISMATCH",
          `Checksum mismatch for "${url}": expected ${expected}, got ${actual}. ` +
            `The download was discarded.`,
        );
      }
    });
  } catch (err) {
    if (err instanceof KonteError) throw err;
    throw new KonteError("DOWNLOAD_FAILED", `Failed to download "${url}": ${errorMessage(err)}`);
  }
}
