import {
  DIRECTION_BRIEF_FIELDS,
  DIRECTION_NARRATOR_ADDRESS,
  DIRECTION_ROOT_PATH,
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
  Character,
  Direction,
  DirectionNode,
  Landmark,
  Location,
  Prop,
  Setup,
  Shot,
  Voice,
} from "./dsl/direction.js";
import { isAsideShot, isGraphicShot, resolveDirectionFormat } from "./dsl/direction.js";
import { shortHash } from "./content-hash.js";

// Two projections of the direction, for two different questions.
//
// `directionHash` is the whole parsed direction, prose included — only comments and formatting
// escape, since those never reach the parsed structure. Acceptance is tracked per PART (see
// `directionPartHashes`), so this is not the verdict itself; it is the SHORT-CIRCUIT for it. State
// stamps it once every part is accepted, and while it still matches, no part can have changed —
// which holds only because this projection is a superset of every part hash's input. Anything a
// part hashes must be reachable from here, or a direction edit would leave an acceptance standing
// that no human gave.
//
// `projectShape` is the narrower one, used for the root `sequence` part hash only: the sequence map
// shows the arc's shape, not its prose, so a note written on it survives a brief reword — even
// though its Accept is shared with the shots in the Flow & Shots box.
//
// `stableStringify` sorts object keys but PRESERVES array order, so shot/sequence order is part of
// the hash while the waiver map (a set of key→reason) is order-independent.

function projectShotShape(shot: Shot): unknown {
  // `setup` rides with the shape, not the prose: pointing a shot at a different frame re-shapes the
  // arc's size and space cadence, so an arc note ages out. The framing/location the setup CARRIES are
  // deliberately not resolved in here — they are the setup's own part to age out, exactly as a
  // character's voice is not folded into the character's hash. Re-describing one frame must not
  // re-block every shot on it.
  //
  // An aside has neither a role nor a setup, but it holds a span, and inserting or moving one
  // re-shapes the piece. So its `kind` and `duration` ride here and its label does not.
  if (isAsideShot(shot)) {
    return { id: shot.id, kind: "aside", duration: shot.duration };
  }
  // Whether a wipe is there, which camera it is and how it runs on are the arc's cadence like the
  // main frame's own `setup` and `join`; who it holds is the prose half below. Absent on a shot
  // with none, so declaring the field changes no hash a shot without one had.
  const cutin = shot.cutin
    ? { cutin: { setup: shot.cutin.setup, join: shot.cutin.join ?? null } }
    : {};
  if (isGraphicShot(shot)) {
    return { id: shot.id, kind: "graphic", role: shot.role, duration: shot.duration, ...cutin };
  }
  return {
    id: shot.id,
    role: shot.role,
    setup: shot.setup,
    duration: shot.duration,
    // The boundary into this shot rides with the shape too: whether the cut before it is there at
    // all, and whether story time breaks across it, is the arc's own cadence rather than prose.
    join: shot.join ?? null,
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
    ? { cutinLineup: { lineup: shot.cutin.lineup ?? [], lineupTo: shot.cutin.lineupTo ?? [] } }
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
    lineupTo: shot.lineupTo ?? [],
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

// A renamed or re-described character does re-accept — the look the human agreed to has changed, and
// so does the word every prompt calls them by.
function projectCharacters(characters: Record<string, Character> | undefined): unknown[] {
  return projectRoster(characters, (c) => ({
    name: c.name,
    promptDepiction: c.promptDepiction,
    description: c.description,
    voice: projectVoice(c.voice),
  }));
}

// A cast voice, for the whole-direction projection and its own part hash alike — the two must agree,
// or the acceptance short-circuit could outlive a voice edit no human re-read.
function projectVoice(voice: Voice | undefined): unknown {
  return voice ? { id: voice.id, description: voice.description } : null;
}

// Props and locations follow the characters' rule: a renamed or re-described one re-accepts.
function projectProps(props: Record<string, Prop> | undefined): unknown[] {
  return projectRoster(props, (p) => ({ name: p.name, description: p.description }));
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

function projectLocations(locations: Record<string, Location> | undefined): unknown[] {
  return projectRoster(locations, (l) => ({
    name: l.name,
    description: l.description,
    landmarks: projectLandmarks(l.landmarks),
  }));
}

// The setups roster in full — its prose plus the structural values it carries: the place and size
// every shot on it reads, what the frame holds, and the wider frame it is a window of.
function projectSetups(setups: Record<string, Setup> | undefined): unknown[] {
  return projectRoster(setups, (s) => ({
    name: s.name,
    description: s.description,
    location: s.location,
    framing: s.framing,
    holds: [...(s.holds ?? [])],
    // Absent and `null` fold together: they are one frame, a root of its own axis, so spelling out
    // `within: null` on a frame that was already one re-asks the reviewer nothing. Only the authoring
    // surfaces tell them apart, since only the absent form can be `within-undeclared`.
    within: s.within ?? null,
  }));
}

// The setups as the ARC sees them. Unlike the three identity rosters (ids only — their prose is not
// shape), a setup carries the size and the place of every shot on it, so those two ride the shape:
// re-pointing one frame from `close` to `wide` re-cuts the piece's size cadence, and an arc note
// written about that cadence must age out. The prose stays out.
function projectSetupShape(setups: Record<string, Setup> | undefined): unknown[] {
  return projectRoster(setups, (s) => ({ location: s.location, framing: s.framing }));
}

// A custom lens is a `LensSpec` the author wrote: rewriting its `beats` changes the arc every shot
// is placed on, even though `direction.lens` still names the same thing. Sorted by name — a lens
// registry is a lookup table, not an ordered list.
function projectLenses(lenses: readonly { name: string }[] | undefined): unknown[] {
  return [...(lenses ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

// A node's shape (no prose): its lens, aimed-for feeling, and its body's shapes. A child
// node's `id`/`role` are structural (they place it in its parent's arc), but its `synopsis` is prose
// and rides with `projectNode`. An act's aimed-for feeling is structural, like the piece's own:
// retargeting one act from `scary` to `emotional` is a change to the shape a human signed off on.
// Waivers ride with `projectNode`: each is a part of its own, so removing one moves no arc.
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

function projectNode(node: DirectionNode): unknown {
  return {
    ...(projectNodeShape(node) as object),
    synopsis: node.synopsis ?? null,
    waivers: node.waivers ?? {},
    ...(Array.isArray(node.shots)
      ? { shots: node.shots.map(projectShot) }
      : { sequences: (node.sequences ?? []).map(projectNode) }),
  };
}

// The policy fields, normalized once so the acceptance projection and the per-part hash agree: a
// note on the format ages out on exactly the edit that re-blocks acceptance.
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

// The arc's shape: the characters it can draw on, the lens definitions its nodes are placed on, and the
// tree itself. `lenses` rides here rather than in a part of its own — a custom lens is not a thing a
// reviewer takes a position on, it is the ruler every shot's role is measured against, so rewriting
// its beats changes the shape of the arc the sequence map shows while `node.lens` still names the same
// thing. Including it is also what makes `projectDirection` a superset of every part hash, which the
// acceptance short-circuit depends on (see `directionPartHashes`).
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

function projectDirection(direction: Direction): unknown {
  return {
    brief: direction.brief ?? null,
    characters: projectCharacters(direction.characters),
    narrator: projectVoice(direction.narrator),
    props: projectProps(direction.props),
    locations: projectLocations(direction.locations),
    setups: projectSetups(direction.setups),
    lenses: projectLenses(direction.lenses),
    policy: {
      format: projectFormat(direction),
      lang: direction.policy?.lang ?? null,
      fonts: projectFonts(direction.policy?.fonts),
      speech: direction.policy?.speech ?? null,
    },
    sequence: projectNode(direction.sequence),
  };
}

export function directionHash(direction: Direction): string {
  return hash(projectDirection(direction));
}

function hash(value: unknown): string {
  return shortHash(value);
}

// The content hash of each reviewable *part* of the direction, keyed by its feedback address. This
// map IS the set of parts: what it emits is what the review page must offer an Accept for and what
// the spend gate demands, so a part that gains no key here is a part nobody can be asked about.
//
// Both of the direction's verdicts hang off these hashes, which is why they are one map and not two.
// A comment has no variant to go stale against (the stage is media-less), so it snapshots its part's
// hash at authoring time: once that part reads differently, the comment was written about something
// that no longer exists and `computeFeedbackStale` ages it out. An acceptance is the same reviewer's
// other verdict on the same words, so it snapshots the same hash and ages out on the same edit.
//
// A part hash covers everything a reviewer sees ON THAT PART — a comment on a shot's action (or an
// act's synopsis) must go stale when that prose is rewritten. The root `sequence` is the exception: its section of the
// review shows the arc's shape (the shots, their order and lengths), not the prose hung on it, so it
// takes the narrower `projectShape` and an arc note survives a brief reword that re-blocks the gate.
export function directionPartHashes(direction: Direction): Map<string, string> {
  const out = new Map<string, string>();
  out.set(formatDirectionSequenceAddress(DIRECTION_ROOT_PATH), hash(projectShape(direction)));

  // Each brief field is reviewed on its own, so retuning the tone leaves a note on the logline
  // standing. A prose field the author left out has nothing to review and gets no key; the two list
  // fields always get one, empty included — "the piece bans nothing" / "the piece tolerates nothing"
  // is a position a reviewer takes and adds to, so it must stay reviewable.
  for (const field of DIRECTION_BRIEF_FIELDS) {
    const value = direction.brief?.[field];
    if (isDirectionBriefListField(field)) {
      out.set(formatDirectionBriefAddress(field), hash([...(value ?? [])]));
      continue;
    }
    if (value === undefined || value.length === 0) continue;
    out.set(formatDirectionBriefAddress(field), hash(value));
  }

  // The policy fields are always declared, so each gets a key unconditionally — a note on the
  // speech rule ages out only when the rule itself is retuned, not on a format edit.
  out.set(formatDirectionPolicyAddress("format"), hash(projectFormat(direction)));
  out.set(formatDirectionPolicyAddress("lang"), hash(direction.policy?.lang ?? null));
  out.set(formatDirectionPolicyAddress("fonts"), hash(projectFonts(direction.policy?.fonts)));
  out.set(formatDirectionPolicyAddress("speech"), hash(direction.policy?.speech ?? null));

  // One part per shot, aside included: an aside owes an accept and ages out when its label, span or
  // placement changes.
  const addShot = (s: Shot, nodePath: readonly string[]) =>
    out.set(formatDirectionShotAddress(nodePath, s.id), hash(projectShot(s)));

  // A note on a waiver argues with the reason given for it, so a reworded reason ages it out.
  const addWaivers = (waivers: Record<string, string> | undefined, nodePath: readonly string[]) => {
    for (const [key, reason] of Object.entries(waivers ?? {})) {
      out.set(formatDirectionWaiverAddress(nodePath, key), hash({ key, reason }));
    }
  };

  // Walk the arc tree: each node contributes its waivers, a child node its own sequence part, and a
  // leaf its shots — each keyed by the field path that reaches it. A sequence note is about the act
  // it brackets, so gaining or losing a direct child (a shot, or a sub-sequence) ages it out — that
  // is what the `children` id list captures.
  const addNode = (node: DirectionNode, nodePath: readonly string[], isRoot: boolean) => {
    if (!isRoot && node.id !== undefined) {
      out.set(
        formatDirectionSequenceAddress(nodePath),
        hash({
          id: node.id,
          role: node.role ?? null,
          lens: node.lens,
          pleasure: node.pleasure,
          synopsis: node.synopsis ?? null,
          children: Array.isArray(node.shots)
            ? node.shots.map((s) => s.id)
            : (node.sequences ?? []).map((c) => c.id),
        }),
      );
    }
    addWaivers(node.waivers, nodePath);
    if (Array.isArray(node.shots)) {
      for (const s of node.shots) addShot(s, nodePath);
    } else {
      for (const c of node.sequences ?? []) {
        addNode(c, directionChildNodePath(nodePath, c.id ?? ""), false);
      }
    }
  };
  addNode(direction.sequence, DIRECTION_ROOT_PATH, true);

  // A character's look and their voice are two assets, generated and accepted separately, so they
  // are two parts: the entry's hash deliberately EXCLUDES `voice`, or rewording the visual brief
  // would age out a note about how they sound (and the reverse). A voice part exists only while a
  // voice is cast — dropping one removes a key, which the gate reads as an orphan.
  for (const [id, c] of Object.entries(direction.characters ?? {})) {
    out.set(
      formatDirectionCharacterAddress(id),
      hash({ id, name: c.name, promptDepiction: c.promptDepiction, description: c.description }),
    );
    if (c.voice) {
      out.set(formatDirectionCharacterVoiceAddress(id), hash({ id, voice: projectVoice(c.voice) }));
    }
  }
  if (direction.narrator) {
    out.set(DIRECTION_NARRATOR_ADDRESS, hash({ narrator: projectVoice(direction.narrator) }));
  }
  for (const [id, p] of Object.entries(direction.props ?? {})) {
    out.set(formatDirectionPropAddress(id), hash({ id, name: p.name, description: p.description }));
  }
  for (const [id, l] of Object.entries(direction.locations ?? {})) {
    out.set(
      formatDirectionLocationAddress(id),
      hash({
        id,
        name: l.name,
        description: l.description,
        landmarks: projectLandmarks(l.landmarks),
      }),
    );
  }
  for (const [id, s] of Object.entries(direction.setups ?? {})) {
    out.set(
      formatDirectionSetupAddress(id),
      hash({
        id,
        name: s.name,
        description: s.description,
        location: s.location,
        framing: s.framing,
        holds: [...(s.holds ?? [])],
        within: s.within ?? null,
      }),
    );
  }
  return out;
}
