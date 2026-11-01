import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FalHttpClient } from "../http-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(handler: () => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => handler());
}

const unreachable = () => {
  throw new TypeError("fetch failed");
};

describe("FalHttpClient errors", () => {
  it("is FAL_UNAUTHORIZED when fal rejects the key", async () => {
    mockFetch(() => json({ detail: "bad key" }, 401));
    const client = new FalHttpClient("key");

    await expect(client.submit("a/b", {})).rejects.toMatchObject({ code: "FAL_UNAUTHORIZED" });
    await expect(client.getStatus("a/b", "r1")).rejects.toMatchObject({
      code: "FAL_UNAUTHORIZED",
    });
    await expect(client.cancel("a/b", "r1")).rejects.toMatchObject({ code: "FAL_UNAUTHORIZED" });
  });

  it("is SUBMISSION_UNCONFIRMED when a submit cannot be sent or answers 5xx", async () => {
    const client = new FalHttpClient("key");

    mockFetch(unreachable);
    await expect(client.submit("a/b", {})).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
    });

    mockFetch(() => json({}, 503));
    await expect(client.submit("a/b", {})).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
    });
  });

  it("types a cancel or upload that cannot be sent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-fal-errors-"));
    try {
      const filePath = path.join(tmpDir, "in.png");
      await fs.writeFile(filePath, "png");
      mockFetch(unreachable);
      const client = new FalHttpClient("key");

      await expect(client.cancel("a/b", "r1")).rejects.toMatchObject({ code: "FAL_ERROR" });
      await expect(client.uploadFile(filePath)).rejects.toMatchObject({
        code: "FAL_UPLOAD_FAILED",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
