import {
  DIRECTION_BRIEF_FIELDS,
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
  CanvasSize,
  Cutin,
  Direction,
  DirectionNode,
  Framing,
  Landmark,
  Pleasure,
  SpeechPolicy,
} from "./dsl/direction.js";
import { isAsideShot, isGraphicShot, resolveDirectionFormat } from "./dsl/direction.js";
import type { ScriptLine } from "./types/script.js";

// What each reviewable part of the direction actually holds — the read side of `directionPartHashes`,
// which hashes the same parts under the same addresses. The two walks must emit the same key set: a
// part with a hash and no content is one the gate demands and no reader can show. `directionPartHashes`
// stays the authority on the set; a caller iterating live parts looks its content up here.

// One thing only a place has, shown under the location that declares it.
export type DirectionLandmarkContent = {
  id: string;
  name: string;
  promptDepiction: string;
  description: string;
};

export type DirectionPartContent =
  | {
      kind: "brief";
      field: DirectionBriefField;
      text: string | null;
      items: readonly string[] | null;
    }
  | { kind: "format"; fps: number; base: CanvasSize; delivery: CanvasSize | null }
  | { kind: "lang"; lang: string }
  // The declared families in declaration order — empty when the piece declares none, which is a
  // position a reviewer takes (text falls to the rendering machine's own faces), so it stays a part.
  | { kind: "fonts"; fonts: readonly string[] }
  | { kind: "speech"; speech: SpeechPolicy }
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
      duration: number;
      action: string;
      script: readonly ScriptLine[];
      telop: readonly string[];
      // Who the frame holds left to right, the order the shot leaves behind, and what the boundary
      // into this shot is. Empty/null on a shot that declares none.
      lineup: readonly string[];
      lineupTo: readonly string[];
      join: "continuous" | "jump-back" | "jump-forward" | null;
      cutin: DirectionCutinContent | null;
    }
  // A shot of the arc with no camera — a UI screen, a motion graphic.
  | {
      kind: "graphic";
      id: string;
      role: string;
      duration: number;
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
      duration: number;
      telop: readonly string[];
    }
  | { kind: "waiver"; key: string; reason: string };

// The second camera frame over a shot, as the direction declares it.
export type DirectionCutinContent = {
  setup: string;
  lineup: readonly string[];
  lineupTo: readonly string[];
  join: "continuous" | "jump-back" | "jump-forward" | null;
};

function cutinContent(cutin: Cutin | undefined): DirectionCutinContent | null {
  return cutin
    ? {
        setup: cutin.setup,
        lineup: cutin.lineup ?? [],
        lineupTo: cutin.lineupTo ?? [],
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

function nodeChildIds(node: DirectionNode): string[] {
  return Array.isArray(node.shots)
    ? node.shots.map((s) => s.id)
    : (node.sequences ?? []).map((c) => c.id ?? "");
}

export function directionPartContents(direction: Direction): Map<string, DirectionPartContent> {
  const out = new Map<string, DirectionPartContent>();

  for (const field of DIRECTION_BRIEF_FIELDS) {
    const value = direction.brief?.[field];
    if (isDirectionBriefListField(field)) {
      out.set(formatDirectionBriefAddress(field), {
        kind: "brief",
        field,
        text: null,
        items: [...((value as readonly string[] | undefined) ?? [])],
      });
      continue;
    }
    if (value === undefined || value.length === 0) continue;
    out.set(formatDirectionBriefAddress(field), {
      kind: "brief",
      field,
      text: value as string,
      items: null,
    });
  }

  const format = direction.policy?.format ? resolveDirectionFormat(direction) : null;
  out.set(formatDirectionPolicyAddress("format"), {
    kind: "format",
    fps: format?.fps ?? 0,
    base: format?.size.base ?? { width: 0, height: 0 },
    delivery: format?.size.delivery ?? null,
  });
  out.set(formatDirectionPolicyAddress("lang"), {
    kind: "lang",
    lang: direction.policy?.lang ?? "",
  });
  out.set(formatDirectionPolicyAddress("fonts"), {
    kind: "fonts",
    fonts: [...(direction.policy?.fonts ?? [])],
  });
  out.set(formatDirectionPolicyAddress("speech"), {
    kind: "speech",
    speech: direction.policy?.speech ?? "free",
  });

  const addNode = (node: DirectionNode, nodePath: readonly string[], isRoot: boolean) => {
    if (isRoot || node.id !== undefined) {
      out.set(formatDirectionSequenceAddress(nodePath), {
        kind: "sequence",
        id: node.id ?? null,
        role: node.role ?? null,
        synopsis: node.synopsis ?? null,
        lens: node.lens,
        pleasure: node.pleasure,
        children: nodeChildIds(node),
      });
    }
    for (const [key, reason] of Object.entries(node.waivers ?? {})) {
      out.set(formatDirectionWaiverAddress(nodePath, key), { kind: "waiver", key, reason });
    }
    if (Array.isArray(node.shots)) {
      for (const s of node.shots) {
        out.set(
          formatDirectionShotAddress(nodePath, s.id),
          isAsideShot(s)
            ? {
                kind: "aside",
                id: s.id,
                label: s.label,
                duration: s.duration,
                telop: s.telop ?? [],
              }
            : isGraphicShot(s)
              ? {
                  kind: "graphic",
                  id: s.id,
                  role: s.role,
                  duration: s.duration,
                  action: s.action,
                  script: s.script ?? [],
                  telop: s.telop ?? [],
                  cutin: cutinContent(s.cutin),
                }
              : {
                  kind: "shot",
                  id: s.id,
                  role: s.role,
                  setup: s.setup,
                  duration: s.duration,
                  action: s.action,
                  script: s.script ?? [],
                  telop: s.telop ?? [],
                  lineup: s.lineup ?? [],
                  lineupTo: s.lineupTo ?? [],
                  join: s.join ?? null,
                  cutin: cutinContent(s.cutin),
                },
        );
      }
      return;
    }
    for (const c of node.sequences ?? []) {
      addNode(c, directionChildNodePath(nodePath, c.id ?? ""), false);
    }
  };
  addNode(direction.sequence, DIRECTION_ROOT_PATH, true);

  for (const [id, c] of Object.entries(direction.characters ?? {})) {
    out.set(formatDirectionCharacterAddress(id), {
      kind: "roster",
      roster: "characters",
      id,
      name: c.name,
      description: c.description,
      promptDepiction: c.promptDepiction ?? null,
      landmarks: null,
    });
    if (c.voice) {
      out.set(formatDirectionCharacterVoiceAddress(id), {
        kind: "voice",
        characterId: id,
        name: c.name,
        description: c.voice.description,
        assetId: c.voice.id,
      });
    }
  }
  if (direction.narrator) {
    out.set(DIRECTION_NARRATOR_ADDRESS, {
      kind: "voice",
      characterId: null,
      name: null,
      description: direction.narrator.description,
      assetId: direction.narrator.id,
    });
  }
  for (const [id, p] of Object.entries(direction.props ?? {})) {
    out.set(formatDirectionPropAddress(id), {
      kind: "roster",
      roster: "props",
      id,
      name: p.name,
      description: p.description,
      promptDepiction: null,
      landmarks: null,
    });
  }
  for (const [id, l] of Object.entries(direction.locations ?? {})) {
    out.set(formatDirectionLocationAddress(id), {
      kind: "roster",
      roster: "locations",
      id,
      name: l.name,
      description: l.description,
      promptDepiction: null,
      landmarks: landmarkContents(l.landmarks),
    });
  }
  for (const [id, s] of Object.entries(direction.setups ?? {})) {
    out.set(formatDirectionSetupAddress(id), {
      kind: "setup",
      id,
      name: s.name,
      description: s.description,
      location: s.location,
      framing: s.framing,
      holds: [...(s.holds ?? [])],
      ...(s.within !== undefined ? { within: s.within } : {}),
    });
  }

  return out;
}
