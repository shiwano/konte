type Env = Readonly<Record<string, string | undefined>>;

function firstSet(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseNoProxyEntry(entry: string): { host: string; port: string | null } {
  const match =
    /^\[(?<host>[^\]]+)\](?::(?<port>\d+))?$/.exec(entry) ??
    /^(?<host>[^:]+):(?<port>\d+)$/.exec(entry);
  return { host: match?.groups?.host ?? entry, port: match?.groups?.port ?? null };
}

function bypassesProxy(url: URL, noProxy: string): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port;
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const parsed = parseNoProxyEntry(entry);
    const suffix = parsed.host.replace(/^\./, "");
    if (parsed.port !== null && parsed.port !== port) continue;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/**
 * The proxy a WebSocket to `wsUrl` goes through, chosen by the rules Bun's `fetch` applies to the
 * same environment, which Bun's WebSocket does not read on its own.
 */
export function wsProxyFor(wsUrl: string, env: Env = process.env): string | undefined {
  const url = new URL(wsUrl);
  const proxy =
    url.protocol === "wss:"
      ? firstSet(env, "https_proxy", "HTTPS_PROXY")
      : firstSet(env, "http_proxy", "HTTP_PROXY");
  if (!proxy) return undefined;
  const noProxy = firstSet(env, "no_proxy", "NO_PROXY");
  if (noProxy && bypassesProxy(url, noProxy)) return undefined;
  return proxy.includes("://") ? proxy : `http://${proxy}`;
}
