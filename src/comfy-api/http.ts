import { sendOnce as sendRequestOnce } from "../backends/http-util.js";
import { rejectedCredentialMessage } from "../core/credentials.js";
import { KonteError, type KonteErrorCode } from "../core/errors.js";
import { fetchWithRetry } from "../core/http-retry.js";
import { redactExternalBody } from "../core/redact.js";
import { COMFY_API_KEY_ENV } from "./routing.js";

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
  if (status === 401 || status === 403) return "COMFY_API_UNAUTHORIZED";
  return "COMFY_API_ERROR";
}

export async function toHttpError(res: Response, what: string): Promise<ComfyApiHttpError> {
  const body = redactExternalBody(await res.text().catch(() => ""), [`\${${COMFY_API_KEY_ENV}}`]);
  const { code: serverCode, message } = serverCodeOf(body);
  const detail = message ?? body;
  const code = codeFor(res.status, serverCode, body);
  const hint =
    code === "COMFY_API_UNAUTHORIZED" ? `. ${rejectedCredentialMessage(COMFY_API_KEY_ENV)}` : "";
  return new ComfyApiHttpError(
    code,
    `${what} failed (${res.status}${serverCode ? ` ${serverCode}` : ""})${detail ? `: ${detail}` : ""}${hint}`,
    { status: res.status, serverCode, body },
  );
}

export function sendOnce(
  url: string,
  init: RequestInit & { auth: ComfyApiAuth },
  what: string,
): Promise<Response> {
  const { auth, headers, ...rest } = init;
  return sendRequestOnce(
    url,
    {
      ...rest,
      headers: { ...authHeaders(auth), ...(headers as Record<string, string> | undefined) },
    },
    what,
    async (res) => (await toHttpError(res, what)).message,
  );
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
