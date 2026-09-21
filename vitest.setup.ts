import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// Last line of defence for the managed runtimes: pin the tool cache to a throwaway dir, so a
// resolver that slips past the overrides below writes there rather than into the developer's real
// cache (or a fixture workspace).
if (!process.env.KONTE_CACHE_DIR) {
  process.env.KONTE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "konte-tool-cache-"));
}

// Integration tests drive the real ffmpeg pipeline. Point konte's binary resolver at the system
// ffmpeg/ffprobe (resolved via PATH) so a test never triggers a network download of the managed
// build. Tests that exercise the resolver itself override or clear these explicitly.
if (!process.env.KONTE_FFMPEG_PATH) process.env.KONTE_FFMPEG_PATH = "ffmpeg";
if (!process.env.KONTE_FFPROBE_PATH) process.env.KONTE_FFPROBE_PATH = "ffprobe";

// Whether a vendor backend is configured is read from its credential in the environment, so a
// developer's own FAL_KEY would otherwise decide what the adapter listing and the generate gate
// say. A test that wants fal configured stubs the variable itself.
delete process.env.FAL_KEY;

// doctor asks GitHub for the latest release once a day and caches the answer beside the binary
// (~/.konte). Neither belongs in a test run.
if (!process.env.KONTE_UPDATE_CHECK) process.env.KONTE_UPDATE_CHECK = "0";

// Nothing under test launches a browser (the render path mocks HyperFrames), but ensureChromium is
// reachable from workspace setup — pin the override so a stray call can never pull ~150 MB.
if (!process.env.KONTE_CHROMIUM_PATH) process.env.KONTE_CHROMIUM_PATH = "chrome-headless-shell";
if (!process.env.KONTE_CLOUDFLARED_PATH) process.env.KONTE_CLOUDFLARED_PATH = "cloudflared";

// The e2e suite spawns the real CLI, whose preAction type-checks the scaffolded project — on a
// cold cache that downloads the managed native tsc from npm. The JS `tsc` takes the same
// `--noEmit --pretty` CLI and is already a devDependency, so pin the override at it: a real
// type-check, no network.
if (!process.env.KONTE_TSC_PATH) {
  const tsc = path.resolve(process.cwd(), "node_modules", ".bin", "tsc");
  if (fs.existsSync(tsc)) process.env.KONTE_TSC_PATH = tsc;
}

// No test may open a socket to anything it did not start itself. A test that needs an HTTP peer
// brings one up on loopback (`listen(0)`); every other address a command reaches for — the ComfyUI
// URL `konte workspace new` scaffolds, a model download URL, a vendor endpoint — has to come back as
// "nothing is listening". Left to the OS that answer is a refused connection on one machine and a
// silently dropped packet on another (a firewall in front of a common port such as 8000), and the
// caller then sits out its full timeout until the test dies on the clock rather than on an
// assertion. Answer it here instead, from the set of ports this process is actually serving.
// Bun's http.Server does not inherit net.Server's listen, so wrap every prototype that owns one.
const servingPorts = new Set<number>();
for (const proto of [net.Server.prototype, http.Server.prototype]) {
  if (!Object.prototype.hasOwnProperty.call(proto, "listen")) continue;
  const listen = proto.listen as (this: net.Server, ...args: unknown[]) => net.Server;
  proto.listen = function (this: net.Server, ...args: unknown[]) {
    const server = listen.apply(this, args);
    const record = () => {
      const addr = this.address();
      if (addr !== null && typeof addr === "object") servingPorts.add(addr.port);
    };
    if (this.listening) record();
    else this.once("listening", record);
    return server;
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  let target: URL;
  try {
    target = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
  } catch {
    return realFetch(input as RequestInfo, init);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.hostname);
  if (!loopback || !servingPorts.has(Number(target.port))) {
    const cause = Object.assign(
      new Error(`connect ECONNREFUSED ${target.hostname}:${target.port}`),
      { code: "ECONNREFUSED", errno: -111, syscall: "connect" },
    );
    return Promise.reject(new TypeError("fetch failed", { cause }));
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// vitest finds the file behind a `vi.mock` by its Node-shaped stack frame (` at Object.mock`). Bun
// prints ` at mock (`, so the importer comes back empty and a relative path resolves against cwd.
// Read the caller off Bun's frame and hand the mock an absolute path instead.
if (process.versions.bun) {
  const callerFile = (): string | undefined => {
    for (const line of (new Error().stack ?? "").split("\n")) {
      const m = /\((.+?):\d+:\d+\)\s*$/.exec(line) ?? /at (.+?):\d+:\d+\s*$/.exec(line);
      const file = m?.[1];
      if (!file || file.includes("/node_modules/") || file.endsWith("vitest.setup.ts")) continue;
      return file.startsWith("file:") ? fileURLToPath(file) : file;
    }
    return undefined;
  };
  const absolute = <A extends unknown[], R>(fn: (p: string, ...rest: A) => R) =>
    function (this: unknown, p: string, ...rest: A): R {
      const file = typeof p === "string" && p.startsWith(".") ? callerFile() : undefined;
      return fn.call(this, file ? path.resolve(path.dirname(file), p) : p, ...rest);
    };
  vi.mock = absolute(vi.mock) as typeof vi.mock;
  vi.doMock = absolute(vi.doMock) as typeof vi.doMock;
  vi.unmock = absolute(vi.unmock) as typeof vi.unmock;
  vi.doUnmock = absolute(vi.doUnmock) as typeof vi.doUnmock;
  vi.importActual = absolute(vi.importActual) as typeof vi.importActual;
  vi.importMock = absolute(vi.importMock) as typeof vi.importMock;
}
