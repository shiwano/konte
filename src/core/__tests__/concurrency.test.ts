import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../concurrency.js";

describe("mapConcurrent", () => {
  it("returns results in input order", async () => {
    const out = await mapConcurrent([5, 1, 3], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6]);
  });

  it("keeps at most `limit` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    );
    expect(peak).toBe(3);
  });

  it("rejects with the first failure and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(
      mapConcurrent([0, 1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(started).toEqual([0, 1, 2]);
  });

  it("handles an empty input", async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
  });
});
