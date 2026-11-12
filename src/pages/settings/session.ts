import { jsonBody, PageRequestError, requestJson } from "../shared/http.js";
import { REDEEM_TOKEN_PATH, SESSION_HEADER, type RedeemTokenResponse } from "./types.js";

const STORAGE_KEY = "konte-settings-session";
export const SESSION_LOST_EVENT = "konte:session-lost";

/** `unreachable`: the launch token is still unspent, and a reload tries it again. */
export type SessionState = "ok" | "expired" | "unreachable";

function stored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(value: string | null): void {
  session = value;
  try {
    if (value === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, value);
  } catch {}
}

let session: string | null = stored();

function isSessionRefusal(err: unknown): boolean {
  return err instanceof PageRequestError && err.code === "SESSION_REQUIRED";
}

export async function establishSession(): Promise<SessionState> {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token === null) return session !== null ? "ok" : "expired";
  try {
    const res = await requestJson<RedeemTokenResponse>(
      REDEEM_TOKEN_PATH,
      jsonBody("POST", { token }),
    );
    store(res.session);
  } catch (err) {
    if (!isSessionRefusal(err)) return "unreachable";
    store(null);
  }
  history.replaceState(null, "", location.pathname + location.search);
  return session !== null ? "ok" : "expired";
}

export function withSession(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (session !== null) headers.set(SESSION_HEADER, session);
  return { ...init, headers };
}

export function reportSessionLoss(err: unknown): never {
  if (isSessionRefusal(err)) window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT));
  throw err;
}
