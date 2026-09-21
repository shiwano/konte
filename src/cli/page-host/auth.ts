import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { errorResponse, NativeResponse, type RequestVia } from "./http.js";
import gateBundle from "../../pages/pin/gate.html" with { type: "text" };
import lockedBundle from "../../pages/pin/locked.html" with { type: "text" };

// @types/bun models a bare `*.html` import as its full-stack HTMLBundle. The `type: "text"`
// attribute makes it the file contents, in both `bun run` and the compiled binary.
const gateHtml = gateBundle as unknown as string;
const lockedHtml = lockedBundle as unknown as string;

const SESSION_COOKIE = "konte_review_session";
/** Where the gate page posts. Under `/api/` so it is never mistaken for a page route. */
export const PIN_SUBMIT_PATH = "/api/pin";

// Four digits is 10,000 combinations, brute-forceable in seconds without this cap.
const MAX_ATTEMPTS = 5;
// Guesses this session, never cleared: knowing the PIN buys no fresh budget. Nobody who mistyped
// their PIN submits forty-five more after being told to restart. Past this the session ends, and
// the one restarted in its place is reached under a new host name and a new PIN.
const MAX_GUESSES = 50;
// A PIN and a path. Anything larger is not a form this page sent.
const MAX_SUBMIT_BYTES = 4096;

export interface PinGate {
  /** Printed by the CLI, never persisted: konte.config.json is not gitignored. */
  readonly pin: string;
  /**
   * The response to send in place of handling this request, or null to let it through. Loopback is
   * let through unconditionally — the CLI opens the browser at 127.0.0.1 and the local agent's
   * fetches arrive there too.
   */
  guard(req: Request, url: URL, via: RequestVia): Promise<Response | null>;
}

export function createPinGate(
  opts: { onLockout?: () => void; onAttack?: () => void } = {},
): PinGate {
  const pin = String(randomInt(0, 10_000)).padStart(4, "0");
  const token = randomBytes(32).toString("base64url");
  let attempts = 0;
  let locked = false;
  let reported = false;

  // Called with no `await` between it and the check that admitted the guess, which is what makes
  // the count exact.
  function recordGuess(): void {
    attempts++;
    if (!locked && attempts >= MAX_ATTEMPTS) {
      locked = true;
      opts.onLockout?.();
    }
    if (!reported && attempts >= MAX_GUESSES) {
      reported = true;
      opts.onAttack?.();
    }
  }

  function authenticated(req: Request): boolean {
    const cookie = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
    return cookie !== null && constantTimeEquals(cookie, token);
  }

  function refused(status: number, message: string): Response {
    recordGuess();
    return locked ? lockedPage() : gatePage({ next: "/", error: message }, status);
  }

  // Every exit from here counts once: an uncounted knock is one the teardown never sees.
  async function handleSubmit(req: Request): Promise<Response> {
    if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      return refused(415, "That is not this form");
    }
    const body = await readCapped(req, MAX_SUBMIT_BYTES);
    if (body === null) return refused(413, "That is not this form");
    const form = new URLSearchParams(body);
    // Re-checked after the body read: `guard` tested `locked` before awaiting, so a batch of
    // submissions fired at once are all already past that test and would each get a guess.
    if (locked) {
      recordGuess();
      return lockedPage();
    }
    const next = safeNext(String(form.get("next") ?? "/"));
    if (!constantTimeEquals(String(form.get("pin") ?? ""), pin)) {
      recordGuess();
      if (locked) return lockedPage();
      const left = MAX_ATTEMPTS - attempts;
      return gatePage(
        { next, error: `Wrong PIN: ${left} attempt${left === 1 ? "" : "s"} left` },
        401,
      );
    }
    return new NativeResponse(null, {
      status: 303,
      headers: {
        Location: next,
        "Cache-Control": "no-store",
        // Lax, not Strict: the link is opened from a chat app, and Strict drops the cookie on that
        // first cross-site navigation, which would ask for the PIN again on every arrival.
        // Secure follows the scheme the browser says it is on — a proxy may terminate TLS or not,
        // and a Secure cookie on plain http is one the browser silently discards.
        "Set-Cookie":
          `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/` +
          (isHttpsOrigin(req) ? "; Secure" : ""),
      },
    });
  }

  return {
    pin,
    async guard(req, url, via) {
      if (via === "loopback") return null;
      if (locked) {
        if (url.pathname === PIN_SUBMIT_PATH && req.method === "POST") recordGuess();
        return lockedPage();
      }
      if (authenticated(req)) return null;
      if (url.pathname === PIN_SUBMIT_PATH && req.method === "POST") return handleSubmit(req);
      // An unauthenticated fetch is the page's own JS on a session that has gone away: it needs a
      // status it can branch on, not a login page.
      if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
        return errorResponse("PIN required", "PIN_REQUIRED", 401);
      }
      return gatePage({ next: safeNext(url.pathname + url.search) }, 200);
    },
  };
}

function isHttpsOrigin(req: Request): boolean {
  return (req.headers.get("origin") ?? "").startsWith("https:");
}

/**
 * A redirect target confined to this server: a bare path, never `//host` — which a browser reads as
 * protocol-relative and follows off-site. A backslash is a `/` to a URL parser, so `/\evil.example`
 * leaves by the same door.
 */
function safeNext(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

/**
 * The body, or null if it runs past `cap` or cannot be read. Counted in bytes actually taken rather
 * than bytes declared: `Content-Length` is the sender's claim, and a chunked body makes none.
 */
async function readCapped(req: Request, cap: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch; only the length leaks, which is not the secret.
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function html(source: string, status: number, slots: Record<string, string> = {}): Response {
  const body = source.replace(/\{\{(\w+)\}\}/g, (_, name: string) => escapeHtml(slots[name] ?? ""));
  return new NativeResponse(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function gatePage(opts: { next: string; error?: string }, status: number): Response {
  return html(gateHtml, status, {
    action: PIN_SUBMIT_PATH,
    next: opts.next,
    error: opts.error ?? "",
  });
}

function lockedPage(): Response {
  return html(lockedHtml, 403);
}
