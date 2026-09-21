import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { KonteError, errorMessage } from "../core/errors.js";
import { withFileLock } from "../core/file-lock.js";
import { redactErrorBody, redactUrlSecret } from "../core/redact-url.js";
import { buildTokenRedactor } from "./token-resolver.js";

// Holds the bytes in flight. A root that registers no extension filter lists every file it holds,
// so it is the name, not the suffix, that keeps a partial from reading as the model.
const PART_SUFFIX = ".konte-part";
// Identifies the partial, so a resume can prove the bytes still belong to the file being fetched.
const META_SUFFIX = ".konte-part.json";
const LOCK_SUFFIX = ".konte-lock";

// `shouldCancel` reads the job record, so it is asked on an interval rather than per chunk.
const CANCEL_POLL_INTERVAL_MS = 1000;
// Bounds the header phase only — connect, redirects, first response. The body is unbounded;
// cancellation covers a stalled one.
const HEADER_TIMEOUT_MS = 60_000;

const HF_HOSTS = new Set(["huggingface.co", "hf.co"]);

// The download runs in whichever process owns the job — the MCP watcher, when one is running — and
// that process read the workspace's credentials once at startup. A token added or rotated since
// then is not in its environment, so the file looks right and the request is still refused.
const STALE_ENV_HINT =
  "If a konte MCP server is running, restart it so it picks up the current credentials.";

export type ModelDownloadProgress = {
  received: number;
  // null when the server sends no length.
  total: number | null;
};

type ModelDownloadResult =
  | { kind: "downloaded"; bytes: number }
  | { kind: "cancelled" }
  | { kind: "alreadyPresent" }
  // Another worker holds the lock; the caller leaves the job re-observable rather than failing it.
  | { kind: "busy" };

type ModelDownloadOptions = {
  // Token placeholders already resolved. Never logged, never persisted.
  resolvedUrl: string;
  // The declaration's URL with its `${VAR}` placeholders intact, for messages that reach disk.
  declaredUrl: string;
  destPath: string;
  onProgress?: (p: ModelDownloadProgress) => void;
  onLog?: (msg: string) => void;
  shouldCancel?: () => boolean | Promise<boolean>;
};

// The declared URL plus the validator the bytes were fetched under — one URL can serve different
// content over time, and without a validator a resume cannot tell which it is continuing.
type PartMeta = { url: string; validator?: string };

// What a 206's `Content-Range` claims, once it has been checked for internal consistency.
type ParsedRange = { start: number; end: number; total: number };

/**
 * Fetch one model file straight into ComfyUI's model directory.
 *
 * Interrupted transfers resume: the partial stays under `<dest>.konte-part` beside a note of what
 * it is, and the next attempt continues it only when the server confirms the object has not
 * changed. The destination takes its real name only once every byte is accounted for.
 */
export async function downloadModelFile(opts: ModelDownloadOptions): Promise<ModelDownloadResult> {
  const { resolvedUrl, declaredUrl, destPath, onProgress, onLog, shouldCancel } = opts;
  const partPath = `${destPath}${PART_SUFFIX}`;
  const metaPath = `${destPath}${META_SUFFIX}`;

  if (await exists(destPath)) return { kind: "alreadyPresent" };
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  // Every string this function can put on disk goes through here. It covers the bearer token too,
  // which lives only in a header and so is invisible to `redactErrorBody`'s URL matching.
  const redactToken = buildTokenRedactor([declaredUrl, "${HF_TOKEN}"]);
  const scrub = (text: string): string => redactErrorBody(redactToken(text));

  try {
    // The run lease already serializes jobs, but a lease is meant to lapse and be reclaimed, and
    // two workers appending to one partial corrupt it.
    return await withFileLock(
      `${destPath}${LOCK_SUFFIX}`,
      async () => {
        const controller = new AbortController();
        let cancelled = false;
        let polling = false;
        const poll = setInterval(() => {
          void (async () => {
            if (cancelled || polling || !shouldCancel) return;
            polling = true;
            try {
              if (await Promise.resolve(shouldCancel()).catch(() => false)) {
                cancelled = true;
                controller.abort();
              }
            } finally {
              polling = false;
            }
          })();
        }, CANCEL_POLL_INTERVAL_MS);

        try {
          return await runDownload({
            resolvedUrl,
            declaredUrl,
            destPath,
            partPath,
            metaPath,
            controller,
            isCancelled: () => cancelled,
            scrub,
            ...(onProgress ? { onProgress } : {}),
            ...(onLog ? { onLog } : {}),
          });
        } finally {
          clearInterval(poll);
        }
      },
      // Long enough for the acquire loop to retry once after clearing an abandoned lock, short
      // enough that a lock held by a live transfer reports `busy` instead of blocking on it.
      { timeoutMs: 500 },
    );
  } catch (err) {
    if (err instanceof KonteError && err.code === "LOCK_TIMEOUT") return { kind: "busy" };
    // Aborted before the body began, so there was no pipeline to reject.
    if (err instanceof CancelledDuringHeaders) {
      onLog?.("Download cancelled before it started");
      return { kind: "cancelled" };
    }
    throw err;
  }
}

async function runDownload(ctx: {
  resolvedUrl: string;
  declaredUrl: string;
  destPath: string;
  partPath: string;
  metaPath: string;
  controller: AbortController;
  isCancelled: () => boolean;
  scrub: (text: string) => string;
  onProgress?: (p: ModelDownloadProgress) => void;
  onLog?: (msg: string) => void;
}): Promise<ModelDownloadResult> {
  const { resolvedUrl, declaredUrl, partPath, metaPath, controller, isCancelled, scrub } = ctx;
  const where = redactUrlSecret(declaredUrl);
  // Bun's `body.cancel()` leaves the socket streaming, so a response konte lets go of is dropped by
  // aborting the request that opened it — its own controller, not the shared cancel one.
  const openers = new WeakMap<Response, AbortController>();

  // Resume only with a validator to check it against.
  const meta = await readMeta(metaPath);
  const resumable =
    meta !== null && meta.url === declaredUrl && meta.validator !== undefined
      ? await sizeOf(partPath)
      : 0;
  if (resumable === 0) await discardPartial(partPath, metaPath);

  let res = resumable > 0 ? await request(resumable, meta?.validator) : await request(0);
  let startAt = 0;
  let objectTotal: number | null = null;

  if (resumable > 0) {
    // `If-Range` makes the server answer 200 when the object no longer matches, so a 206 here is
    // its assurance that these bytes continue the ones on disk.
    const range = res.status === 206 ? parseContentRange(res) : null;
    const usable =
      res.status === 206 &&
      range !== null &&
      range.start === resumable &&
      range.end === range.total - 1 &&
      lengthOf(res.headers.get("content-length")) === range.end - range.start + 1 &&
      validatorMatches(res, meta?.validator);
    if (usable && range !== null) {
      startAt = resumable;
      objectTotal = range.total;
      ctx.onLog?.(`Resuming download at ${formatBytes(startAt)}: ${where}`);
    } else if (res.status === 200) {
      // The object no longer matches, so this response already carries the whole of the new one.
      // Reuse it; re-requesting would download a multi-GB model twice.
      ctx.onLog?.(`The remote file changed; downloading ${where} in full`);
      await discardPartial(partPath, metaPath);
    } else if (res.status === 416 || res.status === 206) {
      // The range was refused, or the 206 did not describe the continuation asked for. This
      // response cannot stand in for the object either.
      ctx.onLog?.(`Cannot continue the existing partial; downloading ${where} from the start`);
      await discardPartial(partPath, metaPath);
      // A server free to answer with a bogus range is free to keep streaming it alongside the
      // replacement transfer.
      await abandon(res, openers.get(res));
      res = await request(0);
    }
  }

  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new KonteError("COMFYUI_ERROR", `Download of ${where} returned no body`);
  // A request that sent no Range must be answered with the whole object.
  if (startAt === 0 && res.status === 206) {
    await abandon(res, openers.get(res));
    throw new KonteError(
      "COMFYUI_ERROR",
      `Download of ${where} answered with a partial response to a request for the whole file.`,
    );
  }
  if (objectTotal === null) objectTotal = lengthOf(res.headers.get("content-length"));

  const append = startAt > 0;
  await writeMeta(metaPath, {
    url: declaredUrl,
    ...(currentValidator(res) !== undefined ? { validator: scrub(currentValidator(res)!) } : {}),
  });

  let received = startAt;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      ctx.onProgress?.({ received, total: objectTotal });
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
      counter,
      createWriteStream(partPath, { flags: append ? "a" : "w" }),
      { signal: controller.signal },
    );
  } catch (err) {
    if (isCancelled()) {
      // The partial survives — the next attempt resumes from it.
      ctx.onLog?.(`Download cancelled at ${formatBytes(received)}`);
      return { kind: "cancelled" };
    }
    throw new KonteError(
      "COMFYUI_ERROR",
      `Download of ${where} failed after ${formatBytes(received)}: ` + scrub(errorMessage(err)),
    );
  }

  const written = await sizeOf(partPath);
  if (objectTotal !== null && written !== objectTotal) {
    await discardPartial(partPath, metaPath);
    throw new KonteError(
      "COMFYUI_ERROR",
      `Download of ${where} is short: got ${written} bytes, expected ${objectTotal}. ` +
        `The partial was discarded; re-run to download it again.`,
    );
  }

  await fs.rename(partPath, ctx.destPath);
  await fs.unlink(metaPath).catch(() => {});
  return { kind: "downloaded", bytes: written };

  async function request(from: number, validator?: string): Promise<Response> {
    const headers: Record<string, string> = { ...authHeaders(resolvedUrl) };
    if (from > 0) {
      headers.Range = `bytes=${from}-`;
      if (validator !== undefined) headers["If-Range"] = validator;
    }
    // Its own deadline plus the shared cancel signal: the pipeline's signal only covers what
    // arrives after the headers.
    let timedOut = false;
    const headerTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, HEADER_TIMEOUT_MS);
    const opener = new AbortController();
    try {
      const res = await fetch(resolvedUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.any([controller.signal, opener.signal]),
      });
      openers.set(res, opener);
      return res;
    } catch (err) {
      if (isCancelled()) throw new CancelledDuringHeaders();
      if (timedOut) {
        throw new KonteError(
          "COMFYUI_ERROR",
          `Download of ${where} timed out after ${HEADER_TIMEOUT_MS / 1000}s waiting for the ` +
            `server to respond.`,
        );
      }
      throw new KonteError(
        "COMFYUI_ERROR",
        `Failed to download ${where}: ${scrub(errorMessage(err))}`,
      );
    } finally {
      clearTimeout(headerTimer);
    }
  }

  async function httpError(response: Response): Promise<KonteError> {
    const body = scrub(await response.text().catch(() => ""));
    if (response.status === 401 || response.status === 403) {
      return new KonteError(
        "MISSING_TOKEN",
        `Download of ${where} was denied (${response.status}). ${authHint(resolvedUrl)}\n` +
          STALE_ENV_HINT,
      );
    }
    return new KonteError(
      "COMFYUI_ERROR",
      `Download of ${where} failed (${response.status}): ${body || scrub(response.statusText)}`,
    );
  }
}

// Thrown when the abort fired during the header phase; the caller turns it back into a cancel.
class CancelledDuringHeaders extends Error {}

/**
 * `Content-Range: bytes <start>-<end>/<total>`, accepted only when it is internally coherent and
 * names a concrete total — a `*` total leaves nothing to check the finished file against.
 */
function parseContentRange(res: Response): ParsedRange | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(
    (res.headers.get("content-range") ?? "").trim(),
  );
  if (!match) return null;
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!(start <= end && end < total)) return null;
  return { start, end, total };
}

// Stop the transfer of a response konte has decided not to read.
async function abandon(res: Response, opener?: AbortController): Promise<void> {
  opener?.abort();
  await res.body?.cancel().catch(() => {});
}

function currentValidator(res: Response): string | undefined {
  return res.headers.get("etag") ?? res.headers.get("last-modified") ?? undefined;
}

// A 206 answering `If-Range` should carry the same validator it was matched against. One that
// sends none is taken at its word.
function validatorMatches(res: Response, expected: string | undefined): boolean {
  const actual = currentValidator(res);
  return actual === undefined || expected === undefined || actual === expected;
}

async function readMeta(metaPath: string): Promise<PartMeta | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const meta = parsed as PartMeta;
    return typeof meta.url === "string" ? meta : null;
  } catch {
    return null;
  }
}

// Both fields must arrive scrubbed: the URL is the declared one, and the validator is a header
// value the model host chose.
async function writeMeta(metaPath: string, meta: PartMeta): Promise<void> {
  await fs.writeFile(metaPath, JSON.stringify(meta)).catch(() => {});
}

async function discardPartial(partPath: string, metaPath: string): Promise<void> {
  await fs.unlink(partPath).catch(() => {});
  await fs.unlink(metaPath).catch(() => {});
}

// HuggingFace authenticates `/resolve/` with a bearer token and nothing else; a credential in the
// URL's userinfo is not read. Attached at use time, so it lives only in this request's headers.
function authHeaders(url: string): Record<string, string> {
  if (!isHuggingFace(url)) return {};
  const token = process.env.HF_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isHuggingFace(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HF_HOSTS.has(host) || host.endsWith(".hf.co");
  } catch {
    return false;
  }
}

function authHint(resolvedUrl: string): string {
  if (authHeaders(resolvedUrl).Authorization !== undefined) {
    return (
      "HF_TOKEN is set but was rejected — check the token is valid and that you have accepted " +
      "the repo's licence at its HuggingFace page."
    );
  }
  return isHuggingFace(resolvedUrl)
    ? 'This repo is gated. Set HF_TOKEN in "konte settings" and accept the repo\'s licence at its HuggingFace page.'
    : "The server rejected the request; check any token this URL needs.";
}

function lengthOf(header: string | null): number | null {
  if (header === null) return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function sizeOf(file: string): Promise<number> {
  return await fs
    .stat(file)
    .then((s) => s.size)
    .catch(() => 0);
}

async function exists(file: string): Promise<boolean> {
  return await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
