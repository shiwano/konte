import * as os from "node:os";
import { KonteError } from "../../core/errors.js";

// The frame-capture pipeline loads @hyperframes/producer, whose bundled
// @hono/node-server replaces the global `Response`/`Request` with its own
// (non-configurable, so it can't be restored) the first time it serves a request.
// After that, a plain `new Response(...)` would build an @hono/node-server Response
// that Bun.serve rejects ("Expected a Response object, but received Response
// (lightweight)"). Capture Bun's native Response at module load — before any
// capture runs — and build every page-server response from it.
export const NativeResponse = globalThis.Response;

export function jsonResponse(data: unknown, status = 200): Response {
  return new NativeResponse(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(error: string, code: string, status: number): Response {
  return jsonResponse({ error, code }, status);
}

export function htmlResponse(html: string): Response {
  return new NativeResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}

export async function parseJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Who may talk to a page server. A tunnel needs only `allowedHosts` — cloudflared connects to
 * loopback and fronts it under its own hostname, so the bind address never changes.
 */
export interface AccessPolicy {
  /** Bind address. A non-loopback one is what admits the private ranges it listens on. */
  host: string;
  /** Host names admitted beyond that, as globs. A tunnel's hostname goes here. */
  allowedHosts: string[];
}

export const LOOPBACK_ONLY: AccessPolicy = { host: "127.0.0.1", allowedHosts: [] };

// The canonical spellings `URL` reduces a loopback authority to.
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a peer address is this machine. Wider than `isLoopbackBind`: a connection arrives from
 * anywhere in 127.0.0.0/8, and from an IPv4-mapped form when the bind is `::`.
 */
export function isLoopbackAddress(address: string): boolean {
  const bare = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  if (bare === "::1") return true;
  const mapped = /^::ffff:(.+)$/.exec(bare);
  if (mapped) {
    const inner = mapped[1]!;
    if (inner.includes(".")) return isLoopbackAddress(inner);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (!hex) return false;
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return isLoopbackAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

export function isLoopbackBind(host: string): boolean {
  const h = host.trim();
  // A bind address is written bare (`::1`), an authority bracketed.
  const name = canonicalHostName(h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
  return name !== null && LOOPBACK_NAMES.has(name);
}

/**
 * The name and port a `Host` header carries, put through the same parser the `Origin` goes through
 * — an authority has many spellings (`010.8.8.8` is octal, one IPv6 address has several forms) and
 * admitting one while comparing another is how a public address slips in wearing a private one's
 * digits. A name `URL` cannot parse is refused.
 */
function parseHostHeader(host: string): { name: string; port: string | null } | null {
  const h = host.trim();
  let raw: string;
  let port: string | null;
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close === -1) return null;
    const rest = h.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return null;
    raw = h.slice(0, close + 1);
    port = rest.startsWith(":") ? rest.slice(1) : null;
  } else {
    const colon = h.lastIndexOf(":");
    raw = colon === -1 ? h : h.slice(0, colon);
    port = colon === -1 ? null : h.slice(colon + 1);
  }
  if (port !== null && !/^\d+$/.test(port)) return null;
  const name = canonicalHostName(raw);
  return name === null ? null : { name, port };
}

function canonicalHostName(name: string): string | null {
  // Only a bare authority: userinfo, a path or whitespace would each let `URL` read a different
  // name out of the string than the one admission was asked about.
  if (name === "" || /[@/\\?#\s]/.test(name)) return null;
  try {
    const url = new URL(`http://${name}`);
    return url.port === "" && url.pathname === "/" ? url.hostname : null;
  } catch {
    return null;
  }
}

// A browser omits the default port from Host and Origin, so on :80 the bare name is the only form
// that ever arrives.
function portMatches(port: string | null, listening: number): boolean {
  if (port === null) return listening === 80;
  return port === String(listening);
}

/** An address reachable only from the local network — the range a `0.0.0.0` bind means to serve. */
export function isPrivateAddress(name: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const v6 = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  if (!v6.includes(":")) return false;
  // An IPv4-mapped address is the v4 one: a `::` bind answers a v4 client under this form, in
  // either the dotted or the fully-hexadecimal spelling.
  const mapped = /^::ffff:(.+)$/.exec(v6);
  if (mapped) {
    const inner = mapped[1]!;
    if (inner.includes(".")) return isPrivateAddress(inner);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (!hex) return false;
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

/**
 * Match a Host name against one `allowedHosts` glob. `*` stands for a single label, so
 * `*.trycloudflare.com` admits the subdomain a quick tunnel names and nothing deeper; the bare
 * `*` is the escape hatch and admits everything.
 */
export function hostMatchesPattern(name: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === "*") return true;
  const re = new RegExp(
    `^${p
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^.]*")}$`,
  );
  return re.test(name);
}

/**
 * How a request reached this server. `loopback` is the machine itself — the CLI, the browser it
 * opens, the local agent. The other two arrived from off the machine, and are what the PIN gate
 * stands in front of.
 */
export type RequestVia = "loopback" | "network" | "host";

// `scheme` is which URL schemes an admitted name may carry in `Origin`. A name konte serves itself
// is reached over plain HTTP; one in `allowedHosts` sits behind a tunnel or proxy that terminates
// TLS, so its Origin arrives as `https:`.
type Admission = null | { via: RequestVia; scheme: "http" | "http-or-https" };

type RequestHost = { name: string; port: string | null };

/** An admitted request carries the route it came in by; a refused one carries the 403 to send. */
export type OriginCheck = { ok: true; via: RequestVia } | { ok: false; response: Response };

function admitHost(host: RequestHost, port: number, policy: AccessPolicy): Admission {
  // Checked before the port: a tunnel fronts the server on 443 and sends no port at all.
  for (const pattern of policy.allowedHosts) {
    if (hostMatchesPattern(host.name, pattern)) return { via: "host", scheme: "http-or-https" };
  }
  if (!portMatches(host.port, port)) return null;
  if (LOOPBACK_NAMES.has(host.name)) return { via: "loopback", scheme: "http" };
  if (!isLoopbackBind(policy.host) && isPrivateAddress(host.name)) {
    return { via: "network", scheme: "http" };
  }
  return null;
}

/**
 * Whether this Origin is the very host the request arrived under. Admitting it on its own merit
 * would let one admitted name forge a request at another — a second quick tunnel is a hostname
 * anyone can take, and a second machine on the LAN is inside the private range by definition.
 */
function originIsHost(origin: URL, host: RequestHost): boolean {
  if (host.name !== origin.hostname) return false;
  // A browser omits the default port from Origin but not always from Host, and the scheme it
  // omits it for is the Origin's — through a proxy that terminates TLS, that is https.
  const defaultPort = origin.protocol === "https:" ? "443" : "80";
  const hostPort = host.port === defaultPort ? null : host.port;
  return hostPort === (origin.port === "" ? null : origin.port);
}

function admitOrigin(
  origin: string,
  host: RequestHost,
  admission: NonNullable<Admission>,
): boolean {
  try {
    const url = new URL(origin);
    if (!originIsHost(url, host)) return false;
    if (url.protocol === "http:") return true;
    return url.protocol === "https:" && admission.scheme === "http-or-https";
  } catch {
    return false;
  }
}

/**
 * Binding to loopback is not a boundary a browser honors: any page the user has open can POST to
 * 127.0.0.1 (a text/plain body makes it a simple request, so no preflight guards it), and a rebound
 * DNS name resolves to loopback while keeping the attacker's origin. Both are caught by admitting
 * only the names this server is meant to answer to, in `Host` and in a mutation's `Origin`.
 *
 * A same-origin GET carries no `Origin`, so its absence is only fatal on a state-changing method.
 *
 * An admitted request also reports how it arrived, from the same pass that admitted it.
 * `peerAddress` is the connection's real remote address, and only loopback needs it.
 */
export function checkRequestOrigin(
  req: Pick<Request, "method"> & { headers: Headers },
  port: number,
  policy: AccessPolicy = LOOPBACK_ONLY,
  peerAddress: string | null = null,
): OriginCheck {
  const rawHost = req.headers.get("host");
  const host = rawHost === null ? null : parseHostHeader(rawHost);
  const admission = host === null ? null : admitHost(host, port, policy);
  if (host === null || admission === null) return refuse("Forbidden host");

  // `loopback` is the one route that goes ungated, so every signal has to agree. cloudflared
  // connects from loopback carrying the tunnel's name, so the peer alone is not enough; a LAN
  // client can write `127.0.0.1` into its own `Host`, so the name alone is not either; a local
  // proxy defeats both at once. A peer we cannot read is not this machine.
  const isLocal =
    peerAddress !== null && isLoopbackAddress(peerAddress) && !wasForwarded(req.headers);
  const via: RequestVia = admission.via === "loopback" && !isLocal ? "network" : admission.via;

  const origin = req.headers.get("origin");
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (origin === null) {
    return mutating ? refuse("Forbidden origin") : { ok: true, via };
  }
  if (!admitOrigin(origin, host, admission)) return refuse("Forbidden origin");
  return { ok: true, via };
}

function refuse(reason: string): OriginCheck {
  return { ok: false, response: errorResponse(reason, "FORBIDDEN", 403) };
}

// A request that has been through a proxy, which is the third signal: one rewriting the upstream
// `Host` to a loopback name leaves the peer and the name both looking local. Only ever consulted to
// take the loopback verdict away, so forging one buys nothing.
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

function wasForwarded(headers: Headers): boolean {
  return FORWARDED_HEADERS.some((name) => headers.get(name) !== null);
}

const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]"]);

function addressUrl(address: string, port: number): string {
  return address.includes(":") ? `http://[${address}]:${port}` : `http://${address}:${port}`;
}

/**
 * The URLs another machine reaches this bind at — only the private ones, since a public address the
 * wildcard also listens on is not one the policy admits.
 */
export function localNetworkUrls(bindHost: string, port: number): string[] {
  const bind = bindHost.trim().toLowerCase();
  if (!WILDCARD_BINDS.has(bind)) {
    const bare = bind.startsWith("[") && bind.endsWith("]") ? bind.slice(1, -1) : bind;
    return isPrivateAddress(bare) ? [addressUrl(bare, port)] : [];
  }
  const wantsV6 = bind !== "0.0.0.0";
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      if (addr.family === "IPv6" && !wantsV6) continue;
      // A link-local IPv6 address needs an interface scope a URL cannot carry: it would not open.
      if (addr.family === "IPv6" && /^fe[89ab][0-9a-f]:/i.test(addr.address)) continue;
      if (isPrivateAddress(addr.address)) out.push(addressUrl(addr.address, port));
    }
  }
  return out;
}

/**
 * What this policy opens up, or null when it opens nothing. konte.config.json is not gitignored, so
 * a committed `preview.host` follows the repo onto machines whose owner never asked for it — the
 * line is printed every session rather than once.
 */
export function describeExposure(
  policy: AccessPolicy,
  port: number,
  session: { pin?: string; tunnelUrl?: string } = {},
): string | null {
  const lines: string[] = [];
  if (!isLoopbackBind(policy.host)) {
    const urls = localNetworkUrls(policy.host, port);
    lines.push(
      urls.length > 0
        ? `Give the human this URL: ${urls.join(" or ")}`
        : `Listening on ${policy.host}, with no private address to name`,
    );
  }
  // The tunnel's own host name is in `allowedHosts` too; name it once, by the URL that reaches it.
  const tunnelHost = session.tunnelUrl ? hostOf(session.tunnelUrl) : null;
  if (session.tunnelUrl) {
    lines.push(`Tunnel open — give the human this URL: ${session.tunnelUrl}`);
  }
  const named = policy.allowedHosts.filter((pattern) => pattern.trim() !== tunnelHost);
  if (named.length > 0) {
    const open = named.some((pattern) => pattern.trim() === "*");
    lines.push(
      open
        ? `Accepting requests under ANY host name`
        : `Accepting requests under ${named.join(", ")}. Give the human the URL your tunnel or proxy fronts.`,
    );
  }
  if (lines.length === 0) return null;
  lines.push(
    session.pin
      ? `PIN ${session.pin} — asked for once per browser. Everything off this machine goes through it.`
      : "The review UI has no authentication.",
  );
  return lines.map((line) => `  ! ${line}`).join("\n");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Bun.serve throws on a taken port; with fallback enabled retry on an ephemeral one so a second
// page (another video, another stage, a settings window next to a preview) does not need an
// explicit --port. An explicitly requested port never falls back — silently listening somewhere
// else would break whoever asked for it.
export function listenWithPortFallback<T>(
  serve: (port: number) => T,
  port: number,
  allowFallback: boolean,
): T {
  try {
    return serve(port);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "EADDRINUSE" || port === 0) throw err;
    if (!allowFallback) {
      throw new KonteError(
        "PORT_IN_USE",
        `Port ${port} is already in use — pass a different --port, or omit it to take a free one`,
      );
    }
    return serve(0);
  }
}
