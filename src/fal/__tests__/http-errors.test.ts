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
    const client = new FalHttpClient(() => "key");

    await expect(client.submit("a/b", {})).rejects.toMatchObject({ code: "FAL_UNAUTHORIZED" });
    await expect(client.getStatus("a/b", "r1")).rejects.toMatchObject({
      code: "FAL_UNAUTHORIZED",
    });
    await expect(client.cancel("a/b", "r1")).rejects.toMatchObject({ code: "FAL_UNAUTHORIZED" });
  });

  it("sends the key the reader holds at each request", async () => {
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(new Headers(init?.headers).get("Authorization") ?? "");
      return json({ status: "IN_QUEUE" });
    });
    let key = "old";
    const client = new FalHttpClient(() => key);

    await client.getStatus("a/b", "r1");
    key = "new";
    await client.getStatus("a/b", "r1");

    expect(sent).toEqual(["Key old", "Key new"]);
  });

  it("is SUBMISSION_UNCONFIRMED when a submit cannot be sent or answers 5xx", async () => {
    const client = new FalHttpClient(() => "key");

    mockFetch(unreachable);
    await expect(client.submit("a/b", {})).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
    });

    mockFetch(() => json({}, 503));
    await expect(client.submit("a/b", {})).rejects.toMatchObject({
      code: "SUBMISSION_UNCONFIRMED",
    });
  });

  it("is SUBMISSION_UNCONFIRMED when an accepted submit's answer cannot be read", async () => {
    const client = new FalHttpClient(() => "key");
    const interrupted = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200 },
      );

    for (const answer of [
      () => json({ id: "r1" }),
      () => new Response("<html>", { status: 200 }),
      interrupted,
    ]) {
      mockFetch(answer);
      await expect(client.submit("a/b", {})).rejects.toMatchObject({
        code: "SUBMISSION_UNCONFIRMED",
      });
    }
  });

  it("types a cancel or upload that cannot be sent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-fal-errors-"));
    try {
      const filePath = path.join(tmpDir, "in.png");
      await fs.writeFile(filePath, "png");
      mockFetch(unreachable);
      const client = new FalHttpClient(() => "key");

      await expect(client.cancel("a/b", "r1")).rejects.toMatchObject({ code: "FAL_ERROR" });
      await expect(client.uploadFile(filePath)).rejects.toMatchObject({
        code: "FAL_UPLOAD_FAILED",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
