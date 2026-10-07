import { KonteError, type KonteErrorCode } from "../core/errors.js";
import { API_REQUEST_TIMEOUT_MS, fetchWithRetry, TransientHttpError } from "../core/http-retry.js";
import { redactErrorBody } from "../core/redact-url.js";

export const COMFY_CLOUD_ORIGIN = "https://cloud.comfy.org";
export const COMFY_PLATFORM_ORIGIN = "https://platformapi.comfy.org";

// One key opens every layer; the runtime takes it as a bearer, the platform and Cloud's own
// catalog routes as `X-API-Key`.
export type ComfyApiAuth = { scheme: "bearer" | "x-api-key"; key: string };

export function authHeaders(auth: ComfyApiAuth): Record<string, string> {
  return auth.scheme === "bearer"
    ? { Authorization: `Bearer ${auth.key}` }
    : { "X-API-Key": auth.key };
}

/** A non-OK answer from a Comfy API layer, carrying the server's own code when it sent one. */
export class ComfyApiHttpError extends KonteError {
  readonly status: number;
  readonly serverCode: string | null;
  readonly body: string;

  constructor(
    code: KonteErrorCode,
    message: string,
    info: { status: number; serverCode: string | null; body: string },
  ) {
    super(code, message);
    this.status = info.status;
    this.serverCode = info.serverCode;
    this.body = info.body;
  }
}

// The runtime wraps its code as `{ error: { code, message } }`, the platform as `{ error: "<code>" }`
// or `{ code }`. Read whichever is there.
function serverCodeOf(body: string): { code: string | null; message: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: null, message: null };
  }
  if (typeof parsed !== "object" || parsed === null) return { code: null, message: null };
  const record = parsed as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "object" && nested !== null) {
    const inner = nested as Record<string, unknown>;
    return {
      code: typeof inner.code === "string" ? inner.code : null,
      message: typeof inner.message === "string" ? inner.message : null,
    };
  }
  const code =
    typeof nested === "string" ? nested : typeof record.code === "string" ? record.code : null;
  const message = typeof record.message === "string" ? record.message : null;
  return { code, message };
}

function codeFor(status: number, serverCode: string | null, body: string): KonteErrorCode {
  const upper = `${serverCode ?? ""} ${body}`.toUpperCase();
  if (
    status === 402 ||
    upper.includes("PAYMENT_REQUIRED") ||
    upper.includes("INSUFFICIENT_CREDITS")
  )
    return "COMFY_API_INSUFFICIENT_CREDITS";
  if (status === 403 && upper.includes("FEATURE_NOT_ENABLED")) return "COMFY_API_NOT_ENABLED";
  return "COMFY_API_ERROR";
}

export async function toHttpError(res: Response, what: string): Promise<ComfyApiHttpError> {
  const body = redactErrorBody(await res.text().catch(() => ""));
  const { code: serverCode, message } = serverCodeOf(body);
  const detail = message ?? body;
  return new ComfyApiHttpError(
    codeFor(res.status, serverCode, body),
    `${what} failed (${res.status}${serverCode ? ` ${serverCode}` : ""})${detail ? `: ${detail}` : ""}`,
    { status: res.status, serverCode, body },
  );
}

/**
 * One request that must not repeat on its own (a POST that may have landed). A network failure or a
 * 5xx is a `TransientHttpError`, which a caller reads as "outcome unknown".
 */
export async function sendOnce(
  url: string,
  init: RequestInit & { auth: ComfyApiAuth },
  what: string,
): Promise<Response> {
  const { auth, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { ...authHeaders(auth), ...(headers as Record<string, string> | undefined) },
      signal: rest.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TransientHttpError(`${what}: ${(cause as Error).message}`, { cause });
  }
  if (res.status >= 500) {
    const err = await toHttpError(res, what);
    throw new TransientHttpError(err.message, { status: res.status });
  }
  return res;
}

/** An idempotent request: retried on a transient failure, then thrown as `TransientHttpError`. */
export async function sendIdempotent(
  url: string,
  init: RequestInit & { auth: ComfyApiAuth },
  options?: { maxRetries?: number; timeoutMs?: number },
): Promise<Response> {
  const { auth, headers, ...rest } = init;
  return fetchWithRetry(
    url,
    {
      ...rest,
      headers: { ...authHeaders(auth), ...(headers as Record<string, string> | undefined) },
    },
    options,
  );
}

export async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) {
      throw new TransientHttpError(`${what} response interrupted`, { cause });
    }
    throw new KonteError("COMFY_API_ERROR", `${what} returned a non-JSON response`);
  }
}
