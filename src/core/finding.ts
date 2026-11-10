// The one vocabulary of machine findings. A check reads the definitions (and the takes) and reports
// findings; what a finding is — what it reads, how it clears, what it holds and from when — is a
// property of its code, fixed in FINDING_TRAITS. The gates, `status` and FINDINGS.md all read the
// table.

import { type AssetStage, type Stage, matchesAddressScope } from "./address.js";
import type { DirectionFindingCode } from "./direction-check.js";
import type { DirectionErrorCode } from "./direction.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import { DIRECTION_ERROR_REMEDY } from "./finding-remedy/direction-error.js";
import { DIRECTION_FINDING_REMEDY } from "./finding-remedy/direction.js";
import { OTHER_FINDING_REMEDY } from "./finding-remedy/other.js";
import type { PinFindingCode } from "./pin-check.js";
import type { PromptFindingCode } from "./prompt-check.js";

// Every command that can spend on a backend.
export type SpendCommand = "generate" | "reroll" | "patch" | "export";

export type FindingCode =
  | DirectionFindingCode
  | DirectionErrorCode
  | PromptFindingCode
  | PinFindingCode
  // A shot's prompt naming a landmark its frame does not hold.
  | "landmark-unheld"
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
  | "line-truncated"
  // An animatic shot that runs on long in silence after its last sound.
  | "tail-silent"
  // A video shot that spends without building on the board it develops.
  | "animatic-unconsumed"
  // A video take driven by a board stem no mouth in the frame speaks.
  | "stem-unmouthed"
  // A board shot's `#narrationStem` / `#offFrameStem` that no video shot places.
  | "stem-unplaced"
  // A script-line `<Subtitle>` entry split at the pauses of a take that no longer plays its line.
  | "subtitle-pauses-stale"
  | BuildFindingCode
  // An asset built on a shot that is still a pendingShot: the edge it would hang on has no take.
  | "pending-reference"
  // A locator of `brief.source` — a digest's `at`, or the span — past the original's chunks.
  | "source-locator-out-of-range";

// What a stage build finds of itself instead of refusing to load: a demand the direction makes that
// the stage file has not caught up with, after an edit to the direction alone.
type BuildFindingCode =
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
type SpendReach = "stage" | "stage+downstream" | "downstream" | "edge";

export type FindingTraits = {
  reads: "definition" | "take";
  clears: "fix" | "waive" | "vouch" | "accept";
  holds: {
    // `named`: a targeted spend (`reroll`, `patch apply`) is held only when it names an asset under
    // the finding's targets, or one of no shot.
    spend?: { reach: SpendReach; commands?: readonly SpendCommand[]; named?: true };
    accept?: true;
    preview?: true;
  };
  onset: "always" | "after-direction-accepted" | "after-take";
  // An accept of the addresses it is judged by (`judgedBy`) signs it off.
  signsOff: boolean;
};

// The file a finding is fixed in: a stage's entry file, or the patch script of one take.
export type SourceFile = { stage: Stage; patch?: string };

type FindingFields = {
  // What the finding is about — an address, a shot, a direction part, a variant, a phrase.
  subject: string;
  fixIn: SourceFile;
  message: string;
  // The key a waiver cancels it by, for a waivable code.
  key?: string;
  // The addresses it sits on — what an accept hold and an `edge` hold match. Absent, it sits on its
  // whole stage.
  targets?: readonly string[];
  // The `judgedBy` addresses accepted as drawn (`signOffFinding`).
  signedOff?: readonly string[];
  // The one take it sits on: its accept hold matches an accept naming that take.
  variant?: string;
};

export type Finding =
  | (FindingFields & {
      code: AcceptJudgedCode;
      // The addresses whose accept judges it (`signOffFinding`).
      judgedBy: readonly string[];
    })
  | (FindingFields & { code: Exclude<FindingCode, AcceptJudgedCode>; judgedBy?: never });

function sourceFilePath(file: SourceFile): string {
  return file.patch ? `patches/${file.patch}.ts` : STAGE_ENTRY_FILE[file.stage];
}

const waive = (
  reach: SpendReach,
  onset: FindingTraits["onset"] = "always",
  reads: FindingTraits["reads"] = "definition",
) => ({
  reads,
  clears: "waive" as const,
  holds: { spend: { reach } },
  onset,
  signsOff: false as const,
});

const judged = <T extends FindingTraits>(traits: T) => ({ ...traits, signsOff: true as const });

// A declaration contradicting another, or naming nothing.
const fixDirection = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage+downstream" }, accept: true },
  onset: "always",
  signsOff: false,
} as const satisfies FindingTraits;

const ROSTER = "after-direction-accepted" as const;

// The codes an accept of the addresses a finding names in `judgedBy` signs off.
const ACCEPT_JUDGED_CODES = [
  "setup-unrealized",
  "axis-unrealized",
  "setup-unconsumed",
  "setup-atomized",
  "character-unconsumed",
  "slot-order-mismatch",
  "plate-recropped",
  "subject-unnamed",
  "prop-unnamed",
  "passer-unconsumed",
  "passer-unnamed",
  "plate-unnamed",
  "landmark-unnamed",
  "view-unnamed",
  "join-unpinned",
  "join-unshown",
  "opening-key",
  "panel-unlinked",
  "return-unlinked",
  "prompt-negation",
  "prompt-not-yet",
  "prompt-double-negative",
  "landmark-unheld",
  "stem-unmouthed",
] as const satisfies readonly FindingCode[];

export type AcceptJudgedCode = (typeof ACCEPT_JUDGED_CODES)[number];

// Each code's traits, its `signsOff` agreeing with `ACCEPT_JUDGED_CODES`.
type TraitsOf<Code extends FindingCode> = {
  [K in Code]: FindingTraits & { signsOff: K extends AcceptJudgedCode ? true : false };
};

const DIRECTION_FINDING_TRAITS: TraitsOf<DirectionFindingCode> = {
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
  "setup-unrealized": judged(waive("stage+downstream", ROSTER)),
  "plate-unanchored": waive("stage+downstream", ROSTER),
  "plate-unnested": waive("stage+downstream", ROSTER),
  "axis-unrealized": judged(waive("stage+downstream", ROSTER)),
  "plate-unowed": waive("stage+downstream", ROSTER),
  "setup-unconsumed": judged(waive("stage+downstream", ROSTER)),
  "unused-setup": fixDirection,
  "setup-atomized": judged(waive("stage+downstream", ROSTER)),
  "view-unrealized": waive("downstream", ROSTER),
  "plate-unviewed": waive("stage+downstream", ROSTER),
  "view-unanchored": waive("stage+downstream"),
  "view-unnamed": judged(waive("stage+downstream", ROSTER)),
  "multi-sentence-action": waive("stage+downstream"),
  "off-grid-duration": fixDirection,
  "off-beat-cut": waive("stage+downstream"),
  "fonts-undeclared": waive("stage+downstream"),
  "lineup-flipped": waive("stage+downstream"),
  "lineup-gap": waive("stage+downstream"),
  "lineup-vacuous": fixDirection,
  "lineup-inconsistent": waive("stage+downstream"),
  "location-backtrack": waive("stage+downstream"),
  "character-unconsumed": judged(waive("stage+downstream")),
  "slot-order-mismatch": judged(waive("stage+downstream")),
  "plate-recropped": judged(waive("stage+downstream")),
  "landmark-flipped": waive("stage+downstream"),
  "subject-unnamed": judged(waive("stage+downstream")),
  "prop-unnamed": judged(waive("stage+downstream")),
  "passer-unconsumed": judged(waive("stage")),
  "passer-unnamed": judged(waive("stage")),
  "plate-unnamed": judged(waive("stage+downstream")),
  "landmark-unnamed": judged(waive("stage+downstream")),
  "join-lineup-mismatch": fixDirection,
  "join-unpinned": judged(waive("stage+downstream")),
  "join-unshown": judged(waive("stage+downstream")),
  "opening-key": judged(waive("stage", "always", "take")),
  "panel-unlinked": judged(waive("stage+downstream")),
  "return-unlinked": judged(waive("stage+downstream")),
  "song-unreferenced": {
    ...fixDirection,
    holds: { spend: { reach: "downstream" }, accept: true },
  },
  "lyric-unplaced": waive("stage+downstream", "always", "take"),
  "song-overrun": waive("stage+downstream", "always", "take"),
};

// A stage file behind its direction: it holds that stage's spend, its downstream's, and the accept
// of what it sits on.
const fixStageAndDownstream = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage+downstream" }, accept: true },
  onset: "always",
  signsOff: false,
} as const satisfies FindingTraits;

const fixStage = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage" }, accept: true },
  onset: "always",
  signsOff: false,
} as const satisfies FindingTraits;

// A prompt is judged by the picture it draws: an accept of a take drawn from it signs off its address.
const fixPrompt = judged({
  reads: "definition",
  clears: "accept",
  holds: { spend: { reach: "edge" } },
  onset: "always",
  signsOff: false,
});

const OTHER_TRAITS: TraitsOf<Exclude<FindingCode, DirectionFindingCode | DirectionErrorCode>> = {
  "prompt-negation": fixPrompt,
  "prompt-not-yet": fixPrompt,
  "prompt-double-negative": fixPrompt,
  "landmark-unheld": fixPrompt,
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
    signsOff: false,
  },
  "take-silent": {
    reads: "take",
    clears: "vouch",
    holds: { accept: true, preview: true },
    onset: "always",
    signsOff: false,
  },
  "line-misheard": {
    reads: "take",
    clears: "vouch",
    holds: { accept: true, preview: true },
    onset: "always",
    signsOff: false,
  },
  "line-truncated": { reads: "take", clears: "fix", holds: {}, onset: "always", signsOff: false },
  "tail-silent": {
    reads: "take",
    clears: "vouch",
    holds: { preview: true },
    onset: "always",
    signsOff: false,
  },
  "animatic-unconsumed": {
    reads: "definition",
    clears: "fix",
    holds: { spend: { reach: "stage", named: true } },
    onset: "always",
    signsOff: false,
  },
  "stem-unmouthed": fixPrompt,
  "stem-unplaced": {
    reads: "definition",
    clears: "fix",
    holds: { spend: { reach: "stage", commands: ["export"] }, accept: true, preview: true },
    onset: "always",
    signsOff: false,
  },
  "subtitle-pauses-stale": {
    reads: "take",
    clears: "fix",
    holds: { spend: { reach: "stage", commands: ["export"] }, preview: true },
    onset: "always",
    signsOff: false,
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
    signsOff: false,
  },
  "source-locator-out-of-range": fixStageAndDownstream,
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
type SpendOp = { command: SpendCommand; stage: AssetStage; patch?: string };

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

export type ReviewOp =
  | { op: "preview"; stage: Stage }
  | { op: "accept"; address: string; variantId?: string | undefined };

export function reviewHold(finding: Finding, op: ReviewOp): boolean {
  const holds = findingTraits(finding.code).holds;
  if (op.op === "preview") return holds.preview === true && finding.fixIn.stage === op.stage;
  if (!holds.accept) return false;
  if (finding.variant !== undefined && finding.variant !== op.variantId) return false;
  const targets = finding.targets;
  if (!targets) return op.address.startsWith(`${finding.fixIn.stage}:`);
  return targets.some(
    (target) => matchesAddressScope(op.address, target) || matchesAddressScope(target, op.address),
  );
}

// The key a status line and a refusal name a finding by: its waiver key, else its code.
function findingLabel(finding: Finding): string {
  return finding.key ?? finding.code;
}

// What clears every finding of a code, printed once over its findings; a finding carries only what
// is its own in `message`.
const FINDING_REMEDY: Record<FindingCode, string> = {
  ...DIRECTION_FINDING_REMEDY,
  ...DIRECTION_ERROR_REMEDY,
  ...OTHER_FINDING_REMEDY,
};

export function findingRemedy(code: FindingCode): string {
  return FINDING_REMEDY[code];
}

// The finding without its code's remedy, as a line under the remedy.
function formatFindingItem(finding: Finding): string {
  const subject =
    finding.subject && !finding.key?.endsWith(finding.subject) ? `${finding.subject} — ` : "";
  const label = finding.key ? `[${finding.key}] ` : "";
  return `${label}${subject}${finding.message}`;
}

export function formatFindingLine(finding: Finding): string {
  const subject =
    finding.subject && !finding.key?.endsWith(finding.subject) ? `${finding.subject} — ` : "";
  return `[${findingLabel(finding)}] ${subject}${finding.message} — ${FINDING_REMEDY[finding.code]}`;
}

// One file's findings as printed: each code's under one `<code> ×<n> — <remedy>` head.
export type FindingBlock = { head: string; items: string[] };

export function formatFindingBlocks(findings: readonly Finding[]): FindingBlock[] {
  const byCode = new Map<FindingCode, Finding[]>();
  for (const f of findings) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);
  return [...byCode].map(([code, group]) => ({
    head: `${code}${group.length > 1 ? ` ×${group.length}` : ""} — ${FINDING_REMEDY[code]}`,
    items: group.map(formatFindingItem),
  }));
}

export function formatFindingBlockLines(blocks: readonly FindingBlock[]): string[] {
  return blocks.flatMap((b) => [b.head, ...b.items.map((i) => `  ${i}`)]);
}

// The findings under the file each is fixed in, as lines of a refusal.
export function formatFindingGroups(findings: readonly Finding[]): string[] {
  return groupByFixIn(findings).flatMap(({ file, findings: group }) => [
    `  ${file}:`,
    ...formatFindingBlockLines(formatFindingBlocks(group)).map((l) => `    ${l}`),
  ]);
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
