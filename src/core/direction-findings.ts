// Each direction finding code's standing: the class a pass must read to evaluate it, where a waiver
// of it plays, the stage its fix is written in, and the waiver key that cancels it.

import type { DirectionFinding, DirectionFindingCode } from "./direction-check.js";
import { type FindingCode, findingTraits } from "./finding.js";

// A finding's class: what a pass must have read to evaluate it, so its waivers may be called stale.
export type DirectionFindingClass =
  | "arc"
  | "pacing"
  | "characters"
  | "props"
  | "locations"
  | "setups"
  | "staging"
  | "typesetting"
  | "song";

const FINDING_CLASS: Record<DirectionFindingCode, DirectionFindingClass> = {
  "missing-role": "arc",
  "no-payoff": "arc",
  "role-out-of-order": "arc",
  "lens-role-mismatch": "arc",
  "too-few-consecutive": "arc",
  "empty-synopsis": "arc",
  "unearned-payoff": "arc",
  "role-overweight": "pacing",
  "role-underweight": "pacing",
  "character-unreferenced": "characters",
  "unused-character": "characters",
  // The voice checks are cast drift like their look siblings, so they ride the same class: deferred
  // until the direction is accepted (they point at reference wiring, not at the shots under review),
  // then gating every spend — which is what puts them in front of a TTS bill.
  "character-voice-missing": "characters",
  "character-voice-unreferenced": "characters",
  "unused-character-voice": "characters",
  "narrator-missing": "characters",
  "narrator-unreferenced": "characters",
  "unused-narrator": "characters",
  "prop-unreferenced": "props",
  "unused-prop": "props",
  "location-unreferenced": "locations",
  "unused-location": "locations",
  "setup-unrealized": "setups",
  "plate-unanchored": "setups",
  "plate-unnested": "setups",
  "axis-unrealized": "setups",
  "plate-unowed": "setups",
  "setup-unconsumed": "setups",
  "unused-setup": "setups",
  "setup-atomized": "setups",
  "view-unrealized": "setups",
  "plate-unviewed": "setups",
  "view-unanchored": "setups",
  // A fused-shot content check on the action prose (like empty-synopsis): it gates generate and is
  // never deferred.
  "multi-sentence-action": "arc",
  "off-grid-duration": "pacing",
  "off-beat-cut": "pacing",
  "fonts-undeclared": "typesetting",
  "lineup-flipped": "staging",
  "lineup-gap": "staging",
  "lineup-vacuous": "staging",
  "lineup-inconsistent": "staging",
  "location-backtrack": "staging",
  "character-unconsumed": "staging",
  "slot-order-mismatch": "staging",
  "plate-recropped": "staging",
  "landmark-flipped": "staging",
  "subject-unnamed": "staging",
  "prop-unnamed": "staging",
  "passer-unconsumed": "staging",
  "passer-unnamed": "staging",
  "plate-unnamed": "staging",
  "landmark-unnamed": "staging",
  "join-lineup-mismatch": "staging",
  "join-unpinned": "staging",
  "join-unshown": "staging",
  "opening-key": "staging",
  "panel-unlinked": "staging",
  "return-unlinked": "staging",
  // The song the piece is cut to. Never deferred.
  "song-unreferenced": "song",
  "lyric-unplaced": "song",
  "song-overrun": "song",
};

export function classifyDirectionFinding(code: DirectionFindingCode): DirectionFindingClass {
  return FINDING_CLASS[code];
}

export function isDirectionFindingCode(code: string): code is DirectionFindingCode {
  return Object.hasOwn(FINDING_CLASS, code);
}

// Where what a waiver of the code lets through plays, read off its subject: inside one shot (the
// shot, one of its frames, or a subject in one), across the boundary `<from>-<to>` between two, in
// every shot with a frame on the setup it names, or in no one shot (null).
type WaiverShotScope = "shot" | "boundary" | "setup" | null;

const WAIVER_ON_SHOT: Record<DirectionFindingCode, WaiverShotScope> = {
  "missing-role": null,
  "no-payoff": null,
  "role-out-of-order": null,
  "lens-role-mismatch": null,
  "too-few-consecutive": null,
  "empty-synopsis": null,
  "unearned-payoff": null,
  "role-overweight": null,
  "role-underweight": null,
  "character-unreferenced": null,
  "unused-character": null,
  "character-voice-missing": null,
  "character-voice-unreferenced": null,
  "unused-character-voice": null,
  "narrator-missing": null,
  "narrator-unreferenced": null,
  "unused-narrator": null,
  "prop-unreferenced": null,
  "unused-prop": null,
  "location-unreferenced": null,
  "unused-location": null,
  "setup-unrealized": null,
  "plate-unanchored": null,
  "plate-unnested": null,
  "axis-unrealized": null,
  "plate-unowed": null,
  "setup-unconsumed": "setup",
  "unused-setup": null,
  "setup-atomized": null,
  "view-unrealized": null,
  "plate-unviewed": null,
  "view-unanchored": null,
  "multi-sentence-action": "shot",
  "off-grid-duration": "shot",
  "off-beat-cut": "shot",
  "fonts-undeclared": null,
  "lineup-flipped": "shot",
  "lineup-gap": "shot",
  "lineup-vacuous": "shot",
  "lineup-inconsistent": "shot",
  "location-backtrack": "shot",
  "character-unconsumed": "shot",
  "slot-order-mismatch": "shot",
  "plate-recropped": "shot",
  "landmark-flipped": null,
  "subject-unnamed": "shot",
  "prop-unnamed": "shot",
  "passer-unconsumed": "shot",
  "passer-unnamed": "shot",
  "plate-unnamed": null,
  "landmark-unnamed": "shot",
  "join-lineup-mismatch": "shot",
  "join-unpinned": "shot",
  "join-unshown": "shot",
  "opening-key": "shot",
  "panel-unlinked": "boundary",
  "return-unlinked": "boundary",
  "song-unreferenced": null,
  "lyric-unplaced": null,
  "song-overrun": null,
};

export function waiverShotScope(code: DirectionFindingCode): WaiverShotScope {
  return WAIVER_ON_SHOT[code];
}

// The stage entry file a finding's fix is written in. A declared entity — a look or a cast voice —
// with no reference asset is answered in `reference.tsx`; a setup the board realizes wrongly is
// answered by its plates and keyframes in `animatic.tsx`, and a take or composition by `video.tsx`.
// The direction entry naming any of them is edited only to waive one.
const FIX_STAGE: Record<DirectionFindingCode, FindingFixStage> = {
  "missing-role": "direction",
  "no-payoff": "direction",
  "role-out-of-order": "direction",
  "lens-role-mismatch": "direction",
  "too-few-consecutive": "direction",
  "empty-synopsis": "direction",
  "unearned-payoff": "direction",
  "role-overweight": "direction",
  "role-underweight": "direction",
  "character-unreferenced": "reference",
  "unused-character": "direction",
  "character-voice-missing": "direction",
  "character-voice-unreferenced": "reference",
  "unused-character-voice": "direction",
  "narrator-missing": "direction",
  "narrator-unreferenced": "reference",
  "unused-narrator": "direction",
  "prop-unreferenced": "reference",
  "unused-prop": "direction",
  "location-unreferenced": "reference",
  "unused-location": "direction",
  "setup-unrealized": "animatic",
  "plate-unanchored": "animatic",
  "plate-unnested": "animatic",
  "axis-unrealized": "animatic",
  "plate-unowed": "animatic",
  "setup-unconsumed": "animatic",
  "unused-setup": "direction",
  "setup-atomized": "direction",
  "view-unrealized": "reference",
  "plate-unviewed": "animatic",
  "view-unanchored": "reference",
  "multi-sentence-action": "direction",
  "off-grid-duration": "direction",
  "off-beat-cut": "direction",
  "fonts-undeclared": "direction",
  "lineup-flipped": "direction",
  "lineup-gap": "direction",
  "lineup-vacuous": "direction",
  "lineup-inconsistent": "direction",
  "location-backtrack": "direction",
  "character-unconsumed": "animatic",
  "slot-order-mismatch": "animatic",
  "plate-recropped": "direction",
  "landmark-flipped": "direction",
  "subject-unnamed": "animatic",
  "prop-unnamed": "animatic",
  "passer-unconsumed": "video",
  "passer-unnamed": "video",
  "plate-unnamed": "animatic",
  "landmark-unnamed": "animatic",
  "join-lineup-mismatch": "direction",
  "join-unpinned": "video",
  "join-unshown": "video",
  "opening-key": "video",
  "panel-unlinked": "animatic",
  "return-unlinked": "animatic",
  "song-unreferenced": "reference",
  "lyric-unplaced": "direction",
  "song-overrun": "direction",
};

type FindingFixStage = "direction" | "reference" | "animatic" | "video";

export function findingFixStage(code: DirectionFindingCode): FindingFixStage {
  return FIX_STAGE[code];
}

// The findings a surface reports or gates on: a finding whose onset is the direction's acceptance
// (the roster wiring) waits for it. Waiver
// reconciliation is untouched: a waived roster finding still counts as waived, never as stale.
export function reportableDirectionFindings<F extends { code: FindingCode }>(
  active: F[],
  directionAccepted: boolean,
): F[] {
  if (directionAccepted) return active;
  return active.filter((f) => findingTraits(f.code).onset !== "after-direction-accepted");
}

// The waiver key that cancels a finding: `<code>` for subject-less findings (no-payoff) or
// `<code>_<subject>` for an instance (missing-role_disruption, lens-role-mismatch_08). No finding
// code contains an underscore (they are all hyphenated), so the first one splits the key back apart
// however the subject (role / shot id / id-range / stage) is spelled — and the key stays a single
// segment of its review address (`waivers.<key>`), where a `:` would need escaping and a
// `-` would be indistinguishable from the hyphens inside a code.
const WAIVER_KEY_SEPARATOR = "_";

export function directionWaiverKey(finding: Pick<DirectionFinding, "code" | "subject">): string {
  return finding.subject
    ? `${finding.code}${WAIVER_KEY_SEPARATOR}${finding.subject}`
    : finding.code;
}

export function splitWaiverKey(key: string): { code: string; subject?: string } {
  const sep = key.indexOf(WAIVER_KEY_SEPARATOR);
  return sep === -1 ? { code: key } : { code: key.slice(0, sep), subject: key.slice(sep + 1) };
}

// A code a waiver can cancel: one whose rule a work may rightly break. A waiver naming any other
// cancels nothing, and is stale.
export function isWaivableCode(code: string): code is DirectionFindingCode {
  return isDirectionFindingCode(code) && findingTraits(code).clears === "waive";
}
