import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { downloadedClip, fetchVideoFile, keepDownload } from "../clip-download.js";
import { clipSha256, clipStudyDir } from "../study-clip.js";

describe("fetchVideoFile", () => {
  let server: Server;
  let port: number;
  let dir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
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
    dir = await fs.mkdtemp(path.join(tmpdir(), "konte-fetch-clip-"));
  });

  const at = (p: string) => `http://127.0.0.1:${port}${p}`;

  it("saves a video file under the URL's name", async () => {
    const file = await fetchVideoFile(at("/ref.mp4"), dir);
    expect(file).toBe(path.join(dir, "ref.mp4"));
    expect(readFileSync(file!, "utf-8")).toBe("bytes");
  });

  it("names a file the URL gives no extension by its type", async () => {
    expect(await fetchVideoFile(at("/stream"), dir)).toBe(path.join(dir, "stream.webm"));
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

describe("keepDownload", () => {
  let workspace: string;
  let workDir: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "konte-keep-download-"));
    workDir = path.join(workspace, "work");
    await fs.mkdir(workDir);
    await fs.writeFile(path.join(workDir, "Youtube-abc.webm"), "picture");
    await fs.writeFile(path.join(workDir, "Youtube-abc.info.json"), "{}");
    await fs.writeFile(path.join(workDir, "Youtube-abc.en.vtt"), "WEBVTT");
    await fs.writeFile(path.join(workDir, "stray.txt"), "");
  });

  const url = "https://example.com/watch?v=abc";

  it("moves the clip and what was saved beside it into its study directory", async () => {
    const file = await keepDownload(workspace, url, path.join(workDir, "Youtube-abc.webm"));
    const dir = clipStudyDir(workspace, await clipSha256(file));
    expect(file).toBe(path.join(dir, "Youtube-abc.webm"));
    expect((await fs.readdir(dir)).sort()).toEqual([
      "Youtube-abc.webm",
      "en.vtt",
      "info.json",
      "source.json",
    ]);
  });

  it("finds the clip again by its URL", async () => {
    const file = await keepDownload(workspace, url, path.join(workDir, "Youtube-abc.webm"));
    expect(downloadedClip(workspace, url)).toBe(file);
    expect(downloadedClip(workspace, "https://example.com/watch?v=other")).toBeNull();
  });
});
