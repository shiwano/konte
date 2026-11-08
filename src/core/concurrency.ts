import { availableParallelism } from "node:os";

// Cell and frame renders are one short-lived ffmpeg process each, so the useful width is the
// machine's, capped: past a handful the processes contend for the same cores and the sheet gets no
// faster. Bounded rather than unbounded because a full-timeline sheet is hundreds of cells.
export const FFMPEG_CONCURRENCY = Math.max(2, Math.min(8, availableParallelism()));

/**
 * Run `fn` over `items` with at most `limit` in flight, returning results in input order.
 *
 * Rejects with the first failure once the workers in flight have settled, so no process outlives
 * the call. The first failure also aborts the `signal` handed to every call.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const abort = new AbortController();
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length || failure !== undefined) return;
      try {
        results[i] = await fn(items[i]!, i, abort.signal);
      } catch (err) {
        if (failure === undefined) {
          failure = err ?? new Error("unknown failure");
          abort.abort();
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure;
  return results;
}
