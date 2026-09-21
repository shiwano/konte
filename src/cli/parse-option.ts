import { KonteError } from "../core/errors.js";

// Commander hands option values through as raw strings; parse them here so a
// malformed value (e.g. `--count abc`, `--timeout 5m`) fails loudly with a typed
// error instead of becoming NaN and silently disabling the behavior it controls.
export function parsePositiveInt(value: string, optionName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new KonteError(
      "INVALID_OPTION",
      `Invalid ${optionName} "${value}": expected a positive integer`,
    );
  }
  return n;
}

// Parse a numeric CLI option, throwing INVALID_OPTION on a non-number rather than silently passing
// NaN downstream (which would yield a broken tile spec, an inverted window, or a bad frame count).
export function parseNumberOption(
  flag: string,
  raw: string | undefined,
  opts: { integer?: boolean; min?: number; max?: number },
): number | undefined {
  if (raw == null) return undefined;
  // Number() (not parseFloat/parseInt) so trailing garbage like "10abc" or "0.5x" is rejected
  // rather than silently truncated; treat empty/whitespace as invalid too.
  const trimmed = raw.trim();
  const n = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n))) {
    throw new KonteError(
      "INVALID_OPTION",
      `${flag} must be ${opts.integer ? "an integer" : "a number"}, got "${raw}"`,
    );
  }
  if (opts.min != null && n < opts.min) {
    throw new KonteError("INVALID_OPTION", `${flag} must be ≥ ${opts.min}, got ${n}`);
  }
  if (opts.max != null && n > opts.max) {
    throw new KonteError("INVALID_OPTION", `${flag} must be ≤ ${opts.max}, got ${n}`);
  }
  return n;
}
