import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KonteError } from "../../core/errors.js";
import { TransientHttpError } from "../../core/http-retry.js";
import { FalBackend, encodeBackendJobId } from "../backend.js";
import type { FalStatusResponse } from "../types.js";

function makeBackend(): FalBackend {
  return new FalBackend({ apiKey: "test-key" }, "/tmp");
}

const jobId = encodeBackendJobId("fal-ai/some-model", "req-1");
const status = (s: FalStatusResponse["status"]): FalStatusResponse =>
  ({ status: s }) as FalStatusResponse;
const okResult = {
  video: { url: "https://example.com/v.mp4", file_name: "v.mp4", content_type: "video/mp4" },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FalBackend.waitForCompletion resilience", () => {
  it("keeps polling through a transient status failure and still completes", async () => {
    const backend = makeBackend();
    const getStatus = vi
      .spyOn(backend.httpClient, "getStatus")
      .mockRejectedValueOnce(new TransientHttpError("HTTP 503", { status: 503 }))
      .mockResolvedValueOnce(status("COMPLETED"));
    vi.spyOn(backend.httpClient, "getResult").mockResolvedValue(okResult);
    vi.spyOn(backend.httpClient, "downloadFile").mockResolvedValue();

    vi.useFakeTimers();
    const p = backend.waitForCompletion(jobId, "/tmp/out");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await p;

    expect(result).toEqual({
      kind: "done",
      result: expect.objectContaining({ files: [path.join("/tmp/out", "v.mp4")] }),
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("stops with timedOut on the waiter deadline — never throwing, never marking failed", async () => {
    const backend = makeBackend();
    vi.spyOn(backend.httpClient, "getStatus").mockResolvedValue(status("IN_PROGRESS"));

    vi.useFakeTimers();
    const settled = backend
      .waitForCompletion(jobId, "/tmp/out", { timeoutMs: 1000 })
      .then((r) => r)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);

    expect(await settled).toEqual({ kind: "timedOut" });
  });

  it("strips a traversal in a result file_name before writing", async () => {
    const backend = makeBackend();
    vi.spyOn(backend.httpClient, "getStatus").mockResolvedValue(status("COMPLETED"));
    vi.spyOn(backend.httpClient, "getResult").mockResolvedValue({
      video: {
        url: "https://example.com/v.mp4",
        file_name: "../../../evil.mp4",
        content_type: "video/mp4",
      },
    });
    const downloadFile = vi.spyOn(backend.httpClient, "downloadFile").mockResolvedValue();

    const result = await backend.waitForCompletion(jobId, "/tmp/out");

    const expected = path.join("/tmp/out", "evil.mp4");
    expect(downloadFile).toHaveBeenCalledWith("https://example.com/v.mp4", expected);
    expect(result).toEqual({
      kind: "done",
      result: expect.objectContaining({ files: [expected] }),
    });
  });

  it("fails a completed job whose result yields no downloadable files", async () => {
    const backend = makeBackend();
    vi.spyOn(backend.httpClient, "getStatus").mockResolvedValue(status("COMPLETED"));
    vi.spyOn(backend.httpClient, "getResult").mockResolvedValue({ unexpected_shape: "x" });
    const downloadFile = vi.spyOn(backend.httpClient, "downloadFile");

    await expect(backend.waitForCompletion(jobId, "/tmp/out")).rejects.toMatchObject({
      code: "FAL_ERROR",
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("fails fast on a permanent (non-transient) error", async () => {
    const backend = makeBackend();
    vi.spyOn(backend.httpClient, "getStatus").mockRejectedValue(
      new KonteError("FAL_ERROR", "FAL status check failed (404): gone"),
    );

    await expect(backend.waitForCompletion(jobId, "/tmp/out")).rejects.toMatchObject({
      code: "FAL_ERROR",
    });
  });

  it("flags status unconfirmed after the threshold of continuous transient failures, then clears on recovery", async () => {
    const backend = makeBackend();
    const transient = new TransientHttpError("HTTP 503", { status: 503 });
    vi.spyOn(backend.httpClient, "getStatus")
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue(status("COMPLETED"));
    vi.spyOn(backend.httpClient, "getResult").mockResolvedValue(okResult);
    vi.spyOn(backend.httpClient, "downloadFile").mockResolvedValue();
    const onUnconfirmedChange = vi.fn();

    vi.useFakeTimers();
    const p = backend.waitForCompletion(jobId, "/tmp/out", {
      unconfirmedThresholdMs: 100,
      onUnconfirmedChange,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await p;

    expect(onUnconfirmedChange).toHaveBeenCalledWith({ unconfirmed: true, lastError: "HTTP 503" });
    expect(onUnconfirmedChange).toHaveBeenCalledWith({ unconfirmed: false, lastError: null });
  });
});
