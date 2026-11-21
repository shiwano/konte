import {
  DIRECTION_BRIEF_FIELDS,
  DIRECTION_LYRICS_ADDRESS,
  DIRECTION_NARRATOR_ADDRESS,
  DIRECTION_ROOT_PATH,
  type DirectionBriefField,
  directionChildNodePath,
  formatDirectionBriefAddress,
  formatDirectionCharacterAddress,
  formatDirectionCharacterVoiceAddress,
  formatDirectionLocationAddress,
  formatDirectionSetupAddress,
  formatDirectionPolicyAddress,
  formatDirectionPropAddress,
  formatDirectionSequenceAddress,
  formatDirectionShotAddress,
  formatDirectionWaiverAddress,
  isDirectionBriefListField,
} from "./address.js";
import type {
  BriefReference,
  CanvasSize,
  Cutin,
  Direction,
  DirectionLyrics,
  DirectionNode,
  Framing,
  View,
  Landmark,
  LocationViews,
  Pleasure,
  Setup,
  Shot,
  Voice,
} from "./dsl/direction.js";
import {
  declaredViews,
  resolveDirectionFormat,
  resolveDirectionTimeline,
} from "./dsl/direction.js";
import { isAsideShot, isGraphicShot } from "./dsl/shot-kind.js";
import { singersOf } from "./dsl/direction-timeline.js";
import type { ShotJoin } from "./types/definition.js";
import type { ScriptLine } from "./types/script.js";

// Each reviewable part of the direction, keyed by its feedback address, as two readings of one
// walk: `hashInput` is what its hash covers (see `directionPartHashes`), `content` what a reader is
// shown. The map's key set IS the set of parts, in the order a reader is told about them.

// One thing only a place has, shown under the location that declares it.
type DirectionLandmarkContent = {
  id: string;
  name: string;
  promptDepiction: string;
  description: string;
};

export type DirectionPartContent =
  | {
      kind: "brief";
      field: Exclude<DirectionBriefField, "references" | "source">;
      text: string | null;
      items: readonly string[] | null;
    }
  | { kind: "references"; references: readonly BriefReference[] }
  // The original the piece is adapted from: the span and the adaptation map.
  | {
      kind: "source";
      span: string;
      keep: readonly string[];
      drop: readonly string[];
    }
  | { kind: "format"; fps: number; base: CanvasSize; delivery: CanvasSize | null }
  | { kind: "lang"; lang: string }
  // The declared families in declaration order — empty when the piece declares none, which is a
  // position a reviewer takes (text falls to the rendering machine's own faces), so it stays a part.
  | { kind: "fonts"; fonts: readonly string[] }
  | { kind: "song"; song: string }
  // The song's words by section and who sings each section; a line's own singers are null where
  // its section's sing it.
  | {
      kind: "lyrics";
      sections: readonly {
        label: string;
        singer: readonly string[];
        lines: readonly { text: string; singer: readonly string[] | null }[];
      }[];
    }
  | {
      kind: "roster";
      roster: "characters" | "props" | "locations";
      id: string;
      name: string;
      description: string;
      // The noun a prompt calls this entry by — a character's own, null on the two rosters no check
      // reads one for.
      promptDepiction: string | null;
      // What only this place has, in roster order. Null on the two rosters that declare none.
      landmarks: readonly DirectionLandmarkContent[] | null;
      // Each way a camera faces in this place and the landmark ids it sees. Null on the two rosters
      // that declare none.
      views: readonly { view: string; holds: readonly string[] }[] | null;
    }
  // A camera setup. Its own kind rather than a fourth `roster`: it carries the frame's size and place
  // as well as its prose, and unlike the three identity rosters it is not anchored to a
  // `reference:<id>` — what realizes it is an animatic plate, so a reader must not be pointed at a
  // reference asset that will never exist.
  | {
      kind: "setup";
      id: string;
      name: string;
      description: string;
      location: string;
      framing: Framing;
      // The landmark ids this frame carries, left to right on screen.
      holds: readonly string[];
      // The setup id this frame steps in from; `null` where the author declared this frame
      // a root, absent where they declared neither.
      within?: string | null;
      // The way the camera faces; absent on a window, which faces its parent's way.
      view?: View;
    }
  // A cast voice. `characterId`/`name` are the character it belongs to, both null for the narrator —
  // who is cast piece-wide and has no roster entry. `assetId` is the `reference:<id>` holding the
  // sample, printed so a reader can go hear what the brief describes.
  | {
      kind: "voice";
      characterId: string | null;
      name: string | null;
      description: string;
      assetId: string;
    }
  | {
      kind: "sequence";
      id: string | null;
      role: string | null;
      synopsis: string | null;
      lens: string;
      pleasure: Pleasure;
      children: readonly string[];
    }
  | {
      kind: "shot";
      id: string;
      role: string;
      // The frame this shot is taken from. Its size and place are the setup's own part to show and to
      // age out, so they are not copied in here — a reader resolves them through the roster.
      setup: string;
      // The span on the timeline in seconds, on the frame grid — null on the song while no take of it
      // is read — and the beats it was written as on the song (null without one).
      duration: number | null;
      beats: number | null;
      action: string;
      script: readonly ScriptLine[];
      telop: readonly string[];
      // Who the frame holds left to right, the order the shot leaves behind, the props it shows, and
      // what the boundary into this shot is. Empty/null on a shot that declares none.
      lineup: readonly string[];
      lineupTo: readonly string[];
      passing: readonly string[];
      props: readonly string[];
      join: ShotJoin | null;
      // A shot the model cuts inside, its frame columns the opening one.
      coverage: boolean;
      cutin: DirectionCutinContent | null;
    }
  // A shot of the arc with no camera — a UI screen, a motion graphic.
  | {
      kind: "graphic";
      id: string;
      role: string;
      duration: number | null;
      beats: number | null;
      action: string;
      script: readonly ScriptLine[];
      telop: readonly string[];
      cutin: DirectionCutinContent | null;
    }
  // A shot that occupies the clock without being a shot of the arc — a title card, an eyecatch, an
  // OP. It shows what it is and how long it runs; the arc's columns (role, frame, action, lines) are
  // absent, not blank.
  | {
      kind: "aside";
      id: string;
      label: string;
      duration: number | null;
      beats: number | null;
      telop: readonly string[];
    }
  | { kind: "waiver"; key: string; reason: string };

// The second camera frame over a shot, as the direction declares it.
type DirectionCutinContent = {
  setup: string;
  lineup: readonly string[];
  lineupTo: readonly string[];
  passing: readonly string[];
  props: readonly string[];
  join: ShotJoin | null;
};

function cutinContent(cutin: Cutin | undefined): DirectionCutinContent | null {
  return cutin
    ? {
        setup: cutin.setup,
        lineup: cutin.lineup ?? [],
        lineupTo: cutin.lineupTo ?? [],
        passing: cutin.passing ?? [],
        props: cutin.props ?? [],
        join: cutin.join ?? null,
      }
    : null;
}

function landmarkContents(
  landmarks: Record<string, Landmark> | undefined,
): DirectionLandmarkContent[] {
  return Object.entries(landmarks ?? {}).map(([id, l]) => ({
    id,
    name: l.name,
    promptDepiction: l.promptDepiction,
    description: l.description,
  }));
}

// The span as written: beats on the song, seconds without one. Whichever the author did not
// write is absent.
function projectSpan(shot: Shot): { duration: number } | { beats: number } | object {
  if (shot.beats !== undefined) return { beats: shot.beats };
  if (shot.duration !== undefined) return { duration: shot.duration };
  return {};
}

function projectShotShape(shot: Shot): unknown {
  // `setup` rides with the shape, not the prose: pointing a shot at a different frame re-shapes the
  // arc's size and space cadence, so an arc note ages out. The framing/location the setup CARRIES are
  // deliberately not resolved in here — they are the setup's own part to age out, exactly as a
  // character's voice is not folded into the character's hash. Re-describing one frame must not
  // re-block every shot on it.
  //
  // An aside has neither a role nor a setup, but it holds a span, and inserting or moving one
  // re-shapes the piece. So its `kind` and span ride here and its label does not.
  if (isAsideShot(shot)) {
    return { id: shot.id, kind: "aside", ...projectSpan(shot) };
  }
  // Whether a wipe is there, which camera it is and how it runs on are the arc's cadence like the
  // main frame's own `setup` and `join`; who it holds is the prose half below. Absent on a shot
  // with none, so declaring the field changes no hash a shot without one had.
  const cutin = shot.cutin
    ? { cutin: { setup: shot.cutin.setup, join: shot.cutin.join ?? null } }
    : {};
  if (isGraphicShot(shot)) {
    return { id: shot.id, kind: "graphic", role: shot.role, ...projectSpan(shot), ...cutin };
  }
  return {
    id: shot.id,
    role: shot.role,
    setup: shot.setup,
    ...projectSpan(shot),
    // The boundary into this shot rides with the shape too: whether the cut before it is there at
    // all, and whether story time breaks across it, is the arc's own cadence rather than prose.
    join: shot.join ?? null,
    // Whether the model cuts inside the take is the arc's cadence too.
    ...(shot.coverage ? { coverage: true } : {}),
    ...cutin,
  };
}

function projectShot(shot: Shot): unknown {
  // `script` and `telop` ride with `action`, not with the shape: the words are prose a reviewer reads
  // and re-accepts, but they are not the arc's shape, so a sequence note survives a dialogue edit.
  if (isAsideShot(shot)) {
    return { ...(projectShotShape(shot) as object), label: shot.label, telop: shot.telop ?? [] };
  }
  const cutinLineup = shot.cutin
    ? {
        cutinLineup: {
          lineup: shot.cutin.lineup ?? [],
          lineupTo: shot.cutin.lineupTo ?? null,
          passing: [...(shot.cutin.passing ?? [])].sort(),
          props: [...(shot.cutin.props ?? [])].sort(),
        },
      }
    : {};
  if (isGraphicShot(shot)) {
    return {
      ...(projectShotShape(shot) as object),
      action: shot.action,
      script: shot.script ?? [],
      telop: shot.telop ?? [],
      ...cutinLineup,
    };
  }
  return {
    ...(projectShotShape(shot) as object),
    action: shot.action,
    script: shot.script ?? [],
    telop: shot.telop ?? [],
    // Who the frame holds rides with the prose, not the shape: moving someone across the deck is an
    // edit to the performance a reviewer reads, not to the arc's size and space cadence. A line's
    // `acting` needs no line of its own — it is inside `script`.
    lineup: shot.lineup ?? [],
    lineupTo: shot.lineupTo ?? null,
    passing: [...(shot.passing ?? [])].sort(),
    props: [...(shot.props ?? [])].sort(),
    ...cutinLineup,
  };
}

// A roster is a set (membership) keyed by id, so it is projected sorted by id: adding or removing
// an entry re-accepts, but the record's key order never matters.
function projectRoster<T>(
  roster: Record<string, T> | undefined,
  pick: (entry: T) => Record<string, unknown>,
): unknown[] {
  return Object.entries(roster ?? {})
    .map(([id, entry]) => ({ id, ...pick(entry) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function projectVoice(voice: Voice | undefined): unknown {
  return voice ? { id: voice.id, description: voice.description } : null;
}

// The landmarks ride with the place: what only this room has is part of what the room looks like, so
// adding or renaming one re-accepts the location the reviewer agreed to. A roster keyed by id, so it
// projects sorted like every other.
function projectLandmarks(landmarks: Record<string, Landmark> | undefined): unknown[] {
  return projectRoster(landmarks, (l) => ({
    name: l.name,
    promptDepiction: l.promptDepiction,
    description: l.description,
  }));
}

// A view's `holds` has no order.
function projectViews(views: LocationViews | undefined): unknown[] {
  return projectRoster(Object.fromEntries(declaredViews(views)), (v) => ({
    holds: [...(v.holds ?? [])].sort(),
  }));
}

// The setups as the ARC sees them. Unlike the three identity rosters (ids only — their prose is not
// shape), a setup carries the size and the place of every shot on it, so those two ride the shape:
// re-pointing one frame from `close` to `wide` re-cuts the piece's size cadence, and an arc note
// written about that cadence must age out. The prose stays out.
function projectSetupShape(setups: Record<string, Setup> | undefined): unknown[] {
  return projectRoster(setups, (s) => ({ location: s.location, framing: s.framing }));
}

// A custom lens is a `LensSpec` the author wrote: rewriting its `roles` changes the arc every shot
// is placed on, even though `direction.lens` still names the same thing. Sorted by name — a lens
// registry is a lookup table, not an ordered list.
function projectLenses(lenses: readonly { name: string }[] | undefined): unknown[] {
  return [...(lenses ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

// A node's shape (no prose): its lens, aimed-for feeling, and its body's shapes. A child
// node's `id`/`role` are structural (they place it in its parent's arc), but its `synopsis` is prose
// and rides with the node's own part. An act's aimed-for feeling is structural, like the piece's own:
// retargeting one act from `scary` to `emotional` is a change to the shape a human signed off on.
function projectNodeShape(node: DirectionNode): unknown {
  return {
    id: node.id ?? null,
    role: node.role ?? null,
    lens: node.lens,
    pleasure: node.pleasure,
    ...(Array.isArray(node.shots)
      ? { shots: node.shots.map(projectShotShape) }
      : { sequences: (node.sequences ?? []).map(projectNodeShape) }),
  };
}

// Declaration order is the fallback order, so the list is hashed as authored — never sorted.
function projectFonts(fonts: Direction["policy"]["fonts"]): unknown {
  return [...(fonts ?? [])];
}

// The DERIVED canvas is what is hashed, never the budget it came from: a budget edit that lands on
// the same canvas changes nothing downstream and must not age the part out, and one that moves the
// canvas must. A version bump reaches the hash the same way, through the canvas it resolves to.
function projectFormat(direction: Direction): unknown {
  const format = direction.policy?.format;
  if (!format) return null;
  const resolved = resolveDirectionFormat(direction);
  return { fps: resolved.fps, base: resolved.size.base, delivery: resolved.size.delivery };
}

// The words in singing order, with their sections and who sings each.
function projectLyrics(lyrics: DirectionLyrics | undefined): unknown {
  if (!lyrics) return null;
  return lyrics.map((s) => ({
    label: s.label,
    singer: s.singer,
    lines: s.lines.map((l) =>
      typeof l === "string" ? { text: l } : { text: l.text, singer: l.singer },
    ),
  }));
}

// The arc's shape: the characters it can draw on, the lens definitions its nodes are placed on, and the
// tree itself. `lenses` rides here rather than in a part of its own — a custom lens is not a thing a
// reviewer takes a position on, it is the ruler every shot's role is measured against, so rewriting
// its roles changes the shape of the arc the sequence map shows while `node.lens` still names the same
// thing.
//
// This is the "shape the sequence map shows" the reviewer reads at the top of the Flow & Shots box.
function projectShape(direction: Direction): unknown {
  return {
    characters: Object.keys(direction.characters ?? {}).sort(),
    props: Object.keys(direction.props ?? {}).sort(),
    locations: Object.keys(direction.locations ?? {}).sort(),
    setups: projectSetupShape(direction.setups),
    lenses: projectLenses(direction.lenses),
    sequence: projectNodeShape(direction.sequence),
  };
}

type DirectionPart = { hashInput: unknown; content: DirectionPartContent };

export function directionParts(direction: Direction): Map<string, DirectionPart> {
  const out = new Map<string, DirectionPart>();
  const put = (address: string, hashInput: unknown, content: DirectionPartContent) =>
    out.set(address, { hashInput, content });

  // The root's part shows the arc's shape, not the prose hung on it, so an arc note survives a
  // brief reword.
  put(formatDirectionSequenceAddress(DIRECTION_ROOT_PATH), projectShape(direction), {
    kind: "sequence",
    id: null,
    role: null,
    synopsis: null,
    lens: direction.sequence.lens,
    pleasure: direction.sequence.pleasure,
    children: nodeChildIds(direction.sequence).map((id) => id ?? ""),
  });

  // Each brief field is reviewed on its own. A prose field the author left out has nothing to
  // review and gets no part; the two list fields always get one, empty included — "the piece bans
  // nothing" is a position a reviewer takes and adds to.
  for (const field of DIRECTION_BRIEF_FIELDS) {
    const address = formatDirectionBriefAddress(field);
    if (field === "references") {
      const references = direction.brief?.references ?? [];
      if (references.length > 0) put(address, references, { kind: "references", references });
      continue;
    }
    if (field === "source") {
      const source = direction.brief?.source;
      if (source) {
        put(address, source, {
          kind: "source",
          span: source.span,
          keep: [...(source.keep ?? [])],
          drop: [...(source.drop ?? [])],
        });
      }
      continue;
    }
    if (isDirectionBriefListField(field)) {
      const items = [...(direction.brief?.[field] ?? [])];
      put(address, items, { kind: "brief", field, text: null, items });
      continue;
    }
    const text = direction.brief?.[field];
    if (text === undefined || text.length === 0) continue;
    put(address, text, { kind: "brief", field, text, items: null });
  }

  const format = direction.policy?.format ? resolveDirectionFormat(direction) : null;
  put(formatDirectionPolicyAddress("format"), projectFormat(direction), {
    kind: "format",
    fps: format?.fps ?? 0,
    base: format?.size.base ?? { width: 0, height: 0 },
    delivery: format?.size.delivery ?? null,
  });
  put(formatDirectionPolicyAddress("lang"), direction.policy?.lang ?? null, {
    kind: "lang",
    lang: direction.policy?.lang ?? "",
  });
  put(formatDirectionPolicyAddress("fonts"), projectFonts(direction.policy?.fonts), {
    kind: "fonts",
    fonts: [...(direction.policy?.fonts ?? [])],
  });
  // A piece keeps seconds until it declares a song, and the part exists only once it does.
  const song = direction.policy?.song;
  if (song) put(formatDirectionPolicyAddress("song"), song, { kind: "song", song });

  // A note on a waiver argues with the reason given for it, so a reworded reason ages it out.
  for (const [key, reason] of Object.entries(direction.waivers ?? {})) {
    put(formatDirectionWaiverAddress(key), { key, reason }, { kind: "waiver", key, reason });
  }

  const timings = direction.policy?.format ? resolveDirectionTimeline(direction).timings : null;
  const span = (s: Shot) => {
    const timing = timings?.get(s.id);
    return {
      duration: timing ? timing.duration : song ? null : (s.duration ?? 0),
      beats: song ? (s.beats ?? null) : null,
    };
  };

  // One part per shot, aside included. A child node's part is about the act it brackets, so
  // gaining or losing a direct child ages it out.
  const addNode = (node: DirectionNode, nodePath: readonly string[]) => {
    if (Array.isArray(node.shots)) {
      for (const s of node.shots) {
        put(formatDirectionShotAddress(nodePath, s.id), projectShot(s), shotContent(s, span(s)));
      }
      return;
    }
    for (const c of node.sequences ?? []) {
      const path = directionChildNodePath(nodePath, c.id ?? "");
      if (c.id !== undefined) {
        const children = nodeChildIds(c);
        put(
          formatDirectionSequenceAddress(path),
          {
            id: c.id,
            role: c.role ?? null,
            lens: c.lens,
            pleasure: c.pleasure,
            synopsis: c.synopsis ?? null,
            children,
          },
          {
            kind: "sequence",
            id: c.id,
            role: c.role ?? null,
            synopsis: c.synopsis ?? null,
            lens: c.lens,
            pleasure: c.pleasure,
            children: children.map((id) => id ?? ""),
          },
        );
      }
      addNode(c, path);
    }
  };
  addNode(direction.sequence, DIRECTION_ROOT_PATH);

  // A character's look and their voice are two assets, generated and accepted separately, so they
  // are two parts: rewording the look leaves a note on the voice standing, and the reverse.
  for (const [id, c] of Object.entries(direction.characters ?? {})) {
    put(
      formatDirectionCharacterAddress(id),
      { id, name: c.name, promptDepiction: c.promptDepiction, description: c.description },
      {
        kind: "roster",
        roster: "characters",
        id,
        name: c.name,
        description: c.description,
        promptDepiction: c.promptDepiction ?? null,
        landmarks: null,
        views: null,
      },
    );
    if (c.voice) {
      put(
        formatDirectionCharacterVoiceAddress(id),
        { id, voice: projectVoice(c.voice) },
        {
          kind: "voice",
          characterId: id,
          name: c.name,
          description: c.voice.description,
          assetId: c.voice.id,
        },
      );
    }
  }
  if (direction.narrator) {
    put(
      DIRECTION_NARRATOR_ADDRESS,
      { narrator: projectVoice(direction.narrator) },
      {
        kind: "voice",
        characterId: null,
        name: null,
        description: direction.narrator.description,
        assetId: direction.narrator.id,
      },
    );
  }
  if (direction.lyrics) {
    put(DIRECTION_LYRICS_ADDRESS, projectLyrics(direction.lyrics), {
      kind: "lyrics",
      sections: direction.lyrics.map((s) => ({
        label: s.label,
        singer: singersOf(s.singer),
        lines: s.lines.map((l) =>
          typeof l === "string"
            ? { text: l, singer: null }
            : { text: l.text, singer: singersOf(l.singer) },
        ),
      })),
    });
  }
  for (const [id, p] of Object.entries(direction.props ?? {})) {
    put(
      formatDirectionPropAddress(id),
      { id, name: p.name, promptDepiction: p.promptDepiction, description: p.description },
      {
        kind: "roster",
        roster: "props",
        id,
        name: p.name,
        description: p.description,
        promptDepiction: p.promptDepiction ?? null,
        landmarks: null,
        views: null,
      },
    );
  }
  for (const [id, l] of Object.entries(direction.locations ?? {})) {
    put(
      formatDirectionLocationAddress(id),
      {
        id,
        name: l.name,
        description: l.description,
        landmarks: projectLandmarks(l.landmarks),
        views: projectViews(l.views),
      },
      {
        kind: "roster",
        roster: "locations",
        id,
        name: l.name,
        description: l.description,
        promptDepiction: null,
        landmarks: landmarkContents(l.landmarks),
        views: declaredViews(l.views).map(([view, v]) => ({ view, holds: v.holds ?? [] })),
      },
    );
  }
  for (const [id, s] of Object.entries(direction.setups ?? {})) {
    put(
      formatDirectionSetupAddress(id),
      {
        id,
        name: s.name,
        description: s.description,
        location: s.location,
        framing: s.framing,
        holds: [...(s.holds ?? [])],
        within: s.within ?? null,
        view: s.view ?? null,
      },
      {
        kind: "setup",
        id,
        name: s.name,
        description: s.description,
        location: s.location,
        framing: s.framing,
        holds: [...(s.holds ?? [])],
        ...(s.within !== undefined ? { within: s.within } : {}),
        ...(s.view ? { view: s.view } : {}),
      },
    );
  }
  return out;
}

export function directionPartContents(direction: Direction): Map<string, DirectionPartContent> {
  return new Map([...directionParts(direction)].map(([address, p]) => [address, p.content]));
}

function nodeChildIds(node: DirectionNode): (string | undefined)[] {
  return Array.isArray(node.shots)
    ? node.shots.map((s) => s.id)
    : (node.sequences ?? []).map((c) => c.id);
}

function shotContent(
  s: Shot,
  span: { duration: number | null; beats: number | null },
): DirectionPartContent {
  if (isAsideShot(s)) {
    return { kind: "aside", id: s.id, label: s.label, ...span, telop: s.telop ?? [] };
  }
  if (isGraphicShot(s)) {
    return {
      kind: "graphic",
      id: s.id,
      role: s.role,
      ...span,
      action: s.action,
      script: s.script ?? [],
      telop: s.telop ?? [],
      cutin: cutinContent(s.cutin),
    };
  }
  return {
    kind: "shot",
    id: s.id,
    role: s.role,
    setup: s.setup,
    ...span,
    action: s.action,
    script: s.script ?? [],
    telop: s.telop ?? [],
    lineup: s.lineup ?? [],
    lineupTo: s.lineupTo ?? [],
    passing: s.passing ?? [],
    props: s.props ?? [],
    join: s.join ?? null,
    coverage: s.coverage === true,
    cutin: cutinContent(s.cutin),
  };
}
