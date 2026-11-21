// The direction check. Sits on top of the arc engine (`direction-check.ts`): it resolves a loaded
// `Direction` to its lens(es), runs the generic `checkArc`, then folds in `direction.waivers` to split
// findings into active (unwaived) and waived, and flags stale waivers (a waiver whose finding has
// gone). `directionFindings` hands the result to the finding registry, whose gates and `status` act
// on it.

import {
  DIRECTION_ROOT_PATH,
  directionChildNodePath,
  formatDirectionSequenceAddress,
  formatDirectionShotAddress,
  formatDirectionWaiverAddress,
  formatReferenceAddress,
} from "./address.js";
import {
  type AnchoredEntityRef,
  type SetupRef,
  type AnimaticSetupState,
  type ArcItem,
  type CharacterVoiceRef,
  type DirectionFinding,
  type LensSpec,
  type LineupShot,
  type PanelSlots,
  type PanelReach,
  type VideoShotPins,
  type PanelPrompts,
  type PlateNaming,
  type ViewNaming,
  type LandmarkFrame,
  type HeldLandmark,
  type PropNamingRef,
  type PlateRecrop,
  type ShotPanels,
  type AxisCut,
  type PanelSeam,
  checkJoinPins,
  checkKeyPins,
  checkPanelLinks,
  checkReturnLinks,
  type HoldsSetupRef,
  checkArc,
  checkCharacterVoices,
  checkCharacters,
  checkLocations,
  checkLandmarkOrder,
  checkLineups,
  checkRoutes,
  checkNarrator,
  checkPlateNaming,
  checkViewNaming,
  checkLandmarkNaming,
  frameSubject,
  offscreenFigures,
  type OffscreenFigure,
  checkPropNaming,
  checkProps,
  checkSetups,
  checkViewImages,
  placeRefOf,
  usedSetupIds,
} from "./direction-check.js";
import {
  collectArcShots,
  collectShotFrames,
  collectShots,
  continuedFrames,
  directionHasShots,
  frameKey,
  frameLabel,
  joinBoundaries,
  setupView,
  shotFrames,
  withinRoot,
  type ShotFrame,
} from "./direction-frames.js";
import {
  lyricSingerIds,
  resolveLens,
  validateDirectionStructure,
  type DirectionStructureError,
} from "./direction-structure.js";
import {
  declaredViews,
  type Direction,
  type DirectionNode,
  type Landmark,
  type Setup,
} from "./dsl/direction.js";
import { placeDirectionLyrics, readDirectionTimeline, shotSpan } from "./dsl/direction-timeline.js";
import { isAsideShot, isGraphicShot } from "./dsl/shot-kind.js";
import { isView, viewAssetName } from "./view.js";
import { songAnalysisOf } from "./song-reading.js";
import { type SongVariant, songAddressOf } from "./song-variant.js";
import type { PanelLane } from "./types/definition.js";
import type { KonteState } from "./types/index.js";
import { scriptOf } from "./typography.js";
import { KonteError } from "./errors.js";
import { formatSeconds } from "./format-duration.js";
import type { Finding } from "./finding.js";
import type { Accepted } from "./sign-off.js";
import {
  type DirectionFindingClass,
  type DirectionFindingCode,
  directionFindingSpec,
  directionWaiverKey,
  foldWaivers,
  isDirectionFindingCode,
  isWaivableCode,
  splitWaiverKey,
} from "./direction-findings.js";

// A waiver read by watching a shot: its review address, what it waives, and the shots it plays in —
// one, or both sides of a boundary.
export type ShotWaiver = {
  address: string;
  code: DirectionFindingCode;
  subject: string;
  reason: string;
  shotIds: string[];
};

function boundaryShots(pairs: readonly FramePair[]): Map<string, [string, string]> {
  return new Map(
    pairs.map(({ frame, from }) => [
      `${from.shotId}.${frame.shotId}${frame.lane === "cutin" ? ".cutin" : ""}`,
      [from.shotId, frame.shotId],
    ]),
  );
}

function shotsBySetup(direction: Direction): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { shotId, setup } of collectShotFrames(direction)) {
    const ids = out.get(setup) ?? [];
    if (!ids.includes(shotId)) out.set(setup, [...ids, shotId]);
  }
  return out;
}

export function directionShotWaivers(direction: Direction): ShotWaiver[] {
  const shotIds = new Set(collectShots(direction).map((s) => s.id));
  const boundaries = boundaryShots(
    joinBoundaries(direction).flatMap(({ frame, previousFrame }) =>
      previousFrame ? [{ frame, from: previousFrame }] : [],
    ),
  );
  const returns = boundaryShots(frameReturns(direction));
  const onSetup = shotsBySetup(direction);
  const out: ShotWaiver[] = [];
  for (const [key, reason] of Object.entries(direction.waivers ?? {})) {
    const { code, subject } = splitWaiverKey(key);
    if (subject === undefined || !isWaivableCode(code)) continue;
    const on = directionFindingSpec(code).waiverScope;
    if (!on) continue;
    // A shot's subject opens with its id; an id holds no `.`.
    const head = subject.split(".")[0] ?? "";
    const ids =
      on === "boundary"
        ? ((code === "return-unlinked" ? returns : boundaries).get(subject) ?? [])
        : on === "setup"
          ? (onSetup.get(subject) ?? [])
          : shotIds.has(head)
            ? [head]
            : [];
    if (ids.length === 0) continue;
    out.push({
      address: formatDirectionWaiverAddress(key),
      code,
      subject,
      reason,
      shotIds: ids,
    });
  }
  return out;
}

export type StaleWaiver = {
  key: string;
  reason: string;
  // It names a finding that is only ever fixed, which no reason cancels.
  fixOnly?: true;
};

// What the waivers do in one pass, by part address: what each lets through now (`covers`; none for
// a waiver whose finding names nothing that can grow, or was not evaluated), and the stale ones,
// which cancel nothing and so owe no reader.
export type WaiverCoverage = {
  covers: ReadonlyMap<string, readonly string[]>;
  stale: ReadonlySet<string>;
};

type DirectionCheckResult = {
  structureErrors: DirectionStructureError[];
  active: DirectionFinding[];
  waived: DirectionFinding[];
  staleWaivers: StaleWaiver[];
  waiverCoverage: WaiverCoverage;
};

export function collectFramedCharacterIds(direction: Direction): Set<string> {
  return new Set(
    collectShotFrames(direction).flatMap((f) => [
      ...(f.lineup ?? []),
      ...(f.lineupTo ?? []),
      ...(f.passing ?? []),
    ]),
  );
}

function collectShownPropIds(direction: Direction): Set<string> {
  return new Set(collectShotFrames(direction).flatMap((f) => f.props ?? []));
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

// The set of location ids the shots reach — through their setups and the masters those are windows
// of, since a shot names no place of its own. The `unused-location` check's "used" signal.
function collectUsedLocationIds(direction: Direction): Set<string> {
  const used = new Set<string>();
  for (const id of usedSetupIds(setupRefs(direction.setups), countShotsPerSetup(direction))) {
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
          within?: string | null;
        }
      >
    | undefined,
): SetupRef[] {
  const setups = (roster ?? {}) as Record<string, Setup>;
  return Object.entries(roster ?? {}).map(([id, s]) => {
    const view = setupView(setups, id);
    return {
      id,
      name: s.name,
      location: s.location,
      framing: s.framing,
      ...(s.within != null ? { within: s.within } : {}),
      ...(view ? { view } : {}),
    };
  });
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
      message: `policy.lang is "${lang}" (${script} script) but policy.fonts names no family`,
    },
  ];
}

// What the song class reads off state: the take of the song the piece is read against (see
// `resolveSongVariant`), null while no take has been read, and how long that take plays, null while
// unmeasured. Undefined at a caller is "state could not be read", and the class is then not
// evaluated.
export type SongVariantState = { variant: SongVariant | null; durationSec: number | null };

// The song the piece is cut to must be a reference asset, and every lyric line must be found in its
// take or placed by hand.
function checkSong(
  direction: Direction,
  referenceAssetNames: readonly string[],
  song: SongVariantState,
): DirectionFinding[] {
  const id = direction.policy?.song;
  if (!id) return [];
  if (!referenceAssetNames.includes(id)) {
    return [
      {
        code: "song-unreferenced",
        message: `policy.song is "${id}", but reference.tsx exposes no reference:${id}`,
      },
    ];
  }
  const variant = song.variant;
  if (!variant) return [];
  const findings: DirectionFinding[] = [];
  for (const line of placeDirectionLyrics(direction, variant)) {
    if (line.start !== null) continue;
    findings.push({
      code: "lyric-unplaced",
      subject: line.key,
      message:
        `lyric line ${line.key} ("${line.text}") is not clearly sung anywhere in ${variant.address} ` +
        `${variant.variantId}`,
    });
  }
  return findings;
}

// The timeline a take of the song is cut on ends within a frame of the take.
function checkSongOverrun(direction: Direction, song: SongVariantState): DirectionFinding[] {
  const { variant, durationSec } = song;
  if (!direction.policy?.song || !variant || durationSec === null) return [];
  const timeline = readDirectionTimeline(direction, variant);
  const last = [...timeline.timings.values()].at(-1);
  const end = last?.start != null ? last.start + last.duration : 0;
  if (end - durationSec <= 1 / timeline.fps) return [];
  return [
    {
      code: "song-overrun",
      message:
        `the timeline runs ${formatSeconds(end, 2)}, past the end of ${variant.address} ${variant.variantId} ` +
        `(${formatSeconds(durationSec, 2)})`,
    },
  ];
}

// Refuses an accept of a song take with a lyric line nobody placed on it.
export function assertSongLinesPlaced(
  videoRoot: string,
  direction: Direction | null,
  state: KonteState,
  address: string,
  variantId: string,
): void {
  const refusal = songLinesRefusal(videoRoot, direction, state, address, variantId);
  if (refusal) throw new KonteError("SONG_LINES_UNPLACED", refusal);
}

// Why a song take cannot be accepted yet, or null when it can (or the address is not the song).
export function songLinesRefusal(
  videoRoot: string,
  direction: Direction | null,
  state: KonteState,
  address: string,
  variantId: string,
): string | null {
  if (!direction?.lyrics || songAddressOf(direction) !== address) return null;
  const analysis = songAnalysisOf(
    videoRoot,
    address,
    variantId,
    state.assets[address]?.variants?.[variantId]?.song,
  );
  const unplaced = placeDirectionLyrics(
    direction,
    analysis ? { address, variantId, analysis } : null,
  ).filter((line) => line.start === null);
  if (unplaced.length === 0) return null;
  return (
    `${address} ${variantId} has ${unplaced.length} lyric line(s) placed nowhere on it ` +
    `(${unplaced.map((l) => l.key).join(", ")}) — place them on the song's track in ` +
    "`konte preview reference`"
  );
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
    // A coverage shot's action is the run of beats the model cuts between.
    if (!isGraphicShot(s) && s.coverage) continue;
    const breaks = countSentenceBreaks(s.action);
    if (breaks > 0) {
      findings.push({
        code: "multi-sentence-action",
        subject: s.id,
        message: `shot ${s.id}'s action reads as ${breaks + 1} sentences`,
      });
    }
  }
  return findings;
}

// A shot whose span is off its grid, or not positive. A shot's span is a window the render cuts the
// take to: in seconds the grid is the one every legal `fps` (a multiple of 8) lands a whole frame on;
// on the song it is the beat, asides included; off the song an aside owes only a positive span. A
// span off the beat is waivable (`off-beat-cut_<shotId>`); `off-grid-duration` is fixed.
export const DURATION_GRID = 0.5;

function checkDurations(direction: Direction): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  if (direction.policy?.song) {
    for (const s of collectShots(direction)) {
      if (s.beats === undefined) continue;
      if (s.beats <= 0) {
        findings.push({
          code: "off-grid-duration",
          subject: s.id,
          message: `shot ${s.id} runs ${s.beats} beats`,
        });
      } else if (!Number.isInteger(s.beats)) {
        findings.push({
          code: "off-beat-cut",
          subject: s.id,
          message: `shot ${s.id} runs ${s.beats} beats`,
        });
      }
    }
    return findings;
  }
  for (const s of collectShots(direction)) {
    if (!isAsideShot(s) || s.duration === undefined || s.duration > 0) continue;
    findings.push({
      code: "off-grid-duration",
      subject: s.id,
      message: `aside ${s.id} runs ${s.duration}s`,
    });
  }
  for (const s of collectArcShots(direction)) {
    if (s.duration === undefined) continue;
    const steps = s.duration / DURATION_GRID;
    if (s.duration <= 0 || Math.abs(steps - Math.round(steps)) > 1e-9) {
      findings.push({
        code: "off-grid-duration",
        subject: s.id,
        message: `shot ${s.id} runs ${s.duration}s, off its ${DURATION_GRID}s grid`,
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
  // The keyframes that crop their setup's plate instead of standing on its frame.
  plateRecrops: readonly PlateRecrop[];
  // A third reading of the same panels: the conditioning text each one stands on, which
  // `subject-unnamed` looks for the frame's subjects in.
  panelPrompts: readonly PanelPrompts[];
  // The positive prompts each returned plate is generated with, keyed by setup id — what
  // `plate-unnamed` reads for the landmarks that frame declares it holds. Every returned plate has an
  // entry, so a setup with none is one whose keyframes `landmark-unnamed` reads instead.
  plateTexts: Readonly<Record<string, readonly string[]>>;
  // The reference ids each developed shot puts on screen as they are, keyed by shot id — what
  // `prop-unnamed` drops.
  shownReferences: Readonly<Record<string, readonly string[]>>;
  // The one reading that comes off the VIDEO rather than the board: which frames each developed
  // video shot pins, so `join-unpinned` can ask whether a declared long take is carried across its
  // seam and `opening-key` whether a key opens a take. Empty where video.tsx could not be read —
  // which is the one place stale-waiver detection is imprecise, since the class is marked evaluated
  // by the BOARD: a `join-unpinned` or `opening-key` waiver reads stale while the video is broken.
  videoPins: readonly VideoShotPins[];
  videoPassers?: readonly {
    shotId: string;
    lane: PanelLane;
    refs: readonly string[];
    texts: readonly string[];
    generative: boolean;
    // The take the frame renders.
    take: string;
  }[];
  // The seam reading: the two keyframes each developed shot answers a boundary with, and what the
  // opening one was handed of the frame before it. `join-unpinned` reads the opening keyframe as
  // the seam of a long take; `panel-unlinked` reads the rest against the `within` declarations.
  shotPanels: readonly ShotPanels[];
};
// The direction flattened to what the lineup accumulation reads — one entry per FRAME, a shot's main
// frame before its cutin. A frame whose setup names no declared location carries `undefined` —
// reported structurally as `setup-unknown`, and filed under no place here.
function lineupShots(direction: Direction): LineupShot[] {
  const actionById = new Map(collectArcShots(direction).map((s) => [s.id, s.action]));
  const continuedBy = continuedFrames(direction);
  return joinBoundaries(direction).map(({ frame, runOn }) => ({
    shotId: frame.shotId,
    lane: frame.lane,
    location: direction.setups?.[frame.setup]?.location,
    action: actionById.get(frame.shotId) ?? "",
    lineup: frame.lineup ?? [],
    ...(frame.lineupTo ? { lineupTo: frame.lineupTo } : {}),
    ...(frame.passing ? { passing: frame.passing } : {}),
    // A `continuous` at a boundary no unbroken take could cross is `join-impossible`. The seam
    // checks read the declaration only where it could be true, so a broken direction reports that
    // error rather than a mismatch at a seam the piece does not have.
    ...(frame.join && (frame.join !== "continuous" || runOn) ? { join: frame.join } : {}),
    ...(continuedBy.has(frameKey(frame)) ? { continuedBy: continuedBy.get(frameKey(frame)) } : {}),
    ...(frame.coverage ? { coverage: true as const } : {}),
  }));
}

export function offscreenSides(direction: Direction): Map<string, OffscreenFigure[]> {
  return offscreenFigures(lineupShots(direction));
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
            plateRecrops: stage.plateRecrops,
            placeRefs: new Map(setupRefs(direction.setups).map((s) => [s.id, placeRefOf(s)])),
            panelPrompts: stage.panelPrompts,
            subjectPromptDepictions: subjectPromptDepictions(direction),
          }
        : {}),
      ...(referenceAssetNames ? { referenceAssetNames } : {}),
    }),
    ...(stage
      ? checkPropNaming(
          collectShotFrames(direction),
          stage.panelPrompts,
          stage.shownReferences,
          propRefs(direction),
        )
      : []),
    ...checkRoutes(shots),
    // The setups roster alone: a landmark's place on screen is the camera's, not a shot's.
    ...checkLandmarkOrder(holdsSetupRefs(direction)),
    ...(stage ? checkPlateNaming(plateNamings(direction, stage.plateTexts)) : []),
    ...(stage
      ? checkLandmarkNaming(unplatedFrames(direction, stage.plateTexts), stage.panelPrompts)
      : []),
    ...(stage ? checkJoinPins(shots, stage.videoPins, stage.shotPanels) : []),
    ...(stage ? checkKeyPins(shots, stage.videoPins, stage.shotPanels) : []),
    ...(stage ? checkPanelLinks(boardSeams(axisCutPairs(direction), stage.shotPanels)) : []),
    ...(stage ? checkReturnLinks(boardSeams(frameReturns(direction), stage.shotPanels)) : []),
    ...checkPassers(direction, stage?.videoPassers, referenceAssetNames),
  ];
}

function checkPassers(
  direction: Direction,
  inputs: StagingStageState["videoPassers"],
  referenceAssetNames?: readonly string[],
): DirectionFinding[] {
  if (!inputs) return [];
  const findings: DirectionFinding[] = [];
  for (const frame of collectShotFrames(direction)) {
    const takes = inputs.filter(
      (input) => input.shotId === frame.shotId && input.lane === frame.lane && input.generative,
    );
    if (takes.length === 0) continue;
    for (const id of frame.passing ?? []) {
      const subject = `${frameSubject(frame)}.${id}`;
      const unreached = takes.filter((take) => !take.refs.includes(id));
      if (referenceAssetNames?.includes(id) && unreached.length > 0) {
        findings.push({
          code: "passer-unconsumed",
          subject,
          message: `${frameLabel(frame)} passes "${id}" but a video take's input chain does not reach reference:${id}`,
          judgedBy: unreached.map((take) => take.take),
        });
      }
      const depiction = direction.characters?.[id]?.promptDepiction;
      const unnamed = depiction?.trim()
        ? takes.filter(
            (take) =>
              !take.texts.some((text) => text.toLowerCase().includes(depiction.toLowerCase())),
          )
        : [];
      if (unnamed.length > 0) {
        findings.push({
          code: "passer-unnamed",
          subject,
          message: `${frameLabel(frame)} passes "${id}" but a video take's positive prompts do not contain "${depiction}"`,
          judgedBy: unnamed.map((take) => take.take),
        });
      }
    }
  }
  return findings;
}

// The word a prompt calls each character by, for the `subject-unnamed` scan. An entry with none is
// `character-empty-prompt-depiction`, a structural error, and is dropped here rather than matched
// as "".
function subjectPromptDepictions(direction: Direction): Map<string, string> {
  return new Map(
    Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.promptDepiction ?? ""]),
  );
}

function propRefs(direction: Direction): PropNamingRef[] {
  return Object.entries(direction.props ?? {}).map(([id, p]) => ({
    id,
    name: p.name,
    promptDepiction: p.promptDepiction ?? "",
  }));
}

// The setups in roster order, for the landmark accumulation. A frame set nowhere the roster declares
// is `setup-unknown-location`; it still files under its own raw id here, which is the only place its
// own frames could contradict each other.
function holdsSetupRefs(direction: Direction): HoldsSetupRef[] {
  const setups = direction.setups ?? {};
  return Object.entries(setups).map(([id, s]) => ({
    id,
    location: s.location,
    view: setupView(setups, id),
    holds: s.holds ?? [],
  }));
}

/**
 * The landmarks a setup's frame holds, left to right; null for a setup the roster does not declare.
 * `landmark` is absent for an id the place does not declare (`holds-unknown-id`) — own keys only, so
 * an inherited name is not read as one.
 */
export function setupHolds(
  direction: Direction,
  setupId: string,
): { id: string; landmark?: Landmark }[] | null {
  const setup = direction.setups?.[setupId];
  if (!setup) return null;
  const landmarks = direction.locations?.[setup.location]?.landmarks ?? {};
  return (setup.holds ?? []).map((id) =>
    Object.hasOwn(landmarks, id) ? { id, landmark: landmarks[id]! } : { id },
  );
}

// The landmarks a setup's frame holds, with the noun each is asked for by.
function heldLandmarks(direction: Direction, setupId: string): HeldLandmark[] {
  const location = direction.setups?.[setupId]?.location ?? "";
  return (setupHolds(direction, setupId) ?? []).flatMap(({ id, landmark }) =>
    landmark ? [{ id, location, promptDepiction: landmark.promptDepiction ?? "" }] : [],
  );
}

// Each returned plate paired with what its setup declares that frame holds. A plate made with no
// prompt has nothing to read, and a setup holding nothing (an `insert`) has nothing to look for.
function plateNamings(
  direction: Direction,
  plateTexts: Readonly<Record<string, readonly string[]>>,
): PlateNaming[] {
  const out: PlateNaming[] = [];
  for (const [setupId, texts] of Object.entries(plateTexts)) {
    const holds = heldLandmarks(direction, setupId);
    if (texts.length === 0 || holds.length === 0) continue;
    out.push({ setupId, texts, holds });
  }
  return out;
}

// Each view a location declares, read against the prompt its image is generated with. An image with
// no prompt — a file, or one not returned — has nothing to read.
export function checkViewNamings(
  direction: Direction,
  imageTexts: Readonly<Record<string, readonly string[]>>,
): DirectionFinding[] {
  const namings: ViewNaming[] = [];
  for (const [location, { landmarks = {}, views }] of Object.entries(direction.locations ?? {})) {
    for (const [view, declared] of declaredViews(views)) {
      if (!isView(view)) continue;
      const name = view === "front" ? location : viewAssetName(location, view);
      const texts = imageTexts[name] ?? [];
      if (texts.length === 0) continue;
      const holds = (declared.holds ?? []).flatMap((id) =>
        Object.hasOwn(landmarks, id)
          ? [{ id, location, promptDepiction: landmarks[id]!.promptDepiction ?? "" }]
          : [],
      );
      namings.push({ location, view, image: formatReferenceAddress(name), texts, holds });
    }
  }
  return checkViewNaming(namings);
}

// The frames whose setup has no returned plate, each with what it holds.
function unplatedFrames(
  direction: Direction,
  plateTexts: Readonly<Record<string, readonly string[]>>,
): LandmarkFrame[] {
  return collectShotFrames(direction).flatMap((frame) => {
    if (Object.hasOwn(plateTexts, frame.setup)) return [];
    const holds = heldLandmarks(direction, frame.setup);
    return holds.length === 0 ? [] : [{ shotId: frame.shotId, lane: frame.lane, holds }];
  });
}

const EXPOSED_FRAMINGS: readonly string[] = ["wide", "medium"];

function axisCuts(direction: Direction): AxisCut[] {
  const setups = direction.setups ?? {};
  const out: AxisCut[] = [];
  const push = (from: string, to: string) => {
    if (from === to) return;
    const a = setups[from];
    const b = setups[to];
    if (!a || !b) return;
    if (a.location !== b.location) return;
    const root = withinRoot(setups, from);
    if (root === undefined || root !== withinRoot(setups, to)) return;
    if (!EXPOSED_FRAMINGS.includes(a.framing) || !EXPOSED_FRAMINGS.includes(b.framing)) return;
    if (a.framing === b.framing) return;
    const chain = nestingChain(setups, from, to);
    const pair = [from, to].sort() as [string, string];
    if (chain) out.push({ pair, chain });
  };
  for (const { frame, previousFrame } of joinBoundaries(direction)) {
    if (previousFrame) push(previousFrame.setup, frame.setup);
  }
  return out;
}

// Both setups and every frame between them and the one they are both windows of. `undefined` where
// they stand on different axes.
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

// The cuts a frame has to carry across: an omitted join
// across two setups on ONE `within` axis — story time runs on and the camera has moved only along
// that axis. The plate nesting already carries the room (`plate-unnested`); what the frame before
// it carries is the subject — her light, her size against the set, where she stands.
//
// `"continuous"` owes the board nothing here: the seam is the next shot's opening keyframe, and the
// take before landing on it is the video's to answer (`join-unpinned`). A story-time jump
// carries nothing (she may have moved), a second axis is a different camera, two frames holding no
// subject in common have no subject to carry, an aside between the two shots is a card the take
// does not run through, and a coverage shot's panel is its opening frame, not where its camera
// ended. A seam is judged only where both shots are on the board and the opening
// keyframe has a slot for the frame — the rest is not this finding's to report.
//
// Each lane is its own camera: a wipe carries across the seam from the wipe before it, and a main
// frame from the main frame before it.
function axisCutPairs(direction: Direction): FramePair[] {
  const setups = direction.setups ?? {};
  return joinBoundaries(direction).flatMap(({ frame, previousFrame }) =>
    previousFrame !== undefined &&
    !previousFrame.coverage &&
    isAxisCut(setups, frame, previousFrame) &&
    sharesSubject(previousFrame, frame)
      ? [{ frame, from: previousFrame }]
      : [],
  );
}

type FramePair = { frame: ShotFrame; from: ShotFrame };

// The pairs answered on the board: judged where both frames are on the board and the opening
// keyframe's model reads a previous panel.
function boardSeams(pairs: readonly FramePair[], continuity: readonly ShotPanels[]): PanelSeam[] {
  const byFrame = new Map(continuity.map((entry) => [frameKey(entry), entry]));
  return pairs.flatMap(({ frame, from }) => {
    const here = byFrame.get(frameKey(frame));
    const before = byFrame.get(frameKey(from));
    if (!here?.carries || !before) return [];
    return [
      {
        id: frame.shotId,
        lane: frame.lane,
        from: from.shotId,
        fromPanel: before.lastPanel,
        linked: here.linked,
        opening: here.firstPanel,
      },
    ];
  });
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

// A frame showing one of `frame`'s subjects at any point, read strictly: a frame that declares no
// one shows no one.
function showsSubjectOf(other: ShotFrame, frame: ShotFrame): boolean {
  const shown = [...other.lineup, ...(other.lineupTo ?? []), ...(other.passing ?? [])];
  return frame.lineup.some((id) => shown.includes(id));
}

/**
 * A frame cut back to its setup across a cutaway, and the frame of its lane it returns to: the
 * latest one on that setup, where that one is not the frame just before it (the `join` rules own
 * that boundary).
 */
export type FrameReturn = FramePair;

// None across a story-time jump or an aside, from a coverage shot,
// between frames holding no subject in common, into a frame an axis cut already carries, across a
// cutaway of its lane in another place, or across any frame showing the subject.
export function frameReturns(direction: Direction): FrameReturn[] {
  const setups = direction.setups ?? {};
  const carried = new Set(axisCutPairs(direction).map(({ frame }) => frameKey(frame)));
  const out: FrameReturn[] = [];
  let run: ShotFrame[] = [];
  let previousShotId: string | undefined;
  for (const shot of collectShots(direction)) {
    if (isAsideShot(shot)) {
      run = [];
      previousShotId = undefined;
      continue;
    }
    const frames = shotFrames(shot);
    if (frames.some((f) => f.join === "jump-back" || f.join === "jump-forward")) run = [];
    for (const frame of frames) {
      if (frame.join !== undefined || setups[frame.setup] === undefined) continue;
      if (carried.has(frameKey(frame))) continue;
      let at = run.length - 1;
      while (at >= 0 && !(run[at]!.lane === frame.lane && run[at]!.setup === frame.setup)) at--;
      const from = run[at];
      if (from === undefined || from.shotId === previousShotId || from.coverage) continue;
      const between = run.slice(at + 1).filter((f) => f.shotId !== from.shotId);
      const place = setups[from.setup]?.location;
      const away = between.filter((f) => f.lane === frame.lane);
      if (away.some((f) => setups[f.setup]?.location !== place)) continue;
      if (!sharesSubject(from, frame)) continue;
      if (between.some((f) => showsSubjectOf(f, frame))) continue;
      out.push({ frame, from });
    }
    run.push(...frames);
    previousShotId = shot.id;
  }
  return out;
}

// One node of the arc tree the checker walks. A leaf carries shot `items`; an internal node carries
// child `nodes` and appears as an item in its parent's arc (`item`). The walk is generic over depth:
// `buildArcTree` produces a depth-1 (flat) or depth-2 (sequenced) tree today, but duration
// derivation and the arc check both recurse — so nesting the DSL deeper later (an act
// of acts, toward true long-form) changes only the builder below, not the engine. `lens` is optional
// so an unresolved lens name (a structural error reported elsewhere) skips that node's own arc while
// its children are still checked.
type ArcNode = {
  item?: { id: string; role: string; synopsis: string };
  lens?: LensSpec<string>;
  noun: string;
  path: readonly string[];
  items?: ArcItem<string>[];
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
// checked against its lens. A branch node
// (`sequences`) → an internal arc over one child per sub-node, checked against its lens. The
// recursion is depth-agnostic, so an act of acts just nests one level deeper. Only a *child* node
// carries an `item` (its place in its parent's arc).
function buildArcNode(
  node: DirectionNode,
  lenses: readonly LensSpec<string>[] | undefined,
  // The song, so a shot's span is counted in the unit it was written in.
  song: string | undefined,
  // The node's field path in direction.ts — the same path its review addresses are built from.
  path: readonly string[],
  isRoot: boolean,
): ArcNode {
  const lens = resolveLens(node.lens, lenses);
  const item = isRoot
    ? undefined
    : { id: node.id ?? "", role: node.role ?? "", synopsis: node.synopsis ?? "" };
  if (Array.isArray(node.shots)) {
    const items: ArcItem<string>[] = node.shots
      .filter((s) => !isAsideShot(s))
      .map((s) => ({
        id: s.id,
        role: s.role,
        synopsis: s.action,
        duration: shotSpan(s, song),
      }));
    return { item, lens, noun: "shot", path, items };
  }
  return {
    item,
    lens,
    noun: "sequence",
    path,
    nodes: (node.sequences ?? []).map((child) =>
      buildArcNode(child, lenses, song, directionChildNodePath(path, child.id ?? ""), false),
    ),
  };
}

function buildArcTree(direction: Direction): ArcNode {
  return buildArcNode(
    direction.sequence,
    direction.lenses,
    direction.policy?.song,
    DIRECTION_ROOT_PATH,
    true,
  );
}

// Walk the tree depth-first, checking each node that has a resolvable lens. An internal node checks
// its children as arc items with derived durations (so pacing reads each scale); a leaf checks its
// shots. A node's own findings come before its children's (meta arc before the per-sequence shot
// arcs).
function walkArcTree(node: ArcNode, out: DirectionFinding[]): void {
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
      noun: node.noun,
      // A leaf's shot text is a shot's `action`; a branch's is a sequence's `synopsis`.
      textLabel: node.noun === "shot" ? "action" : "synopsis",
    }).map((f) => {
      const subject = f.subject;
      const nodeId = node.item?.id;
      return {
        ...f,
        subject:
          nodeId !== undefined && directionFindingSpec(f.code).nodeScoped
            ? subject
              ? `${nodeId}.${subject}`
              : nodeId
            : subject,
        path: node.path,
      };
    });
    out.push(...findings);
  }
  for (const child of node.nodes ?? []) walkArcTree(child, out);
}

// Run the arc checks and fold in waivers. Stale-waiver detection is scoped to the classes actually
// evaluated, so a pass that could not read a stage never flags that stage's waivers stale.
export function checkDirection(
  direction: Direction,
  options: {
    referenceAssetNames?: readonly string[];
    // The board's plates and which shots ignore them. Supplied on the same terms as
    // `referenceAssetNames`: undefined means the animatic could not be read, so the setups class is
    // not evaluated and its waivers are never flagged stale.
    animaticSetups?: AnimaticSetupState;
    // The board's slot orders and voice takes. Same contract again: undefined means the stage could
    // not be read, so the two stage-side staging findings stay silent and the class's waivers are
    // never flagged stale.
    stagingStage?: StagingStageState;
    // The take of the song the piece is read against. Same contract again: undefined means state
    // could not be read, so the song class is not evaluated.
    songVariant?: SongVariantState;
    accepted?: Accepted;
  } = {},
): DirectionCheckResult {
  const structureErrors = validateDirectionStructure(direction);

  const evaluatedClasses = new Set<DirectionFindingClass>(["arc", "pacing", "typesetting"]);
  // The characters and prop checks cross-reference the reference stage, so they run only when the caller
  // supplies its asset names (undefined = "can't evaluate the roster", so their waivers are never
  // flagged stale).
  if (options.referenceAssetNames !== undefined) {
    evaluatedClasses.add("characters");
    evaluatedClasses.add("props");
    evaluatedClasses.add("locations");
    if (options.songVariant !== undefined) evaluatedClasses.add("song");
  }
  // `unused-setup` reads the direction alone, but the two plate findings need the board, and
  // stale-waiver detection is per CLASS: marking the class evaluated without it would flag a live
  // `setup-unrealized` waiver stale, since `checkSetups` emitted nothing to match it. So the whole
  // class waits for the board — the cost is that a genuinely stale `unused-setup` waiver goes
  // unreported on an animatic-less pass, which is the same conservative trade the rosters make.
  // Both classes also read the reference pool (the view and anchor findings, the subjects a lineup
  // and a passer draw on), so a reference.tsx that failed to load holds them back too.
  const poolRead = options.referenceAssetNames !== undefined;
  if (options.animaticSetups !== undefined && poolRead) evaluatedClasses.add("setups");
  // The staging class's direction half always runs (it reads the direction alone), but two of its
  // findings need the board — so, like the setups class, the whole class waits for it before a
  // waiver of it may be called stale.
  if (options.stagingStage !== undefined && poolRead) evaluatedClasses.add("staging");

  // The arc findings: walk the arc tree, checking each node that has a resolvable lens — a leaf's
  // shot arc, or a branch's arc over its children (recursively). The engine recurses, so the tree,
  // not this function, decides depth.
  const findings: DirectionFinding[] = [];
  // A direction with no shots yet is one being written after its song: `empty-direction` says so,
  // and an arc of nothing would only list every role as missing.
  if (directionHasShots(direction)) {
    walkArcTree(buildArcTree(direction), findings);
  }

  if (evaluatedClasses.has("characters")) {
    // A singer is on screen singing whatever the actions say; singing needs no cast voice. A
    // character a frame holds is in the picture whatever the action prose names.
    const alwaysUsed = collectScriptCharacterIds(direction);
    for (const id of lyricSingerIds(direction)) alwaysUsed.add(id);
    for (const id of collectFramedCharacterIds(direction)) alwaysUsed.add(id);
    findings.push(
      ...checkCharacters(
        entityRefs(direction.characters),
        options.referenceAssetNames ?? [],
        alwaysUsed,
        collectFramedCharacterIds(direction),
      ),
      ...checkCharacterVoices(characterVoiceRefs(direction), options.referenceAssetNames ?? []),
      ...checkNarrator(
        direction.narrator?.id ?? null,
        options.referenceAssetNames ?? [],
        hasNarrationLines(direction),
      ),
    );
  }

  if (options.songVariant !== undefined) {
    findings.push(...checkSongOverrun(direction, options.songVariant));
  }

  if (evaluatedClasses.has("song")) {
    findings.push(...checkSong(direction, options.referenceAssetNames ?? [], options.songVariant!));
  }

  if (evaluatedClasses.has("props")) {
    findings.push(
      ...checkProps(
        entityRefs(direction.props),
        options.referenceAssetNames ?? [],
        collectShownPropIds(direction),
      ),
    );
  }

  if (evaluatedClasses.has("locations")) {
    findings.push(
      ...checkLocations(
        entityRefs(direction.locations),
        options.referenceAssetNames ?? [],
        collectUsedLocationIds(direction),
      ),
      ...checkViewImages(
        Object.entries(direction.locations ?? {}).map(([id, l]) => ({
          id,
          views: declaredViews(l.views)
            .map(([v]) => v)
            .filter(isView),
        })),
        options.referenceAssetNames ?? [],
      ),
    );
  }

  findings.push(
    ...checkSetups(
      setupRefs(direction.setups),
      countShotsPerSetup(direction),
      options.animaticSetups,
      options.referenceAssetNames,
      axisCuts(direction),
    ),
    ...(options.animaticSetups && options.referenceAssetNames !== undefined
      ? checkViewNamings(direction, options.animaticSetups.referenceImageTexts)
      : []),
    // Who each frame holds, left to right.
    ...checkStaging(direction, options.stagingStage, options.referenceAssetNames),
    // A shot's action should land a single sentence, not an event-plus-reaction pair.
    ...checkFusedShots(direction),
    // A script no default face carries needs a family named.
    ...checkTypesetting(direction),
    // A shot's length must be a whole second to survive a backend's frame grid.
    ...checkDurations(direction),
  );
  const reported = directionHasShots(direction)
    ? findings
    : findings.filter((f) => !directionFindingSpec(f.code).awaitsShots);

  const waivers = direction.waivers ?? {};
  const { active, waived, matched, covers } = foldWaivers(reported, waivers, options.accepted);

  const staleWaivers: StaleWaiver[] = [];
  for (const [key, reason] of Object.entries(waivers)) {
    if (matched.has(key)) continue;
    const { code } = splitWaiverKey(key);
    // Flag a waiver stale only for a class this pass evaluated: a pass that could not read a stage
    // must not mislabel a still-valid waiver of it. A code no finding has is stale in any pass.
    if (isWaivableCode(code) && !evaluatedClasses.has(directionFindingSpec(code).class)) continue;
    staleWaivers.push({
      key,
      reason,
      ...(isDirectionFindingCode(code) && !isWaivableCode(code) ? { fixOnly: true } : {}),
    });
  }

  const waiverCoverage: WaiverCoverage = {
    covers,
    stale: new Set(staleWaivers.map((w) => formatDirectionWaiverAddress(w.key))),
  };
  return { structureErrors, active, waived, staleWaivers, waiverCoverage };
}

// The part address of every shot and every child node, by id — what a finding on an item sits on.
function itemPartAddresses(direction: Direction): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: DirectionNode, path: readonly string[]) => {
    for (const shot of node.shots ?? [])
      out.set(shot.id, formatDirectionShotAddress(path, shot.id));
    for (const child of node.sequences ?? []) {
      const childPath = directionChildNodePath(path, child.id ?? "");
      out.set(child.id ?? "", formatDirectionSequenceAddress(childPath));
      walk(child, childPath);
    }
  };
  walk(direction.sequence, DIRECTION_ROOT_PATH);
  return out;
}

// The direction part a finding to fix sits on, which its accept hold matches. Undefined where no one
// part carries it, which holds every part.
function findingPart(
  finding: DirectionFinding,
  items: ReadonlyMap<string, string>,
): string | undefined {
  const subject = finding.subject ?? "";
  const part = directionFindingSpec(finding.code).part;
  return part ? part(subject) : items.get(subject.split(".")[0] ?? "");
}

// The check's result as the finding registry reads it: each structural error and each unwaived
// finding, with the file it is fixed in, the key a waiver would cancel it by, and the part it sits
// on.
export function directionFindings(result: DirectionCheckResult, direction: Direction): Finding[] {
  const items = itemPartAddresses(direction);
  return [
    ...result.structureErrors.map(
      (e): Finding => ({
        code: e.code,
        subject: e.subject ?? "",
        fixIn: { stage: "direction" },
        message: e.message,
        // A shotless direction is one being written after its song: its policy and lyrics are still
        // accepted on their own.
        ...(e.code === "empty-direction" ? { targets: [] } : {}),
      }),
    ),
    ...result.active.map((f): Finding => {
      const spec = directionFindingSpec(f.code);
      const part = spec.traits.clears === "fix" ? findingPart(f, items) : undefined;
      return registryFinding(f, {
        subject: f.subject ?? "",
        fixIn: { stage: spec.fixStage },
        message: f.message,
        key: directionWaiverKey(f),
        ...(part ? { targets: [part] } : {}),
      });
    }),
  ];
}

// A direction finding as the registry carries it, with the addresses its accept is judged by.
export function registryFinding(
  f: DirectionFinding,
  fields: Omit<Finding, "code" | "judgedBy">,
): Finding {
  return f.judgedBy === undefined
    ? { ...fields, code: f.code }
    : { ...fields, code: f.code, judgedBy: f.judgedBy };
}
