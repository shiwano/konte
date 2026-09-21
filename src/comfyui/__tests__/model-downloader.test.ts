import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KonteError } from "../../core/errors.js";
import { downloadModelFile } from "../model-downloader.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

describe("downloadModelFile", () => {
  let server: Server;
  let origin: string;
  let tmp: string;
  let handler: Handler;
  let seenHeaders: IncomingMessage["headers"][] = [];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "konte-dl-"));
    seenHeaders = [];
    handler = (_req, res) => res.end("body");
    server = createServer((req, res) => {
      seenHeaders.push(req.headers);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.HF_TOKEN;
  });

  const dest = () => path.join(tmp, "m.safetensors");

  const run = (over: Partial<Parameters<typeof downloadModelFile>[0]> = {}) =>
    downloadModelFile({
      resolvedUrl: `${origin}/m.safetensors`,
      declaredUrl: "https://huggingface.co/r/resolve/main/m.safetensors",
      destPath: dest(),
      ...over,
    });

  const ETAG = '"v1"';

  // A well-behaved range server: honours `bytes=N-`, answers with a coherent `Content-Range`, and
  // carries a validator so a resume can be proven to continue the same object.
  const serveBytes = (body: string, etag = ETAG): void => {
    handler = (req, res) => {
      const range = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
      const from = range ? Number(range[1]) : 0;
      const slice = body.slice(from);
      res.writeHead(
        from > 0 ? 206 : 200,
        from > 0
          ? {
              etag,
              "content-length": String(slice.length),
              "content-range": `bytes ${from}-${body.length - 1}/${body.length}`,
            }
          : { etag, "content-length": String(slice.length) },
      );
      res.end(slice);
    };
  };

  it("writes the file and reports the byte count", async () => {
    serveBytes("hello world");
    const result = await run();
    expect(result).toEqual({ kind: "downloaded", bytes: 11 });
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  it("returns alreadyPresent without a request when the file is there", async () => {
    await fs.writeFile(dest(), "x");
    expect(await run()).toEqual({ kind: "alreadyPresent" });
    expect(seenHeaders).toHaveLength(0);
  });

  it("leaves no partial at the destination name while in flight", async () => {
    let duringDownload: string[] = [];
    handler = async (_req, res) => {
      res.writeHead(200, { "content-length": "8" });
      res.write("aaaa");
      await new Promise((r) => setTimeout(r, 40));
      duringDownload = await fs.readdir(tmp);
      res.end("bbbb");
    };
    await run();
    // The bytes land under a name that carries no model extension, so a ComfyUI directory scan
    // racing the download cannot list it as the model.
    expect(duringDownload).not.toContain("m.safetensors");
    expect(duringDownload.some((f) => f.endsWith(".konte-part"))).toBe(true);
  });

  const DECLARED = "https://huggingface.co/r/resolve/main/m.safetensors";

  // A partial is only resumable together with the note saying what it is — the source URL and the
  // validator the bytes were fetched under.
  const seedPartial = async (
    bytes: string,
    meta: { url?: string; validator?: string | null } = {},
  ): Promise<void> => {
    await fs.writeFile(`${dest()}.konte-part`, bytes);
    await fs.writeFile(
      `${dest()}.konte-part.json`,
      JSON.stringify({
        url: meta.url ?? DECLARED,
        ...(meta.validator === null ? {} : { validator: meta.validator ?? ETAG }),
      }),
    );
  };

  it("resumes from an interrupted partial rather than restarting", async () => {
    serveBytes("hello world");
    await seedPartial("hello ");
    const result = await run();
    expect(result).toEqual({ kind: "downloaded", bytes: 11 });
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
    expect(seenHeaders[0]?.range).toBe("bytes=6-");
  });

  // The destination filename alone does not identify a file. If the declaration's URL changed, the
  // bytes on disk belong to something else and appending to them would silently forge a model
  // whose length still checks out.
  it("discards a partial left by a different URL", async () => {
    serveBytes("hello world");
    await seedPartial("XXXXXX", { url: "https://huggingface.co/r/resolve/main/OLD.safetensors" });
    await run();
    expect(seenHeaders[0]?.range).toBeUndefined();
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  it("discards a partial with no source note at all", async () => {
    serveBytes("hello world");
    await fs.writeFile(`${dest()}.konte-part`, "hello ");
    await run();
    expect(seenHeaders[0]?.range).toBeUndefined();
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  // Same URL, different content. Without a validator there is nothing to detect that with, so
  // these bytes are not resumable at all.
  it("does not resume a partial recorded without a validator", async () => {
    serveBytes("hello world");
    await seedPartial("hello ", { validator: null });
    await run();
    expect(seenHeaders[0]?.range).toBeUndefined();
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  it("sends If-Range so the server can refuse a stale resume", async () => {
    serveBytes("hello world");
    await seedPartial("hello ");
    await run();
    expect(seenHeaders[0]?.["if-range"]).toBe(ETAG);
  });

  // The object behind the URL changed: `If-Range` makes the server answer with the whole new
  // object, and the old bytes must be dropped rather than prefixed onto it.
  it("takes the whole object when the validator no longer matches", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      // A correct server answers a no-longer-matching If-Range with 200 and the whole new object.
      if (req.headers["if-range"] === '"v1"') {
        res.writeHead(200, { etag: '"v2"', "content-length": "13" });
        res.end("goodbye world");
        return;
      }
      res.writeHead(500).end();
    };
    await seedPartial("hello ", { validator: '"v1"' });
    expect(await run()).toEqual({ kind: "downloaded", bytes: 13 });
    expect(await fs.readFile(dest(), "utf8")).toBe("goodbye world");
    // That 200 already carried the object; asking again would transfer a multi-GB model twice.
    expect(calls).toBe(1);
  });

  // `bytes 6-10/100` alongside `content-length: 5` is internally coherent but describes a slice of
  // a 100-byte object. Appending it yields 11 bytes, which the old start-only check accepted.
  it("rejects a range whose total contradicts the bytes on offer", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      if (req.headers.range) {
        res.writeHead(206, {
          etag: ETAG,
          "content-length": "5",
          "content-range": "bytes 6-10/100",
        });
        res.end("world");
        return;
      }
      res.writeHead(200, { etag: ETAG, "content-length": "11" });
      res.end("hello world");
    };
    await seedPartial("hello ");
    expect(await run()).toEqual({ kind: "downloaded", bytes: 11 });
    expect(calls).toBe(2);
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  // A server free to answer with a bogus range is free to keep streaming it. Left open, that
  // transfer runs alongside the replacement one for the same file.
  it("stops the stream it rejected before starting the replacement", async () => {
    let rejectedClosed = false;
    handler = (req, res) => {
      if (req.headers.range) {
        res.writeHead(206, {
          etag: ETAG,
          "content-length": "1000",
          "content-range": "bytes 999-1998/2000",
        });
        req.socket.on("close", () => {
          rejectedClosed = true;
        });
        res.write("x".repeat(100));
        // Deliberately never ended: only konte letting go can close it.
        return;
      }
      res.writeHead(200, { etag: ETAG, "content-length": "11" });
      res.end("hello world");
    };
    await seedPartial("hello ");
    expect(await run()).toEqual({ kind: "downloaded", bytes: 11 });
    expect(rejectedClosed).toBe(true);
  });

  // The job may be running in the MCP watcher, which read the credentials when it started. "The
  // token is in the file" and "the token is in the process doing the download" are different, and the
  // message has to name the second one or the user re-checks the file that is already correct.
  it("points at a stale MCP environment when the server refuses the credential", async () => {
    handler = (_req, res) => res.writeHead(403).end("nope");
    let message = "";
    try {
      await run();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("restart it so it picks up the current credentials");
  });

  it("refuses a partial response to a request for the whole file", async () => {
    handler = (_req, res) => {
      res.writeHead(206, { "content-length": "5", "content-range": "bytes 0-4/11" });
      res.end("hello");
    };
    await expect(run()).rejects.toThrow(/partial response/i);
    await expect(fs.access(dest())).rejects.toThrow();
  });

  it("restarts when the server ignores the range and replies 200", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": "11" });
      res.end("hello world");
    };
    await seedPartial("hello ");
    await run();
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  // A 206 for a range other than the one asked for must not be appended, and must not be kept as
  // if it were the whole object either — its own length agrees with itself, so the size check
  // cannot catch it.
  it("restarts when a 206 does not begin where the partial ends", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      if (req.headers.range) {
        res.writeHead(206, { "content-length": "5", "content-range": "bytes 6-10/11" });
        res.end("world");
        return;
      }
      res.writeHead(200, { "content-length": "11" });
      res.end("hello world");
    };
    // The partial is 3 bytes, so the server's `bytes 6-` answer lines up with nothing.
    await seedPartial("hel");
    const result = await run();
    expect(calls).toBe(2);
    expect(result).toEqual({ kind: "downloaded", bytes: 11 });
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  it("restarts on a 206 that declares no range at all", async () => {
    handler = (req, res) => {
      if (req.headers.range) {
        res.writeHead(206, { "content-length": "5" });
        res.end("world");
        return;
      }
      res.writeHead(200, { "content-length": "11" });
      res.end("hello world");
    };
    await seedPartial("hello ");
    expect(await run()).toEqual({ kind: "downloaded", bytes: 11 });
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  // A partial at or past the object's length is unresumable and the server says 416. Without
  // recovery that state is permanent — every retry asks for the same impossible range.
  it("starts over when the server rejects the resume range as unsatisfiable", async () => {
    let sawRange = false;
    handler = (req, res) => {
      if (req.headers.range) {
        sawRange = true;
        res.writeHead(416).end();
        return;
      }
      res.writeHead(200, { "content-length": "11" });
      res.end("hello world");
    };
    await seedPartial("hello world and then some");
    const result = await run();
    expect(sawRange).toBe(true);
    expect(result).toEqual({ kind: "downloaded", bytes: 11 });
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  it("leaves no source note beside a finished model", async () => {
    serveBytes("hello world");
    await run();
    expect(await fs.readdir(tmp)).toEqual(["m.safetensors"]);
  });

  // The run lease is meant to lapse and be reclaimed, so two workers can reach the same file. They
  // must not both write it.
  it("stands down while another worker holds the download", async () => {
    serveBytes("hello world");
    await fs.writeFile(`${dest()}.konte-lock`, "");
    expect(await run()).toEqual({ kind: "busy" });
    expect(seenHeaders).toHaveLength(0);
  });

  it("takes over a lock whose owner stopped refreshing it", async () => {
    serveBytes("hello world");
    const lock = `${dest()}.konte-lock`;
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(lock, old, old);
    expect(await run()).toEqual({ kind: "downloaded", bytes: 11 });
  });

  it("releases its lock when the download fails", async () => {
    handler = (_req, res) => res.writeHead(500).end("nope");
    await expect(run()).rejects.toThrow(KonteError);
    await expect(fs.access(`${dest()}.konte-lock`)).rejects.toThrow();
  });

  it("never publishes a truncated transfer, and keeps its bytes for the retry", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("too short");
      setTimeout(() => res.socket?.destroy(), 50);
    };
    await expect(run()).rejects.toThrow(KonteError);
    // The destination name stays unclaimed; whatever arrived survives under the partial name so
    // the next attempt resumes from it instead of starting over.
    await expect(fs.access(dest())).rejects.toThrow();
    await fs.access(`${dest()}.konte-part`);
  });

  it("accepts a chunked response that declares no length", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write("hello ");
      res.end("world");
    };
    const result = await run();
    expect(result).toEqual({ kind: "downloaded", bytes: 11 });
    expect(await fs.readFile(dest(), "utf8")).toBe("hello world");
  });

  it("reports progress against the declared total", async () => {
    serveBytes("hello world");
    const seen: Array<{ received: number; total: number | null }> = [];
    await run({ onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)).toEqual({ received: 11, total: 11 });
  });

  it("counts resumed bytes toward progress, not just the new ones", async () => {
    serveBytes("hello world");
    await fs.writeFile(`${dest()}.konte-part`, "hello ");
    const seen: Array<{ received: number; total: number | null }> = [];
    await run({ onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)).toEqual({ received: 11, total: 11 });
  });
});

describe("downloadModelFile auth", () => {
  let server: Server;
  let origin: string;
  let tmp: string;
  let seen: IncomingMessage["headers"][] = [];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "konte-dl-auth-"));
    seen = [];
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-length": "2" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.HF_TOKEN;
  });

  it("does not send HF_TOKEN to a non-HuggingFace host", async () => {
    process.env.HF_TOKEN = "hf_secret";
    await downloadModelFile({
      resolvedUrl: `${origin}/m.safetensors`,
      declaredUrl: `${origin}/m.safetensors`,
      destPath: path.join(tmp, "m.safetensors"),
    });
    expect(seen[0]?.authorization).toBeUndefined();
  });

  // The token is never part of the URL, so a failure message — which is persisted to the job file
  // and log — cannot carry it.
  it("keeps the token out of an error that reaches disk", async () => {
    process.env.HF_TOKEN = "hf_secret";
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let error: unknown;
    try {
      await downloadModelFile({
        resolvedUrl: `${origin}/m.safetensors`,
        declaredUrl: "https://huggingface.co/r/resolve/main/m.safetensors",
        destPath: path.join(tmp, "m.safetensors"),
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as Error).message).not.toContain("hf_secret");
    server = createServer();
  });
});
