import { afterEach, describe, expect, it, vi } from "vitest";
import { FalHttpClient } from "../http-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FalHttpClient queue URLs", () => {
  it("submits to the endpoint and addresses the request under its app", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      const body = url.endsWith("/status?logs=1")
        ? { status: "COMPLETED" }
        : url.endsWith("/cancel")
          ? {}
          : url === "https://queue.fal.run/minimax/h3-max/text-to-video"
            ? { request_id: "r1" }
            : { video: { url: "https://cdn.example/v.mp4" } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new FalHttpClient("key");
    const endpointId = "minimax/h3-max/text-to-video";
    await client.submit(endpointId, { prompt: "p" });
    await client.getStatus(endpointId, "r1");
    await client.getResult(endpointId, "r1");
    await client.cancel(endpointId, "r1");

    expect(urls).toEqual([
      "https://queue.fal.run/minimax/h3-max/text-to-video",
      "https://queue.fal.run/minimax/h3-max/requests/r1/status?logs=1",
      "https://queue.fal.run/minimax/h3-max/requests/r1",
      "https://queue.fal.run/minimax/h3-max/requests/r1/cancel",
    ]);
  });
});
