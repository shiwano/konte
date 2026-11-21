// The pin check: the machine floor under what a frame-pinning input is wired to. A `pin` input is
// reproduced pixel for pixel, so what it takes has to be a frame of the piece's own picture — the
// board panel the shot develops, the seam frame of the segment before it. A reference sheet and a
// plate are conditioning: pinned, the take opens on a character sheet or on an empty room. Free of
// any DSL/runtime import (like prompt-check.ts) so the gate, status and unit tests can pull it in
// standalone.

import type { PinOccurrence } from "./types/stage-build.js";
import { tryParseAddress } from "./address.js";
import type { Finding, SourceFile } from "./finding.js";

/**
 * The code this check reports.
 *   - pin-unanchored: the pinned image is a reference sheet or a plate.
 */
export type PinFindingCode = "pin-unanchored";

// What a pinned address turns out to be, when it is not a frame.
type PinSubject = "sheet" | "plate";

// The unit is the pinned SOURCE: one sheet pinned across thirty shots is one finding listing thirty
// sites.
export type PinFinding = {
  code: PinFindingCode;
  source: string;
  subject: PinSubject;
  sites: readonly { address: string; input: string; pin: "start" | "end" }[];
};

// What the pinned address is, when it is not a frame of the picture. A source that parses to no
// address at all is a local file — footage, a still handed over whole — and is a frame.
function subjectOf(source: string): PinSubject | undefined {
  const parsed = tryParseAddress(source);
  if (!parsed) return undefined;
  if (parsed.stage === "reference" && parsed.kind === "reference") return "sheet";
  if (parsed.kind === "plate") return "plate";
  return undefined;
}

// Reports findings; it never throws and never decides severity — the gates own that.
export function checkPins(occurrences: readonly PinOccurrence[]): PinFinding[] {
  const bySource = new Map<string, PinFinding & { sites: PinFinding["sites"][number][] }>();
  for (const occurrence of occurrences) {
    if (occurrence.source === undefined) continue;
    const subject = subjectOf(occurrence.source);
    if (!subject) continue;
    const site = { address: occurrence.address, input: occurrence.input, pin: occurrence.pin };
    const existing = bySource.get(occurrence.source);
    if (existing) {
      if (!existing.sites.some((s) => s.address === site.address && s.input === site.input)) {
        existing.sites.push(site);
      }
      continue;
    }
    bySource.set(occurrence.source, {
      code: "pin-unanchored",
      source: occurrence.source,
      subject,
      sites: [site],
    });
  }
  return [...bySource.values()];
}

const SITE_DISPLAY_LIMIT = 3;

function formatSites(finding: PinFinding): string {
  const sites = finding.sites.map((s) => `${s.address}.${s.input}`);
  const shown = sites.slice(0, SITE_DISPLAY_LIMIT).join(", ");
  const hidden = sites.length - SITE_DISPLAY_LIMIT;
  return `${shown}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

// What a stage or a patch declares for the check to read: the pins it wired.
export type PinCheckSubject = {
  pins?: readonly PinOccurrence[];
};

const SUBJECT_NOUN: Record<PinSubject, string> = {
  sheet: "a reference sheet",
  plate: "a plate",
};

// The findings in the pins `subject` wires, fixed in `fixIn` — the file that wires them.
export function pinFindings(subject: PinCheckSubject, fixIn: SourceFile): Finding[] {
  return checkPins(subject.pins ?? []).map((f) => ({
    code: f.code,
    subject: f.source,
    fixIn,
    message: `${SUBJECT_NOUN[f.subject]}, pinned at ${formatSites(f)}`,
    targets: fixIn.patch === undefined ? f.sites.map((site) => site.address) : [],
  }));
}
