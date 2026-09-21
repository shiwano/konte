import { afterEach, describe, expect, it, vi } from "vitest";
import { KonteError } from "../errors.js";
import { pollUntilTerminal, TransientPollError } from "../poll-until-terminal.js";

// pollIntervalMs:0 / maxBackoffMs:0 make sleeps resolve on the next tick, so these
// run in real time without needing fake timers.
const fast = { pollIntervalMs: 0, maxBackoffMs: 0 };

describe("pollUntilTerminal", () => {
  it("returns the result on an immediate done", async () => {
    const result = await pollUntilTerminal(async () => ({ state: "done", result: 42 }), fast);
    expect(result).toEqual({ kind: "done", value: 42 });
  });

  it("polls through pending then done, reporting progress", async () => {
    const onProgress = vi.fn();
    const observe = vi
      .fn()
      .mockResolvedValueOnce({ state: "pending", progress: { value: 50, max: 100 } })
      .mockResolvedValueOnce({ state: "done", result: "ok" });

    const result = await pollUntilTerminal(observe, { ...fast, onProgress });

    expect(result).toEqual({ kind: "done", value: "ok" });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith({ value: 50, max: 100 });
  });

  it("keeps polling through a TransientPollError, then completes", async () => {
    const observe = vi
      .fn()
      .mockRejectedValueOnce(new TransientPollError("blip"))
      .mockResolvedValueOnce({ state: "done", result: "ok" });

    const result = await pollUntilTerminal(observe, fast);

    expect(result).toEqual({ kind: "done", value: "ok" });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-transient error as a terminal failure", async () => {
    const observe = vi.fn().mockRejectedValue(new KonteError("FAL_ERROR", "real failure"));

    await expect(pollUntilTerminal(observe, fast)).rejects.toMatchObject({ code: "FAL_ERROR" });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("returns timedOut (never throws) once the deadline has passed", async () => {
    const observe = vi.fn().mockResolvedValue({ state: "pending" });

    const result = await pollUntilTerminal(observe, { ...fast, deadline: Date.now() - 1 });

    expect(result).toEqual({ kind: "timedOut" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("returns cancelled (never throws) when shouldCancel returns true", async () => {
    const observe = vi.fn().mockResolvedValue({ state: "pending" });

    const result = await pollUntilTerminal(observe, { ...fast, shouldCancel: () => true });

    expect(result).toEqual({ kind: "cancelled" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("flags status unconfirmed on sustained transient failures and clears on recovery", async () => {
    const onUnconfirmedChange = vi.fn();
    const observe = vi
      .fn()
      .mockRejectedValueOnce(new TransientPollError("HTTP 503"))
      .mockResolvedValueOnce({ state: "done", result: undefined });

    await pollUntilTerminal(observe, { ...fast, unconfirmedThresholdMs: 0, onUnconfirmedChange });

    expect(onUnconfirmedChange).toHaveBeenNthCalledWith(1, {
      unconfirmed: true,
      lastError: "HTTP 503",
    });
    expect(onUnconfirmedChange).toHaveBeenNthCalledWith(2, {
      unconfirmed: false,
      lastError: null,
    });
  });

  describe("unreachableTimeout", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("throws the caller's error once nothing has been observable for that long", async () => {
      const observe = vi.fn().mockRejectedValue(new TransientPollError("connection refused"));
      const toError = vi.fn(
        ({ lastError }: { sinceMs: number; lastError: string }) =>
          new KonteError("COMFYUI_UNAVAILABLE", `gave up: ${lastError}`),
      );

      await expect(
        pollUntilTerminal(observe, { ...fast, unreachableTimeout: { afterMs: 0, toError } }),
      ).rejects.toThrow("gave up: connection refused");
      // A thrown error, not a returned outcome — so it commits as a job failure like any other.
      expect(toError).toHaveBeenCalledWith({
        sinceMs: expect.any(Number),
        lastError: "connection refused",
      });
    });

    // The ceiling measures CONSECUTIVE unobservability, so a successful check has to move the
    // clock back to zero. Without that reset a job on a flaky link accumulates blips until it is
    // failed, even though the backend keeps answering in between.
    it("restarts its window after every successful observation", async () => {
      // The ceiling is read off Date.now(), so drive that rather than sleeping: a real 30ms
      // wait against a 50ms ceiling leaves 20ms of scheduler jitter to fail on.
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      // Two runs of 30ms: each under the ceiling alone, over it if the clock never reset.
      const failAfter = async (ms: number): Promise<never> => {
        now += ms;
        throw new TransientPollError("connection refused");
      };
      const observe = vi
        .fn()
        .mockImplementationOnce(() => failAfter(30))
        .mockResolvedValueOnce({ state: "pending" })
        .mockImplementationOnce(() => failAfter(30))
        .mockResolvedValueOnce({ state: "done", result: "ok" });

      const result = await pollUntilTerminal(observe, {
        ...fast,
        unreachableTimeout: {
          afterMs: 50,
          toError: () => new Error("gave up despite the backend answering"),
        },
      });

      expect(result).toEqual({ kind: "done", value: "ok" });
      expect(observe).toHaveBeenCalledTimes(4);
    });

    it("does not fire while the backend is answering, however long the job runs", async () => {
      const observe = vi
        .fn()
        .mockResolvedValueOnce({ state: "pending" })
        .mockResolvedValueOnce({ state: "pending" })
        .mockResolvedValueOnce({ state: "done", result: "ok" });

      const result = await pollUntilTerminal(observe, {
        ...fast,
        unreachableTimeout: { afterMs: 0, toError: () => new Error("must not fire") },
      });

      expect(result).toEqual({ kind: "done", value: "ok" });
    });

    // The default for every cloud backend: their jobs outlive an outage, so nothing may end the
    // polling but a real verdict.
    it("polls on indefinitely when unset", async () => {
      const observe = vi
        .fn()
        .mockRejectedValueOnce(new TransientPollError("blip"))
        .mockRejectedValueOnce(new TransientPollError("blip"))
        .mockResolvedValueOnce({ state: "done", result: "ok" });

      const result = await pollUntilTerminal(observe, { ...fast, unconfirmedThresholdMs: 0 });

      expect(result).toEqual({ kind: "done", value: "ok" });
    });
  });
});
