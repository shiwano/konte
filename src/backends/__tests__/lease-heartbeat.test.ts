import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobManager } from "../../core/job-manager.js";
import { startLeaseHeartbeat } from "../lease-heartbeat.js";

// RUN_LEASE_HEARTBEAT_MS is 20s; drive it with fake timers.
const TICK = 20_000;

describe("startLeaseHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renews on each tick while the owner still holds the lease", async () => {
    const renewLease = vi.fn().mockResolvedValue(true);
    const stop = startLeaseHeartbeat({ renewLease } as unknown as JobManager, "id", "w");

    await vi.advanceTimersByTimeAsync(TICK);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(renewLease).toHaveBeenCalledTimes(2);
    stop();
  });

  it("self-terminates once renewLease returns false (lost ownership / not running)", async () => {
    const renewLease = vi.fn().mockResolvedValue(false);
    startLeaseHeartbeat({ renewLease } as unknown as JobManager, "id", "w");

    await vi.advanceTimersByTimeAsync(TICK);
    expect(renewLease).toHaveBeenCalledTimes(1);
    // Even without an explicit stop(), it must not keep renewing.
    await vi.advanceTimersByTimeAsync(TICK * 5);
    expect(renewLease).toHaveBeenCalledTimes(1);
  });

  it("stop() halts renewals and is idempotent", async () => {
    const renewLease = vi.fn().mockResolvedValue(true);
    const stop = startLeaseHeartbeat({ renewLease } as unknown as JobManager, "id", "w");

    stop();
    stop(); // no throw on repeat
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(renewLease).not.toHaveBeenCalled();
  });

  it("survives a renewLease that rejects, without crashing the interval", async () => {
    const renewLease = vi.fn().mockRejectedValue(new Error("io"));
    const stop = startLeaseHeartbeat({ renewLease } as unknown as JobManager, "id", "w");

    await vi.advanceTimersByTimeAsync(TICK);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(renewLease).toHaveBeenCalledTimes(2);
    stop();
  });
});
