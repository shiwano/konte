import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FalHttpClient } from "../http-client.js";

// The upload path streams a `fs.openAsBlob` Blob straight into fetch. Mocking fetch would prove
// nothing about that hand-off — a Bun regression there only shows up when a real request has to
// read the Blob — so the token call is redirected to a local server and the upload itself is a
// genuine fetch of the file's bytes over the wire.
let server: http.Server;
let baseUrl: string;
let received: { body: Buffer; contentType: string | undefined; fileNameHeader: string | undefined };
let tmpDir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/storage/auth/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ base_url: baseUrl, token: "upload-token" }));
      return;
    }

    if (url.pathname === "/files/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received = {
          body: Buffer.concat(chunks),
          contentType: req.headers["content-type"],
          fileNameHeader: req.headers["x-fal-file-name"] as string | undefined,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_url: "https://cdn.fal.example/uploaded.png" }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-fal-upload-test-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Only the hard-coded token endpoint is rewritten; every other request (the upload itself) runs
// through the real fetch untouched.
function redirectTokenEndpoint(): void {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://rest.alpha.fal.ai")) {
      const rewritten = url.replace("https://rest.alpha.fal.ai", baseUrl);
      return realFetch(rewritten, init);
    }
    return realFetch(input, init);
  });
}

describe("FalHttpClient.uploadFile", () => {
  it("streams the file's bytes to the upload endpoint and returns its access URL", async () => {
    const filePath = path.join(tmpDir, "frame.png");
    const bytes = Buffer.from("PNG-ish payload with a few bytes");
    await fs.writeFile(filePath, bytes);

    redirectTokenEndpoint();
    const client = new FalHttpClient("test-key");
    const { accessUrl } = await client.uploadFile(filePath);

    expect(accessUrl).toBe("https://cdn.fal.example/uploaded.png");
    expect(received.body.equals(bytes)).toBe(true);
    expect(received.contentType).toBe("image/png");
    expect(received.fileNameHeader).toBe("frame.png");
  });

  it("rejects instead of uploading an empty body when the file is missing", async () => {
    redirectTokenEndpoint();
    const client = new FalHttpClient("test-key");

    await expect(client.uploadFile(path.join(tmpDir, "missing.png"))).rejects.toThrow();
  });
});
