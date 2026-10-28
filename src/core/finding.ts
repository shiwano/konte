// The one vocabulary of machine findings. A check reads the definitions (and the takes) and reports
// findings; what a finding is — what it reads, how it clears, what it holds and from when — is a
// property of its code, fixed in FINDING_TRAITS. The gates, `status` and FINDINGS.md all read the
// table.

import { type AssetStage, type Stage, matchesAddressScope } from "./address.js";
import type { DirectionFindingCode } from "./direction-check.js";
import type { DirectionErrorCode } from "./direction.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import type { PinFindingCode } from "./pin-check.js";
import type { PromptFindingCode } from "./prompt-check.js";

// Every command that can spend on a backend.
export type SpendCommand = "generate" | "reroll" | "patch" | "export";

export type FindingCode =
  | DirectionFindingCode
  | DirectionErrorCode
  | PromptFindingCode
  | PinFindingCode
  // A class setting a font family the export cannot embed, in a `jsxImage`'s markup — and in a
  // composition's or the overlay's, which a review renders too.
  | "class-font-family"
  | "composition-class-font-family"
  // A panel's `blocking` / `camera`, owed once it has a take to be written from.
  | "movement-unwritten"
  // A landed take that is silent where it owes sound, or does not say the line it owes.
  | "take-silent"
  | "line-misheard"
  // An animatic shot whose lines the stem's clamp to `duration` cuts.
  | "narration-overflow"
  // A video shot that spends without building on the board it develops.
  | "animatic-unconsumed"
  | BuildFindingCode
  // An asset built on a shot that is still a pendingShot: the edge it would hang on has no take.
  | "pending-reference";

// What a stage build finds of itself instead of refusing to load: a demand the direction makes that
// the stage file has not caught up with, after an edit to the direction alone.
export type BuildFindingCode =
  // A shot the direction gives lines to that does not sound them.
  | "script-unvoiced"
  // A shot whose `<Cutin>` and the direction's `cutin` disagree on whether there is one.
  | "cutin-required"
  | "cutin-undeclared"
  // A plate filed under a setup the direction does not declare.
  | "plate-undeclared-setup"
  // A soundtrack anchored to a shot the direction does not declare.
  | "soundtrack-anchor-unknown";

export type BuildFinding = {
  code: BuildFindingCode;
  subject: string;
  message: string;
  targets: readonly string[];
};

// How far a spend hold reaches, from the finding's stage: `edge` holds only the subject's assets and
// what is built on them, on its stage and downstream; the rest still spends.
export type SpendReach = "stage" | "stage+downstream" | "downstream" | "edge";

export type FindingTraits = {
  reads: "definition" | "take";
  clears: "fix" | "waive" | "vouch";
  holds: {
    // `named`: a targeted spend (`reroll`, `patch apply`) is held only when it names an asset under
    // the finding's targets, or one of no shot.
    spend?: { reach: SpendReach; commands?: readonly SpendCommand[]; named?: true };
    accept?: true;
    preview?: true;
  };
  onset: "always" | "after-direction-accepted" | "after-take";
};

// The file a finding is fixed in: a stage's entry file, or the patch script of one take.
export type SourceFile = { stage: Stage; patch?: string };

export type Finding = {
  code: FindingCode;
  // What the finding is about — an address, a shot, a direction part, a variant, a phrase.
  subject: string;
  fixIn: SourceFile;
  message: string;
  // The key a waiver cancels it by, for a waivable code.
  key?: string;
  // The addresses it sits on — what an accept hold and an `edge` hold match. Absent, it sits on its
  // whole stage.
  targets?: readonly string[];
};

export function sourceFilePath(file: SourceFile): string {
  return file.patch ? `patches/${file.patch}.ts` : STAGE_ENTRY_FILE[file.stage];
}

const waive = (
  reach: SpendReach,
  onset: FindingTraits["onset"] = "always",
  reads: FindingTraits["reads"] = "definition",
): FindingTraits => ({ reads, clears: "waive", holds: { spend: { reach } }, onset });

// A declaration contradicting another, or naming nothing.
const fixDirection: FindingTraits = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage+downstream" }, accept: true },
  onset: "always",
};

const ROSTER = "after-direction-accepted" as const;

const DIRECTION_FINDING_TRAITS: Record<DirectionFindingCode, FindingTraits> = {
  "missing-role": waive("stage+downstream"),
  "no-payoff": waive("stage+downstream"),
  "role-out-of-order": waive("stage+downstream"),
  "lens-role-mismatch": fixDirection,
  "too-few-consecutive": waive("stage+downstream"),
  "empty-synopsis": fixDirection,
  "unearned-payoff": waive("stage+downstream"),
  "role-overweight": waive("stage+downstream"),
  "role-underweight": waive("stage+downstream"),
  "character-unreferenced": waive("downstream", ROSTER),
  "unused-character": fixDirection,
  "character-voice-missing": waive("stage+downstream", ROSTER),
  "character-voice-unreferenced": waive("downstream", ROSTER),
  "unused-character-voice": fixDirection,
  "narrator-missing": waive("stage+downstream", ROSTER),
  "narrator-unreferenced": waive("downstream", ROSTER),
  "unused-narrator": fixDirection,
  "prop-unreferenced": waive("downstream", ROSTER),
  "unused-prop": fixDirection,
  "location-unreferenced": waive("downstream", ROSTER),
  "unused-location": fixDirection,
  "setup-unrealized": waive("stage+downstream", ROSTER),
  "plate-unanchored": waive("stage+downstream", ROSTER),
  "plate-unnested": waive("stage+downstream", ROSTER),
  "axis-unrealized": waive("stage+downstream", ROSTER),
  "setup-unconsumed": waive("stage+downstream", ROSTER),
  "unused-setup": fixDirection,
  "setup-atomized": waive("stage+downstream", ROSTER),
  "view-unrealized": waive("downstream", ROSTER),
  "plate-unviewed": waive("stage+downstream", ROSTER),
  "view-unanchored": waive("stage+downstream"),
  "multi-sentence-action": waive("stage+downstream"),
  "off-grid-duration": fixDirection,
  "off-beat-cut": waive("stage+downstream"),
  "fonts-undeclared": waive("stage+downstream"),
  "lineup-flipped": waive("stage+downstream"),
  "lineup-gap": waive("stage+downstream"),
  "lineup-vacuous": fixDirection,
  "lineup-inconsistent": waive("stage+downstream"),
  "location-backtrack": waive("stage+downstream"),
  "character-unconsumed": waive("stage+downstream"),
  "slot-order-mismatch": waive("stage+downstream"),
  "plate-recropped": waive("stage+downstream"),
  "landmark-flipped": waive("stage+downstream"),
  "subject-unnamed": waive("stage+downstream"),
  "prop-unnamed": waive("stage+downstream"),
  "passer-unconsumed": waive("stage"),
  "passer-unnamed": waive("stage"),
  "plate-unnamed": waive("stage+downstream"),
  "landmark-unnamed": waive("stage+downstream"),
  "join-lineup-mismatch": fixDirection,
  "join-unpinned": waive("stage+downstream"),
  "join-unshown": fixDirection,
  "opening-key": waive("stage", "always", "take"),
  "panel-unlinked": waive("stage+downstream"),
  "song-unreferenced": {
    ...fixDirection,
    holds: { spend: { reach: "downstream" }, accept: true },
  },
  "lyric-unplaced": waive("stage+downstream", "always", "take"),
  "song-overrun": waive("stage+downstream", "always", "take"),
};

// A stage file behind its direction: it holds that stage's spend, its downstream's, and the accept
// of what it sits on.
const fixStageAndDownstream: FindingTraits = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage+downstream" }, accept: true },
  onset: "always",
};

const fixStage: FindingTraits = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage" }, accept: true },
  onset: "always",
};

const OTHER_TRAITS: Record<
  Exclude<FindingCode, DirectionFindingCode | DirectionErrorCode>,
  FindingTraits
> = {
  "prompt-negation": fixStage,
  "prompt-not-yet": fixStage,
  "prompt-double-negative": fixStage,
  "pin-unanchored": fixStage,
  "class-font-family": fixStage,
  "composition-class-font-family": {
    ...fixStage,
    holds: { ...fixStage.holds, preview: true },
  },
  "movement-unwritten": {
    reads: "take",
    clears: "fix",
    holds: { spend: { reach: "downstream" }, accept: true, preview: true },
    onset: "after-take",
  },
  "take-silent": { reads: "take", clears: "vouch", holds: { preview: true }, onset: "always" },
  "line-misheard": { reads: "take", clears: "vouch", holds: { preview: true }, onset: "always" },
  "narration-overflow": { reads: "take", clears: "fix", holds: {}, onset: "always" },
  "animatic-unconsumed": {
    reads: "definition",
    clears: "fix",
    holds: { spend: { reach: "stage", named: true } },
    onset: "always",
  },
  "script-unvoiced": fixStageAndDownstream,
  "cutin-required": fixStageAndDownstream,
  "cutin-undeclared": fixStageAndDownstream,
  "plate-undeclared-setup": fixStageAndDownstream,
  "soundtrack-anchor-unknown": fixStageAndDownstream,
  "pending-reference": {
    reads: "definition",
    clears: "fix",
    holds: { spend: { reach: "edge" }, accept: true },
    onset: "always",
  },
};

export function findingTraits(code: FindingCode): FindingTraits {
  return (
    (DIRECTION_FINDING_TRAITS as Record<string, FindingTraits>)[code] ??
    (OTHER_TRAITS as Record<string, FindingTraits>)[code] ??
    fixDirection
  );
}

// Every code a check reports, in the order FINDINGS.md lists them.
export const DIRECTION_FINDING_CODES = Object.keys(
  DIRECTION_FINDING_TRAITS,
) as DirectionFindingCode[];

// The spend stages downstream of a stage; a direction finding holds the two shot stages.
const DOWNSTREAM: Record<Stage, readonly AssetStage[]> = {
  direction: ["animatic", "video"],
  reference: ["animatic", "video"],
  animatic: ["video"],
  video: [],
};

export function spendStages(stage: Stage, reach: SpendReach): readonly AssetStage[] {
  const own: AssetStage[] = stage === "direction" ? [] : [stage];
  switch (reach) {
    case "stage":
      return own;
    case "stage+downstream":
    case "edge":
      return [...own, ...DOWNSTREAM[stage]];
    case "downstream":
      return DOWNSTREAM[stage];
  }
}

// One spend, as a gate asks about it: the stage spent on, and — for a patch application — the take
// whose patch script is being applied.
export type SpendOp = { command: SpendCommand; stage: AssetStage; patch?: string };

// Whether the finding holds the spend, and how: the whole spend, or only its `edge` assets.
export function spendHold(finding: Finding, op: SpendOp): "whole" | "edge" | null {
  const spend = findingTraits(finding.code).holds.spend;
  if (!spend) return null;
  if (spend.commands && !spend.commands.includes(op.command)) return null;
  // A patch script's finding is that patch's alone.
  if (finding.fixIn.patch !== undefined) return finding.fixIn.patch === op.patch ? "whole" : null;
  if (!spendStages(finding.fixIn.stage, spend.reach).includes(op.stage)) return null;
  return spend.reach === "edge" ? "edge" : "whole";
}

export type ReviewOp = { op: "preview"; stage: Stage } | { op: "accept"; address: string };

export function reviewHold(finding: Finding, op: ReviewOp): boolean {
  const holds = findingTraits(finding.code).holds;
  if (op.op === "preview") return holds.preview === true && finding.fixIn.stage === op.stage;
  if (!holds.accept) return false;
  const targets = finding.targets;
  if (!targets) return op.address.startsWith(`${finding.fixIn.stage}:`);
  return targets.some(
    (target) => matchesAddressScope(op.address, target) || matchesAddressScope(target, op.address),
  );
}

// The key a status line and a refusal name a finding by: its waiver key, else its code.
export function findingLabel(finding: Finding): string {
  return finding.key ?? finding.code;
}

export function formatFindingLine(finding: Finding): string {
  const subject =
    finding.subject && !finding.key?.endsWith(finding.subject) ? `${finding.subject} — ` : "";
  return `[${findingLabel(finding)}] ${subject}${finding.message}`;
}

// The findings grouped by the file each is fixed in, in pipeline order, each file's lines indented
// under it.
export function groupByFixIn(
  findings: readonly Finding[],
): Array<{ file: string; findings: Finding[] }> {
  const order: Stage[] = ["direction", "reference", "animatic", "video"];
  const byFile = new Map<string, { rank: number; findings: Finding[] }>();
  for (const f of findings) {
    const file = sourceFilePath(f.fixIn);
    const entry = byFile.get(file) ?? {
      rank: order.indexOf(f.fixIn.stage) * 2 + (f.fixIn.patch ? 1 : 0),
      findings: [],
    };
    entry.findings.push(f);
    byFile.set(file, entry);
  }
  return [...byFile]
    .sort(([a, x], [b, y]) => x.rank - y.rank || a.localeCompare(b))
    .map(([file, { findings: group }]) => ({ file, findings: group }));
}
