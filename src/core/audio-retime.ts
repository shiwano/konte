import { KonteError } from "./errors.js";

// How far a tempo change may carry a take before it stops being the performance that was cast.
// Speech survives a tenth either way unheard; past that the delivery itself moves, which is the
// direction's call.
export const MAX_RETIME_RATE = 1.1;
export const MIN_RETIME_RATE = 1 / MAX_RETIME_RATE;

// The tempo a source must run at to land on `duration` — above 1 it plays faster, below 1 slower.
export function retimeRate(sourceDuration: number, duration: number): number {
  return sourceDuration / duration;
}

/**
 * The gate on a retime's tempo, read at generation time — the rate is a fact about the take, so it
 * is unknown until the source file exists.
 *
 * A `waiver` is the author's written reason to pass it, declared at the `asset()` site. It is an
 * ordinary input: it hashes into the definition, so it never outlives the take it was written for.
 */
export function assertRetimeRate(options: {
  rate: number;
  sourceDuration: number;
  duration: number;
  waiver?: string;
  where: string;
}): void {
  const { rate, sourceDuration, duration, waiver, where } = options;
  if (waiver) return;
  if (rate >= MIN_RETIME_RATE && rate <= MAX_RETIME_RATE) return;
  const percent = Math.round(Math.abs(rate - 1) * 100);
  throw new KonteError(
    "RETIME_RATE_EXCEEDED",
    `${where}: fitting a ${sourceDuration.toFixed(2)}s take into ${duration.toFixed(2)}s runs it ` +
      `at ${rate.toFixed(3)}x (${percent}% off the take), past the ±` +
      `${Math.round((MAX_RETIME_RATE - 1) * 100)}% a voice carries unheard. Widen \`duration\`, ` +
      `shorten the line, or declare \`waiver: "<reason>"\` on the asset to run it anyway.`,
  );
}

/**
 * `rate` as a chain of `atempo` filters. The filter itself is only dependable over 0.5–2.0, so a
 * waived rate outside that is split into factors that each are.
 */
export function atempoChain(rate: number): string {
  const factors: number[] = [];
  let remaining = rate;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining *= 2;
  }
  factors.push(remaining);
  return factors.map((factor) => `atempo=${factor}`).join(",");
}
