import * as crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

// The temp lives in the same directory so the rename stays on one filesystem, and is named
// uniquely per process so concurrent writers don't clobber each other's temp. A failed write
// removes the temp, so a corrupt file never lands at the final path.
async function withAtomicTemp(
  filePath: string,
  write: (tmpPath: string) => Promise<void>,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await write(tmp);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Write a file atomically via a unique temp file + rename, so that concurrent
 * writers (e.g. the MCP watcher and a `konte job wait` process both downloading the
 * same job output) can never leave a partial/corrupt file, and readers (hashing,
 * thumbnail extraction) always see a complete file.
 */
export function writeFileAtomic(
  filePath: string,
  data: Buffer | Uint8Array | string,
  // Applied to the temp file, which the rename carries to the final path — so a secret is never
  // world-readable.
  options: { mode?: number } = {},
): Promise<void> {
  return withAtomicTemp(filePath, (tmp) =>
    fs.writeFile(tmp, data, options.mode === undefined ? undefined : { mode: options.mode }),
  );
}

/**
 * Stream a web `ReadableStream` (a `fetch` Response body) to a file via the same unique-temp +
 * rename discipline as `writeFileAtomic`, without buffering the whole payload in memory — a
 * result video can be hundreds of MB, and buffering it spikes RSS. The write stream's own errors
 * (e.g. ENOSPC) propagate through `pipeline`.
 */
export function streamToFileAtomic(
  body: ReadableStream<Uint8Array>,
  filePath: string,
  // Run once the whole stream has landed in the temp, before the rename. Throwing here removes the
  // temp, so content the caller rejects (a checksum mismatch) never reaches the final path.
  verify?: () => void | Promise<void>,
): Promise<void> {
  return withAtomicTemp(filePath, async (tmp) => {
    await pipeline(
      Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>),
      createWriteStream(tmp),
    );
    await verify?.();
  });
}
