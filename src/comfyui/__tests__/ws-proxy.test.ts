import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMFYUI_TIMING } from "../config.js";
import { ComfyUIWsClient } from "../ws-client.js";
import { wsProxyFor } from "../ws-proxy.js";

const HTTP = "http://proxy.test:3128";
const HTTPS = "http://secure-proxy.test:3128";

describe("wsProxyFor", () => {
  it.each([
    ["ws://comfy.test:8188/ws", { HTTP_PROXY: HTTP, HTTPS_PROXY: HTTPS }, HTTP],
    ["wss://comfy.test/ws", { HTTP_PROXY: HTTP, HTTPS_PROXY: HTTPS }, HTTPS],
    ["wss://comfy.test/ws", { HTTP_PROXY: HTTP }, undefined],
    ["ws://comfy.test:8188/ws", { http_proxy: HTTP, HTTP_PROXY: HTTPS }, HTTP],
    ["ws://comfy.test:8188/ws", { http_proxy: "", HTTP_PROXY: HTTP }, HTTP],
    ["ws://127.0.0.1:8188/ws", { HTTP_PROXY: HTTP }, HTTP],
    ["ws://comfy.test:8188/ws", {}, undefined],
    ["ws://comfy.test:8188/ws", { HTTP_PROXY: "proxy.test:3128" }, HTTP],
    [
      "ws://comfy.test:8188/ws",
      { HTTP_PROXY: "socks5://proxy.test:1080" },
      "socks5://proxy.test:1080",
    ],
  ])("%s under %j goes through %s", (url, env, expected) => {
    expect(wsProxyFor(url, env)).toBe(expected);
  });

  it.each([
    ["comfy.test", "ws://comfy.test:8188/ws", true],
    ["COMFY.test", "ws://comfy.test:8188/ws", true],
    ["test", "ws://box.comfy.test:8188/ws", true],
    [".comfy.test", "ws://comfy.test:8188/ws", true],
    [" other.test , comfy.test ", "ws://comfy.test:8188/ws", true],
    ["*", "ws://comfy.test:8188/ws", true],
    ["comfy.test:8188", "ws://comfy.test:8188/ws", true],
    ["[::1]:8188", "ws://[::1]:8188/ws", true],
    ["100.100.1.1", "ws://100.100.1.1:8188/ws", true],
    ["omfy.test", "ws://comfy.test:8188/ws", false],
    ["comfy.test:9999", "ws://comfy.test:8188/ws", false],
    ["comfy.test:80", "ws://comfy.test/ws", false],
    ["*.comfy.test", "ws://box.comfy.test:8188/ws", false],
    ["100.64.0.0/10", "ws://100.100.1.1:8188/ws", false],
  ])("NO_PROXY=%j bypasses %s: %s", (noProxy, url, bypassed) => {
    expect(wsProxyFor(url, { HTTP_PROXY: HTTP, NO_PROXY: noProxy })).toBe(
      bypassed ? undefined : HTTP,
    );
  });

  it("reads no_proxy before NO_PROXY", () => {
    const env = { HTTP_PROXY: HTTP, no_proxy: "comfy.test", NO_PROXY: "other.test" };
    expect(wsProxyFor("ws://comfy.test:8188/ws", env)).toBeUndefined();
  });
});

const isolateProxyEnv = () => {
  beforeEach(() => {
    for (const name of ["http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY"]) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => vi.unstubAllEnvs());
};

describe("ComfyUIWsClient with a proxy Bun refuses", () => {
  isolateProxyEnv();

  it("fails the connect with COMFYUI_WS_UNAVAILABLE", async () => {
    vi.stubEnv("HTTP_PROXY", "socks5://user:secret@127.0.0.1:1080");
    const connecting = new ComfyUIWsClient("http://comfy.test:8188", "c1").connect();
    await expect(connecting).rejects.toMatchObject({ code: "COMFYUI_WS_UNAVAILABLE" });
    await expect(connecting).rejects.not.toMatchObject({
      message: expect.stringContaining("secret"),
    });
  });
});

const hasSecondLoopback = await new Promise<boolean>((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "127.0.0.2", () => probe.close(() => resolve(true)));
});

describe.skipIf(!hasSecondLoopback)("ComfyUIWsClient through a proxy", () => {
  const servers: net.Server[] = [];
  isolateProxyEnv();
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  // Bun's WebSocket also applies the NO_PROXY the process started with, which stubEnv cannot
  // change, so the ComfyUI end listens on a loopback address a NO_PROXY seldom names.
  const recordingServer = async (host: string): Promise<{ origin: string; requests: string[] }> => {
    const requests: string[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        requests.push(chunk.toString().split("\r\n", 1).join(""));
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return { origin: `http://${host}:${(server.address() as net.AddressInfo).port}`, requests };
  };

  const connect = (origin: string) =>
    new ComfyUIWsClient(origin, "c1", {
      ...DEFAULT_COMFYUI_TIMING,
      handshakeTimeoutMs: 1000,
    }).connect();

  it("tunnels the handshake through HTTP_PROXY", async () => {
    const proxy = await recordingServer("127.0.0.1");
    const comfy = await recordingServer("127.0.0.2");
    vi.stubEnv("HTTP_PROXY", proxy.origin);

    await expect(connect(comfy.origin)).rejects.toMatchObject({ code: "COMFYUI_WS_UNAVAILABLE" });
    expect(proxy.requests).toEqual([`CONNECT ${new URL(comfy.origin).host} HTTP/1.1`]);
    expect(comfy.requests).toEqual([]);
  });

  it("connects directly to a host NO_PROXY names", async () => {
    const proxy = await recordingServer("127.0.0.1");
    const comfy = await recordingServer("127.0.0.2");
    vi.stubEnv("HTTP_PROXY", proxy.origin);
    vi.stubEnv("NO_PROXY", "127.0.0.2");

    await expect(connect(comfy.origin)).rejects.toMatchObject({ code: "COMFYUI_WS_UNAVAILABLE" });
    expect(proxy.requests).toEqual([]);
    expect(comfy.requests).toEqual(["GET /ws?clientId=c1 HTTP/1.1"]);
  });
});
