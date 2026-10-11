// The pin check: the machine floor under what a frame-pinning input is wired to. A `pin` input is
// reproduced pixel for pixel, so what it takes has to be a frame of the piece's own picture — the
// board panel the shot develops, the seam frame of the segment before it. A reference sheet is
// conditioning: pinned, the take opens on a character sheet. Free of any DSL/runtime import (like
// prompt-check.ts) so the gate, status and unit tests can pull it in standalone.

import { tryParseAddress } from "./address.js";
import { KonteError } from "./errors.js";
import { waiverKey, type StageFindingCode } from "./waiver-keys.js";

/**
 * The class this check reports, its slice of the waiver namespace (see waiver-keys.ts).
 *   - pin-unanchored: the pinned image is a reference sheet.
 */
export type PinFindingCode = Extract<StageFindingCode, `pin-${string}`>;

// One `pin` input's wiring, as declared at one address. `source` is the address it was passed, never
// what that resolves to.
export type PinOccurrence = {
  address: string;
  input: string;
  pin: "start" | "end";
  // Absent where the adapter declares the slot and the author passed nothing. `join-unpinned` reads
  // those to tell a model that CANNOT carry a seam from one whose author did not; every other reader
  // is about what a pin points at, and skips them.
  source?: string;
  // How long the take at `address` is, where its adapter declares the length, and where in it an end
  // image lands — the frame index a workflow anchors it at, else the take's last frame. What says
  // whether a composition that plays the take cuts on the landing.
  clip?: { sec: number; frameSec: number; landsAt: number };
};

// The unit is the pinned SOURCE: one sheet pinned across thirty shots is one finding listing thirty
// sites.
export type PinFinding = {
  code: PinFindingCode;
  key: string;
  source: string;
  sites: readonly { address: string; input: string; pin: "start" | "end" }[];
};

type PinStaleWaiver = { key: string; reason: string };

type PinCheckResult = {
  active: PinFinding[];
  waived: PinFinding[];
  // A waiver whose source is no longer pinned. Unknown keys are not reported here — the prompt check
  // judges them against the whole namespace.
  staleWaivers: PinStaleWaiver[];
};

export function pinWaiverKey(code: PinFindingCode, source: string): string {
  return waiverKey(code, source);
}

// Whether the pinned address is a reference sheet rather than a frame of the picture. A source that
// parses to no address at all is a local file — footage, a still handed over whole — and is a frame.
function isSheet(source: string): boolean {
  const parsed = tryParseAddress(source);
  return parsed?.stage === "reference" && parsed.kind === "reference";
}

// Reports findings; it never throws and never decides severity — the caller (the spend gate,
// status) owns waivers and abort policy.
export function checkPins(
  occurrences: readonly PinOccurrence[],
  waivers: Readonly<Record<string, string>> = {},
): PinCheckResult {
  const byKey = new Map<string, PinFinding & { sites: PinFinding["sites"][number][] }>();
  for (const occurrence of occurrences) {
    if (occurrence.source === undefined) continue;
    if (!isSheet(occurrence.source)) continue;
    const key = pinWaiverKey("pin-unanchored", occurrence.source);
    const site = { address: occurrence.address, input: occurrence.input, pin: occurrence.pin };
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.sites.some((s) => s.address === site.address && s.input === site.input)) {
        existing.sites.push(site);
      }
      continue;
    }
    byKey.set(key, {
      code: "pin-unanchored",
      key,
      source: occurrence.source,
      sites: [site],
    });
  }

  const active: PinFinding[] = [];
  const waived: PinFinding[] = [];
  for (const finding of byKey.values()) {
    (finding.key in waivers ? waived : active).push(finding);
  }

  const staleWaivers: PinStaleWaiver[] = [];
  for (const [key, reason] of Object.entries(waivers)) {
    if (key.slice(0, key.indexOf(":")) !== "pin-unanchored") continue;
    if (!byKey.has(key)) staleWaivers.push({ key, reason });
  }

  return { active, waived, staleWaivers };
}

const SITE_DISPLAY_LIMIT = 3;

export function formatPinFinding(finding: PinFinding): string {
  const sites = finding.sites.map((s) => `${s.address}.${s.input}`);
  const shown = sites.slice(0, SITE_DISPLAY_LIMIT).join(", ");
  const hidden = sites.length - SITE_DISPLAY_LIMIT;
  return `${finding.source} — ${shown}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

// What a stage or a patch declares for the check to read: the pins it wired, and the waivers
// standing against them.
export type PinCheckSubject = {
  pins?: readonly PinOccurrence[];
  waivers?: Readonly<Record<string, string>>;
};

const REMEDY =
  "a sheet is conditioning, not a frame — pass it as an ordinary reference input and pin the board panel this shot develops";

// The gate: abort with PIN_CHECK_FAILED when a take about to be spent on pins a frame that is not
// one. `where` is the file that holds both the wiring and its waivers.
export function assertPinGate(subject: PinCheckSubject, where: string): void {
  const { active } = checkPins(subject.pins ?? [], subject.waivers ?? {});
  if (active.length === 0) return;

  const blocks = [
    `  ${REMEDY}:\n${active.map((f) => `    [${f.key}] ${formatPinFinding(f)}`).join("\n")}`,
  ];

  throw new KonteError(
    "PIN_CHECK_FAILED",
    `${where} pins ${active.length} image(s) that are not frames of the picture. A pinned image is ` +
      `reproduced pixel for pixel, so it has to be a frame the piece actually shows. Fix each, or ` +
      `add a reason to \`waivers\` in ${where} when the take is meant to open on it`,
    blocks,
  );
}
