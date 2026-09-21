import { setTimeout as delay } from "node:timers/promises";
import { TransientPollError } from "./poll-until-terminal.js";
import { errorMessage } from "./errors.js";

// 408 Request Timeout, 429 Too Many Requests, and 5xx are treated as transient;
// every other non-OK status (401/403/404/422…) is a real failure and not retried.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A transient communication failure — a network error or a 408/429/5xx — that a
 * polled status check kept hitting. A `TransientPollError`, so `pollUntilTerminal`
 * keeps waiting on it rather than failing the still-running backend job.
 */
export class TransientHttpError extends TransientPollError {
  readonly status: number | null;
  constructor(message: string, options?: { status?: number | null; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TransientHttpError";
    this.status = options?.status ?? null;
  }
}

interface FetchRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  // Per-attempt deadline. A connection that opens but never responds would
  // otherwise hang forever (fetch has no default timeout), permanently stalling
  // the polling/download data path; a lapsed deadline aborts the attempt and is
  // treated as a transient failure so it retries within budget.
  timeoutMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

// Default per-attempt timeout. Generous enough for a large media download yet
// bounded so a dead connection can't wedge a job indefinitely.
const DEFAULT_TIMEOUT_MS = 120_000;

// Deadline for a one-shot API call (submit/cancel/status) — a small JSON body that
// should return quickly. Bounds a raw fetch() that would otherwise hang forever after
// the connection opens (fetch has no default timeout), wedging a lease-holding job.
export const API_REQUEST_TIMEOUT_MS = 120_000;

// Deadline for a large media transfer (upload/download of hundreds of MB). Generous
// enough for a slow link yet still bounded, so a stalled transfer can't wedge a job.
export const MEDIA_TRANSFER_TIMEOUT_MS = 600_000;

// Ceiling for the size-scaled deadline below: a transfer this long is a dead connection, not a
// slow one, and must not wedge a lease-holding job forever.
const MAX_MEDIA_TRANSFER_TIMEOUT_MS = 7_200_000;

// Deadline for a transfer whose size is known up front. The flat MEDIA_TRANSFER_TIMEOUT_MS is a
// floor generous for the common case, but a multi-GB `file` asset on a domestic uplink legitimately
// exceeds it — so allow the payload's bytes at a deliberately pessimistic 1 MB/s on top, capped.
export function mediaTransferTimeoutMs(bytes: number): number {
  const slowLinkMs = Math.ceil(bytes / 1024); // 1 MB/s expressed as bytes-per-millisecond
  return Math.min(MAX_MEDIA_TRANSFER_TIMEOUT_MS, Math.max(MEDIA_TRANSFER_TIMEOUT_MS, slowLinkMs));
}

/**
 * fetch() that retries transient failures — network errors and 408/429/5xx — with
 * exponential backoff (honoring Retry-After when present), then throws
 * `TransientHttpError` once retries are exhausted. A non-transient non-OK response
 * (401/403/404/422…) is returned as-is so the caller raises its own typed error.
 *
 * Use ONLY for idempotent requests: a polled status GET, a result fetch, a download.
 * Never wrap a POST that could double-charge if the first attempt reached the server.
 *
 * Pass `maxRetries: 0` to make it a single attempt that merely classifies the outcome
 * (transient → throws immediately; ok/permanent → returns) and leaves the retry
 * cadence to the caller's own poll loop.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: FetchRetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 5;
  const initialDelayMs = options?.initialDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let caught: unknown;
    let status: number | null = null;
    let reason: string;

    try {
      res = await fetch(url, { ...init, signal: withTimeout(init?.signal, timeoutMs) });
      if (res.ok || !TRANSIENT_STATUS.has(res.status)) return res;
      status = res.status;
      reason = `HTTP ${res.status}`;
    } catch (err) {
      // An external caller-supplied signal (e.g. cancellation) is intentional —
      // propagate it instead of swallowing it as a retryable transient.
      if (init?.signal?.aborted) throw err;
      caught = err;
      reason = errorMessage(err);
    }

    // Only transient outcomes reach here (ok/permanent already returned).
    if (attempt >= maxRetries) {
      throw new TransientHttpError(reason, { status, cause: caught });
    }

    const backoff = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
    const delayMs = retryAfterMs(res, maxDelayMs) ?? backoff;
    options?.onRetry?.({ attempt: attempt + 1, delayMs, reason });
    await delay(delayMs);
  }
}

// Combine the caller's signal (if any) with a fresh per-attempt timeout so the
// request aborts on whichever fires first.
function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function retryAfterMs(res: Response | undefined, maxDelayMs: number): number | null {
  const header = res?.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxDelayMs);
}
