import * as path from "node:path";
import { ratioOf } from "../../../core/aspect.js";
import { cachedClipStudy } from "../../../core/study-clip.js";
import { workspaceRootOrNull } from "../../../core/workspace-context.js";
import {
  DIRECTION_BRIEF_FIELDS,
  DIRECTION_LYRICS_ADDRESS,
  DIRECTION_NARRATOR_ADDRESS,
  DIRECTION_ROOT_PATH,
  type DirectionSection,
  directionChildNodePath,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionSetupAddress,
  formatDirectionPropAddress,
  formatDirectionSequenceAddress,
  formatDirectionShotAddress,
  formatDirectionBriefAddress,
  formatDirectionPolicyAddress,
  formatDirectionWaiverAddress,
  isDirectionBriefListField,
} from "../../../core/address.js";
import { resolveLens } from "../../../core/direction-structure.js";
import { setupView } from "../../../core/direction-frames.js";
import { directionWaiverKey } from "../../../core/direction-findings.js";
import { ROLE_FUNCTION_LABEL, PLEASURE_GLOSS } from "../../../core/lenses.js";
import type { DirectionSectionStatus } from "../../../core/direction-acceptance.js";
import type {
  BriefReference,
  Direction,
  DirectionBrief,
  DirectionNode,
  Pleasure,
  Shot,
} from "../../../core/dsl/direction.js";
import {
  declaredViews,
  resolveDirectionFormat,
  resolveDirectionTimeline,
} from "../../../core/dsl/direction.js";
import { isAsideShot, isGraphicShot } from "../../../core/dsl/shot-kind.js";
import { lyricText, singersOf } from "../../../core/dsl/direction-timeline.js";
import type { DirectionFinding, RoleFunction } from "../../../core/direction-check.js";
import type {
  BriefReferenceInfo,
  BriefSourceInfo,
  DirectionBriefFieldInfo,
  DirectionCharacterInfo,
  DirectionLocationInfo,
  DirectionPartInfo,
  DirectionPolicyFieldInfo,
  DirectionLyricsInfo,
  DirectionPreviewState,
  DirectionSequenceInfo,
  DirectionSetupInfo,
  DirectionShotInfo,
  DirectionVoiceInfo,
  DirectionWaiverInfo,
} from "../../../core/types/review-state.js";
import { scriptLinesToView } from "../../../core/types/script.js";
import type { Handoff } from "../../../core/types/index.js";
import { shotFrameResolver } from "./shot-facts.js";
import { sourceViewOf, spanLabelOf } from "../../../core/source-direction.js";

// Where the page fetches a study's sheets, under `<workspace>/.konte/studies/`.
export const STUDY_SHEET_BASE = "/api/study-sheets";

// The span by its chapter headings, else as written where the source cannot be read.
async function briefSourceView(
  direction: Direction,
  videoRoot: string,
): Promise<BriefSourceInfo | null> {
  const brief = direction.brief.source;
  if (!brief) return null;
  const sv = await sourceViewOf(direction, videoRoot).catch(() => null);
  return {
    span: sv ? spanLabelOf(sv) : brief.span,
    keep: [...(brief.keep ?? [])],
    drop: [...(brief.drop ?? [])],
  };
}

// A brief reference as the page shows it: the sheets of its study where one was made, never making
// one.
async function referenceView(videoRoot: string, ref: BriefReference): Promise<BriefReferenceInfo> {
  const workspaceRoot = workspaceRootOrNull();
  const study = workspaceRoot
    ? await cachedClipStudy(workspaceRoot, path.resolve(videoRoot, ref.clip)).catch(() => null)
    : null;
  return {
    clip: ref.clip,
    link: ref.link ?? null,
    variant: ref.take,
    avoid: ref.avoid,
    sheets: study
      ? study.study.sheets.map(
          (s) => `${STUDY_SHEET_BASE}/${path.basename(study.dir)}/${encodeURIComponent(s.file)}`,
        )
      : [],
  };
}

interface DirectionViewContext {
  direction: Direction;
  videoRoot: string;
  timeline: ReturnType<typeof resolveDirectionTimeline>;
  partView: (address: string) => DirectionPartInfo;
  characterNameById: ReadonlyMap<string, string>;
  frameOf: ReturnType<typeof shotFrameResolver>;
}

// The shot's `role` never crosses the wire: `method` is a word the reviewer cannot argue with, and
// naming it invites them to think they should. Its dramatic function does cross — as the label
// ("rising", "payoff"), a claim about the piece they can dispute on instinct alone. That function is
// read off the node's lens (a role the lens does not declare has none → null).
function roleFunctionOf(direction: Direction, lensName: string, role: string): RoleFunction | null {
  return resolveLens(lensName, direction.lenses)?.roles.find((b) => b.role === role)?.fn ?? null;
}

// The page shows names rather than ids. An id the character roster does not hold is a structural
// error, so it prints as itself.
function subjectNames(vc: DirectionViewContext, ids: readonly string[] | undefined): string[] {
  return (ids ?? []).map((id) => characterName(vc, id));
}

function characterName(vc: DirectionViewContext, id: string): string {
  return vc.characterNameById.get(id) ?? id;
}

function propNames(vc: DirectionViewContext, ids: readonly string[] | undefined): string[] {
  return (ids ?? []).map((id) => vc.direction.props?.[id]?.name ?? id);
}

function spanOf(
  vc: DirectionViewContext,
  s: Shot,
): { duration: number | null; beats: number | null } {
  const song = vc.direction.policy.song ?? null;
  const timing = vc.timeline.timings.get(s.id);
  return {
    duration: timing ? timing.duration : song ? null : 0,
    beats: song ? (s.beats ?? null) : null,
  };
}

function distinct(ids: readonly (string | undefined)[]): string[] {
  return [...new Set(ids.filter((id) => id !== undefined))];
}

// `nodePath` is the field path of the node the shot sits in — a shot is reviewed where it is
// declared, so its address hangs off its owner rather than off the root.
function shotView(
  vc: DirectionViewContext,
  s: Shot,
  lensName: string,
  nodePath: readonly string[],
): DirectionShotInfo {
  const { direction, frameOf } = vc;
  // An aside is no item of the arc, so every column the arc reads is null on it. What stays is what
  // a reviewer actually decides about one: that it is there, what it is, and how long it runs.
  if (isAsideShot(s)) {
    return {
      id: s.id,
      aside: true,
      graphic: false,
      beatFunction: null,
      roleFunctionLabel: null,
      action: s.label,
      setup: null,
      framing: null,
      location: null,
      script: [],
      lineup: [],
      lineupTo: [],
      passing: [],
      props: [],
      join: null,
      coverage: false,
      cutin: null,
      telop: [...(s.telop ?? [])],
      shows: { locations: [], setups: [], characters: [], props: [] },
      ...spanOf(vc, s),
      ...vc.partView(formatDirectionShotAddress(nodePath, s.id)),
    };
  }
  const fn = roleFunctionOf(direction, lensName, s.role);
  const own = isGraphicShot(s) ? null : s;
  const frames = [...(own ? [own] : []), ...(s.cutin ? [s.cutin] : [])];
  const cutin = s.cutin
    ? {
        setup: frameOf(s.cutin.setup).setupName,
        framing: frameOf(s.cutin.setup).framing,
        location: frameOf(s.cutin.setup).location,
        lineup: subjectNames(vc, s.cutin.lineup),
        lineupTo: subjectNames(vc, s.cutin.lineupTo),
        passing: subjectNames(vc, s.cutin.passing),
        props: propNames(vc, s.cutin.props),
        join: s.cutin.join ?? null,
      }
    : null;
  return {
    id: s.id,
    aside: false,
    graphic: own === null,
    // Drives the direction map's colors and the arc line's height.
    beatFunction: fn,
    roleFunctionLabel: fn ? ROLE_FUNCTION_LABEL[fn] : null,
    action: s.action,
    // The shot table's frame and space columns are read through the shot's setup — the reviewer
    // reads the size cadence down one and the space cadence down the other, and neither is declared
    // per shot.
    setup: own ? frameOf(own.setup).setupName : null,
    framing: own ? frameOf(own.setup).framing : null,
    location: own ? frameOf(own.setup).location : null,
    // The shot's spoken/narrated lines — reviewed with the action, character ids resolved to names.
    script: scriptLinesToView(s.script, vc.characterNameById),
    // Who the frame holds, left to right, and the order the shot leaves behind. `join` is what the
    // boundary into this shot is, drawn between the rows rather than inside one.
    lineup: subjectNames(vc, own?.lineup),
    lineupTo: subjectNames(vc, own?.lineupTo),
    passing: subjectNames(vc, own?.passing),
    props: propNames(vc, own?.props),
    join: own?.join ?? null,
    coverage: own?.coverage === true,
    cutin,
    // The shot's unspoken on-screen text. Bare strings — telop carries no speaker to resolve.
    telop: [...(s.telop ?? [])],
    shows: {
      locations: distinct(frames.map((f) => direction.setups?.[f.setup]?.location)),
      setups: distinct(frames.map((f) => f.setup)),
      characters: distinct([
        ...frames.flatMap((f) => [
          ...(f.lineup ?? []),
          ...(f.lineupTo ?? []),
          ...(f.passing ?? []),
        ]),
        ...(s.script ?? []).map((line) => ("character" in line ? line.character : undefined)),
      ]),
      props: distinct(frames.flatMap((f) => f.props ?? [])),
    },
    ...spanOf(vc, s),
    ...vc.partView(formatDirectionShotAddress(nodePath, s.id)),
  };
}

function pleasureView(name: Pleasure) {
  return { name, gloss: PLEASURE_GLOSS[name] };
}

// A child node's view: its own role function (read off its PARENT's lens, which orders it),
// pleasure, and body — its shots (checked against this node's lens) or its child sequences
// (recursively). Exactly one body is present, mirroring the DirectionNode it comes from.
function childNodeView(
  vc: DirectionViewContext,
  node: DirectionNode,
  parentLens: string,
  parentPath: readonly string[],
): DirectionSequenceInfo {
  const fn = node.role ? roleFunctionOf(vc.direction, parentLens, node.role) : null;
  const nodePath = directionChildNodePath(parentPath, node.id ?? "");
  return {
    id: node.id ?? "",
    beatFunction: fn,
    roleFunctionLabel: fn ? ROLE_FUNCTION_LABEL[fn] : null,
    synopsis: node.synopsis ?? "",
    pleasure: pleasureView(node.pleasure),
    ...vc.partView(formatDirectionSequenceAddress(nodePath)),
    ...(Array.isArray(node.shots)
      ? { shots: node.shots.map((s) => shotView(vc, s, node.lens, nodePath)) }
      : {
          sequences: (node.sequences ?? []).map((c) => childNodeView(vc, c, node.lens, nodePath)),
        }),
  };
}

// Each brief field is its own feedback target, so a note argues with the tone (or the scope) rather
// than with the concept wholesale. A prose field left unwritten is dropped, not rendered empty; the
// two list fields are always rendered, empty included, so a reviewer can ask for an entry the piece
// does not have yet.
async function briefFieldViews(vc: DirectionViewContext): Promise<DirectionBriefFieldInfo[]> {
  const { direction, videoRoot } = vc;
  const brief: Partial<DirectionBrief> = direction.brief ?? {};
  return (
    await Promise.all(
      DIRECTION_BRIEF_FIELDS.map(async (field): Promise<DirectionBriefFieldInfo | null> => {
        const view = vc.partView(formatDirectionBriefAddress(field));
        if (field === "references") {
          const references = brief.references ?? [];
          if (references.length === 0) return null;
          return {
            ...view,
            field,
            references: await Promise.all(references.map((r) => referenceView(videoRoot, r))),
          };
        }
        if (field === "source") {
          const source = await briefSourceView(direction, videoRoot);
          return source ? { ...view, field, source } : null;
        }
        if (isDirectionBriefListField(field)) {
          return { ...view, field, items: [...(brief[field] ?? [])] };
        }
        const text = brief[field];
        return text ? { ...view, field, text } : null;
      }),
    )
  ).filter((f) => f !== null);
}

// The always-declared policy fields, each its own feedback target below the brief. Structured (not
// pre-formatted) so the UI owns the labels and glosses, as it does for the brief.
function policyFieldViews(vc: DirectionViewContext): DirectionPolicyFieldInfo[] {
  const { direction, partView } = vc;
  const song = direction.policy.song ?? null;
  const resolvedFormat = resolveDirectionFormat(direction);
  return [
    {
      field: "format",
      aspects: [ratioOf(resolvedFormat.size.delivery)],
      fps: resolvedFormat.fps,
      base: resolvedFormat.size.base,
      megapixels: resolvedFormat.size.megapixels,
      delivery: resolvedFormat.size.delivery,
      ...partView(formatDirectionPolicyAddress("format")),
    },
    {
      field: "lang",
      lang: direction.policy.lang,
      ...partView(formatDirectionPolicyAddress("lang")),
    },
    {
      field: "fonts",
      fonts: [...(direction.policy.fonts ?? [])],
      ...partView(formatDirectionPolicyAddress("fonts")),
    },
    ...(song
      ? [{ field: "song" as const, song, ...partView(formatDirectionPolicyAddress("song")) }]
      : []),
  ];
}

// Only waived findings reach the page. An unwaived finding — or a structure error — blocks
// generation until the author clears it, so it never outlives their turn; putting it in front of a
// reviewer would ask them to arbitrate a rule written for the checker, in a state that cannot be
// accepted into anything anyway.
//
// A waiver is its own reviewable target: what was flagged, and the reason it was signed off.
function waiverViews(
  vc: DirectionViewContext,
  waived: readonly DirectionFinding[],
): DirectionWaiverInfo[] {
  return waived.map((f) => {
    const key = directionWaiverKey(f);
    return {
      code: f.code,
      subject: f.subject ?? null,
      message: f.message,
      reason: vc.direction.waivers?.[key] ?? "",
      ...vc.partView(formatDirectionWaiverAddress(key)),
    };
  });
}

function lyricsView(vc: DirectionViewContext): DirectionLyricsInfo | null {
  const lyrics = vc.direction.lyrics;
  if (!lyrics) return null;
  return {
    sections: lyrics.map((section) => ({
      label: section.label,
      singer: singersOf(section.singer).map((id) => characterName(vc, id)),
      lines: section.lines.map((line) => ({
        text: lyricText(line),
        singer:
          typeof line === "string"
            ? null
            : singersOf(line.singer).map((id) => characterName(vc, id)),
      })),
    })),
    ...vc.partView(DIRECTION_LYRICS_ADDRESS),
  };
}

function characterViews(vc: DirectionViewContext): DirectionCharacterInfo[] {
  return Object.entries(vc.direction.characters ?? {}).map(([id, c]) => ({
    id,
    name: c.name,
    description: c.description,
    ...(c.voice
      ? {
          voice: {
            description: c.voice.description,
            ...vc.partView(formatDirectionCharacterVoiceAddress(id)),
          } satisfies DirectionVoiceInfo,
        }
      : {}),
    ...vc.partView(formatDirectionCharacterAddress(id)),
  }));
}

function locationViews(vc: DirectionViewContext): DirectionLocationInfo[] {
  return Object.entries(vc.direction.locations ?? {}).map(([id, l]) => ({
    id,
    name: l.name,
    description: l.description,
    landmarks: Object.entries(l.landmarks ?? {}).map(([landmarkId, landmark]) => ({
      id: landmarkId,
      name: landmark.name,
      description: landmark.description,
    })),
    views: declaredViews(l.views).map(([view, v]) => ({
      view,
      holds: (v.holds ?? []).map((holdId) => l.landmarks?.[holdId]?.name ?? holdId),
    })),
    ...vc.partView(formatDirectionLocationAddress(id)),
  }));
}

// Grouped under their location on the page, so both are sent: the id it groups by, and the NAME it
// reads against the space column rather than against the roster key. `holds` resolves the same way,
// to its location's landmark names.
function setupViews(vc: DirectionViewContext): DirectionSetupInfo[] {
  const { direction } = vc;
  return Object.entries(direction.setups ?? {}).map(([id, s]) => {
    const view = setupView(direction.setups ?? {}, id);
    return {
      id,
      name: s.name,
      description: s.description,
      locationId: s.location,
      location: direction.locations?.[s.location]?.name ?? s.location,
      framing: s.framing,
      holds: (s.holds ?? []).map(
        (holdId) => direction.locations?.[s.location]?.landmarks?.[holdId]?.name ?? holdId,
      ),
      // The name, like `location` above. Sent only where the author declared one, so an undeclared
      // frame is not shown as a root while `within-undeclared` is asking it to choose.
      ...(s.within !== undefined
        ? { within: s.within ? (direction.setups?.[s.within]?.name ?? s.within) : null }
        : {}),
      ...(view ? { view } : {}),
      ...vc.partView(formatDirectionSetupAddress(id)),
    };
  });
}

// The direction as a media-less review view: the arc (lens/pleasure), every shot and (long-form)
// sequence with its role/synopsis/duration, the characters, the waived findings, and how much of it
// a human has signed off.
export async function directionPreviewState(args: {
  direction: Direction;
  videoRoot: string;
  handoff: Handoff | null;
  directionHash: string;
  sections: ReadonlyMap<DirectionSection, DirectionSectionStatus>;
  acceptSections: readonly DirectionSection[];
  waived: readonly DirectionFinding[];
  partView: (address: string) => DirectionPartInfo;
}): Promise<DirectionPreviewState> {
  const { direction, handoff, sections, acceptSections } = args;
  const timeline = resolveDirectionTimeline(direction);
  const vc: DirectionViewContext = {
    direction,
    videoRoot: args.videoRoot,
    timeline,
    partView: args.partView,
    characterNameById: new Map(
      Object.entries(direction.characters ?? {}).map(([id, c]) => [id, c.name]),
    ),
    frameOf: shotFrameResolver(direction),
  };
  const song = direction.policy.song ?? null;
  const lyrics = lyricsView(vc);
  const root = direction.sequence;

  const base = {
    mode: "direction-preview" as const,
    // The feeling the piece aims for — the one controlled term a reviewer can take a position on.
    // It is the root node's pleasure; the lens never crosses: choosing the shape is the agent's job,
    // and a reviewer says "this stretch drags", not "use kishotenketsu".
    pleasure: pleasureView(root.pleasure),
    directionHash: args.directionHash,
    // The verdict per box, which is the unit the page offers an Accept for. The header's own badge
    // is derived from these rather than sent beside them — two fields could disagree, and the one a
    // reviewer would believe is the one on the box they are reading.
    sections: Object.fromEntries(sections) as Record<DirectionSection, DirectionSectionStatus>,
    accept: {
      available: acceptSections.length > 0,
      standing:
        acceptSections.length > 0 && acceptSections.every((s) => sections.get(s) === "accepted"),
    },
    brief: await briefFieldViews(vc),
    policy: policyFieldViews(vc),
    song: song ? { beatsPerBar: timeline.songGrid?.beatsPerBar ?? null } : null,
    ...(lyrics ? { lyrics } : {}),
    sequence: vc.partView(formatDirectionSequenceAddress(DIRECTION_ROOT_PATH)),
    characters: characterViews(vc),
    ...(direction.narrator
      ? {
          narrator: {
            description: direction.narrator.description,
            ...vc.partView(DIRECTION_NARRATOR_ADDRESS),
          } satisfies DirectionVoiceInfo,
        }
      : {}),
    props: Object.entries(direction.props ?? {}).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
      ...vc.partView(formatDirectionPropAddress(id)),
    })),
    locations: locationViews(vc),
    setups: setupViews(vc),
    waivers: waiverViews(vc, args.waived),
    ...(handoff?.summary ? { handoffSummary: handoff.summary } : {}),
  };

  // The root node drives the page's top level: a branch (sequences) → the sequenced view (each act
  // rendered recursively); a leaf (shots) → the flat view. Deeper nesting lives inside each act.
  if (Array.isArray(root.sequences)) {
    return {
      ...base,
      kind: "sequenced",
      sequences: root.sequences.map((child) =>
        childNodeView(vc, child, root.lens, DIRECTION_ROOT_PATH),
      ),
    };
  }
  return {
    ...base,
    kind: "flat",
    shots: (root.shots ?? []).map((s) => shotView(vc, s, root.lens, DIRECTION_ROOT_PATH)),
  };
}
