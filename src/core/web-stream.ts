import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

// lib.dom's ReadableStream and node:stream/web's are one object at runtime but unrelated types.
// `Readable.fromWeb` cancels the body when the pipeline fails, so a failed write does not wait on a
// pending read.
export function readableFromWeb(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>);
}
