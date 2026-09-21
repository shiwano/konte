import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../file-lock.js";

let tmpDir: string;

// Poll until a condition holds. Contention makes a fixed sleep either flaky (too short) or
// slow (too long); the tests below wait on the state they actually depend on instead.
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-lock-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("executes fn and returns the result", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    const result = await withFileLock(lockPath, async () => 42);
    expect(result).toBe(42);
  });

  it("removes the lock file after completion", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    await withFileLock(lockPath, async () => {});
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("removes the lock file even when fn throws", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("serialises concurrent access", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    const order: number[] = [];

    const task = (id: number, delayMs: number) =>
      withFileLock(lockPath, async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(id);
      });

    await Promise.all([task(1, 200), task(2, 50), task(3, 50)]);

    // Each task should push its id twice consecutively (no interleaving)
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe(order[i + 1]);
    }
  }, 15_000);

  it("removes stale lock files older than 60 seconds", async () => {
    const lockPath = path.join(tmpDir, "test.lock");

    // Create a stale lock file
    await fs.writeFile(lockPath, "99999\n");
    const past = new Date(Date.now() - 61_000);
    await fs.utimes(lockPath, past, past);

    const result = await withFileLock(lockPath, async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("does not steal a lock held longer than the stale threshold (heartbeat keeps it alive)", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    // A heartbeat an order of magnitude tighter than the stale window: a scheduling hiccup
    // under load delays a refresh without letting the lock read as stale.
    const opts = { staleMs: 500, heartbeatMs: 50 };
    let waiterEntered = false;
    let ownerNonce = "";

    // Owner holds the lock across a full stale window — the span in which an unrefreshed lock
    // becomes stealable. The heartbeat must keep its mtime fresh so the waiter never steals it.
    const owner = withFileLock(
      lockPath,
      async () => {
        ownerNonce = await fs.readFile(lockPath, "utf-8");
        const heldSince = Date.now();
        await until(() => Date.now() - heldSince > opts.staleMs * 1.5);
        // Still ours: the waiter neither stole the lock nor entered the critical section.
        expect(await fs.readFile(lockPath, "utf-8")).toBe(ownerNonce);
        expect(waiterEntered).toBe(false);
        return "owner";
      },
      opts,
    );

    // The waiter must start only once the owner actually holds the lock — otherwise it can win
    // the acquire race and the test asserts against the wrong holder.
    await until(() =>
      fs.access(lockPath).then(
        () => true,
        () => false,
      ),
    );

    const waiter = withFileLock(
      lockPath,
      async () => {
        waiterEntered = true;
        return "waiter";
      },
      { ...opts, timeoutMs: 5_000 },
    );

    expect(await owner).toBe("owner");
    expect(await waiter).toBe("waiter");
  }, 15_000);

  it("a stalled owner whose lock was stolen does not delete the new owner's lock on release", async () => {
    const lockPath = path.join(tmpDir, "test.lock");
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let ownerReleased = false;
    let lockAfterOwnerRelease: string | null = null;

    // Owner stalls past staleMs with an effectively-disabled heartbeat, so its lock goes
    // stale and the waiter steals it. When the owner finally releases, it must recognise the
    // lock now carries the thief's nonce and leave it intact.
    const owner = withFileLock(
      lockPath,
      async () => {
        await sleep(400);
      },
      { staleMs: 100, heartbeatMs: 10_000 },
    ).then(() => {
      ownerReleased = true;
    });

    // Start the thief only once the owner holds the lock, so it steals rather than wins the race.
    await until(() =>
      fs.access(lockPath).then(
        () => true,
        () => false,
      ),
    );

    const thief = withFileLock(
      lockPath,
      async () => {
        while (!ownerReleased) await sleep(20);
        lockAfterOwnerRelease = await fs.readFile(lockPath, "utf-8").catch(() => null);
      },
      { staleMs: 100, heartbeatMs: 10_000, timeoutMs: 5_000 },
    );

    await Promise.all([owner, thief]);

    expect(lockAfterOwnerRelease).not.toBeNull();
    await expect(fs.access(lockPath)).rejects.toThrow();
  }, 15_000);

  it("serialises concurrent acquirers contending over a stale lock", async () => {
    const lockPath = path.join(tmpDir, "state.lock");
    const dataPath = path.join(tmpDir, "data.json");
    await fs.writeFile(dataPath, JSON.stringify({ count: 0 }));

    // Seed a stale lock that all acquirers must contend to steal.
    await fs.writeFile(lockPath, "99999\n");
    const past = new Date(Date.now() - 61_000);
    await fs.utimes(lockPath, past, past);

    const increment = () =>
      withFileLock(lockPath, async () => {
        const data = JSON.parse(await fs.readFile(dataPath, "utf-8")) as { count: number };
        data.count += 1;
        await fs.writeFile(dataPath, JSON.stringify(data));
      });

    const concurrency = 20;
    await Promise.all(Array.from({ length: concurrency }, () => increment()));

    const finalData = JSON.parse(await fs.readFile(dataPath, "utf-8")) as { count: number };
    expect(finalData.count).toBe(concurrency);
  }, 15_000);

  it(
    "concurrent withFileLock calls on shared state file produce correct results",
    { timeout: 15_000 },
    async () => {
      const lockPath = path.join(tmpDir, "state.lock");
      const dataPath = path.join(tmpDir, "data.json");
      await fs.writeFile(dataPath, JSON.stringify({ count: 0 }));

      const increment = () =>
        withFileLock(lockPath, async () => {
          const raw = await fs.readFile(dataPath, "utf-8");
          const data = JSON.parse(raw) as { count: number };
          data.count += 1;
          await fs.writeFile(dataPath, JSON.stringify(data));
        });

      const concurrency = 20;
      await Promise.all(Array.from({ length: concurrency }, () => increment()));

      const finalRaw = await fs.readFile(dataPath, "utf-8");
      const finalData = JSON.parse(finalRaw) as { count: number };
      expect(finalData.count).toBe(concurrency);
    },
  );
});
