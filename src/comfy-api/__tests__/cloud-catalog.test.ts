import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ComfyCloudCatalog } from "../cloud-catalog.js";

// A network failure is retried with backoff before it is given up on; the waits go to zero.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

const HOUR = 60 * 60 * 1000;

let tmpDir: string;
let fetchMock: MockInstance<typeof fetch>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-comfycloud-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(handler: (url: URL) => Response | Promise<Response>): void {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => handler(new URL(String(input))));
}

function calls(pathname: string): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === pathname);
}

async function readCache(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(tmpDir, ".konte", "comfycloud.json"), "utf-8"));
}

describe("nodeClasses", () => {
  it("reads object_info once and keeps it for the hour", async () => {
    mockFetch(() => json({ KSampler: {}, SaveImage: {} }));
    let now = 1_000_000;
    const clock = () => now;

    const first = new ComfyCloudCatalog(tmpDir, "key", clock);
    expect(await first.nodeClasses()).toEqual(new Set(["KSampler", "SaveImage"]));
    expect(await first.nodeClasses()).toEqual(new Set(["KSampler", "SaveImage"]));
    expect(calls("/api/object_info")).toHaveLength(1);
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)["X-API-Key"]).toBe(
      "key",
    );
    expect(await readCache()).toMatchObject({
      nodes: { fetchedAt: 1_000_000, classes: ["KSampler", "SaveImage"] },
    });

    now += HOUR - 1;
    await new ComfyCloudCatalog(tmpDir, "key", clock).nodeClasses();
    expect(calls("/api/object_info")).toHaveLength(1);

    now += 1;
    await new ComfyCloudCatalog(tmpDir, "key", clock).nodeClasses();
    expect(calls("/api/object_info")).toHaveLength(2);
  });

  it("is COMFY_CLOUD_UNAVAILABLE when Cloud refuses the read", async () => {
    mockFetch(() => json({ error: "unauthorized" }, 401));
    await expect(new ComfyCloudCatalog(tmpDir, "key").nodeClasses()).rejects.toMatchObject({
      code: "COMFY_CLOUD_UNAVAILABLE",
    });
  });

  it("is COMFY_CLOUD_UNAVAILABLE when Cloud cannot be reached", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(new ComfyCloudCatalog(tmpDir, "key").nodeClasses()).rejects.toMatchObject({
      code: "COMFY_CLOUD_UNAVAILABLE",
    });
  });
});

describe("hasModel", () => {
  it("holds a model only on an exact models/<relative> file_path", async () => {
    mockFetch(() =>
      json({
        assets: [
          { name: "flux.safetensors", file_path: "models/checkpoints/flux.safetensors" },
          { name: "flux.safetensors", file_path: null },
        ],
      }),
    );
    const catalog = new ComfyCloudCatalog(tmpDir, "key");
    expect(await catalog.hasModel("diffusion_models/flux.safetensors")).toBe(false);
    expect(await catalog.hasModel("checkpoints/flux.safetensors")).toBe(true);

    const query = calls("/api/assets")[0]!.searchParams;
    expect(query.get("name_contains")).toBe("flux.safetensors");
    expect(query.get("include_tags")).toBe("models");
  });

  it("pages on has_more until it finds the file", async () => {
    mockFetch((url) =>
      url.searchParams.get("offset") === "0"
        ? json({ assets: [{ file_path: "models/loras/other.safetensors" }], has_more: true })
        : json({ assets: [{ file_path: "models/loras/x.safetensors" }], has_more: false }),
    );
    expect(await new ComfyCloudCatalog(tmpDir, "key").hasModel("loras/x.safetensors")).toBe(true);
    expect(calls("/api/assets").map((u) => u.searchParams.get("offset"))).toEqual(["0", "500"]);
  });

  it("caches each answer, present or not, for the hour", async () => {
    mockFetch(() => json({ assets: [] }));
    let now = 5_000;
    const clock = () => now;

    expect(await new ComfyCloudCatalog(tmpDir, "key", clock).hasModel("vae/a.safetensors")).toBe(
      false,
    );
    expect(await readCache()).toMatchObject({
      models: { "models/vae/a.safetensors": { fetchedAt: 5_000, present: false } },
    });

    await new ComfyCloudCatalog(tmpDir, "key", clock).hasModel("vae/a.safetensors");
    expect(calls("/api/assets")).toHaveLength(1);

    now += HOUR;
    await new ComfyCloudCatalog(tmpDir, "key", clock).hasModel("vae/a.safetensors");
    expect(calls("/api/assets")).toHaveLength(2);
  });

  it("keeps the node index beside a model answer in one cache file", async () => {
    mockFetch((url) =>
      url.pathname === "/api/object_info"
        ? json({ KSampler: {} })
        : json({ assets: [{ file_path: "models/vae/a.safetensors" }] }),
    );
    const catalog = new ComfyCloudCatalog(tmpDir, "key", () => 1);
    await catalog.nodeClasses();
    await catalog.hasModel("vae/a.safetensors");
    expect(await readCache()).toEqual({
      nodes: { fetchedAt: 1, classes: ["KSampler"] },
      models: { "models/vae/a.safetensors": { fetchedAt: 1, present: true } },
    });
  });

  it("is COMFY_CLOUD_UNAVAILABLE on an unexpected answer", async () => {
    mockFetch(() => json({ items: [] }));
    await expect(
      new ComfyCloudCatalog(tmpDir, "key").hasModel("vae/a.safetensors"),
    ).rejects.toMatchObject({ code: "COMFY_CLOUD_UNAVAILABLE" });
  });
});
