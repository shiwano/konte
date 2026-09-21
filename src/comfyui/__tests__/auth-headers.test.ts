import * as http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KonteError } from "../../core/errors.js";
import { KonteConfigSchema } from "../../core/types/config.js";
import { ComfyUIHttpClient } from "../http-client.js";
import { ComfyUIManagerClient } from "../manager-client.js";
import { resolveHeaderTokens } from "../token-resolver.js";
import { ComfyUIWsClient } from "../ws-client.js";

describe("comfyui.headers schema", () => {
  const parse = (headers: Record<string, string>) =>
    KonteConfigSchema.safeParse({ comfyui: { headers } });

  it("takes a secret header whose value is a placeholder, with or without an auth scheme", () => {
    expect(parse({ Authorization: "${COMFYUI_TOKEN}" }).success).toBe(true);
    expect(parse({ Authorization: "Bearer ${COMFYUI_TOKEN}" }).success).toBe(true);
    expect(parse({ Authorization: "Basic ${PROXY_CREDENTIAL}" }).success).toBe(true);
    expect(parse({ "cf-access-client-secret": "${CF_SECRET}" }).success).toBe(true);
    expect(parse({ "X-API-Key": "${COMFY_CLOUD_KEY}" }).success).toBe(true);
    expect(parse({ Cookie: "${COMFYUI_COOKIE}" }).success).toBe(true);
  });

  it("rejects a literal in a secret header, however it is dressed up", () => {
    expect(parse({ Authorization: "Bearer abc123" }).success).toBe(false);
    expect(parse({ AUTHORIZATION: "abc" }).success).toBe(false);
    // Only the scheme may stand beside the placeholder — anything trailing it is a literal again.
    expect(parse({ Authorization: "Bearer ${COMFYUI_TOKEN} abc" }).success).toBe(false);
    expect(parse({ "x-api-key": "raw-key" }).success).toBe(false);
    expect(parse({ Cookie: "session=live-secret" }).success).toBe(false);
    expect(parse({ "Proxy-Authorization": "Basic bGl2ZQ==" }).success).toBe(false);
  });

  it("leaves a non-secret header free-form", () => {
    expect(parse({ "X-Trace-Id": "konte" }).success).toBe(true);
  });

  it("rejects one field name spelled two ways", () => {
    // fetch would join them into `Bearer ${A}, Bearer ${B}` and authenticate as neither.
    expect(parse({ Authorization: "${A}", authorization: "${B}" }).success).toBe(false);
  });

  it("rejects a header konte builds itself, and a malformed name", () => {
    expect(parse({ "Content-Type": "application/json" }).success).toBe(false);
    expect(parse({ Host: "elsewhere" }).success).toBe(false);
    expect(parse({ "bad header": "x" }).success).toBe(false);
  });
});

describe("resolveHeaderTokens", () => {
  it("substitutes from the environment", () => {
    const resolved = resolveHeaderTokens(
      { Authorization: "${TOK}" },
      { env: { TOK: "Bearer live-value" } },
    );
    expect(resolved).toEqual({ Authorization: "Bearer live-value" });
  });

  it("names the header when a variable is unset", () => {
    try {
      resolveHeaderTokens({ Authorization: "${NOPE}" }, { env: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as KonteError).code).toBe("MISSING_TOKEN");
      expect((err as Error).message).toContain('comfyui.headers."Authorization"');
    }
  });
});

describe("ComfyUIHttpClient with configured headers", () => {
  let server: http.Server;
  let baseUrl: string;
  const seen: Array<{ path: string; auth: string | undefined; contentType: string | undefined }> =
    [];
  let status = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
      });
      if (status !== 200) {
        res.writeHead(status).end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ devices: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.KONTE_TEST_COMFY_TOKEN = "live-value";
  });

  afterAll(async () => {
    delete process.env.KONTE_TEST_COMFY_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () =>
    new ComfyUIHttpClient(baseUrl, {
      headers: { Authorization: "Bearer ${KONTE_TEST_COMFY_TOKEN}" },
    });

  it("sends the resolved credential on a request", async () => {
    seen.length = 0;
    await client().systemStats();
    expect(seen[0]?.auth).toBe("Bearer live-value");
  });

  it("leaves the multipart Content-Type to fetch on an upload", async () => {
    seen.length = 0;
    await client()
      .uploadImage("a.png", Buffer.from("x"))
      .catch(() => {});
    expect(seen[0]?.auth).toBe("Bearer live-value");
    expect(seen[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("reports a rejection as unauthorized rather than unreachable", async () => {
    status = 403;
    try {
      await client().systemStats();
      expect.unreachable();
    } catch (err) {
      expect((err as KonteError).code).toBe("COMFYUI_UNAUTHORIZED");
      expect((err as Error).message).toContain("Authorization");
      expect((err as Error).message).not.toContain("live-value");
    } finally {
      status = 200;
    }
  });

  it("reports a rejected /prompt as unauthorized, not as a workflow error", async () => {
    status = 401;
    try {
      await client().queuePrompt({});
      expect.unreachable();
    } catch (err) {
      expect((err as KonteError).code).toBe("COMFYUI_UNAUTHORIZED");
    } finally {
      status = 200;
    }
  });

  it("fails a request whose ${VAR} is unset instead of sending an empty credential", async () => {
    seen.length = 0;
    const bare = new ComfyUIHttpClient(baseUrl, { headers: { Authorization: "${KONTE_UNSET}" } });
    await expect(bare.systemStats()).rejects.toMatchObject({ code: "MISSING_TOKEN" });
    expect(seen).toHaveLength(0);
  });
});

/**
 * Attaching headers to a handshake is a Bun extension to the WebSocket constructor, so under this
 * suite's Node runtime a real socket would drop them. What belongs to konte — that the resolved
 * credential reaches the constructor — is what this stubs.
 */
describe("ComfyUIWsClient handshake", () => {
  type Init = { headers?: Record<string, string> } | undefined;
  const calls: Array<{ url: string; init: Init }> = [];

  class FakeWebSocket {
    private listeners = new Map<string, Array<() => void>>();

    constructor(url: string, init?: Init) {
      calls.push({ url, init });
      queueMicrotask(() => {
        for (const listener of this.listeners.get("open") ?? []) listener();
      });
    }

    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(type: string, listener: () => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    }

    close() {}
  }

  const timing = {
    reconnectDelaysMs: [1],
    pollIntervalMs: 1,
    maxBackoffMs: 1,
    safetyNetIntervalMs: 1000,
    handshakeTimeoutMs: 50,
  };

  const connect = async (headers?: Record<string, string>): Promise<Init> => {
    calls.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new ComfyUIWsClient("http://comfy.test:8188", "client-id", timing, headers);
    await client.connect();
    client.disconnect();
    return calls[0]?.init;
  };

  afterEach(() => vi.unstubAllGlobals());

  it("carries the resolved credential", async () => {
    process.env.KONTE_TEST_WS_TOKEN = "handshake-secret";
    try {
      const init = await connect({ Authorization: "Bearer ${KONTE_TEST_WS_TOKEN}" });
      expect(init?.headers).toEqual({ Authorization: "Bearer handshake-secret" });
    } finally {
      delete process.env.KONTE_TEST_WS_TOKEN;
    }
  });

  it("passes nothing when no header is configured", async () => {
    expect(await connect()).toBeUndefined();
  });
});

/**
 * The Manager fetches the same server, so the same two guarantees hold there: a rejection is an
 * auth verdict, and an echoed credential never reaches a persisted error.
 */
describe("ComfyUIManagerClient with configured headers", () => {
  let server: http.Server;
  let baseUrl: string;
  let reply: { status: number; body: string } = { status: 200, body: "{}" };
  let sawAuth: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.KONTE_TEST_MANAGER_TOKEN = "manager-live-value";
  });

  afterAll(async () => {
    delete process.env.KONTE_TEST_MANAGER_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const manager = () => {
    const http = new ComfyUIHttpClient(baseUrl, {
      headers: { Authorization: "Bearer ${KONTE_TEST_MANAGER_TOKEN}" },
    });
    return new ComfyUIManagerClient(baseUrl, http);
  };

  it("authenticates its own requests", async () => {
    sawAuth = undefined;
    reply = { status: 200, body: JSON.stringify({}) };
    await manager().getInstalledNodeIds("default");
    expect(sawAuth).toBe("Bearer manager-live-value");
  });

  it("reports a 401 as unauthorized rather than a missing Manager", async () => {
    reply = { status: 401, body: "unauthorized" };
    await expect(manager().getInstalledNodeIds("default")).rejects.toMatchObject({
      code: "COMFYUI_UNAUTHORIZED",
    });
  });

  // 403 means one thing on a route konte reads from (the auth front) and another on one it asks to
  // act (the Manager's own security_level), so the two must not collapse into one verdict.
  it("reads a 403 as an auth front on a GET and as the Manager's own refusal on a POST", async () => {
    reply = { status: 403, body: "forbidden" };
    await expect(manager().getInstalledNodeIds("default")).rejects.toMatchObject({
      code: "COMFYUI_UNAUTHORIZED",
    });
    await expect(manager().queueInstallNode({ node: { id: "pack-a" } })).rejects.toMatchObject({
      code: "COMFYUI_MANAGER_UNAVAILABLE",
    });
  });

  // Every Manager route that embeds a response body in its error: a site left on the bare redactor
  // would persist the credential the server echoed back. A 5xx never reaches these (classified
  // transient without a body read) and a 401 throws before the read.
  it.each([
    ["getInstalledNodeIds", 400, () => manager().getInstalledNodeIds("default")],
    ["queueInstallNode", 400, () => manager().queueInstallNode({ node: { id: "pack-a" } })],
    [
      "queueInstallNode (security_level)",
      403,
      () => manager().queueInstallNode({ node: { id: "pack-a" } }),
    ],
    [
      "queueInstall",
      400,
      () =>
        manager().queueInstall({
          model: { filename: "a.safetensors", type: "lora", url: "u" },
          resolvedUrl: "u",
        }),
    ],
    ["startQueue", 400, () => manager().startQueue()],
    ["getQueueStatus", 400, () => manager().getQueueStatus()],
  ])("keeps an echoed credential out of %s's error", async (_name, status, call) => {
    reply = { status, body: "rejected: Authorization: Bearer manager-live-value" };
    try {
      await call();
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("manager-live-value");
      expect(message).toContain("${KONTE_TEST_MANAGER_TOKEN}");
    }
  });
});
