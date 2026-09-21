import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { KonteError } from "./errors.js";
import { sleep } from "./sleep.js";

const STALE_LOCK_MS = 60_000;
const RETRY_BASE_MS = 100;
const RETRY_JITTER_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
}

// Each acquisition stamps the lock file with a unique nonce (pid + random) so a holder
// can prove ownership before removing or restoring it — a holder that stalled past staleMs
// and had its lock stolen must not later unlink the new owner's lock.
function makeNonce(): string {
  return `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
}

async function readLockNonce(lockPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(lockPath, "utf-8");
    return content.split("\n")[1] ?? null;
  } catch {
    return null;
  }
}

// Atomically remove a lock only if it is still the stale lock we observed.
// `fs.rename` is atomic, so concurrent stealers can't both move the same inode:
// the loser gets ENOENT and falls back to the normal acquire race. The winner
// re-checks the moved file's mtime to guard against a fresh lock having replaced
// the stale one in the gap; if so it puts it back rather than discarding it.
async function stealStaleLock(lockPath: string, staleMs: number): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return;
  }
  if (Date.now() - stat.mtimeMs <= staleMs) {
    return;
  }

  const asidePath = `${lockPath}.${process.pid}.stale`;
  try {
    await fs.rename(lockPath, asidePath);
  } catch {
    // Another stealer moved/removed it first, or it vanished — just retry.
    return;
  }

  try {
    const aside = await fs.stat(asidePath);
    if (Date.now() - aside.mtimeMs <= staleMs) {
      // A fresh lock replaced the stale one before we moved it aside; restore it — but only
      // if no new writer has since grabbed lockPath, since `rename` would clobber theirs.
      // The access→rename gap is a microsecond TOCTOU with no POSIX primitive that closes it
      // (rename always clobbers); accepted, because reaching it needs a lock to be stolen AND
      // re-acquired AND restored inside that gap, and the loser still re-acquires normally.
      try {
        await fs.access(lockPath);
        await fs.unlink(asidePath).catch(() => {});
      } catch {
        await fs.rename(asidePath, lockPath);
      }
      return;
    }
  } catch {
    // ignore — fall through to remove the moved-aside file
  }
  await fs.unlink(asidePath).catch(() => {});
}

async function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const nonce = makeNonce();

  while (true) {
    try {
      const fd = await fs.open(lockPath, "wx");
      await fd.write(`${process.pid}\n${nonce}\n`);
      await fd.close();
      return nonce;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    await stealStaleLock(lockPath, staleMs);

    if (Date.now() >= deadline) {
      throw new KonteError("LOCK_TIMEOUT", `Timed out waiting for lock: ${lockPath}`);
    }

    const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
    await sleep(RETRY_BASE_MS + jitter);
  }
}

async function releaseLock(lockPath: string, nonce: string): Promise<void> {
  // Only remove the lock if it still carries our nonce. If we stalled past staleMs, another
  // process may have stolen the lock and now holds it under a different nonce — unlinking it
  // would orphan their critical section and let a third writer in. The read→unlink gap is a
  // microsecond TOCTOU (POSIX has no compare-and-unlink); accepted, since hitting it means a
  // steal landing inside that gap after we already ran past staleMs.
  if ((await readLockNonce(lockPath)) !== nonce) {
    return;
  }
  try {
    await fs.unlink(lockPath);
  } catch {
    // lock may have been cleaned up externally
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  // Refresh the held lock's mtime well within staleMs so a live owner is never
  // mistaken for a dead one — otherwise a legitimately long operation would have
  // its lock stolen out from under it.
  const heartbeatMs = options.heartbeatMs ?? staleMs / 3;

  const nonce = await acquireLock(lockPath, timeoutMs, staleMs);
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lockPath, nonce);
  }
}
