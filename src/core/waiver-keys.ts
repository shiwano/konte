// The namespace a stage's `waivers` record is keyed in: `<code>:<hash>`, the code naming the finding
// class and the hash pinning the one finding inside it. Every stage check writes its keys here: a key
// is judged against the whole namespace, so a pin waiver is not an unknown key to the prompt gate.

import { createHash } from "node:crypto";

/**
 * Fixed contract, like KonteErrorCode: waiver keys are written against these. The prefix names the
 * check that owns the class — `prompt-*` in prompt-check.ts, `pin-*` in pin-check.ts.
 */
export const STAGE_FINDING_CODES = [
  "prompt-negation",
  "prompt-not-yet",
  "prompt-double-negative",
  "pin-unanchored",
] as const;

export type StageFindingCode = (typeof STAGE_FINDING_CODES)[number];

// Hashes `text` verbatim. Folding case here would be right for a phrase and wrong for an address —
// an asset name may carry uppercase, so `reference:Hero` and `reference:hero` are two assets, and one
// waiver must not cancel the other. A class that keys on prose normalizes before it calls.
export function waiverKey(code: StageFindingCode, text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `${code}:${hash}`;
}

export function waiverKeyCode(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

// The keys whose code half names no class at all — a typo that can never cancel anything.
export function unknownWaiverKeys(waivers: Readonly<Record<string, string>>): string[] {
  const codes: readonly string[] = STAGE_FINDING_CODES;
  return Object.keys(waivers).filter((key) => !codes.includes(waiverKeyCode(key)));
}
