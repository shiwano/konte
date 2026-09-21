import { describe, expect, it, vi } from "vitest";
import { createPageLifecycle } from "../lifecycle.js";

// The reported gap: `konte preview` exited without naming the record a submit had just written.
// Bun's stop() lets an in-flight handler run on, so a shutdown triggered mid-submit reported the
// session before the submit had reported itself — the record landed unnamed.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("page lifecycle — shutdown drain", () => {
  it("reports only after tracked work finishes, so a mid-submit close still names the record", async () => {
    let outcome: string | null = null;
    const reported: Array<string | null> = [];
    const lifecycle = createPageLifecycle({
      autoClose: true,
      onShutdown: () => {
        reported.push(outcome);
      },
    });
    const stop = vi.fn();
    lifecycle.attach({ stop });

    const submit = deferred<void>();
    const inFlight = lifecycle.track(async () => {
      await submit.promise;
      outcome = "review/video/records/20260816T164357280.json";
    });

    lifecycle.triggerShutdown();
    await Promise.resolve();
    expect(reported).toEqual([]);
    // Stopped up front, so nothing new can start work the drain would then miss.
    expect(stop).toHaveBeenCalledOnce();

    submit.resolve();
    await inFlight;
    await lifecycle.shutdown;

    expect(reported).toEqual(["review/video/records/20260816T164357280.json"]);
  });

  it("waits for work that starts while it is already draining", async () => {
    const finished: string[] = [];
    const lifecycle = createPageLifecycle({
      autoClose: true,
      onShutdown: () => {
        finished.push("reported");
      },
    });
    lifecycle.attach({ stop: () => {} });

    const first = deferred<void>();
    const second = deferred<void>();
    const a = lifecycle.track(async () => {
      await first.promise;
      finished.push("a");
    });
    lifecycle.triggerShutdown();
    const b = lifecycle.track(async () => {
      await second.promise;
      finished.push("b");
    });

    first.resolve();
    await a;
    await Promise.resolve();
    expect(finished).toEqual(["a"]);

    second.resolve();
    await b;
    await lifecycle.shutdown;

    expect(finished).toEqual(["a", "b", "reported"]);
  });

  it("says it is shutting down, so a write route can turn a late request away", async () => {
    const lifecycle = createPageLifecycle({ autoClose: true });
    lifecycle.attach({ stop: () => {} });
    expect(lifecycle.isShuttingDown()).toBe(false);

    const held = deferred<void>();
    const work = lifecycle.track(() => held.promise);
    lifecycle.triggerShutdown();

    // True from the trigger, not from the drain finishing: the whole point is that the window in
    // between is when a stray request would slip in.
    expect(lifecycle.isShuttingDown()).toBe(true);

    held.resolve();
    await work;
    await lifecycle.shutdown;
  });

  it("reports the timeout, so a cut-short submit is not read as a clean end", async () => {
    const reported: boolean[] = [];
    const lifecycle = createPageLifecycle({
      autoClose: true,
      drainTimeoutMs: 10,
      onShutdown: ({ drainTimedOut }) => {
        reported.push(drainTimedOut);
      },
    });
    lifecycle.attach({ stop: () => {} });

    void lifecycle.track(() => new Promise<void>(() => {}));
    lifecycle.triggerShutdown();

    await expect(lifecycle.shutdown).resolves.toEqual({ drainTimedOut: true });
    expect(reported).toEqual([true]);
  });

  it("settles the shutdown even when the report throws", async () => {
    const stop = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const lifecycle = createPageLifecycle({
      autoClose: true,
      onShutdown: () => {
        throw new Error("report failed");
      },
    });
    lifecycle.attach({ stop });

    lifecycle.triggerShutdown();

    await expect(lifecycle.shutdown).resolves.toEqual({ drainTimedOut: false });
    expect(stop).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("gives up on a handler that never finishes rather than holding the session open", async () => {
    const lifecycle = createPageLifecycle({ autoClose: true, drainTimeoutMs: 10 });
    lifecycle.attach({ stop: () => {} });

    void lifecycle.track(() => new Promise<void>(() => {}));
    lifecycle.triggerShutdown();

    await expect(lifecycle.shutdown).resolves.toEqual({ drainTimedOut: true });
  });

  it("still reports when a tracked handler throws", async () => {
    const reported: string[] = [];
    const lifecycle = createPageLifecycle({
      autoClose: true,
      onShutdown: () => {
        reported.push("shutdown");
      },
    });
    lifecycle.attach({ stop: () => {} });

    const failing = lifecycle.track(async () => {
      throw new Error("submit failed");
    });
    await expect(failing).rejects.toThrow("submit failed");

    lifecycle.triggerShutdown();
    await lifecycle.shutdown;

    expect(reported).toEqual(["shutdown"]);
  });
});
