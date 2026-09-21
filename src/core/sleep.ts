// The global `setTimeout`, not `node:timers/promises` — the latter is not faked by vitest's fake
// timers, which several poll/retry tests advance.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
