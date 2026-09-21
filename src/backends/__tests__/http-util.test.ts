import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KonteError } from "../../core/errors.js";
import { downloadToFile, parseApiResponse, saveDownloadResponse } from "../http-util.js";
import { TransientHttpError } from "../../core/http-retry.js";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("parseApiResponse", () => {
  it("keeps an interrupted JSON response retryable", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("connection reset"));
        },
      }),
    );
    await expect(
      parseApiResponse(response, z.object({ id: z.string() }), "FAL_ERROR", "FAL result"),
    ).rejects.toBeInstanceOf(TransientHttpError);
  });
  it("returns the parsed output, with defaults applied and unknown keys stripped", async () => {
    const schema = z.object({ id: z.string(), retries: z.number().default(0) });
    const parsed = await parseApiResponse(
      jsonResponse({ id: "req-1", extra: "ignored" }),
      schema,
      "FAL_ERROR",
      "test",
    );
    expect(parsed).toEqual({ id: "req-1", retries: 0 });
  });

  it("names the offending path and expected type without echoing the received value", async () => {
    const schema = z.object({ status: z.enum(["ok"]) });
    const secret = "https://cdn.example/file?token=SECRET-TOKEN";

    const err = await parseApiResponse(
      jsonResponse({ status: secret }),
      schema,
      "FAL_ERROR",
      "FAL status check",
    ).catch((e) => e as KonteError);

    expect(err).toBeInstanceOf(KonteError);
    expect((err as KonteError).code).toBe("FAL_ERROR");
    expect((err as KonteError).message).toContain("status:");
    expect((err as KonteError).message).not.toContain("SECRET-TOKEN");
  });

  it("throws a typed error on a non-JSON body", async () => {
    const err = await parseApiResponse(
      new Response("<html>502</html>"),
      z.object({ id: z.string() }),
      "FAL_ERROR",
      "FAL submit",
    ).catch((e) => e as KonteError);

    expect((err as KonteError).code).toBe("FAL_ERROR");
    expect((err as KonteError).message).toContain("non-JSON");
  });
});

describe("downloadToFile", () => {
  it("classifies a broken response stream as transient and keeps the existing file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-interrupted-"));
    const dest = path.join(dir, "output.png");
    try {
      await fs.writeFile(dest, "previous");
      let reads = 0;
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
            else controller.error(new TypeError("connection reset"));
          },
        }),
      );
      await expect(saveDownloadResponse(response, dest)).rejects.toBeInstanceOf(TransientHttpError);
      expect(await fs.readFile(dest, "utf-8")).toBe("previous");
      expect(await fs.readdir(dir)).toEqual(["output.png"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not classify a filesystem failure as a transient network error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-write-failure-"));
    try {
      const parent = path.join(dir, "file");
      await fs.writeFile(parent, "not a directory");
      const result = await saveDownloadResponse(
        new Response("payload"),
        path.join(parent, "out"),
      ).catch((err: unknown) => err);
      expect(result).toBeInstanceOf(Error);
      expect(result).not.toBeInstanceOf(TransientHttpError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  async function withServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    body: (baseUrl: string, outDir: string) => Promise<void>,
  ): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-download-test-"));
    try {
      await body(`http://127.0.0.1:${port}`, outDir);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }

  it("streams a delivery to disk", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end("payload");
      },
      async (baseUrl, outDir) => {
        const out = path.join(outDir, "out.mp4");
        await downloadToFile(`${baseUrl}/out.mp4?token=secret`, out, "FAL_ERROR");
        expect(await fs.readFile(out, "utf-8")).toBe("payload");
      },
    );
  });

  it("throws the caller's typed error on a permanent failure, naming the file but not the token", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(404);
        res.end("gone");
      },
      async (baseUrl, outDir) => {
        const out = path.join(outDir, "out.mp4");
        const err = (await downloadToFile(
          `${baseUrl}/out.mp4?token=supersecret`,
          out,
          "FAL_ERROR",
        ).catch((e) => e)) as KonteError;

        expect(err).toBeInstanceOf(KonteError);
        expect(err.code).toBe("FAL_ERROR");
        expect(err.message).toContain("/out.mp4");
        expect(err.message).not.toContain("supersecret");
        // A failed download leaves nothing half-written behind.
        await expect(fs.access(out)).rejects.toThrow();
      },
    );
  });
});
