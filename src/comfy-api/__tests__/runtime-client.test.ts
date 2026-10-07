import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientHttpError } from "../../core/http-retry.js";
import { blake3File, ComfyApiRuntimeClient } from "../runtime-client.js";

let tmpDir: string;
let inputPath: string;
let hash: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-comfyapi-runtime-"));
  inputPath = path.join(tmpDir, "frame.png");
  await fs.writeFile(inputPath, "png bytes");
  hash = await blake3File(inputPath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

const headersOf = (call: Call) => (call.init.headers ?? {}) as Record<string, string>;

const JOB = { id: "job-1", status: "queued", outputs: [] };

describe("blake3File", () => {
  it("names a file by its blake3 digest", () => {
    expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);
  });
});

describe("uploadInput", () => {
  it("mints an asset from a hash the platform already holds", async () => {
    const calls = mockFetch(({ url }) =>
      url.endsWith("/from-hash") ? json({ id: "asset-1" }) : new Response(null, { status: 200 }),
    );
    const client = new ComfyApiRuntimeClient("https://cloud.comfy.org", "key", "cloud");

    expect(await client.uploadInput(inputPath)).toBe("asset-1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `HEAD https://cloud.comfy.org/api/v2/assets/by-hash/${encodeURIComponent(hash)}`,
      "POST https://cloud.comfy.org/api/v2/assets/from-hash",
    ]);
    expect(headersOf(calls[0]!).Authorization).toBe("Bearer key");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      hash,
      file_path: "frame.png",
      tags: ["input"],
    });
  });

  it("uploads the file on Cloud with tags as a JSON array", async () => {
    const calls = mockFetch(({ init }) =>
      init.method === "HEAD" ? new Response(null, { status: 404 }) : json({ id: "asset-2" }),
    );
    const client = new ComfyApiRuntimeClient("https://cloud.comfy.org/", "key", "cloud");

    expect(await client.uploadInput(inputPath)).toBe("asset-2");
    const upload = calls[1]!;
    expect(upload.url).toBe("https://cloud.comfy.org/api/v2/assets");
    const form = upload.init.body as FormData;
    expect(form.get("tags")).toBe('["input"]');
    expect(form.get("expected_hash")).toBe(hash);
    expect(form.get("file_path")).toBe("frame.png");
    expect(await (form.get("file") as Blob).text()).toBe("png bytes");
  });

  it("uploads the file on a deployment with tags as plain input", async () => {
    const calls = mockFetch(({ init }) =>
      init.method === "HEAD" ? new Response(null, { status: 404 }) : json({ id: "asset-3" }),
    );
    const client = new ComfyApiRuntimeClient("https://dep.example/api/v2", "key", "deployment");

    expect(await client.uploadInput(inputPath)).toBe("asset-3");
    expect(calls[1]!.url).toBe("https://dep.example/api/v2/assets");
    expect((calls[1]!.init.body as FormData).get("tags")).toBe("input");
  });

  it("uploads when the hash ages out between the lookup and the mint", async () => {
    const calls = mockFetch(({ url, init }) =>
      init.method === "HEAD"
        ? new Response(null, { status: 200 })
        : url.endsWith("/from-hash")
          ? json({ error: { code: "not_found", message: "gone" } }, 404)
          : json({ id: "asset-4" }),
    );
    const client = new ComfyApiRuntimeClient("https://cloud.comfy.org", "key", "cloud");

    expect(await client.uploadInput(inputPath)).toBe("asset-4");
    expect(calls.map((c) => c.url.split("/api/v2")[1])).toEqual([
      `/assets/by-hash/${encodeURIComponent(hash)}`,
      "/assets/from-hash",
      "/assets",
    ]);
  });
});

describe("submitJob", () => {
  it("sends the variant id as the Idempotency-Key", async () => {
    const calls = mockFetch(() => json(JOB, 201));
    const client = new ComfyApiRuntimeClient("https://cloud.comfy.org", "key", "cloud");

    const job = await client.submitJob({ "9": { class_type: "SaveImage", inputs: {} } }, "v-abc");
    expect(job.id).toBe("job-1");
    expect(calls[0]!.url).toBe("https://cloud.comfy.org/api/v2/jobs");
    expect(headersOf(calls[0]!)["Idempotency-Key"]).toBe("v-abc");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      workflow: { "9": { class_type: "SaveImage", inputs: {} } },
    });
  });

  it("reads a 429 as transient", async () => {
    mockFetch(() => json({ error: { code: "warming_up", message: "not yet" } }, 429));
    const client = new ComfyApiRuntimeClient("https://dep.example", "key", "deployment");

    const err = await client.submitJob({}, "v-abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientHttpError);
    expect((err as TransientHttpError).status).toBe(429);
  });

  it("keeps the server's code on a refusal", async () => {
    mockFetch(() => json({ error: { code: "idempotency_key_reuse", message: "reused" } }, 409));
    const client = new ComfyApiRuntimeClient("https://dep.example", "key", "deployment");

    await expect(client.submitJob({}, "v-abc")).rejects.toMatchObject({
      code: "COMFY_API_ERROR",
      status: 409,
      serverCode: "idempotency_key_reuse",
    });
  });
});

describe("downloadOutput", () => {
  const output = { node_id: "9", name: "out.png", type: "image", id: "asset-9" };

  it("follows the redirect to a signed URL without the key", async () => {
    const calls = mockFetch(({ url }) =>
      url.startsWith("https://storage.example/")
        ? new Response("image bytes", { status: 200 })
        : new Response(null, {
            status: 302,
            headers: { location: "https://storage.example/out.png?sig=abc" },
          }),
    );
    const client = new ComfyApiRuntimeClient("https://cloud.comfy.org", "key", "cloud");
    const outputPath = path.join(tmpDir, "out.png");

    await client.downloadOutput(output, outputPath);
    expect(await fs.readFile(outputPath, "utf-8")).toBe("image bytes");
    expect(calls[0]!.url).toBe("https://cloud.comfy.org/api/v2/assets/asset-9/content");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(headersOf(calls[0]!).Authorization).toBe("Bearer key");
    expect(calls[1]!.url).toBe("https://storage.example/out.png?sig=abc");
    expect(JSON.stringify(calls[1]!.init.headers ?? {})).not.toContain("key");
  });

  it("saves a body served in place", async () => {
    mockFetch(() => new Response("inline bytes", { status: 200 }));
    const client = new ComfyApiRuntimeClient("https://cloud.comfy.org", "key", "cloud");
    const outputPath = path.join(tmpDir, "inline.png");

    await client.downloadOutput(output, outputPath);
    expect(await fs.readFile(outputPath, "utf-8")).toBe("inline bytes");
  });
});
