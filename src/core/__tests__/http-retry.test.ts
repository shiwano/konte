import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, TransientHttpError } from "../http-retry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const noWait = { initialDelayMs: 0, maxDelayMs: 0 };

describe("fetchWithRetry", () => {
  it("returns immediately on a successful response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const res = await fetchWithRetry("https://example.test", undefined, noWait);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await fetchWithRetry("https://example.test", undefined, noWait);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown network error then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await fetchWithRetry("https://example.test", undefined, noWait);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient 404", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 404 }));

    const res = await fetchWithRetry("https://example.test", undefined, noWait);

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TransientHttpError after exhausting retries on persistent 500", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("down", { status: 500 }));

    await expect(
      fetchWithRetry("https://example.test", undefined, { ...noWait, maxRetries: 2 }),
    ).rejects.toMatchObject({ name: "TransientHttpError", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws TransientHttpError after exhausting retries on a persistent network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const err = await fetchWithRetry("https://example.test", undefined, {
      ...noWait,
      maxRetries: 2,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TransientHttpError);
    expect(err.message).toBe("network down");
    expect(err.status).toBeNull();
  });

  it("classifies in a single attempt when maxRetries is 0", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("busy", { status: 503 }));

    await expect(
      fetchWithRetry("https://example.test", undefined, { maxRetries: 0 }),
    ).rejects.toBeInstanceOf(TransientHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an attempt that exceeds timeoutMs and treats it as transient", async () => {
    // A hung connection that never responds: it only settles when its signal aborts.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });

    await expect(
      fetchWithRetry("https://example.test", undefined, {
        ...noWait,
        maxRetries: 1,
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(TransientHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates an external abort instead of retrying it", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });

    const p = fetchWithRetry(
      "https://example.test",
      { signal: controller.signal },
      { ...noWait, maxRetries: 3 },
    );
    controller.abort(new Error("cancelled"));

    await expect(p).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports each retry through onRetry", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const onRetry = vi.fn();
    await fetchWithRetry("https://example.test", undefined, { ...noWait, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, reason: "HTTP 429" }),
    );
  });
});
