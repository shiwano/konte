// The direction doctor + generate gate. Sits on top of the arc engine (`direction-check.ts`): it
// resolves a loaded `Direction` to its lens(es), runs the generic `checkArc`, then folds in
// `direction.waivers` to split findings into active (unwaived) and waived, and flags stale waivers
// (a waiver whose finding has gone). `doctor` reports the result; the generate/reroll/export gate
// turns the scoped, unwaived subset into a hard `DIRECTION_CHECK_FAILED`. The two share this one
// finding pass so "report" and "enforce" can never diverge.

import { DIRECTION_ROOT_PATH, directionChildNodePath, type Stage } from "./address.js";
import { findBuiltinLens } from "./lenses.js";
import {
  type AnchoredEntityRef,
  type SetupRef,
  type AnimaticSetupState,
  type ArcItem,
  type CharacterVoiceRef,
  type DirectionFinding,
  type DirectionFindingCode,
  type LensSpec,
  type LineupShot,
  type PanelSlots,
  type PanelReach,
  type VideoShotPins,
  type PanelPrompts,
  type PlateNaming,
  type PlateUse,
  type ShotPanels,
  type AxisCut,
  type PanelSeam,
  checkJoinPins,
  checkPanelLinks,
  type HoldsSetupRef,
  checkArc,
  checkCharacterVoices,
  checkCharacters,
  checkLocations,
  checkLandmarkOrder,
  checkLineups,
  checkNarrator,
  checkPlateNaming,
  checkProps,
  checkSetups,
} from "./direction-check.js";
import type {
  Direction,
  DirectionNode,
  GraphicShot,
  NarrativeShot,
  Setup,
  Shot,
} from "./dsl/direction.js";
import { isAsideShot, isGraphicShot } from "./dsl/direction.js";
import type { PanelLane } from "./types/definition.js";

// A shot of the arc — every kind but an aside.
export type ArcShot = NarrativeShot | GraphicShot;
import { isIdentifier } from "./dsl/validate-identifier.js";
import { scriptOf } from "./typography.js";
import { KonteError } from "./errors.js";

// A waivable finding's class. The gate looks at a scope-specific subset of these (a `generate`
// allows partial coverage so it ignores `completeness`; only `export` enforces it).
export type DirectionFindingClass =
  | "arc"
  | "pacing"
  | "stage"
  | "completeness"
  | "characters"
  | "props"
  | "locations"
  | "setups"
  | "staging"
  | "typesetting";

const FINDING_CLASS: Record<DirectionFindingCode, DirectionFindingClass> = {
  "missing-beat": "arc",
  "no-payoff": "arc",
  "beat-out-of-order": "arc",
  "lens-role-mismatch": "arc",
  "too-many-consecutive": "arc",
  "too-few-consecutive": "arc",
  "empty-synopsis": "arc",
  "unearned-payoff": "arc",
  "beat-overweight": "pacing",
  "beat-underweight": "pacing",
  "stage-order-mismatch": "stage",
  unrealized: "completeness",
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
  "setup-unconsumed": "setups",
  "unused-setup": "setups",
  "setup-indistinct": "setups",
  "setup-atomized": "setups",
  // A direction content check (like empty-synopsis): it gates generate and is never deferred.
  "unexpected-script": "arc",
  // A fused-shot content check on the action prose — likewise gates generate and is never deferred.
  "multi-sentence-action": "arc",
  "off-grid-duration": "pacing",
  "undeclared-continuity": "pacing",
  "re-established-wide": "pacing",
  "fonts-undeclared": "typesetting",
  "lineup-flipped": "staging",
  "lineup-gap": "staging",
  "lineup-vacuous": "staging",
  "lineup-inconsistent": "staging",
  "character-unconsumed": "staging",
  "slot-order-mismatch": "staging",
  "plate-undescribed": "staging",
  "landmark-flipped": "staging",
  "subject-unnamed": "staging",
  "plate-unnamed": "staging",
  "join-lineup-mismatch": "staging",
  "join-unpinned": "staging",
  "join-unshown": "staging",
  "panel-unlinked": "staging",
};

export function classifyDirectionFinding(code: DirectionFindingCode): DirectionFindingClass {
  return FINDING_CLASS[code];
}

// The stage entry file a finding's fix is written in. A declared entity — a look or a cast voice —
// with no reference asset is answered in `reference.tsx`; a setup the board realizes wrongly is
// answered by its plates and keyframes in `animatic.tsx`. The direction entry naming either is
// already correct, so it is edited only to waive one. Every other finding is direction-side.
const FIX_STAGE: Partial<Record<DirectionFindingCode, "reference" | "animatic">> = {
  "character-unreferenced": "reference",
  "character-voice-unreferenced": "reference",
  "narrator-unreferenced": "reference",
  "prop-unreferenced": "reference",
  "location-unreferenced": "reference",
  "setup-unrealized": "animatic",
  "plate-unanchored": "animatic",
  "plate-unnested": "animatic",
  "axis-unrealized": "animatic",
  "setup-unconsumed": "animatic",
};

export type FindingFixStage = "direction" | "reference" | "animatic";

export function findingFixStage(code: DirectionFindingCode): FindingFixStage {
  return FIX_STAGE[code] ?? "direction";
}

// The framing vocabulary the engine's space checks read (framing stays opaque to `checkArc`; this
// layer knows the DSL's words). `wide` and `medium` keep most of the set in frame, so two different
// ones cut adjacently in one location bind backgrounds; `wide` alone opens a whole set.
const EXPOSED_FRAMINGS: readonly string[] = ["wide", "medium"];
const ESTABLISHING_FRAMING = "wide";

// Characters, prop, and location findings point at post-acceptance work — anchoring an entity to a
// reference asset — and the direction review may still change the roster, so while the direction is
// not currently accepted they are premature and derail the review (an agent treats a FAIL as "fix
// now"). Every surface that reports or gates findings (doctor, preview, spend gate) drops them until
// acceptance stands; structural findings stay — they are what the review judges. Waiver
// reconciliation is untouched: a waived roster finding still counts as waived, never as stale.
const DEFERRED_UNTIL_ACCEPTED: ReadonlySet<DirectionFindingClass> = new Set([
  "characters",
  "props",
  "locations",
  "setups",
]);

export function isDeferredUntilAcceptedFinding(code: DirectionFindingCode): boolean {
  return DEFERRED_UNTIL_ACCEPTED.has(classifyDirectionFinding(code));
}

export function reportableDirectionFindings(
  active: DirectionFinding[],
  directionAccepted: boolean,
): DirectionFinding[] {
  if (directionAccepted) return active;
  return active.filter((f) => !DEFERRED_UNTIL_ACCEPTED.has(classifyDirectionFinding(f.code)));
}

// The waiver key that cancels a finding: `<code>` for subject-less findings (no-payoff) or
// `<code>_<subject>` for an instance (missing-beat_disruption, lens-role-mismatch_08). No finding
// code contains an underscore (they are all hyphenated), so the first one splits the key back apart
// however the subject (role / shot id / id-range / stage) is spelled — and the key stays a single
// segment of its review address (`sequence.waivers.<key>`), where a `:` would need escaping and a
// `-` would be indistinguishable from the hyphens inside a code.
const WAIVER_KEY_SEPARATOR = "_";

export function directionWaiverKey(finding: Pick<DirectionFinding, "code" | "subject">): string {
  return finding.subject
    ? `${finding.code}${WAIVER_KEY_SEPARATOR}${finding.subject}`
    : finding.code;
}

function waiverKeyCode(key: string): string {
  const sep = key.indexOf(WAIVER_KEY_SEPARATOR);
  return sep === -1 ? key : key.slice(0, sep);
}

function isWaivableCode(code: string): code is DirectionFindingCode {
  return Object.hasOwn(FINDING_CLASS, code);
}

// The one typo the separator invites: a key written with `_` where the code's own hyphens belong
// (`beat_overweight_problem`). Re-hyphenate and take the longest code that opens the key, so the
// error can name the key the author meant instead of listing the whole vocabulary.
function waiverKeySuggestion(key: string): string | undefined {
  const hyphenated = key.replace(/_/g, "-");
  const code = Object.keys(FINDING_CLASS)
    .filter((c) => hyphenated === c || hyphenated.startsWith(`${c}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (!code) return undefined;
  const subject = hyphenated.slice(code.length + 1);
  return subject ? `${code}${WAIVER_KEY_SEPARATOR}${subject}` : code;
}

// Every declared waiver, keyed the way `directionWaiverKey` names it — a key is unique across bags,
// since its subject names the shot or role it fires on. The reason is what a reader wants; the
// `nodePath` is what an address needs, since a waiver is reviewed where it is declared (the bag of
// the node whose finding it cancels), not at the root.
type DirectionWaiverEntry = { reason: string; nodePath: readonly string[] };

export function directionWaiverEntries(direction: Direction): Map<string, DirectionWaiverEntry> {
  const out = new Map<string, DirectionWaiverEntry>();
  const collect = (node: DirectionNode, nodePath: readonly string[]) => {
    for (const [key, reason] of Object.entries(node.waivers ?? {}))
      out.set(key, { reason, nodePath });
    for (const child of node.sequences ?? []) {
      collect(child, directionChildNodePath(nodePath, child.id ?? ""));
    }
  };
  collect(direction.sequence, DIRECTION_ROOT_PATH);
  return out;
}

// Definition bugs — not creative judgement, so they are hard FAILs and never waivable. Kept apart
// from `DirectionFindingCode` (the waivable set).
type DirectionErrorCode =
  | "direction-missing"
  | "empty-direction"
  | "duplicate-id"
  | "unknown-lens"
  | "payoff-not-in-beats"
  | "payoff-function-mismatch"
  | "empty-beats"
  | "invalid-share"
  | "character-invalid-id"
  | "character-empty-name"
  | "character-empty-description"
  // The word a prompt calls them by. Empty means the `subject-unnamed` scan has nothing to look for
  // — every prompt would contain "" and the check would silently pass.
  | "character-empty-prompt-depiction"
  // A cast voice's own contract. The empty description is the one that matters: without it an agent
  // silences `character-voice-missing` by declaring a voice that says nothing about how it sounds.
  | "character-voice-invalid-id"
  | "character-voice-empty-description"
  | "narrator-invalid-id"
  | "narrator-empty-description"
  | "prop-invalid-id"
  | "prop-empty-name"
  | "prop-empty-description"
  | "location-invalid-id"
  | "location-empty-name"
  | "location-empty-description"
  | "location-empty"
  // The landmarks a place is recognized by: the roster must exist and hold something, each entry is
  // the same hard contract as a roster entry, and its `promptDepiction` is what `plate-unnamed`
  // looks for.
  | "landmarks-empty"
  | "landmark-invalid-id"
  | "landmark-empty-name"
  | "landmark-empty-description"
  | "landmark-empty-prompt-depiction"
  // A landmark id that collides with a character / prop / location id, or with a landmark of another
  // place. The direction has one id space; unlike the three rosters a landmark maps to no reference
  // asset, so the collision is the id space's, not the namespace's.
  | "landmark-id-conflict"
  // Two declared `promptDepiction`s one substring scan cannot tell apart, characters and landmarks
  // in one depiction space.
  | "prompt-depiction-conflict"
  // The setup roster's twin of the above, plus `setup-unknown-location` (a frame is always somewhere,
  // so the `location` it names must be declared). No `reference-id-conflict` arm: a setup's plate lives
  // at `animatic:plate.<id>`, so its id is in its own namespace.
  | "setup-invalid-id"
  | "setup-empty-name"
  | "setup-empty-description"
  | "setup-empty"
  | "setup-unknown"
  | "setup-unknown-location"
  // What the frame carries of its set. `insert` is the one framing that may hold nothing; every id
  // named must be a landmark of the place the setup is set in.
  | "holds-empty"
  | "holds-unknown-id"
  // The `within` axis's own contract, the `join` pair's twin: a frame that could step in from a
  // wider one and says nothing about whether it does, a `within` no step could have, and a chain of
  // them that closes on itself. None is a creative call, so none is waivable.
  | "within-undeclared"
  | "within-impossible"
  | "within-cyclic"
  // A single id declared in more than one of the characters / props / locations rosters — all three
  // share the `reference:<id>` namespace, so a collision names one reference asset for two entities.
  | "reference-id-conflict"
  // A waiver key whose code half names no waivable finding — it can never cancel anything, in any
  // pass, so it is a typo rather than a waiver whose finding has gone (`staleWaivers`).
  | "waiver-unknown-code"
  | "script-empty-text"
  | "script-unknown-character"
  // A telop entry with nothing in it — a blank string overlays nothing, so it is a typo, not a choice.
  | "telop-empty-text"
  // An aside's own contract: its label is all the board's slug and the direction review have to show
  // for that span.
  | "aside-empty-label"
  // The lineup's own contract — all three are "this declares nothing usable": a shot that says
  // nothing about its frame at all, an id in no roster, and a subject listed twice (which of the two
  // positions is it in?). None is a creative call, so none is waivable.
  | "lineup-missing"
  | "lineup-unknown-id"
  | "lineup-duplicate"
  // The join's own contract. Both are definition bugs with no creative reading, so neither is
  // waivable: a boundary where a long take is possible and nothing says whether it is one, and a
  // `continuous` at a boundary no unbroken take could cross.
  | "join-undeclared"
  | "join-impossible";

type DirectionStructureError = {
  code: DirectionErrorCode;
  subject?: string;
  message: string;
};

type StaleWaiver = {
  key: string;
  reason: string;
  // The field path of the node whose `waivers` bag declares it.
  path?: readonly string[];
};

type DirectionCheckResult = {
  structureErrors: DirectionStructureError[];
  active: DirectionFinding[];
  waived: DirectionFinding[];
  staleWaivers: StaleWaiver[];
};

export function resolveLens(
  name: string,
  customLenses: readonly LensSpec<string>[] | undefined,
): LensSpec<string> | undefined {
  return customLenses?.find((l) => l.name === name) ?? findBuiltinLens(name);
}

// Every leaf node of the arc tree, in direction order (a branch contributes its descendants' leaves).
function collectLeaves(node: DirectionNode): DirectionNode[] {
  if (Array.isArray(node.shots)) return [node];
  return (node.sequences ?? []).flatMap(collectLeaves);
}

// Every node of the arc tree (root + every descendant), depth-first.
function collectNodes(node: DirectionNode): DirectionNode[] {
  return [node, ...(node.sequences ?? []).flatMap(collectNodes)];
}

// Every shot in the direction, flattened across the arc tree in direction order.
// Every shot a leaf declares, asides included — the clock, in direction order. Readers that need
// the runtime, the id namespace or the stage's coverage take this one.
export function collectShots(direction: Direction): Shot[] {
  return collectLeaves(direction.sequence).flatMap((leaf) => leaf.shots ?? []);
}

// The shots of the arc — narrative and graphic, everything the arc, the lines and the rosters are
// about, and the default reader. An aside carries none of the fields those checks read.
export function collectArcShots(direction: Direction): ArcShot[] {
  return collectShots(direction).filter((s): s is ArcShot => !isAsideShot(s));
}

// The shots a camera takes — the narrative ones, the readers of `setup` / `lineup` / `join`.
export function collectCameraShots(direction: Direction): NarrativeShot[] {
  return collectArcShots(direction).filter((s): s is NarrativeShot => !isGraphicShot(s));
}

// One camera frame the direction declares: a narrative shot's own, or the cutin over any arc shot.
// A graphic shot contributes its cutin alone. In clock order, a shot's main frame before its cutin.
export type ShotFrame = {
  shotId: string;
  lane: PanelLane;
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
};

// A frame as a finding or an error names it: the shot's own frame is the shot, a cutin is
// `<shotId>.cutin`, so a waiver written for one never silences the other.
export function frameSubject(frame: Pick<ShotFrame, "shotId" | "lane">): string {
  return frame.lane === "cutin" ? `${frame.shotId}.cutin` : frame.shotId;
}

function frameLabel(frame: Pick<ShotFrame, "shotId" | "lane">): string {
  return frame.lane === "cutin"
    ? `the cutin over shot "${frame.shotId}"`
    : `shot "${frame.shotId}"`;
}

export function collectShotFrames(direction: Direction): ShotFrame[] {
  return collectArcShots(direction).flatMap(shotFrames);
}

function shotFrames(s: ArcShot): ShotFrame[] {
  const frames: ShotFrame[] = [];
  if (!isGraphicShot(s)) {
    frames.push({
      shotId: s.id,
      lane: "main",
      setup: s.setup,
      lineup: s.lineup,
      ...(s.lineupTo ? { lineupTo: s.lineupTo } : {}),
      ...(s.join ? { join: s.join } : {}),
    });
  }
  if (s.cutin) {
    frames.push({
      shotId: s.id,
      lane: "cutin",
      setup: s.cutin.setup,
      lineup: s.cutin.lineup,
      ...(s.cutin.lineupTo ? { lineupTo: s.cutin.lineupTo } : {}),
      ...(s.cutin.join ? { join: s.cutin.join } : {}),
    });
  }
  return frames;
}

// False means the direction declares no shots — direction.ts is still the unwritten template.
export function directionHasShots(direction: Direction): boolean {
  return collectShots(direction).length > 0;
}

// All shot ids declared by the direction, asides included: they share one id namespace with the
// shots and the arc nodes, and a duplicate must be caught wherever it is declared.
function collectShotIds(direction: Direction): string[] {
  return collectShots(direction).map((s) => s.id);
}

// Every shot action in the direction — the prose the characters' `unused-character` check scans.
function collectActions(direction: Direction): string[] {
  return collectArcShots(direction).map((s) => s.action);
}

// The set of setup ids the frames point at — the `unused-setup` check's "used" signal (exact id
// membership, since a frame is named by id in `shot.setup`, not in the action prose).
function collectUsedSetupIds(direction: Direction): Set<string> {
  return new Set(collectShotFrames(direction).map((f) => f.setup));
}

// How many frames each setup is named by. The `setup-unrealized` check reads it: a frame two or more
// shots share is one they must be held to, a frame one shot uses has nothing to hold together. A
// cutin counts as one more shot on its setup.
function countShotsPerSetup(direction: Direction): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of collectShotFrames(direction)) {
    counts.set(f.setup, (counts.get(f.setup) ?? 0) + 1);
  }
  return counts;
}

// The set of location ids the shots reach — through their setups, since a shot names no place of its
// own. The `unused-location` check's "used" signal.
function collectUsedLocationIds(direction: Direction): Set<string> {
  const used = new Set<string>();
  for (const id of collectUsedSetupIds(direction)) {
    const location = direction.setups?.[id]?.location;
    if (location !== undefined) used.add(location);
  }
  return used;
}

// A keyed roster (characters / props) flattened into the DSL-free `{ id, name }` refs the anchored-
// entity checks take — the id is the record key.
function entityRefs(roster: Record<string, { name: string }> | undefined): AnchoredEntityRef[] {
  return Object.entries(roster ?? {}).map(([id, e]) => ({ id, name: e.name }));
}

function setupRefs(
  roster:
    | Record<
        string,
        {
          name: string;
          location: string;
          framing: string;
          holds?: readonly string[];
          within?: string | null;
        }
      >
    | undefined,
): SetupRef[] {
  return Object.entries(roster ?? {}).map(([id, s]) => ({
    id,
    name: s.name,
    location: s.location,
    framing: s.framing,
    holds: s.holds ?? [],
    ...(s.within != null ? { within: s.within } : {}),
  }));
}

// Character ids that speak in some shot's script — an unambiguous "used" signal for the characters check
// that needs no name-in-prose scan (a `{ character }` line names the character by id directly).
function collectScriptCharacterIds(direction: Direction): Set<string> {
  const ids = new Set<string>();
  for (const s of collectArcShots(direction)) {
    for (const line of s.script ?? []) {
      if ("character" in line) ids.add(line.character);
    }
  }
  return ids;
}

// Whether any shot declares a `{ narration }` line — the narrator's "is one needed" signal, the
// twin of `collectScriptCharacterIds` for the one speaker the roster cannot name.
function hasNarrationLines(direction: Direction): boolean {
  return collectArcShots(direction).some((s) =>
    (s.script ?? []).some((line) => "narration" in line),
  );
}

// The character roster flattened into the DSL-free voice refs `checkCharacterVoices` takes: the cast
// voice (null when none) and whether the piece gives this character lines.
function characterVoiceRefs(direction: Direction): CharacterVoiceRef[] {
  const speaking = collectScriptCharacterIds(direction);
  return Object.entries(direction.characters ?? {}).map(([id, c]) => ({
    id,
    name: c.name,
    voiceAssetId: c.voice?.id ?? null,
    speaks: speaking.has(id),
  }));
}

// The scripts (ISO 15924) a default system stack cannot be relied on to carry. Latin and Cyrillic
// ride on faces every desktop and container ships; these do not, and a host missing the face draws
// tofu. Keyed by SCRIPT, not by language: `zh-Latn` is pinyin and needs nothing, `en-Arab` is Arabic
// script and needs a face.
const SCRIPTS_NEEDING_A_DECLARED_FACE: ReadonlySet<string> = new Set([
  "Jpan",
  "Kore",
  "Hans",
  "Hant",
  "Hani",
  "Arab",
  "Hebr",
  "Deva",
  "Thai",
]);

// The piece is set in a script no default face carries, and names no family to carry it. One finding
// per piece, so it takes no subject: the waiver key is the bare `fonts-undeclared`.
function checkTypesetting(direction: Direction): DirectionFinding[] {
  if ((direction.policy?.fonts ?? []).length > 0) return [];
  const lang = direction.policy?.lang;
  if (!lang) return [];
  const script = scriptOf(lang);
  if (!SCRIPTS_NEEDING_A_DECLARED_FACE.has(script)) return [];
  return [
    {
      code: "fonts-undeclared",
      message:
        `policy.lang is "${lang}" (${script} script) but policy.fonts names no family. Text in ` +
        `this script falls to whatever face the rendering machine has installed, and a host ` +
        `without one draws tofu — declare one (e.g. "Noto Sans JP").`,
    },
  ];
}

// Shots whose script contradicts the declared speech policy. `none` forbids any script line;
// `no-dialogue` forbids spoken lines (`{character}`/`{speaker}`) while allowing `{narration}`; `free`
// imposes no constraint. A waivable finding (`unexpected-script_<shotId>`) so a deliberate exception
// is recorded, not silent.
function checkSpeech(direction: Direction): DirectionFinding[] {
  const speech = direction.policy?.speech;
  if (!speech || speech === "free") return [];
  const findings: DirectionFinding[] = [];
  for (const s of collectArcShots(direction)) {
    const lines = s.script ?? [];
    const offends =
      speech === "none"
        ? lines.length > 0
        : lines.some((line) => "character" in line || "speaker" in line);
    if (offends) {
      findings.push({
        code: "unexpected-script",
        subject: s.id,
        message:
          speech === "none"
            ? `shot ${s.id} declares script lines, but the direction's speech policy is "none" (no dialogue or narration)`
            : `shot ${s.id} declares a spoken line, but the direction's speech policy is "no-dialogue" (narration only)`,
      });
    }
  }
  return findings;
}

// How many sentence boundaries a shot's `action` holds — the fused-shot signal. A boundary is a run
// of terminators with prose after it: a CJK one (。．！？) followed by anything, an ASCII one (.!?)
// followed by a space and a capital or a non-ASCII letter. A trailing terminator is no boundary, so
// the count does not depend on how the last sentence ends. Stripped first: quoted speech (a line's
// "!" is not the action's), ellipses, decimals, a single letter's dot (initials, "U.S.", "e.g.") and
// the titles a capital follows ("Mr. Smith"). In-sentence fusion (a 連用形 chain, a comma splice) is
// deliberately out of scope — that is the guide's split test.
function countSentenceBreaks(action: string): number {
  const text = action
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, " ")
    .replace(/…+|\.{2,}/g, " ")
    .replace(/(\d)\.(\d)/g, "$1$2")
    .replace(/\b(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc)\./gi, " ")
    .replace(/\b[a-z]\./gi, " ");
  return (
    text.match(
      /[。．！？][。．！？!?.]*(?=\s*[^\s。．！？!?.」』）)］\]])|[!?.]+(?=\s+(?:[A-Z]|\P{ASCII}))/gu,
    )?.length ?? 0
  );
}

// A shot whose `action` reads as two or more sentences — the initial draft's habit of fusing an
// event and its reaction into one clip. A waivable finding (`multi-sentence-action_<shotId>`) so a
// deliberately two-sentence action is recorded, not silently split.
function checkFusedShots(direction: Direction): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const s of collectArcShots(direction)) {
    const breaks = countSentenceBreaks(s.action);
    if (breaks > 0) {
      findings.push({
        code: "multi-sentence-action",
        subject: s.id,
        message: `shot ${s.id}'s action reads as ${breaks + 1} sentences — a shot should land one action; split it into two shots`,
      });
    }
  }
  return findings;
}

// A shot whose `duration` is off the 0.5s grid, or not positive. A shot's span is a window the
// render cuts the take to, so the grid is the one every legal `fps` (a multiple of 8) lands a whole
// frame on. A waivable finding (`off-grid-duration_<shotId>`).
const DURATION_GRID = 0.5;

function checkDurations(direction: Direction): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const s of collectArcShots(direction)) {
    const steps = s.duration / DURATION_GRID;
    if (s.duration <= 0 || Math.abs(steps - Math.round(steps)) > 1e-9) {
      findings.push({
        code: "off-grid-duration",
        subject: s.id,
        message: `shot ${s.id} runs ${s.duration}s — a shot's span is a multiple of ${DURATION_GRID}s, at least ${DURATION_GRID}s, so it lands a whole frame at every fps; round it to the grid`,
      });
    }
  }
  return findings;
}

// The stage-side half of the staging class: what order the board actually passed each keyframe its
// references in. Built by the CLI and handed in, the way `realizedIds` and `animaticSetups` are —
// this module stays free of the dependency graph.
export type StagingStageState = {
  // One entry per developed keyframe, in panel order: the `reference:<id>` assets that panel takes,
  // in declaration order. Per PANEL, not per shot — one call's input order is what decides where a
  // subject lands, so two panels of a shot are two orders.
  panelSlots: readonly PanelSlots[];
  // The same panels read down the chain instead: every reference each one stands on. An inherited
  // keyframe answers for what it was handed, which is why `character-unconsumed` reads this and
  // `slot-order-mismatch` reads the slots.
  panelReach: readonly PanelReach[];
  // One entry per developed shot standing on a plated setup: whether its panels' prompts carry the
  // plate's own sentence.
  plateUses: readonly PlateUse[];
  // A fourth reading of the same panels: the conditioning text each one stands on, which
  // `subject-unnamed` looks for the frame's subjects in.
  panelPrompts: readonly PanelPrompts[];
  // The sentence each returned plate was written with, keyed by setup id — what `plate-unnamed`
  // reads for the landmarks that frame declares it holds.
  platePrompts: Readonly<Record<string, string>>;
  // The one reading that comes off the VIDEO rather than the board: which frames each developed
  // video shot pins, so `join-unpinned` can ask whether a declared long take is carried across its
  // seam. Empty where the direction declares no seam to judge, and empty too where video.tsx could
  // not be read — which is the one place stale-waiver detection is imprecise, since the class is
  // marked evaluated by the BOARD: a `join-unpinned` waiver reads stale while the video is broken.
  videoPins: readonly VideoShotPins[];
  // The seam reading: the two keyframes each developed shot answers a boundary with, and what the
  // opening one was handed of the frame before it. `join-unpinned` reads the opening keyframe as
  // the seam of a long take; `panel-unlinked` reads the rest against the `within` declarations.
  shotPanels: readonly ShotPanels[];
};

// Each camera frame with the boundary into it, per lane: the shot before it ON THE CLOCK (asides
// included, since an eyecatch dropped between two shots is a cut the narrative-only walk cannot
// see), that shot's frame in the same lane, and the frame this one could run on from in one unbroken
// take — that same frame, when it is on the same DECLARED setup. A main frame runs on only from a
// narrative shot, a cutin only from a cutin. An undeclared setup yields none: `setup-unknown`
// owns that frame, and two frames naming one missing id are not two frames of anything.
type JoinBoundary = {
  frame: ShotFrame;
  previous: Shot | undefined;
  previousFrame: ShotFrame | undefined;
  runOn: ShotFrame | undefined;
};

function joinBoundaries(direction: Direction): JoinBoundary[] {
  const out: JoinBoundary[] = [];
  let previous: Shot | undefined;
  let previousFrames: ShotFrame[] = [];
  for (const shot of collectShots(direction)) {
    const frames = isAsideShot(shot) ? [] : shotFrames(shot);
    for (const frame of frames) {
      const previousFrame = previousFrames.find((f) => f.lane === frame.lane);
      const runOn =
        previousFrame !== undefined &&
        previousFrame.setup === frame.setup &&
        direction.setups?.[frame.setup] !== undefined
          ? previousFrame
          : undefined;
      out.push({ frame, previous, previousFrame, runOn });
    }
    previous = shot;
    previousFrames = frames;
  }
  return out;
}

// The direction flattened to what the lineup accumulation reads — one entry per FRAME, a shot's main
// frame before its cutin. A frame whose setup names no declared location carries `undefined` —
// reported structurally as `setup-unknown`, and filed under no place here.
function lineupShots(direction: Direction): LineupShot[] {
  const actionById = new Map(collectArcShots(direction).map((s) => [s.id, s.action]));
  const continuedBy = continuedFrames(direction);
  return joinBoundaries(direction).map(({ frame, runOn }) => ({
    id: frame.shotId,
    frame: frame.lane,
    location: direction.setups?.[frame.setup]?.location,
    action: actionById.get(frame.shotId) ?? "",
    lineup: frame.lineup ?? [],
    ...(frame.lineupTo ? { lineupTo: frame.lineupTo } : {}),
    // A `continuous` at a boundary no unbroken take could cross is `join-impossible`. The seam
    // checks read the declaration only where it could be true, so a broken direction reports that
    // error rather than a mismatch at a seam the piece does not have.
    ...(frame.join && (frame.join !== "continuous" || runOn) ? { join: frame.join } : {}),
    ...(continuedBy.has(frameKey(frame)) ? { continuedBy: continuedBy.get(frameKey(frame)) } : {}),
  }));
}

const frameKey = (frame: Pick<ShotFrame, "shotId" | "lane">): string =>
  `${frame.shotId}/${frame.lane}`;

/**
 * Each frame the shot after it runs on from in one take, keyed `<shotId>/<lane>`, to that shot's id.
 * Only where the take is possible (`runOn`): a `continuous` written anywhere else is
 * `join-impossible`, not a seam.
 */
export function continuedFrames(direction: Direction): Map<string, string> {
  const out = new Map<string, string>();
  for (const { frame, runOn } of joinBoundaries(direction)) {
    if (frame.join === "continuous" && runOn) out.set(frameKey(runOn), frame.shotId);
  }
  return out;
}

// The staging findings: the declared lineups checked against each other, and the two the board
// feeds. "The prompt put the sweet behind the samurai" is a transcription fault the critic catches by
// reading `inspect --prompts`, and is not a finding here.
function checkStaging(
  direction: Direction,
  stage?: StagingStageState,
  referenceAssetNames?: readonly string[],
): DirectionFinding[] {
  const shots = lineupShots(direction);
  return [
    ...checkLineups(shots, {
      ...(stage
        ? {
            panelSlots: stage.panelSlots,
            panelReach: stage.panelReach,
            plateUses: stage.plateUses,
            panelPrompts: stage.panelPrompts,
            subjectPromptDepictions: subjectPromptDepictions(direction),
          }
        : {}),
      ...(referenceAssetNames ? { referenceAssetNames } : {}),
    }),
    // The setups roster alone: a landmark's place on screen is the camera's, not a shot's.
    ...checkLandmarkOrder(holdsSetupRefs(direction)),
    ...(stage ? checkPlateNaming(plateNamings(direction, stage.platePrompts)) : []),
    ...(stage ? checkJoinPins(shots, stage.videoPins, stage.shotPanels) : []),
    ...(stage ? checkPanelLinks(panelSeams(direction, stage.shotPanels)) : []),
  ];
}

// The word a prompt calls each character by, for the `subject-unnamed` scan. An entry with none is
// `character-empty-prompt-depiction`, a structural error, and is dropped here rather than matched
// as "".
function subjectPromptDepictions(direction: Direction): Map<string, string> {
  return new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.promptDepiction ?? ""]),
  );
}

// The setups in roster order, for the landmark accumulation. A frame set nowhere the roster declares
// is `setup-unknown-location`; it still files under its own raw id here, which is the only place its
// own frames could contradict each other.
function holdsSetupRefs(direction: Direction): HoldsSetupRef[] {
  return Object.entries(direction.setups ?? {}).map(([id, s]) => ({
    id,
    location: s.location,
    holds: s.holds ?? [],
  }));
}

// Each returned plate paired with what its setup declares that frame holds. A setup with no plate has
// no sentence to read, and one holding nothing (an `insert`) has nothing to look for.
function plateNamings(
  direction: Direction,
  platePrompts: Readonly<Record<string, string>>,
): PlateNaming[] {
  const out: PlateNaming[] = [];
  for (const [setupId, prompt] of Object.entries(platePrompts)) {
    const setup = direction.setups?.[setupId];
    if (!setup) continue;
    const landmarks = direction.locations?.[setup.location]?.landmarks ?? {};
    const holds = (setup.holds ?? []).flatMap((id) => {
      // An id the place does not declare is `holds-unknown-id`, a structural error; own keys only,
      // so an inherited name is not read as one.
      if (!Object.hasOwn(landmarks, id)) return [];
      return [{ id, promptDepiction: landmarks[id]!.promptDepiction ?? "" }];
    });
    if (holds.length === 0) continue;
    out.push({ setupId, prompt, holds });
  }
  return out;
}

// The cuts the `undeclared-continuity` skip waives through: adjacent shots of one leaf, no aside
// between them, two set-showing sizes of one place that the direction says are one camera. Walked
// here rather than in the arc engine because the plates that answer for them are the setups class's,
// and read on exactly the same terms as the skip so no pair falls between the two.
//
// A cutin lane is cut along its own axis the same way, read across the clock: two wipes over
// adjacent shots standing on two sizes of one axis owe the same plates.
function axisCuts(direction: Direction): AxisCut[] {
  const setups = direction.setups ?? {};
  const out: AxisCut[] = [];
  const push = (from: string, to: string) => {
    if (from === to) return;
    const a = setups[from];
    const b = setups[to];
    if (!a || !b) return;
    // Read on the skip's own terms, predicate for predicate: the place (a `within` crossing two of
    // them is `within-impossible`, and the skip guards the pair anyway), then the axis by the same
    // `withinRoot` — undefined on a ring, where the skip does not apply either — then the two
    // sizes. A pair one of the two walks and the other does not is a pair that falls between them.
    if (a.location !== b.location) return;
    const root = withinRoot(setups, from);
    if (root === undefined || root !== withinRoot(setups, to)) return;
    if (!EXPOSED_FRAMINGS.includes(a.framing) || !EXPOSED_FRAMINGS.includes(b.framing)) return;
    if (a.framing === b.framing) return;
    const chain = nestingChain(setups, from, to);
    const pair = [from, to].sort() as [string, string];
    if (chain) out.push({ pair, chain });
  };
  for (const leaf of collectLeaves(direction.sequence)) {
    let previous: NarrativeShot | undefined;
    for (const shot of leaf.shots ?? []) {
      // An aside or a graphic shot breaks the pair — the skip does not apply across one, so nothing
      // is owed either.
      if (isAsideShot(shot) || isGraphicShot(shot)) {
        previous = undefined;
        continue;
      }
      const before = previous;
      previous = shot;
      if (before !== undefined) push(before.setup, shot.setup);
    }
  }
  for (const { frame, previousFrame } of joinBoundaries(direction)) {
    if (frame.lane === "cutin" && previousFrame) push(previousFrame.setup, frame.setup);
  }
  return out;
}

// Both setups and every frame between them and the one they are both windows of. `undefined` where
// they stand on different axes — there is nothing to nest and the skip never applied.
function nestingChain(
  setups: Readonly<Record<string, Setup>>,
  from: string,
  to: string,
): string[] | undefined {
  const up = (id: string): string[] => {
    const path: string[] = [];
    let at = id;
    while (setups[at] !== undefined && !path.includes(at)) {
      path.push(at);
      const parent = setups[at]!.within;
      if (parent == null) return path;
      at = parent;
    }
    return path;
  };
  const fromPath = up(from);
  const toPath = up(to);
  // The nearest frame both are windows of. Their roots agreeing is what "one axis" means, so a meet
  // deeper than the root only shortens what has to be plated.
  const meet = fromPath.find((id) => toPath.includes(id));
  if (meet === undefined) return undefined;
  const take = (path: string[]) => path.slice(0, path.indexOf(meet) + 1);
  return [...new Set([...take(fromPath), ...take(toPath)])];
}

// The cuts a frame has to carry across, paired with what the board did about them: an omitted join
// across two setups on ONE `within` axis — story time runs on and the camera has moved only along
// that axis. The plate nesting already carries the room (`plate-unnested`); what the frame before
// it carries is the subject — her light, her size against the set, where she stands.
//
// `"continuous"` owes the board nothing here: the seam is the next shot's opening keyframe, and the
// take before landing on it is the video's to answer (`join-unpinned`). A story-time jump
// carries nothing (she may have moved), a second axis is a different camera, two frames holding no
// subject in common have no subject to carry, and an aside between the two shots is a card the take
// does not run through. A seam is judged only where both shots are on the board and the opening
// keyframe has a slot for the frame — the rest is not this finding's to report.
//
// Each lane is its own camera: a wipe carries across the seam from the wipe before it, and a main
// frame from the main frame before it.
function panelSeams(direction: Direction, continuity: readonly ShotPanels[]): PanelSeam[] {
  const setups = direction.setups ?? {};
  const byFrame = new Map(continuity.map((entry) => [`${entry.shotId}/${entry.lane}`, entry]));
  const out: PanelSeam[] = [];
  for (const { frame, previousFrame } of joinBoundaries(direction)) {
    if (previousFrame === undefined) continue;
    const here = byFrame.get(`${frame.shotId}/${frame.lane}`);
    const before = byFrame.get(`${previousFrame.shotId}/${previousFrame.lane}`);
    if (!here?.carries || !before) continue;
    if (!isAxisCut(setups, frame, previousFrame)) continue;
    if (!sharesSubject(previousFrame, frame)) continue;
    out.push({
      id: frame.shotId,
      lane: frame.lane,
      from: previousFrame.shotId,
      fromPanel: before.lastPanel,
      linked: here.linked,
    });
  }
  return out;
}

// An omitted join between two different setups of one `within` axis. Anything the author wrote at the
// boundary moves story time or is no cut, and two frames of one setup are `join-undeclared` until
// they say which.
function isAxisCut(
  setups: Readonly<Record<string, Setup>>,
  frame: ShotFrame,
  previous: ShotFrame,
): boolean {
  if (frame.join !== undefined) return false;
  if (previous.setup === frame.setup) return false;
  const root = withinRoot(setups, frame.setup);
  return root !== undefined && root === withinRoot(setups, previous.setup);
}

// Two frames that both hold subjects but none in common — a cut from one face to another — carry
// nothing across. A frame with no subject declared may still hold a prop, so it is read as sharing.
function sharesSubject(previous: ShotFrame, frame: ShotFrame): boolean {
  const before = previous.lineupTo ?? previous.lineup;
  if (before.length === 0 || frame.lineup.length === 0) return true;
  return frame.lineup.some((id) => before.includes(id));
}

function lensSpecErrors(lens: LensSpec<string>, who: string): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  if (lens.beats.length === 0) {
    errors.push({
      code: "empty-beats",
      subject: lens.name,
      message: `${who} "${lens.name}" has no beats`,
    });
    return errors;
  }
  if (!lens.beats.some((b) => b.role === lens.payoff)) {
    errors.push({
      code: "payoff-not-in-beats",
      subject: lens.name,
      message: `${who} "${lens.name}" declares payoff "${lens.payoff}", which is not one of its beats`,
    });
  }
  // A beat carries the dramatic function its role performs, so a lens whose declared climax is a
  // grounding or settling role is misusing the vocabulary — a definition bug, never a creative
  // call. A container beat with no `fn` is exempt — it claims no function to contradict.
  const payoffFunction = lens.beats.find((b) => b.role === lens.payoff)?.fn;
  if (payoffFunction !== undefined && payoffFunction !== "payoff") {
    errors.push({
      code: "payoff-function-mismatch",
      subject: lens.name,
      message: `${who} "${lens.name}" declares payoff "${lens.payoff}", a ${payoffFunction} role — the climax must be a payoff-function role`,
    });
  }
  // Share bounds are fractions of the total, so an out-of-[0,1] value or an inverted min/max is a
  // lens-definition bug (never a creative call) — the act-ratio check would then be meaningless or
  // dead. Hard-fail it here alongside the other LensSpec validity errors.
  for (const beat of lens.beats) {
    for (const [field, value] of [
      ["minShare", beat.minShare],
      ["maxShare", beat.maxShare],
    ] as const) {
      if (value !== undefined && (value < 0 || value > 1)) {
        errors.push({
          code: "invalid-share",
          subject: `${lens.name}.${beat.role}`,
          message: `${who} "${lens.name}" beat "${beat.role}" has ${field} ${value}, which must be a fraction in [0, 1]`,
        });
      }
    }
    if (
      beat.minShare !== undefined &&
      beat.maxShare !== undefined &&
      beat.minShare > beat.maxShare
    ) {
      errors.push({
        code: "invalid-share",
        subject: `${lens.name}.${beat.role}`,
        message: `${who} "${lens.name}" beat "${beat.role}" has minShare ${beat.minShare} greater than maxShare ${beat.maxShare}`,
      });
    }
  }
  return errors;
}

// How wide each framing is, for the `within` axis. `insert` is off the axis: it holds nothing, so it
// is neither a window nor a frame one is cut from, and answers `undefined` at both ends.
const FRAMING_WIDTH: Record<string, number> = { wide: 0, medium: 1, close: 2 };

// The shape a push-in on one axis leaves in the two `holds`. A reverse angle (the same landmarks
// the other way round) and an angle from the side (a landmark the wider frame does not carry) both
// fail it, which is what keeps them out of the `within-undeclared` candidate set.
function isOrderedSubsequence(inner: readonly string[], outer: readonly string[]): boolean {
  let at = 0;
  for (const id of outer) {
    if (at < inner.length && inner[at] === id) at++;
  }
  return at === inner.length;
}

// The setups a given one could step in from: same place, strictly wider, and carrying this frame's
// `holds` in order. Only a candidate SET — it decides whether the author owes a declaration, never
// whether the one they wrote is right. A window may legitimately hold a landmark too small to have
// been declared in the frame it is cut from, so a `within` outside this set is not an error.
function withinCandidates(setups: Record<string, Setup>, id: string, setup: Setup): string[] {
  const width = FRAMING_WIDTH[setup.framing];
  if (width === undefined) return [];
  return Object.entries(setups)
    .filter(([otherId, other]) => {
      if (otherId === id || other.location !== setup.location) return false;
      const otherWidth = FRAMING_WIDTH[other.framing];
      return otherWidth !== undefined && otherWidth < width;
    })
    .filter(([, other]) => isOrderedSubsequence(setup.holds ?? [], other.holds ?? []))
    .map(([otherId]) => otherId);
}

// The root of a setup's `within` chain — the widest frame it is a window of, and the id of the camera
// axis it stands on. A setup declaring `within: null` is its own root, and so is one whose chain
// leaves the roster. Guarded against a ring (`within-cyclic` reports it; this must still answer).
export function withinRoot(
  setups: Readonly<Record<string, Setup>>,
  id: string,
): string | undefined {
  const seen = new Set<string>();
  let at = id;
  while (setups[at] !== undefined && !seen.has(at)) {
    seen.add(at);
    // An omitted `within` is a root as much as an explicit `null`: it is legal only where no wider
    // frame could hold this one, which is what being the root of an axis means.
    const parent = setups[at]!.within;
    if (parent == null) return at;
    at = parent;
  }
  // A chain that leaves the roster (`within-impossible`) or rings (`within-cyclic`) names no axis.
  return undefined;
}

// The `within` axis: a window declares the frame it is cut out of, and konte checks the declaration
// rather than deriving it.
function withinErrors(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const setups = direction.setups ?? {};
  for (const [id, setup] of Object.entries(setups)) {
    // A frame set nowhere the roster declares is `setup-unknown-location`; asking it about its
    // window on top of that names the wrong fix.
    if (direction.locations?.[setup.location] === undefined) continue;
    const within = setup.within;
    if (within === undefined) {
      // An `insert` is off the axis, so it owes no declaration however its empty `holds` nests.
      if (setup.framing === "insert") continue;
      const candidates = withinCandidates(setups, id, setup);
      if (candidates.length === 0) continue;
      errors.push({
        code: "within-undeclared",
        subject: id,
        message:
          `setup "${id}" could be a step in from ${candidates.map((c) => `"${c}"`).join(", ")} — ` +
          `same place, wider, and holding what this frame holds. Say which: \`within: "<id>"\` for the ` +
          `frame this one steps in from, or \`within: null\` if it is the root of its own camera axis`,
      });
      continue;
    }
    if (within === null) continue;
    const impossible = (why: string) =>
      errors.push({
        code: "within-impossible",
        subject: id,
        message: `setup "${id}" declares \`within: "${within}"\`, but ${why}`,
      });
    if (setup.framing === "insert") {
      impossible(
        "an insert fills the frame with one object and shows no set, so it holds nothing and is no " +
          "window on another frame — drop the `within`",
      );
      continue;
    }
    const target = setups[within];
    if (target === undefined) {
      impossible("that is not a declared setup");
      continue;
    }
    if (target.location !== setup.location) {
      impossible(
        `"${within}" is set in "${target.location}" while this frame is in "${setup.location}" — a ` +
          `window is cut out of a frame of the same place`,
      );
      continue;
    }
    const width = FRAMING_WIDTH[setup.framing];
    const targetWidth = FRAMING_WIDTH[target.framing];
    if (width === undefined || targetWidth === undefined || targetWidth >= width) {
      impossible(
        `"${within}" is ${target.framing} and this frame is ${setup.framing} — a window is cut out ` +
          `of a strictly wider frame (wide, then medium, then close; an insert is off the axis)`,
      );
    }
  }

  // Only reachable through a computed roster: the framing order is strict, so a literal chain cannot
  // close on itself. Reported once per setup on the ring, so no reader has to walk it.
  for (const id of Object.keys(setups)) {
    const seen = new Set<string>();
    let at: string | undefined = id;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      at = setups[at]?.within ?? undefined;
    }
    if (at !== id) continue;
    errors.push({
      code: "within-cyclic",
      subject: id,
      message: `setup "${id}" is cut out of itself — its \`within\` chain leads back to it`,
    });
  }
  return errors;
}

// Hard, never-waivable structural validity (DirectionErrorCode). Returns errors instead of throwing
// so doctor can report them and the gate can decide to abort.
export function validateDirectionStructure(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];

  const shots = collectShots(direction);
  // A blank label leaves an unnamed hole in the runtime.
  for (const s of shots) {
    if (isAsideShot(s) && s.label.trim() === "") {
      errors.push({
        code: "aside-empty-label",
        subject: s.id,
        message: `aside "${s.id}" has an empty label — name what occupies the clock here`,
      });
    }
  }

  const shotIds = collectShotIds(direction);
  if (shotIds.length === 0) {
    errors.push({
      code: "empty-direction",
      message: "direction is empty — declare at least one shot",
    });
  }

  // Ids are globally unique across the whole tree: every child node's id and every shot id share one
  // namespace (a shot placeholder and a sequence review address must never collide).
  const nodeIds = collectNodes(direction.sequence)
    .map((n) => n.id)
    .filter((id): id is string => id !== undefined);
  const ids = [...nodeIds, ...shotIds];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push({
        code: "duplicate-id",
        subject: id,
        message: `id "${id}" is declared more than once`,
      });
    }
    seen.add(id);
  }

  // A waiver names the finding it cancels, so its code half must be one the checker can emit. A key
  // that names none silences nothing and never will — the finding stays active while the key adds a
  // part to review, which reads as "waived" to everyone but the checker. Structural: no pass can make
  // an unknown code fire, so it is never the soft `staleWaivers` case ("the finding is gone").
  for (const node of collectNodes(direction.sequence)) {
    for (const key of Object.keys(node.waivers ?? {})) {
      if (isWaivableCode(waiverKeyCode(key))) continue;
      const suggestion = waiverKeySuggestion(key);
      errors.push({
        code: "waiver-unknown-code",
        subject: key,
        message:
          `waiver "${key}" names no finding code` +
          (suggestion
            ? ` — did you mean "${suggestion}"?`
            : " — copy the [bracketed] key konte prints with the finding"),
      });
    }
  }

  // The characters are a hard contract: an `id` (the roster key) must be a valid asset name (it maps
  // to reference:<id>), and `name`/`description` must be non-empty — an empty `name` would make the
  // `unused-character` action scan silently pass (every string contains ""). The record key makes a
  // duplicate id structurally impossible, so there is no duplicate-id check here.
  // Every cast voice's reference asset name, so the namespace conflict check below sees them too.
  // Two members sharing ONE id is deliberate and allowed — a narrator who is the protagonist, twins —
  // and their `description`s are two performance briefs on one sample, not a contradiction.
  const seenVoiceIds = new Set<string>();
  const checkVoice = (
    voice: { id: string; description: string } | undefined,
    label: string,
    codes: { invalidId: DirectionErrorCode; emptyDescription: DirectionErrorCode },
    subject: string | undefined,
  ) => {
    if (!voice) return;
    if (!isIdentifier(voice.id)) {
      errors.push({
        code: codes.invalidId,
        ...(subject ? { subject } : {}),
        message: `voice id "${voice.id}" (${label}) must be a valid asset name (a-z, A-Z, 0-9, -, _) so it can map to reference:${voice.id}`,
      });
    }
    seenVoiceIds.add(voice.id);
    if (voice.description.trim() === "") {
      errors.push({
        code: codes.emptyDescription,
        ...(subject ? { subject } : {}),
        message: `the voice cast for ${label} has an empty description — say how it sounds (sex, age, timbre, pace), or drop the voice`,
      });
    }
  };

  const seenCharacterIds = new Set<string>();
  // `key` is the form the naming checks match on.
  const declaredDepictions: {
    subject: string;
    kind: "character" | "landmark";
    depiction: string;
    key: string;
  }[] = [];
  for (const [id, character] of Object.entries(direction.characters ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "character-invalid-id",
        subject: id,
        message: `character id "${id}" must be a valid asset name (a-z, A-Z, 0-9, -, _) so it can map to reference:${id}`,
      });
    }
    seenCharacterIds.add(id);
    if (character.name.trim() === "") {
      errors.push({
        code: "character-empty-name",
        subject: id,
        message: `character "${id}" has an empty name — synopses refer to it by this token`,
      });
    }
    if (character.description.trim() === "") {
      errors.push({
        code: "character-empty-description",
        subject: id,
        message: `character "${id}" has an empty description`,
      });
    }
    if ((character.promptDepiction ?? "").trim() === "") {
      errors.push({
        code: "character-empty-prompt-depiction",
        subject: id,
        message: `character "${id}" has no \`promptDepiction\` — a prompt is written in the model's language and \`name\` is not, so declare a noun the model can draw them by (a role or a proper name is one it has no look for)`,
      });
    } else {
      declaredDepictions.push({
        subject: id,
        kind: "character",
        depiction: character.promptDepiction,
        key: character.promptDepiction.trim().toLowerCase(),
      });
    }
    checkVoice(
      character.voice,
      `character "${id}"`,
      {
        invalidId: "character-voice-invalid-id",
        emptyDescription: "character-voice-empty-description",
      },
      id,
    );
  }

  checkVoice(
    direction.narrator,
    "the narrator",
    { invalidId: "narrator-invalid-id", emptyDescription: "narrator-empty-description" },
    undefined,
  );

  // Props are the same hard contract as the characters — an `id` (the roster key) maps to
  // reference:<id>, `name`/`description` are non-empty. Their `id`s share the reference namespace
  // with the characters, so a prop id that collides with a character id would name the same reference
  // asset for two entities: a hard error, reported by the three-way conflict check below. As with
  // characters, the record key rules out a within-roster duplicate id.
  const seenPropIds = new Set<string>();
  for (const [id, prop] of Object.entries(direction.props ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "prop-invalid-id",
        subject: id,
        message: `prop id "${id}" must be a valid asset name (a-z, A-Z, 0-9, -, _) so it can map to reference:${id}`,
      });
    }
    seenPropIds.add(id);
    if (prop.name.trim() === "") {
      errors.push({
        code: "prop-empty-name",
        subject: id,
        message: `prop "${id}" has an empty name — synopses refer to it by this token`,
      });
    }
    if (prop.description.trim() === "") {
      errors.push({
        code: "prop-empty-description",
        subject: id,
        message: `prop "${id}" has an empty description`,
      });
    }
  }

  // Locations are the same hard contract as the characters and props — an `id` (the roster key) maps
  // to reference:<id>, `name`/`description` are non-empty. The record key rules out a within-roster
  // duplicate id; cross-roster collisions are the three-way conflict check below.
  const seenLocationIds = new Set<string>();
  // Every landmark id, with the places that declare it — the direction has one id space, so a second
  // declarant is a collision rather than a second thing of the same name.
  const seenLandmarkLocations = new Map<string, string[]>();
  for (const [id, location] of Object.entries(direction.locations ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "location-invalid-id",
        subject: id,
        message: `location id "${id}" must be a valid asset name (a-z, A-Z, 0-9, -, _) so it can map to reference:${id}`,
      });
    }
    seenLocationIds.add(id);
    if (location.name.trim() === "") {
      errors.push({
        code: "location-empty-name",
        subject: id,
        message: `location "${id}" has an empty name`,
      });
    }
    if (location.description.trim() === "") {
      errors.push({
        code: "location-empty-description",
        subject: id,
        message: `location "${id}" has an empty description`,
      });
    }
    // A place with nothing only it has in it is a place no frame can be recognized as. Required and
    // non-empty, because the cost is one id and every setup in it names from this list.
    const landmarks = Object.entries(location.landmarks ?? {});
    if (landmarks.length === 0) {
      errors.push({
        code: "landmarks-empty",
        subject: id,
        message: `location "${id}" declares no \`landmarks\` — name what only this place has, or every frame taken here comes back as some other room`,
      });
    }
    for (const [landmarkId, landmark] of landmarks) {
      seenLandmarkLocations.set(landmarkId, [...(seenLandmarkLocations.get(landmarkId) ?? []), id]);
      const subject = `${id}.${landmarkId}`;
      if (!isIdentifier(landmarkId)) {
        errors.push({
          code: "landmark-invalid-id",
          subject,
          message: `landmark id "${landmarkId}" must be a valid identifier (a-z, A-Z, 0-9, -, _) so a setup's \`holds\` can name it`,
        });
      }
      if (landmark.name.trim() === "") {
        errors.push({
          code: "landmark-empty-name",
          subject,
          message: `landmark "${subject}" has an empty name`,
        });
      }
      if (landmark.description.trim() === "") {
        errors.push({
          code: "landmark-empty-description",
          subject,
          message: `landmark "${subject}" has an empty description — say where it stands and what it looks like`,
        });
      }
      if ((landmark.promptDepiction ?? "").trim() === "") {
        errors.push({
          code: "landmark-empty-prompt-depiction",
          subject,
          message: `landmark "${subject}" has no \`promptDepiction\` — declare a noun the model can draw it by`,
        });
      } else {
        declaredDepictions.push({
          subject,
          kind: "landmark",
          depiction: landmark.promptDepiction,
          key: landmark.promptDepiction.trim().toLowerCase(),
        });
      }
    }
  }

  // Characters, props, and locations share the `reference:<id>` namespace, so one id declared in two
  // of the rosters would name the same reference asset for two entities. Report each collision once,
  // naming the two rosters it appears in.
  for (const id of seenPropIds) {
    if (seenCharacterIds.has(id)) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: `id "${id}" is declared as both a character and a prop — both map to reference:${id}`,
      });
    }
  }
  for (const id of seenLocationIds) {
    if (seenCharacterIds.has(id)) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: `id "${id}" is declared as both a character and a location — both map to reference:${id}`,
      });
    }
    if (seenPropIds.has(id)) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: `id "${id}" is declared as both a prop and a location — both map to reference:${id}`,
      });
    }
  }
  // A cast voice names a reference asset too, so it shares that namespace with the three rosters: a
  // voice id equal to a roster id would make one asset both the look and the sound.
  for (const id of seenVoiceIds) {
    const roster = seenCharacterIds.has(id)
      ? "character"
      : seenPropIds.has(id)
        ? "prop"
        : seenLocationIds.has(id)
          ? "location"
          : null;
    if (roster) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: `id "${id}" is cast as a voice and declared as a ${roster} — both map to reference:${id}`,
      });
    }
  }

  // A landmark maps to no reference asset, so it joins none of the checks above — but the direction
  // keeps ONE id space, so a landmark named after a character, a prop, a place, or a landmark of
  // another place makes two things answer to one word in a prompt.
  for (const [landmarkId, declaredIn] of seenLandmarkLocations) {
    if (declaredIn.length > 1) {
      errors.push({
        code: "landmark-id-conflict",
        subject: landmarkId,
        message: `id "${landmarkId}" is declared as a landmark of ${declaredIn.map((id) => `"${id}"`).join(" and ")} — the direction has one id space, so give each its own`,
      });
    }
    const roster = seenCharacterIds.has(landmarkId)
      ? "character"
      : seenPropIds.has(landmarkId)
        ? "prop"
        : seenLocationIds.has(landmarkId)
          ? "location"
          : null;
    if (roster) {
      errors.push({
        code: "landmark-id-conflict",
        subject: landmarkId,
        message: `id "${landmarkId}" is declared as both a landmark and a ${roster} — the direction has one id space`,
      });
    }
  }

  // Both naming checks read a prompt for a declared depiction anywhere in it, so one contained in
  // another is undecidable: a prompt that says only "girl in a purple hoodie" also answers for a
  // bare "girl". One depiction space across both rosters, since a panel's prompt carries its plate's
  // sentence as well.
  for (let i = 0; i < declaredDepictions.length; i++) {
    for (let j = i + 1; j < declaredDepictions.length; j++) {
      const first = declaredDepictions[i]!;
      const second = declaredDepictions[j]!;
      const [outer, inner] =
        first.key.length >= second.key.length ? [first, second] : [second, first];
      if (!outer.key.includes(inner.key)) continue;
      errors.push({
        code: "prompt-depiction-conflict",
        subject: inner.subject,
        message:
          `${inner.kind} "${inner.subject}" and ${outer.kind} "${outer.subject}" declare ` +
          `\`promptDepiction\` "${inner.depiction}" and "${outer.depiction}" — a prompt naming the ` +
          `second names the first too, so no scan can tell them apart. Give each a depiction neither ` +
          `contains`,
      });
    }
  }

  // Setups are the same hard contract minus the reference mapping — a setup's plate is an animatic
  // timeline asset, so its id lives in its own namespace and joins no conflict check above. The
  // `location` it names must still be a declared one: a frame is always somewhere.
  const seenSetupIds = new Set<string>();
  for (const [id, setup] of Object.entries(direction.setups ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "setup-invalid-id",
        subject: id,
        message: `setup id "${id}" must be a valid asset name (a-z, A-Z, 0-9, -, _) so it can map to animatic:plate.${id}`,
      });
    }
    seenSetupIds.add(id);
    if (setup.name.trim() === "") {
      errors.push({
        code: "setup-empty-name",
        subject: id,
        message: `setup "${id}" has an empty name`,
      });
    }
    if (setup.description.trim() === "") {
      errors.push({
        code: "setup-empty-description",
        subject: id,
        message: `setup "${id}" has an empty description`,
      });
    }
    if (seenLocationIds.size > 0 && !seenLocationIds.has(setup.location)) {
      errors.push({
        code: "setup-unknown-location",
        subject: id,
        message: `setup "${id}" is set in location "${setup.location}", which is not a declared location`,
      });
    }
    // What the frame carries of its set, left to right. An `insert` fills the frame with one object
    // and shows no set, so it is the one framing with nothing to hold.
    const holds = setup.holds ?? [];
    if (holds.length === 0 && setup.framing !== "insert") {
      errors.push({
        code: "holds-empty",
        subject: id,
        message: `setup "${id}" holds nothing — name the landmarks of "${setup.location}" this ${setup.framing} frame carries, left to right, or the frame has nothing in it that says which place it is`,
      });
    }
    // Only against a declared place: an unknown one is `setup-unknown-location`, and reporting every
    // id as unknown as well would name the wrong fix.
    const landmarksHere = direction.locations?.[setup.location]?.landmarks;
    if (landmarksHere) {
      // Own keys only: `in` would answer true for "toString", letting a computed `holds` name an
      // inherited function that every reader after this then treats as a landmark.
      const declared = new Set(Object.keys(landmarksHere));
      for (const landmarkId of holds) {
        if (declared.has(landmarkId)) continue;
        errors.push({
          code: "holds-unknown-id",
          subject: `${id}:${landmarkId}`,
          message: `setup "${id}" holds "${landmarkId}", which is not a landmark of "${setup.location}" — a frame carries what its own place has`,
        });
      }
    }
  }

  errors.push(...withinErrors(direction));

  // Every shot is taken from somewhere: `shot.setup` is required and must resolve to a declared setup.
  // An empty roster (while shots exist) is `setup-empty` — reported once rather than as one
  // `setup-unknown` per shot; a non-empty roster reports each shot whose `setup` is not in it.
  if (seenSetupIds.size === 0) {
    if (shotIds.length > 0) {
      errors.push({
        code: "setup-empty",
        message:
          "direction declares no setups — every shot points at one, so declare at least one setup",
      });
    }
  } else {
    for (const f of collectShotFrames(direction)) {
      if (!seenSetupIds.has(f.setup)) {
        errors.push({
          code: "setup-unknown",
          subject: frameSubject(f),
          message: `${frameLabel(f)} has setup "${f.setup}", which is not a declared setup`,
        });
      }
    }
  }

  // A location with no setup in it is unreachable — every shot arrives through a setup, so the roster
  // entry could never be used. Reported once the setups roster is non-empty (an empty one is already
  // `setup-empty`).
  if (seenLocationIds.size === 0 && seenSetupIds.size > 0) {
    errors.push({
      code: "location-empty",
      message:
        "direction declares no locations — every setup is set in one, so declare at least one location",
    });
  }

  // The lineups. All three faults are "this declares nothing usable" — a shot with no `lineup` at
  // all, an id no character roster holds, a subject listed twice — so none is a creative call and
  // none is waivable. The type layer requires the field and blames a bad id at the position it was
  // written; this catches a computed direction, and a roster typed rather than literal.
  for (const f of collectShotFrames(direction)) {
    const where = frameLabel(f);
    if (!f.lineup) {
      errors.push({
        code: "lineup-missing",
        subject: frameSubject(f),
        message:
          `${where} declares no \`lineup\` — every frame states who it holds, left to right; ` +
          `write \`[]\` where it holds no one`,
      });
    }
    for (const [field, lineup] of [
      ["lineup", f.lineup],
      ["lineupTo", f.lineupTo],
    ] as const) {
      if (!lineup) continue;
      const seen = new Set<string>();
      for (const subjectId of lineup) {
        if (!seenCharacterIds.has(subjectId)) {
          errors.push({
            code: "lineup-unknown-id",
            subject: `${frameSubject(f)}:${subjectId}`,
            message:
              `${where} lines up "${subjectId}", which is not a declared character. A prop is ` +
              `not lined up — write where it sits relative to whoever holds or set it down`,
          });
        }
        if (seen.has(subjectId)) {
          errors.push({
            code: "lineup-duplicate",
            subject: `${frameSubject(f)}:${subjectId}`,
            message: `${where} lists "${subjectId}" twice in \`${field}\` — one subject stands in one place`,
          });
        }
        seen.add(subjectId);
      }
    }
  }

  // Where a long take is possible, omission is the one reading nothing could mean, so the boundary
  // has to choose one of the three.
  for (const { frame, previous, previousFrame, runOn } of joinBoundaries(direction)) {
    // Asking a frame whose setup is not declared about its join on top of `setup-unknown` names the
    // wrong fix.
    if (direction.setups?.[frame.setup] === undefined) continue;
    const where = frameLabel(frame);
    const field = frame.lane === "cutin" ? "cutin.join" : "join";
    if (frame.join === "continuous" && !runOn) {
      const why =
        previous === undefined
          ? "it opens the piece, so there is no take before it to run on from"
          : isAsideShot(previous)
            ? `"${previous.id}" before it is an aside, and a take does not run through one`
            : previousFrame === undefined
              ? frame.lane === "cutin"
                ? `"${previous.id}" before it carries no cutin, so there is no wipe to run on from`
                : `"${previous.id}" before it is a graphic shot, and a take does not run through one`
              : `it sits on setup "${frame.setup}" while ${frameLabel(previousFrame)} before it is ` +
                `on "${previousFrame.setup}" — one take is one camera position, so a hold that ` +
                `moves is written as two panels inside one shot`;
      errors.push({
        code: "join-impossible",
        subject: frameSubject(frame),
        message: `${where} declares \`${field}: "continuous"\`, but ${why}`,
      });
    } else if (runOn && frame.join === undefined) {
      errors.push({
        code: "join-undeclared",
        subject: frameSubject(frame),
        message:
          `${where} follows ${frameLabel(runOn)} on the same setup "${frame.setup}", so ` +
          `\`${field}\` has to say what the boundary is: "continuous" for one unbroken take, ` +
          `"jump-forward" for a jump cut or a gap in story time, "jump-back" into a flashback`,
      });
    }
  }

  // Script lines carry the shot's spoken words. Each must have non-empty text, and a line attributed
  // to a character must name a declared character (so it maps to reference:<id>).
  for (const s of collectArcShots(direction)) {
    for (const line of s.script ?? []) {
      if ("character" in line) {
        // A blank `acting` directs nothing and hides on every review surface, while still riding the
        // shot's hash — the same typo `script-empty-text` catches in the words themselves.
        if (line.acting !== undefined && line.acting.trim() === "") {
          errors.push({
            code: "script-empty-text",
            subject: s.id,
            message: `shot "${s.id}" has a script line with an empty \`acting\` note — say how it is said, or drop the field`,
          });
        }
        if (!seenCharacterIds.has(line.character)) {
          errors.push({
            code: "script-unknown-character",
            subject: `${s.id}:${line.character}`,
            message: `shot "${s.id}" has a script line spoken by "${line.character}", which is not a declared character`,
          });
        }
        if (line.text.trim() === "") {
          errors.push({
            code: "script-empty-text",
            subject: s.id,
            message: `shot "${s.id}" has a script line for "${line.character}" with empty text`,
          });
        }
      } else if ("speaker" in line) {
        if (line.text.trim() === "") {
          errors.push({
            code: "script-empty-text",
            subject: s.id,
            message: `shot "${s.id}" has a script line for "${line.speaker}" with empty text`,
          });
        }
      } else if (line.narration.trim() === "") {
        errors.push({
          code: "script-empty-text",
          subject: s.id,
          message: `shot "${s.id}" has a narration line with empty text`,
        });
      }
    }
  }

  // Telop is the one word-bearing field BOTH kinds of shot carry (a title card's own words are
  // telop), so it is checked over every shot rather than with the script above.
  for (const s of collectShots(direction)) {
    for (const text of s.telop ?? []) {
      if (text.trim() === "") {
        errors.push({
          code: "telop-empty-text",
          subject: s.id,
          message: `shot "${s.id}" has a telop entry with empty text`,
        });
      }
    }
  }

  // Every node names a lens; resolve and validate each. A node's id (absent on the root) qualifies
  // the "unknown lens" message so a reader knows which node it fired on.
  for (const node of collectNodes(direction.sequence)) {
    const lens = resolveLens(node.lens, direction.lenses);
    if (!lens) {
      errors.push({
        code: "unknown-lens",
        subject: node.lens,
        message: node.id
          ? `sequence "${node.id}" uses unknown lens "${node.lens}"`
          : `unknown lens "${node.lens}"`,
      });
    } else {
      errors.push(...lensSpecErrors(lens, "lens"));
    }
  }

  return errors;
}

// A fold group pairs an arc's findings with the waiver bag that cancels them. `classFilter`, when
// set, restricts stale-waiver detection to those classes — used where a bag is shared (a sequenced
// direction's top-level `direction.waivers`, folded by both the meta arc and the global characters).
type FoldGroup = {
  findings: DirectionFinding[];
  waivers: Record<string, string>;
  path?: readonly string[];
  classFilter?: Set<DirectionFindingClass>;
};

// One node of the arc tree the checker walks. A leaf carries shot `items`; an internal node carries
// child `nodes` and appears as an item in its parent's arc (`item`). The walk is generic over depth:
// `buildArcTree` produces a depth-1 (flat) or depth-2 (sequenced) tree today, but duration
// derivation, the arc check, and waiver folding all recurse — so nesting the DSL deeper later (an act
// of acts, toward true long-form) changes only the builder below, not the engine. `lens` is optional
// so an unresolved lens name (a structural error reported elsewhere) skips that node's own arc while
// its children are still checked.
type ArcNode = {
  item?: { id: string; role: string; synopsis: string };
  lens?: LensSpec<string>;
  noun: string;
  waivers: Record<string, string>;
  path: readonly string[];
  classFilter?: Set<DirectionFindingClass>;
  items?: ArcItem<string>[];
  // Every shot this node declares, in direction order, asides included — what the stage-coverage
  // checks compare `realizedIds` against. Kept apart from `items` (narrative only): dropping an
  // aside from `items` must not also drop it from coverage. A branch has no shots and leaves it
  // undefined; the engine then covers its `items`, which are its children.
  coverageIds?: readonly string[];
  realizedIds?: readonly string[];
  nodes?: ArcNode[];
};

// A node's total duration: a leaf sums its shots, an internal node sums its children (recursively),
// so an act-ratio share reads the true shape at every scale. It sums `items`, so an aside's span is
// outside it at every scale.
function nodeDuration(node: ArcNode): number {
  if (node.items) return node.items.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  return (node.nodes ?? []).reduce((sum, n) => sum + nodeDuration(n), 0);
}

// Normalize a loaded direction's node tree into the arc tree. A leaf node (`shots`) → a leaf arc
// checked against its lens, seeing `realizedIds` so its stage/completeness checks run. A branch node
// (`sequences`) → an internal arc over one child per sub-node, checked against its lens. The
// recursion is depth-agnostic, so an act of acts just nests one level deeper. Only a *child* node
// carries an `item` (its place in its parent's arc); a branch arc has no realized shot order, so it
// emits arc/pacing only and its bag owns just those classes for stale detection.
function buildArcNode(
  node: DirectionNode,
  lenses: readonly LensSpec<string>[] | undefined,
  realizedIds: readonly string[] | undefined,
  // The setups roster, so a shot's framing/location can be resolved through its setup. The space and
  // framing checks read them off the item; an unknown setup leaves both undefined, which those checks
  // already skip (`validateDirectionStructure` reports it as `setup-unknown`).
  setups: Record<string, Setup> | undefined,
  // The node's field path in direction.ts — the same path its review addresses are built from.
  path: readonly string[],
  isRoot: boolean,
): ArcNode {
  const lens = resolveLens(node.lens, lenses);
  const waivers = node.waivers ?? {};
  const item = isRoot
    ? undefined
    : { id: node.id ?? "", role: node.role ?? "", synopsis: node.synopsis ?? "" };
  if (Array.isArray(node.shots)) {
    // A shot names its shot text `action`; map it onto the engine's generic `synopsis` field. Asides
    // are dropped — every check below `items` reads a role, a framing, a place or an adjacency an
    // aside has none of — and stay in `coverageIds`. The shot after one carries `afterGap`, since a
    // dropped aside leaves two shots adjacent here that the clock does not.
    //
    // A graphic shot stays, so role, share and pacing read it. It carries no framing, place or axis,
    // and since it stays in `items`, the narrative shots either side of it are not adjacent here.
    const items: ArcItem<string>[] = [];
    let afterGap = false;
    for (const s of node.shots) {
      if (isAsideShot(s)) {
        afterGap = true;
        continue;
      }
      const camera = isGraphicShot(s)
        ? {}
        : {
            framing: setups?.[s.setup]?.framing,
            location: setups?.[s.setup]?.location,
            join: s.join,
            axis: withinRoot(setups ?? {}, s.setup),
          };
      items.push({
        id: s.id,
        role: s.role,
        synopsis: s.action,
        duration: s.duration,
        ...camera,
        ...(afterGap ? { afterGap: true as const } : {}),
      });
      afterGap = false;
    }
    const coverageIds = node.shots.map((s) => s.id);
    return { item, lens, noun: "shot", waivers, path, items, coverageIds, realizedIds };
  }
  return {
    item,
    lens,
    noun: "sequence",
    waivers,
    path,
    classFilter: new Set(["arc", "pacing"]),
    nodes: (node.sequences ?? []).map((child) =>
      buildArcNode(
        child,
        lenses,
        realizedIds,
        setups,
        directionChildNodePath(path, child.id ?? ""),
        false,
      ),
    ),
  };
}

function buildArcTree(direction: Direction, realizedIds?: readonly string[]): ArcNode {
  return buildArcNode(
    direction.sequence,
    direction.lenses,
    realizedIds,
    direction.setups,
    DIRECTION_ROOT_PATH,
    true,
  );
}

// Walk the tree depth-first, emitting a fold group per node that has a resolvable lens. An internal
// node checks its children as arc items with derived durations (so pacing reads each scale); a leaf
// checks its shots, plus the stage-coverage checks when given a realized id set. `stage` stamps
// stage-order-mismatch so its waiver reads per stage. A node's own group is emitted before its
// children's (meta arc before the per-sequence shot arcs).
function walkArcTree(node: ArcNode, stage: Stage | undefined, out: FoldGroup[]): void {
  if (node.lens) {
    const items: ArcItem<string>[] =
      node.items ??
      (node.nodes ?? []).map((child) => ({
        id: child.item?.id ?? "",
        role: child.item?.role ?? "",
        synopsis: child.item?.synopsis ?? "",
        duration: nodeDuration(child),
      }));
    const findings = checkArc(node.lens, items, {
      realizedIds: node.realizedIds,
      coverageIds: node.coverageIds,
      noun: node.noun,
      // A leaf's shot text is a shot's `action`; a branch's is a sequence's `synopsis`.
      textLabel: node.noun === "shot" ? "action" : "synopsis",
      exposedFramings: EXPOSED_FRAMINGS,
      establishingFraming: ESTABLISHING_FRAMING,
    }).map((f) => ({
      ...f,
      // stage-order-mismatch's qualifier is the stage (so a waiver reads `stage-order-mismatch_video`
      // and never suppresses the other stage). The arc engine is stage-agnostic, so stamp it here.
      subject: f.code === "stage-order-mismatch" && stage ? stage : f.subject,
      path: node.path,
    }));
    out.push({ findings, waivers: node.waivers, path: node.path, classFilter: node.classFilter });
  }
  for (const child of node.nodes ?? []) walkArcTree(child, stage, out);
}

// Run the arc checks and fold in waivers. With `realizedIds` (a stage's realized shot order) the
// stage-class checks (unrealized / stage-order-mismatch) also run; without it only the direction-level
// arc/pacing checks do — and stale-waiver detection is scoped to the classes actually evaluated, so
// a stage/completeness waiver is never wrongly flagged stale by a direction-only pass (e.g. doctor).
export function checkDirection(
  direction: Direction,
  options: {
    realizedIds?: readonly string[];
    stage?: Stage;
    referenceAssetNames?: readonly string[];
    // The board's plates and which shots ignore them. Supplied on the same terms as
    // `referenceAssetNames`: undefined means the animatic could not be read, so the setups class is
    // not evaluated and its waivers are never flagged stale.
    animaticSetups?: AnimaticSetupState;
    // The board's slot orders and voice takes. Same contract again: undefined means the stage could
    // not be read, so the two stage-side staging findings stay silent and the class's waivers are
    // never flagged stale.
    stagingStage?: StagingStageState;
  } = {},
): DirectionCheckResult {
  const structureErrors = validateDirectionStructure(direction);

  const evaluatedClasses: Set<DirectionFindingClass> = options.realizedIds
    ? new Set(["arc", "pacing", "stage", "completeness", "typesetting"])
    : new Set(["arc", "pacing", "typesetting"]);
  // The characters and prop checks cross-reference the reference stage, so they run only when the caller
  // supplies its asset names (undefined = "can't evaluate the roster", so their waivers are never
  // flagged stale).
  if (options.referenceAssetNames !== undefined) {
    evaluatedClasses.add("characters");
    evaluatedClasses.add("props");
    evaluatedClasses.add("locations");
  }
  // `unused-setup` reads the direction alone, but the two plate findings need the board, and
  // stale-waiver detection is per CLASS: marking the class evaluated without it would flag a live
  // `setup-unrealized` waiver stale, since `checkSetups` emitted nothing to match it. So the whole
  // class waits for the board — the cost is that a genuinely stale `unused-setup` waiver goes
  // unreported on an animatic-less pass, which is the same conservative trade the rosters make.
  if (options.animaticSetups !== undefined) evaluatedClasses.add("setups");
  // The staging class's direction half always runs (it reads the direction alone), but two of its
  // findings need the board — so, like the setups class, the whole class waits for it before a
  // waiver of it may be called stale.
  if (options.stagingStage !== undefined) evaluatedClasses.add("staging");

  // The arc findings: walk the arc tree, emitting one fold group per node that has a resolvable lens
  // — a leaf's shot arc, or a branch's arc over its children (recursively). The engine recurses, so
  // the tree, not this function, decides depth.
  const groups: FoldGroup[] = [];
  walkArcTree(buildArcTree(direction, options.realizedIds), options.stage, groups);

  // Characters and speech are piece-wide (not per-node), so they fold against the ROOT node's waiver bag —
  // the same object the root arc's group uses, so stale detection judges the shared bag once. Adding
  // them as their own filtered groups makes that bag own the characters/arc classes too: for a leaf root the
  // root group is already unfiltered (owns all); for a branch root the root arc owns only arc/pacing,
  // so these groups extend its ownership to characters/arc.
  const rootBag = direction.sequence.waivers ?? {};

  if (evaluatedClasses.has("characters")) {
    const characterFindings = checkCharacters(
      entityRefs(direction.characters),
      options.referenceAssetNames ?? [],
      collectActions(direction),
      collectScriptCharacterIds(direction),
    );
    // The voice checks share the characters class and the root bag, so they fold with the look
    // findings as one group — the cast is one thing the reviewer signs off on.
    const voiceFindings = [
      ...checkCharacterVoices(characterVoiceRefs(direction), options.referenceAssetNames ?? []),
      ...checkNarrator(
        direction.narrator?.id ?? null,
        options.referenceAssetNames ?? [],
        hasNarrationLines(direction),
      ),
    ];
    groups.push({
      findings: [...characterFindings, ...voiceFindings],
      waivers: rootBag,
      classFilter: new Set(["characters"]),
    });
  }

  if (evaluatedClasses.has("props")) {
    const propFindings = checkProps(
      entityRefs(direction.props),
      options.referenceAssetNames ?? [],
      collectActions(direction),
    );
    groups.push({ findings: propFindings, waivers: rootBag, classFilter: new Set(["props"]) });
  }

  if (evaluatedClasses.has("locations")) {
    const locationFindings = checkLocations(
      entityRefs(direction.locations),
      options.referenceAssetNames ?? [],
      collectUsedLocationIds(direction),
    );
    groups.push({
      findings: locationFindings,
      waivers: rootBag,
      classFilter: new Set(["locations"]),
    });
  }

  const setupFindings = checkSetups(
    setupRefs(direction.setups),
    countShotsPerSetup(direction),
    options.animaticSetups,
    options.referenceAssetNames,
    axisCuts(direction),
  );
  groups.push({ findings: setupFindings, waivers: rootBag, classFilter: new Set(["setups"]) });

  // Staging findings: who each frame holds, left to right. Pushed unconditionally like the setups
  // group — the class has one owner, and its direction half runs on every pass.
  groups.push({
    findings: checkStaging(direction, options.stagingStage, options.referenceAssetNames),
    waivers: rootBag,
    classFilter: new Set(["staging"]),
  });

  // Speech findings: the direction's script must honor the declared speech policy.
  const speechFindings = checkSpeech(direction);
  if (speechFindings.length > 0) {
    groups.push({ findings: speechFindings, waivers: rootBag, classFilter: new Set(["arc"]) });
  }

  // Fused-shot findings: a shot's action should land a single sentence, not an event-plus-reaction pair.
  const fusedShotFindings = checkFusedShots(direction);
  if (fusedShotFindings.length > 0) {
    groups.push({ findings: fusedShotFindings, waivers: rootBag, classFilter: new Set(["arc"]) });
  }

  // Typesetting findings: a script no default face carries needs a family named. Pushed
  // unconditionally, like the setups group: `typesetting` is the class's only owner, so skipping the
  // push on an empty result would leave a sequenced direction's filtered root bag not owning it —
  // and a `fonts-undeclared` waiver left behind after the family was declared would go unreported.
  groups.push({
    findings: checkTypesetting(direction),
    waivers: rootBag,
    classFilter: new Set(["typesetting"]),
  });

  // Duration findings: a shot's length must be a whole second to survive a backend's frame grid.
  const durationFindings = checkDurations(direction);
  if (durationFindings.length > 0) {
    groups.push({ findings: durationFindings, waivers: rootBag, classFilter: new Set(["pacing"]) });
  }

  const active: DirectionFinding[] = [];
  const waived: DirectionFinding[] = [];

  // Fold each finding against its group's waiver bag, but accumulate stale-detection state per *bag*
  // (by object identity), not per group: a sequenced direction's meta arc and characters fold against the
  // same top-level `direction.waivers`, so a key matched by either — or an unknown-code typo — must be
  // judged once over the shared bag, never double-counted. A bag owns the union of its groups'
  // `classFilter` classes; a group with no filter makes the bag own every class (the flat direction).
  type BagState = {
    waivers: Record<string, string>;
    matched: Set<string>;
    ownedClasses: Set<DirectionFindingClass>;
    unfiltered: boolean;
    path?: readonly string[];
  };
  const bags = new Map<Record<string, string>, BagState>();
  for (const group of groups) {
    let bag = bags.get(group.waivers);
    if (!bag) {
      bag = {
        waivers: group.waivers,
        matched: new Set(),
        ownedClasses: new Set(),
        unfiltered: false,
        path: group.path,
      };
      bags.set(group.waivers, bag);
    }
    if (group.classFilter) for (const c of group.classFilter) bag.ownedClasses.add(c);
    else bag.unfiltered = true;

    for (const finding of group.findings) {
      const key = directionWaiverKey(finding);
      if (key in group.waivers) {
        bag.matched.add(key);
        waived.push(finding);
      } else {
        active.push(finding);
      }
    }
  }

  const staleWaivers: StaleWaiver[] = [];
  for (const bag of bags.values()) {
    for (const [key, reason] of Object.entries(bag.waivers)) {
      if (bag.matched.has(key)) continue;
      const code = waiverKeyCode(key);
      // An unknown code is `waiver-unknown-code`'s, a structural error — reporting it here too would
      // say "the finding is gone" of a finding that never existed.
      if (!isWaivableCode(code)) continue;
      // Flag a waiver stale only for a class this pass evaluated (a direction-only pass must not mislabel
      // a still-valid stage/completeness waiver) and that this bag actually owns (a filtered bag skips
      // its sibling group's classes).
      const cls = FINDING_CLASS[code];
      if (!evaluatedClasses.has(cls)) continue;
      if (!bag.unfiltered && !bag.ownedClasses.has(cls)) continue;
      staleWaivers.push({ key, reason, path: bag.path });
    }
  }

  return { structureErrors, active, waived, staleWaivers };
}

// Every command that can spend on a backend, and so must clear the direction gate first.
export type SpendCommand = "generate" | "reroll" | "patch" | "export";

// The finding classes a command enforces. A `generate`/`reroll`/`patch` allows partial coverage
// mid-build, so it ignores `completeness` (unrealized); only a video `export` — the final
// assembly — enforces it.
export function gatedClasses(command: SpendCommand, stage: Stage): Set<DirectionFindingClass> {
  const base: DirectionFindingClass[] = [
    "arc",
    "pacing",
    "stage",
    "characters",
    "props",
    "locations",
    "setups",
    "staging",
    "typesetting",
  ];
  if (command === "export" && stage === "video") base.push("completeness");
  return new Set(base);
}

// The gate: abort with DIRECTION_CHECK_FAILED when the running command's scope has an unwaived
// structural problem. Structural definition bugs abort unconditionally; otherwise only the scoped
// finding classes count, so an untouched downstream stage never blocks an upstream generate.
export function assertDirectionGate(
  direction: Direction,
  options: {
    command: SpendCommand;
    stage: Stage;
    realizedIds?: readonly string[];
    referenceAssetNames?: readonly string[];
    animaticSetups?: AnimaticSetupState;
    stagingStage?: StagingStageState;
    // Pre-acceptance, characters findings are deferred (see reportableDirectionFindings) so the
    // acceptance gate that runs after this one surfaces the actionable error instead.
    directionAccepted: boolean;
  },
): void {
  const { structureErrors, active: allActive } = checkDirection(direction, {
    realizedIds: options.realizedIds,
    stage: options.stage,
    referenceAssetNames: options.referenceAssetNames,
    animaticSetups: options.animaticSetups,
    stagingStage: options.stagingStage,
  });
  const active = reportableDirectionFindings(allActive, options.directionAccepted);

  if (structureErrors.length > 0) {
    throw new KonteError(
      "DIRECTION_CHECK_FAILED",
      `direction.ts has a structural error:\n${structureErrors
        .map((e) => `  [${e.code}] ${e.message}`)
        .join("\n")}`,
    );
  }

  const classes = gatedClasses(options.command, options.stage);
  const blocking = active.filter((f) => classes.has(classifyDirectionFinding(f.code)));
  if (blocking.length === 0) return;

  throw new KonteError(
    "DIRECTION_CHECK_FAILED",
    `direction has ${blocking.length} unresolved finding(s) — fix direction.ts or add a reason to ` +
      `direction.waivers:\n${blocking
        .map((f) => `  [${directionWaiverKey(f)}] ${f.message}`)
        .join("\n")}`,
  );
}
