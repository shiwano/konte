import { sleep } from "./sleep.js";

/**
 * A transient communication failure during polling — a network error, a 5xx, a brief
 * outage. It does NOT mean the polled job failed; the job is still running. `observe`
 * throws this to tell `pollUntilTerminal` to keep waiting instead of failing the job.
 * `TransientHttpError` extends it, so a polled GET via `fetchWithRetry` is transient too.
 */
export class TransientPollError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TransientPollError";
  }
}

type PollOutcome<T> =
  | { state: "pending"; progress?: { value: number; max: number; node?: string } }
  | { state: "done"; result: T };

// The result of pollUntilTerminal. `timedOut` (the waiter's own deadline elapsed) and
// `cancelled` (shouldCancel returned true) are NOT failures — they are returned values, never
// thrown, so a caller's `catch` can only ever see a genuine terminal error. This is what makes
// "I stopped waiting" structurally impossible to commit as a job failure.
type PollResult<T> = { kind: "done"; value: T } | { kind: "timedOut" } | { kind: "cancelled" };

interface PollUntilTerminalOptions {
  // Absolute timestamp this waiter stops blocking at. Undefined = wait until the job
  // reaches a terminal state (the cloud watchers pass none; only `--timeout` sets it).
  deadline?: number;
  pollIntervalMs?: number;
  unconfirmedThresholdMs?: number;
  maxBackoffMs?: number;
  shouldCancel?: () => boolean | Promise<boolean>;
  onProgress?: (p: { value: number; max: number; node?: string }) => void;
  onLog?: (line: string) => void;
  onUnconfirmedChange?: (info: { unconfirmed: boolean; lastError: string | null }) => void;
  // A ceiling on total unobservability: after `afterMs` with no successful check, stop polling by
  // throwing what `toError` returns — a real terminal error, committed as a job failure.
  //
  // Omitted by default, and every cloud backend leaves it so: their jobs run on infrastructure
  // that outlives the outage and stay re-observable by id, so "I cannot reach the API" is never a
  // verdict on the job. It is set only where the job CANNOT survive — a ComfyUI prompt lives in
  // the server process and its queue is in memory, so a server silent this long has taken the
  // prompt with it, and polling on waits for something that can never land.
  unreachableTimeout?: {
    afterMs: number;
    toError: (info: { sinceMs: number; lastError: string }) => Error;
  };
  // Identifier woven into the "status unconfirmed" log line, e.g. "request abc" / "prompt xyz".
  label?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
// A status check is just observation; a transient failure doesn't mean the job died.
// Keep polling, but after this long with no successful check, flag the status unconfirmed
// so a human can notice (e.g. a backend outage) — without ever marking the live job failed.
const DEFAULT_UNCONFIRMED_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * The one poll loop every remote/async backend shares (fal, ComfyUI's HTTP
 * fallback, ComfyUI model installs). It owns the contract the unified model promises:
 *
 * - A terminal verdict comes ONLY from `observe` returning `{state:"done"}` or throwing a
 *   real (non-transient) error — never from the waiter's patience running out.
 * - A `TransientPollError` from `observe` means "couldn't observe", so keep polling with
 *   capped exponential backoff; after `unconfirmedThresholdMs` of that, flag the status
 *   unconfirmed (still polling). Only an opt-in `unreachableTimeout` ends that polling, and
 *   only for a backend whose job provably cannot outlive the outage.
 * - `deadline` bounds only how long THIS waiter blocks — on expiry it RETURNS `{kind:"timedOut"}`
 *   (a stop, not a failure), leaving the job re-observable. It is a value, never an exception,
 *   so it cannot be caught-and-failed.
 * - `shouldCancel` returning true RETURNS `{kind:"cancelled"}`.
 *
 * `observe` does one poll: returns pending/done, throws `TransientPollError` for a transient
 * comms failure, or throws anything else for a genuine terminal failure (surfaced as-is).
 */
export async function pollUntilTerminal<T>(
  observe: () => Promise<PollOutcome<T>>,
  options: PollUntilTerminalOptions = {},
): Promise<PollResult<T>> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const unconfirmedThresholdMs = options.unconfirmedThresholdMs ?? DEFAULT_UNCONFIRMED_THRESHOLD_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const { deadline, shouldCancel, onProgress, onLog, onUnconfirmedChange, unreachableTimeout } =
    options;
  const where = options.label ? ` (${options.label})` : "";

  let lastOkPollAt = Date.now();
  let unconfirmed = false;
  let transientStreak = 0;

  while (true) {
    if (shouldCancel && (await shouldCancel())) {
      return { kind: "cancelled" };
    }
    // The deadline bounds only how long THIS waiter blocks — not the job's fate.
    if (deadline && Date.now() > deadline) {
      return { kind: "timedOut" };
    }

    let outcome: PollOutcome<T>;
    try {
      outcome = await observe();
    } catch (err) {
      // A real (permanent) error is a genuine failure; surface it untouched.
      if (!(err instanceof TransientPollError)) throw err;
      // Transient: the job is still running. Keep polling.
      transientStreak++;
      const msg = err.message;
      if (transientStreak === 1) {
        onLog?.(`Status check failed transiently (${msg}); still polling.`);
      }
      const unobservableForMs = Date.now() - lastOkPollAt;
      if (!unconfirmed && unobservableForMs >= unconfirmedThresholdMs) {
        unconfirmed = true;
        onLog?.(
          `No successful status check for ${Math.round(unobservableForMs / 60_000)}m; ` +
            `flagging status unconfirmed but still polling${where}.`,
        );
        onUnconfirmedChange?.({ unconfirmed: true, lastError: msg });
      }
      // The one transient case that IS terminal — see `unreachableTimeout`. Thrown, not returned,
      // so it travels the same path as any other real failure and commits as one.
      if (unreachableTimeout && unobservableForMs >= unreachableTimeout.afterMs) {
        throw unreachableTimeout.toError({ sinceMs: unobservableForMs, lastError: msg });
      }
      await sleep(Math.min(pollIntervalMs * 2 ** (transientStreak - 1), maxBackoffMs));
      continue;
    }

    lastOkPollAt = Date.now();
    transientStreak = 0;
    if (unconfirmed) {
      unconfirmed = false;
      onLog?.("Status check recovered; clearing unconfirmed flag.");
      onUnconfirmedChange?.({ unconfirmed: false, lastError: null });
    }

    if (outcome.state === "done") return { kind: "done", value: outcome.result };
    if (outcome.progress) onProgress?.(outcome.progress);
    await sleep(pollIntervalMs);
  }
}
