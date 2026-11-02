import type { ErrorResponseBody, KonteErrorCode } from "../../core/errors.js";

/** A page server's non-2xx answer: its status, and the code and message its body carried. */
class PageRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: KonteErrorCode | null,
    message: string,
  ) {
    super(message);
    this.name = "PageRequestError";
  }
}

async function requestError(res: Response): Promise<PageRequestError> {
  const body = (await res.json().catch(() => null)) as Partial<ErrorResponseBody> | null;
  return new PageRequestError(
    res.status,
    body?.code ?? null,
    body?.error ?? `Request failed: ${res.status}`,
  );
}

export async function request(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options);
  if (!res.ok) throw await requestError(res);
  return res;
}

export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  return (await (await request(url, options)).json()) as T;
}

export function jsonBody(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Tells the page server its window is done with it. */
export async function closePage(): Promise<void> {
  await request("/api/close", { method: "POST" });
}
