import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchVideoFile } from "../clip-download.js";

describe("fetchVideoFile", () => {
  let server: Server;
  let port: number;
  let dir: string;
  let requests: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests++;
      const { pathname } = new URL(req.url!, "http://localhost");
      if (pathname === "/ref.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" }).end("bytes");
      } else if (pathname === "/stream") {
        res.writeHead(200, { "content-type": "video/webm; codecs=vp9" }).end("bytes");
      } else if (pathname === "/watch") {
        res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(async () => {
    requests = 0;
    dir = await fs.mkdtemp(path.join(tmpdir(), "konte-fetch-clip-"));
  });

  const at = (p: string) => `http://127.0.0.1:${port}${p}`;

  it("saves a video file under the URL's name, once", async () => {
    const file = await fetchVideoFile(at("/ref.mp4"), dir);
    expect(path.basename(file!)).toMatch(/^ref-[0-9a-f]{8}\.mp4$/);
    expect(readFileSync(file!, "utf-8")).toBe("bytes");
    expect(await fetchVideoFile(at("/ref.mp4"), dir)).toBe(file);
    expect(requests).toBe(1);
  });

  it("keeps two URLs of the same name apart", async () => {
    const first = await fetchVideoFile(at("/ref.mp4"), dir);
    const second = await fetchVideoFile(at("/ref.mp4?take=2"), dir);
    expect(second).not.toBe(first);
    expect(requests).toBe(2);
  });

  it("names a file the URL gives no extension by its type, once", async () => {
    const file = await fetchVideoFile(at("/stream"), dir);
    expect(path.basename(file!)).toMatch(/^stream-[0-9a-f]{8}\.webm$/);
    expect(await fetchVideoFile(at("/stream"), dir)).toBe(file);
    expect(requests).toBe(1);
  });

  it("saves nothing for a page", async () => {
    expect(await fetchVideoFile(at("/watch"), dir)).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses a URL that does not answer", async () => {
    await expect(fetchVideoFile(at("/gone.mp4"), dir)).rejects.toMatchObject({
      code: "CLIP_DOWNLOAD_FAILED",
    });
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
