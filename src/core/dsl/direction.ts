import type { BuiltinLens, Pleasure } from "../lenses.js";
import type { CanvasBudget, CanvasSize, ReferenceShape } from "../canvas.js";
import { CANVAS_GRID, deriveCanvasBase, idealSize } from "../canvas.js";
import { ratioOf } from "../aspect.js";
import type { ScriptLine } from "../types/script.js";
import type { Typography } from "../types/definition.js";
import type { ArcItem, LensSpec } from "../direction-check.js";
import type { PendingShotInput, ShotHandle, ShotInput, StageShots } from "./builders.js";
import type { ShotFunction } from "./shot-context.js";
import { makePlaceholder, runInDiscoveryMode } from "./shot-context.js";
import type { ShotStage } from "../address.js";
import type { ShotScript } from "./shot-script.js";
import { makeShotScript } from "./shot-script.js";
import type {
  ArcIdOf,
  AsideShotContext,
  AsideIdOf,
  ChainRest,
  CutinOf,
  DirectionShotTuple,
  FirstShotId,
  DirectionIdTuple,
  GraphicShotContext,
  GraphicIdOf,
  LineupOf,
  LineupToOf,
  NarrativeIdOf,
  ScriptOf,
  StageShotContext,
  StageChain,
  StageCutinContext,
} from "./animatic-builders.js";
import {
  isPendingShotInput,
  makeMediaAsset,
  type AnyShotInput,
  type AsideShotInput,
  type MediaAsset,
  type MediaKind,
} from "./builders.js";
import { assertFontFamilies, assertLanguageTag, type LanguageTag } from "../typography.js";
import { validateShotId, type ValidatedIdentifier } from "./validate-identifier.js";

// Re-export the arc layer so the DSL surface (index.ts / template-entry.ts) has one import point.
export type { Pleasure } from "../lenses.js";
export type { ScriptLine } from "../types/script.js";
export { defineLens } from "../lenses.js";
export type {
  ArcItem,
  Beat,
  BeatFunction,
  DirectionFinding,
  DirectionFindingCode,
  LensSpec,
} from "../direction-check.js";

// A cast member's voice. `id` is an exposed `reference:<id>` asset name holding the sample —
// separate from the look anchor, and never shared with another cast member. `description` is how
// they sound (sex, age, timbre, pace, register), read by whoever writes the TTS/voice-clone prompt.
//
// Optional in the type, required in practice: a script line is what demands one, which no type can
// state, so the checker does (`character-voice-missing` / `narrator-missing`) and a piece whose lines
// are never spoken aloud waives it.
export type Voice = { id: string; description: string };

// A declared character — a recurring character (person, creature, mascot) whose look must stay
// consistent across shots, so it is always anchored to a reference asset. The roster keys it by its
// `id`: the controlled-vocabulary token that must equal the name of an exposed `reference:<id>`
// asset. `name` is how every shot `action` refers to it; `description` is the visual brief.
//
// `voice` is required once any shot gives this character a `{ character }` script line, and is
// reviewed as a part of its own (`direction:characters.<id>.voice`).
//
// `promptDepiction` is what a model's prompt calls them by. `name` is written in the project's
// working language and a prompt is written in the model's, so scanning for one never finds the other — and
// what a keyframe must name is checked against this (`subject-unnamed`). A noun the model can draw:
// a role ("owner") and a proper name are both words it has no look for. Carry the least that tells
// this one from the others in the piece ("girl in a purple hoodie" where a bare "girl" is two
// people), and no adapter notation. No declared depiction may contain another
// (`prompt-depiction-conflict`).
export type Character = {
  name: string;
  promptDepiction: string;
  description: string;
  voice?: Voice;
};

// A declared recurring prop — an object (a handheld item, a set piece) whose look must stay
// consistent across the shots it appears in, so it is anchored to a reference asset exactly like a
// character. Unlike a character it never speaks, so it carries no script linkage. Keyed by its `id`
// (must equal an exposed `reference:<id>` asset name); `name` is how every shot `action` refers to
// it, `description` is the visual brief. The prop `id` shares the reference namespace with the
// characters, so it may not collide with a character `id`.
export type Prop = { name: string; description: string };

// A declared location — a recurring place (a set, a room, an exterior) a shot happens in, whose look
// must stay consistent across the shots set there, so it is anchored to a reference asset exactly
// like a character or prop. Keyed by its `id` (must equal an exposed `reference:<id>` asset name),
// which shares the reference namespace with the characters and props (a collision is a structural
// error). Unlike a character/prop, a location is not named in a shot's `action` prose (a place does
// not act) — a shot reaches its location through its `setup`, so drift between the roster and the
// shots is caught by exact id membership, not a prose scan. `description` is the visual brief.
//
// A location is the place, not a view of it: it anchors what the set is made of, and the `setups`
// declared in it are the frames taken from it.
//
// `landmarks` is what the set is recognized by — required and non-empty (`landmarks-empty`), since a
// frame with nothing only this place has in it comes back as another room. Each `setups.<id>.holds`
// names the ones its frame carries.
export type Location = {
  name: string;
  description: string;
  landmarks: Record<string, Landmark>;
};

// A thing only this place has — the desk, the arm lamp, the window it is always shot through. Keyed
// by its `id` inside its location's `landmarks`, and named left to right by the `holds` of every
// setup whose frame carries it.
//
// Its id is outside the `reference:<id>` namespace: what anchors a landmark is the plate its setup
// stands on, so there is no sheet to expose for it. It still shares the direction's one id space, so
// it may not collide with a character, a prop, a location, or a landmark of another place
// (`landmark-id-conflict`).
//
// `promptDepiction` is the noun a prompt calls it by, exactly as a character's is —
// `plate-unnamed` reads the plate's own sentence for it. `description` is where it stands and what
// it looks like.
export type Landmark = { name: string; promptDepiction: string; description: string };

// A framing — the size of the `action`'s mover in the frame, a controlled vocabulary so the size
// cadence is a structured direction value the pacing check reads, not prose the model defaults past.
// `wide` sets the subject small in its space (geography, situation); `medium` is the default readable
// size (subject and immediate surroundings); `close` is the face/detail (reaction, the landed
// expression); `insert` fills the frame with an object (a plant-and-payoff). It is declared on a
// `Setup` rather than a shot: the size is a property of where the camera stands, so two shots on one
// setup cannot disagree about it.
export type Framing = "wide" | "medium" | "close" | "insert";

// A declared camera setup — one camera position in one location, the frame it takes, and the size
// that frame is. Every shot names one in its required `setup` field, and its `location`/`framing` are
// read through it rather than declared per shot.
//
// The other rosters bind an IDENTITY (who, what, where) and anchor to a `reference:<id>` sheet shared
// by both stages. A setup binds a FRAME, which only the animatic consumes — the video inherits it
// through the panel — so its anchor is the **plate**, an image declared under `plates` in
// animatic.tsx and keyed by this id (`animatic:plate.<id>`), and the `setups` roster itself is prose.
// A setup two or more shots share owes a plate (`setup-unrealized`) and the shots on it must build
// from it (`setup-unconsumed`); one only a single shot names has nothing to hold together and owes
// nothing, so a one-off frame costs a declaration and no generation.
//
// `name` is how a person refers to the frame, `description` is where the camera stands and what it
// sees, `location` is the `id` of a declared `locations` roster entry (a frame is always somewhere).
//
// `holds` is what this frame carries of the set — its location's landmark ids, left to right on
// screen, required and non-empty for every framing but `insert` (`holds-empty`). An insert fills the
// frame with one object and shows no set, so it is the one frame with nothing to hold.
//
// `within` is the wider frame this one steps in from along its axis — a declaration, like `join`,
// never derived: two frames of one place in a subsequence relation are as often a reverse or a second axis
// as a push-in. It names a setup of the same location with a strictly wider `framing`
// (`wide` < `medium` < `close`), and steps may be skipped. `null` says this frame is the root of its
// axis and steps in from nothing; omission is legal only where no wider frame could be the window's
// (`within-undeclared`). An `insert` holds nothing, so it is outside the axis entirely. What the
// declaration buys is `plate-unnested`: the plate must be built from the parent's plate — a cut from
// it or a window inside it — so the set's scale is carried rather than re-invented per plate.
export type Setup = {
  name: string;
  description: string;
  location: string;
  framing: Framing;
  holds: readonly string[];
  within?: string | null;
};

// The agreed concept — what the piece is, for whom, and how it should feel — captured from the
// shaping conversation and reviewed in `konte preview direction` alongside the shots it
// constrains. Prose only: excluded from the acceptance hash (a wording pass never re-blocks the
// spend gate). Every field takes feedback of its own (`direction:brief.<field>`, see
// DIRECTION_BRIEF_FIELDS) and is hashed on its own, so a comment ages out only when the field it
// was written about is rewritten.
//
// `hook` is what the first two seconds put on screen — the frame that stops a scroll — so the
// first shot, the polish pass and the direction critic all read against one sentence.
//
// The two list fields run opposite ways: `outOfScope` is what the piece must not contain,
// `tolerances` what may show up in the output and is left alone. Unlike a feedback comment, a
// tolerance is not aged out by the next generation.
export type DirectionBrief = {
  logline: string;
  hook?: string;
  audience?: string;
  tone?: string;
  look?: string;
  outOfScope?: readonly string[];
  tolerances?: readonly string[];
};

export type { CanvasSize };

// The canvas the piece renders to, pinned on the direction so the agent knows it before the stage
// files exist — the single source of truth for size and fps. The working resolution is derived from
// the two authored numbers (`deriveCanvasBase`), never written:
//
//   - `size.delivery` is the frame `konte export` delivers, and the only declared aspect.
//   - `size.megapixels` is the generation budget; generation time scales with pixel count.
//   - `fps` is the video frame rate.
//
// The derived base and the delivery feed the acceptance hash, so a budget edit that lands on the
// same canvas re-blocks nothing, and one that moves it re-blocks the direction.
export type DirectionFormat = {
  fps: number;
  size: CanvasBudget;
};

// `DirectionFormat` with the canvas resolved. This is what every stage and reader sees
// (`DirectionIndex.format`); the authored form above reaches nothing but the derivation.
export type ResolvedDirectionFormat = {
  fps: number;
  size: CanvasBudget & { base: CanvasSize };
};

// The declared speech policy for the whole piece. `none` forbids any script line (dialogue and
// narration alike); `no-dialogue` allows `{narration}` but forbids spoken lines; `free` imposes no
// constraint (any script is allowed). A shot whose `script` violates the policy raises the waivable
// `unexpected-script` finding. The policy is a required, deliberate choice — there is no "unset"
// state to default silently past review; pick `free` to allow anything.
export type SpeechPolicy = "none" | "no-dialogue" | "free";

// The piece-wide, machine-checked policy: the canvas (`format`), the typesetting (`lang`, `fonts`)
// and the speech rule (`speech`). All feed the acceptance hash, and each is its own reviewed feedback
// part (`direction:policy.<field>`, see DIRECTION_POLICY_FIELDS), so a note on the speech rule is not
// aged out by a canvas-size edit.
export type DirectionPolicy = {
  format: DirectionFormat;
  // The language the piece is authored and rendered in. It becomes the composition document's root
  // `lang`, which is what decides the glyph shapes a browser picks for a codepoint no declared font
  // covers, and the line-breaking rules it applies. One per piece: a document has one root language,
  // and a stray line in another script is set on its own element, not declared here.
  lang: LanguageTag;
  // The web fonts every stage typesets with, by their Google Fonts family names — a fallback stack in
  // declaration order, resolved per codepoint. Declaring none leaves text on whatever faces the
  // rendering machine has installed, which the definition hash does not cover. A `lang` whose script
  // no system face is guaranteed to cover raises `fonts-undeclared`.
  fonts?: readonly string[];
  speech: SpeechPolicy;
};

// Shot-scale leaf: duration is required (it is the rhythm source of truth that pacing checks read).
// `role` is a plain string validated against the node's lens (a foreign role is a waivable finding,
// not a type error). `action` is the single on-screen action this clip lands — the leaf-scale twin
// of a branch node's `synopsis` (the engine holds both as one generic `ArcItem` field). `script` is
// the shot's spoken lines — the source of truth injected into both stages' builds so a video's
// subtitles derive from one place, never re-authored per stage; `telop` is its unspoken twin.
export type NarrativeShot = Omit<ArcItem<string>, "synopsis" | "location" | "framing" | "aside"> & {
  // The discriminant, defaulted rather than required: a shot is narrative unless it
  // says otherwise, so the ordinary case stays unannotated.
  kind?: "shot";
  action: string;
  // The frame this shot is taken from — the `id` of a declared `setups` roster entry (required, so
  // every shot resolves to a place and a size, and shots sharing a frame are named as sharing it).
  // A structured field rather than prose: a camera position does not appear in the `action` sentence,
  // so it is pinned here and matched to the roster by exact id. The shot's `framing` and `location`
  // are read through it — declaring either here as well would let a shot contradict its own setup.
  setup: string;
  duration: number;
  // The lines this shot SPEAKS aloud. Every line demands a cast voice and an `animatic` on the video
  // shot, which is why the unspoken kind lives in `telop` instead of borrowing this field.
  script?: readonly ScriptLine[];
  // Text laid OVER the picture and never spoken — a title, a lower third, a caption with no speaker.
  // Bare strings: a `ScriptLine` is an object only to carry the speaker attribution, which telop has
  // no axis for, and timing is the stage's to decide just as it is for `script`. Words that exist
  // inside the world (a sign, a shop front) are not telop — they belong to the image prompt.
  telop?: readonly string[];
  // Who this frame holds, left to right on screen — `characters` ids, declared rather than derived
  // from a floor plan. A subject only a sleeve of whom is in frame is in the list; one the frame
  // does not hold is absent, and there is no off-frame axis to put them on.
  //
  // It is the frame's own truth: a push-in onto one person lists that person. Continuity between
  // shots is the checker's (it accumulates "a is left of b" per location), so a shot never repeats
  // what has not changed.
  //
  // Required, `[]` where the frame holds no one (an insert of a prop, an empty place). The board's
  // reference inputs are checked against it (`character-unconsumed`).
  lineup: readonly string[];
  // The frame at the shot's END, in full, when it is not the one it opened on — a move inside the
  // shot, an entrance, an exit, or a change meant to land on the next cut. Whoever the opening frame
  // held and this one does not has walked out of it, so their place stops being known until a later
  // frame holds them again; the shots after read against what this shot left behind.
  lineupTo?: readonly string[];
  // What the boundary INTO this shot is, so the shot after a boundary owns it.
  //
  // Omitted is an ordinary cut with story time running on. `jump-back` and `jump-forward` are cuts
  // that move story time (into a flashback, past a gap or out of one); both flush the accumulated
  // lineup order in every location, because given time people move anywhere. `continuous` is no cut
  // at all — this shot and the one before it are one unbroken take.
  //
  // The four states are exclusive and exhaustive, so a jump inside a long take is not expressible.
  // `continuous` is only possible where the shot before it on the clock is a narrative shot on the
  // SAME setup — a literal elsewhere is a type error (`ConstrainJoin`), a computed one
  // `join-impossible` — and where it is possible those pairs must choose one of the three
  // (`join-undeclared`).
  join?: "continuous" | "jump-back" | "jump-forward";
  // A second camera frame laid over this shot's picture (a wipe in the corner, a reaction over the
  // main frame). See `Cutin`.
  cutin?: Cutin;
};

// A second camera frame over a shot — who a wipe holds and where its camera stands. Read by every
// check a main frame's `setup` and `lineup` are: it is one more shot on its setup, shares the
// lineup accumulation of its place, and owes its keyframes the same references and names. Where the
// wipe sits and how big it is are the stage's (`<Cutin>`).
//
// `join` is the boundary into this shot's wipe, on the wipe's own axis: `continuous` is a wipe that
// runs on from the one over the shot before it in one take, a jump a cut inside the wipe that moves
// story time. It is possible and demanded on the same terms as the main frame's — the shot before
// it on the clock carries a cutin on the same setup (`join-impossible` / `join-undeclared`).
export type Cutin = {
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
};

// A shot of the arc with no camera — a UI screen, a motion graphic, a chart. It carries everything
// the arc reads (`role`, `action`, `duration`, `script`, `telop`) and none of the four fields a
// camera view has (`setup`, `lineup`, `lineupTo`, `join`), so every spatial check passes over it.
// Its picture is built whole in the animatic's composition and placed again by the video; a
// character on screen is a `cutin` over it, never part of the graphic.
export type GraphicShot = Omit<NarrativeShot, "kind" | "setup" | "lineup" | "lineupTo" | "join"> & {
  kind: "graphic";
  cutin?: Cutin;
};

// A shot that occupies the clock without being part of the arc — a title card, an eyecatch, a
// sponsor card, an OP or ED dropped in whole. It holds a duration and nothing else the arc reads:
// no `role` (it performs no dramatic function), no `setup` (it is not a camera view of a place),
// no `action` (nothing acts in it).
//
// The arc and pacing checks skip it, so a 90-second OP never dilutes the act ratios around it. The
// animatic never boards it: `asideShot(id)` places it there with no build and konte fills the span
// with a labelled slug, so the reel's clock still matches the video's. The video DOES author it
// (`asideShot(id, …)`, usually a `file`), and the coverage checks still watch it: a declared aside
// nobody realizes is `unrealized` at export like any other shot.
//
// It carries no `script`. A spoken line demands a cast voice and an `<Audio>` on the animatic shot,
// and an aside has no animatic shot to carry one — words over an aside are `telop`, or already
// inside the media it drops in. A shot that needs a line spoken over it is a narrative shot.
export type AsideShot = {
  kind: "aside";
  id: string;
  // What occupies the clock here, in the project's working language ("OP", "提供カード", "アイキャッチ").
  // It is what the board's slug prints and what the direction review shows, so it names the thing
  // rather than describing a picture — the picture is the video stage's, and for an OP it is not
  // konte's at all. Required: an unlabelled hole in the runtime is unreviewable.
  label: string;
  duration: number;
  // Text laid over it and never spoken — a title card's own words. Same field, same meaning as a
  // narrative shot's, and the only text an aside carries.
  telop?: readonly string[];
};

// A leaf's members. `Shot` stays the name of the whole because a leaf's `shots` array holds every
// kind and every reader that only needs "some shot" keeps reading one type; the members are named
// where a reader needs to know which it has.
export type Shot = NarrativeShot | GraphicShot | AsideShot;

export function isAsideShot(shot: Shot): shot is AsideShot {
  return shot.kind === "aside";
}

export function isGraphicShot(shot: Shot): shot is GraphicShot {
  return shot.kind === "graphic";
}

// A node of the arc tree — the single recursive unit the whole direction is built from. Its `lens`
// names the arc its body forms: a LEAF carries `shots` (a run of shots), a BRANCH carries
// `sequences` (a run of child nodes), and a branch's lens governs the order/pacing/payoff of its
// children just as a leaf's lens governs its shots. Nesting is arbitrary: a branch's children may
// themselves be branches (an act of acts). Only a *child* node carries `id`/`role`/`synopsis` — it
// is an item in its parent's arc and an addressable review target; the root node has no parent, so
// it omits them. `pleasure` is the feeling this node aims for and the one thing a person with no
// craft vocabulary can argue with on the review page ("that act should not be scary") — required on
// every node, since a node that could stay silent would, and the reviewer would be left with nothing
// to take a position on. `waivers` cancels this node's own arc findings; the root's bag also owns
// the piece-wide characters/speech findings. Both `pleasure` and the shape are in the acceptance hash —
// retargeting or restructuring a node re-blocks the spend gate.
export type DirectionNode = {
  id?: string;
  role?: string;
  synopsis?: string;
  lens: string;
  pleasure: Pleasure;
  waivers?: Record<string, string>;
  shots?: Shot[];
  sequences?: DirectionNode[];
};

// The always-declared direction policy: `brief`, `characters`, and `policy` (canvas + speech rule)
// are required so every session opens on the full, explicit prior agreement rather than a set of
// silent defaults. `lenses` is the one exception — it is an extension mechanism (custom lenses on top
// of the built-ins), not an agreement, so it stays optional.
export type Direction = {
  brief: DirectionBrief;
  // The character roster, keyed by id (`id` -> character). A set, not a sequence: reordering never
  // re-accepts, and the key uniqueness structurally forbids a duplicate id (see direction-hash).
  characters: Record<string, Character>;
  // Recurring props anchored to reference assets, checked and reviewed like the characters. Optional — a
  // piece may declare none (unlike `characters`, which is always the piece's roster) — so it defaults
  // to an empty roster. Keyed by id like `characters`.
  props?: Record<string, Prop>;
  // The location roster, keyed by id (`id` -> location). Required and non-empty: every setup names
  // one, so the roster must offer at least one. Keyed by id like `characters`, sharing the reference
  // namespace (a collision with a character/prop id is a structural error).
  locations: Record<string, Location>;
  // The camera-setup roster, keyed by id (`id` -> setup). Required and non-empty: every shot points at
  // one via its `setup` field, so the roster must offer at least one — the review's frame and space
  // columns and the unused-setup check all depend on it. Unlike the three identity rosters this one
  // does NOT share the `reference:<id>` namespace: a setup's plate lives at `animatic:plate.<id>`, so
  // a setup id may equal a character/prop/location id without conflict.
  setups: Record<string, Setup>;
  // Who reads the piece's `{ narration }` lines. Piece-wide and singular: a narration line carries no
  // speaker tag, so konte cannot tell two narrators apart — a piece that needs more than one voice
  // over picture writes those lines as `{ speaker }` instead. Required once any shot declares a
  // narration line (`narrator-missing`), and reviewed as `direction:narrator`. Unlike a character it
  // has no look, so it is a bare `Voice` rather than a roster entry.
  narrator?: Voice;
  // Custom lenses referenced by name from any node's `lens`, alongside the built-ins.
  lenses?: LensSpec<string>[];
  // The machine-checked canvas + speech rule, each reviewed as its own feedback part.
  policy: DirectionPolicy;
  // The root of the arc tree. A leaf for a short piece (`{ lens, shots }`), a branch for a long one
  // (`{ lens, sequences }`). Named `sequence` because every node is a sequence — an ordered run that
  // forms an arc — whether it runs over shots or over sub-sequences.
  sequence: DirectionNode;
};

// `const` inference produces readonly tuples, which are NOT assignable to the mutable arrays of
// `Direction` — so `<const D extends Direction>` would reject every literal. Constrain to a
// structural shape whose arrays are `readonly` instead: it still type-checks `role`/`duration`,
// but never widens the inferred literal ids. `duration` stays required so the direction must declare it.
type NarrativeShotShape = {
  id: string;
  kind?: "shot";
  role: string;
  action: string;
  setup: string;
  duration: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  // Left as `readonly string[]` rather than narrowed to the roster keys: `<const D>` captures the
  // literal tuple either way (that is what `LineupOf` reads), and `ConstrainIds` re-blames each
  // element at its own position.
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
  cutin?: CutinShape;
};
type CutinShape = {
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
};
// The camera fields a graphic shot does not have are `never` rather than merely absent: a const
// literal is not checked for excess properties against a generic constraint, so without these a
// `setup` written on a graphic shot would be accepted and silently ignored.
type GraphicShotShape = {
  id: string;
  kind: "graphic";
  role: string;
  action: string;
  duration: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  cutin?: CutinShape;
  setup?: never;
  lineup?: never;
  lineupTo?: never;
  join?: never;
};
type AsideShotShape = {
  id: string;
  kind: "aside";
  label: string;
  duration: number;
  telop?: readonly string[];
  cutin?: never;
};
type ShotShape = NarrativeShotShape | GraphicShotShape | AsideShotShape;
type NodeBodyShape = { shots: readonly ShotShape[] } | { sequences: readonly ChildNodeShape[] };
type NodeCommonShape = {
  lens: string;
  pleasure: Pleasure;
  waivers?: Record<string, string>;
};
// A child node is an item in its parent's arc, so it carries `id`/`role`/`synopsis`; the recursion
// bottoms out at a leaf (a body of `shots`).
type ChildNodeShape = NodeCommonShape & {
  id: string;
  role: string;
  synopsis: string;
} & NodeBodyShape;
// The root node has no parent, so no `id`/`role`/`synopsis`; its `pleasure` is the piece's own.
type RootNodeShape = NodeCommonShape & NodeBodyShape;

type DirectionInput = {
  brief: DirectionBrief;
  characters: Record<string, Character>;
  props?: Record<string, Prop>;
  locations: Record<string, Location>;
  setups: Record<string, Setup>;
  narrator?: Voice;
  lenses?: readonly LensSpec<string>[];
  policy: DirectionPolicy;
  sequence: RootNodeShape;
};

// Every id in the direction is an address part (`reference:<id>`, `<stage>:shot.<id>.<name>`), so it
// must be an identifier — `a-z A-Z 0-9 - _`. These constrain each id-bearing position of the inferred
// literal at the type level: `defineDirection` takes `D & ConstrainIds<D>`, so `D` still infers from
// the bare argument (keeping ShotIdOf/DirectionIdTuple exact) while `ConstrainIds<D>` re-blames any bad
// id at its own position. A non-literal `string` id passes through (caught at runtime instead).
type ConstrainRosterIds<R> = R & {
  [K in keyof R & string as ValidatedIdentifier<K> extends string
    ? never
    : K]: ValidatedIdentifier<K>;
};
// The ids a `lineup` may name: the characters roster — a prop is not lined up, since the row has one
// axis and a prop sits in front of or behind as often as beside. A roster typed `Record<string, …>`
// rather than a literal widens this to `string`, so a computed direction passes through here and is
// caught by `lineup-unknown-id`.
type SubjectIdOf<D extends DirectionInput> = Extract<keyof D["characters"], string>;
// A branded error carrying the offending id in a required property KEY, the way
// `IdentifierViolation` does — an OBJECT rather than the roster union, because a lineup is checked
// through an intersection with the tuple the author wrote, and a `never` element collapses the whole
// tuple to `never` and blames every id in it.
type LineupSubjectViolation<T extends string> = {
  [P in `konte: lineup id "${T}" is not a declared character id`]: never;
};
// Re-blame each element of a lineup at its own position, so a typo draws its line where it was
// typed rather than on the shot.
type ConstrainLineup<L, Subjects extends string> = {
  // A widened `string` element passes through, exactly as `Identifier` lets one through: a computed
  // list has no literal to blame, and `lineup-unknown-id` is the receiver for it.
  [K in keyof L]: string extends L[K]
    ? L[K]
    : L[K] extends Subjects
      ? L[K]
      : L[K] extends string
        ? LineupSubjectViolation<L[K]>
        : never;
};
// A `lineupTo` equal to the `lineup` says the frame ends where it began, which leaving it out
// already says. Branded in the `lineupTo` position, the way `HoldsRequired` brands `holds`. A
// widened tuple on either side passes through — two `readonly string[]`s are mutually assignable,
// and a computed order has no literal to blame — and `lineup-vacuous` receives it.
// The names a direction's own `lenses` declares. `resolveLens` prefers one of these over the built-in
// of the same name, and `defineLens` widens its name to `string` — which could be any built-in's.
type DeclaredLensNameOf<D> = D extends { lenses: readonly (infer L)[] }
  ? L extends { name: infer N }
    ? N
    : never
  : never;
// The roles a node's lens declares, read off the built-in registry's literals. A name a declared lens
// could shadow, a name no built-in has, and a widened name all answer `string` — the pass-through a
// widened id takes, with `lens-role-mismatch` as the receiver.
type LensRolesOf<Name, Declared> = string extends Name
  ? string
  : [Declared] extends [never]
    ? BuiltinLensRolesOf<Name>
    : [Name] extends [Declared]
      ? string
      : BuiltinLensRolesOf<Name>;
type BuiltinLensRolesOf<Name> =
  Extract<BuiltinLens, { name: Name }> extends infer L
    ? [L] extends [never]
      ? string
      : L extends { beats: infer B extends readonly { role: string }[] }
        ? B[number]["role"]
        : string
    : string;
// An item's `role` against the roles its parent's lens declares, blamed at the role itself. A node
// carrying none (the root, an aside) has nothing to blame.
type ConstrainRole<Item, Roles extends string> = Item extends { role: infer R }
  ? string extends R
    ? unknown
    : string extends Roles
      ? unknown
      : [R] extends [Roles]
        ? unknown
        : {
            role: DirectionViolation<`konte: "${R & string}" is not a beat role this node's lens declares`>;
          }
  : unknown;

// An array whose contents the type does not know — `string[]`, `readonly ScriptLine[]` — rather than a
// tuple. Read off `length`, which a tuple carries as a literal: a `readonly T[]` guard alone misses a
// mutable `T[]`, since a readonly array is not assignable to a mutable one.
type IsWidenedArray<A> = A extends readonly unknown[]
  ? number extends A["length"]
    ? true
    : false
  : false;
// A branded error in the offending field's own position, carrying its message in the type ARGUMENT
// so the compiler prints the advice rather than an alias name — the form `WithinViolation` takes.
type DirectionViolation<M extends string> = { [P in M]: never };
type ConstrainLineupTo<F, LT> = F extends { lineup: infer L extends readonly string[] }
  ? IsWidenedArray<L> extends true
    ? unknown
    : IsWidenedArray<LT> extends true
      ? unknown
      : [L] extends [LT]
        ? [LT] extends [L]
          ? {
              lineupTo: DirectionViolation<"konte: this `lineupTo` is the `lineup` again — write the order the shot leaves behind, or drop it">;
            }
          : unknown
        : unknown
  : unknown;
// The two lineup positions of one frame, re-blamed per element. A main frame and a cutin carry the
// same pair.
type ConstrainFrameLineups<F, Subjects extends string> = (F extends {
  lineup: infer L extends readonly string[];
}
  ? { lineup: ConstrainLineup<L, Subjects> }
  : unknown) &
  (F extends { lineupTo: infer L extends readonly string[] }
    ? { lineupTo: ConstrainLineup<L, Subjects> } & ConstrainLineupTo<F, L>
    : unknown);

// A shot's span is a window the render cuts the take to, so it lands on the 0.5s grid every legal
// fps divides whole. Read off the literal's decimal digits — a type does no arithmetic — so a
// negative or computed value passes through to `off-grid-duration`. An aside is outside the check
// (`checkDurations` walks `collectArcShots`), so it is outside this too.
type ConstrainDuration<B> = B extends { kind: "aside" }
  ? unknown
  : B extends { duration: infer N }
    ? number extends N
      ? unknown
      : `${N & number}` extends `${string}.${infer Decimals}`
        ? Decimals extends "5"
          ? unknown
          : {
              duration: DirectionViolation<"konte: a shot's duration is a multiple of 0.5s, so it lands a whole frame at every fps">;
            }
        : [N] extends [0]
          ? {
              duration: DirectionViolation<"konte: a shot's duration is a multiple of 0.5s, so it lands a whole frame at every fps">;
            }
          : unknown
    : unknown;

// The one sentence a shot lands, and a child node's own summary. Empty is `empty-synopsis`; a
// whitespace-only string has no literal form to catch, so that one stays the finding's.
type ConstrainAction<B> = B extends { action: infer A }
  ? [A] extends [""]
    ? {
        action: DirectionViolation<"konte: `action` is the one thing this shot lands — it cannot be empty">;
      }
    : unknown
  : unknown;
type ConstrainSynopsis<N> = N extends { synopsis: infer S }
  ? [S] extends [""]
    ? {
        synopsis: DirectionViolation<"konte: `synopsis` is what this act of the arc IS — it cannot be empty">;
      }
    : unknown
  : unknown;

// `policy.speech` read against the shot that contradicts it: `none` forbids every line, `no-dialogue`
// forbids a spoken one and lets narration through. A widened policy passes through to
// `unexpected-script`, as a widened roster does to its own finding.
type SpokenLines<S> = Extract<S, { character: unknown } | { speaker: unknown }>;
type ConstrainSpeech<B, Speech> = SpeechPolicy extends Speech
  ? unknown
  : B extends { script: infer S extends readonly ScriptLine[] }
    ? IsWidenedArray<S> extends true
      ? unknown
      : [Speech] extends ["none"]
        ? [S] extends [readonly []]
          ? unknown
          : {
              script: DirectionViolation<'konte: policy.speech is "none", so no shot declares a script line'>;
            }
        : [Speech] extends ["no-dialogue"]
          ? [SpokenLines<S[number]>] extends [never]
            ? unknown
            : {
                script: DirectionViolation<'konte: policy.speech is "no-dialogue", so a shot narrates but nobody speaks'>;
              }
          : unknown
    : unknown;
// The shot just before `Id` on the clock, asides included, over the whole arc flattened. `null` at
// the first shot; `never` where the tuple is widened or the id is not in it, which passes through.
type ShotBefore<Shots, Id extends string, Prev = null> = Shots extends readonly [
  infer H extends { id: string },
  ...infer T extends readonly { id: string }[],
]
  ? H extends { id: Id }
    ? Prev
    : ShotBefore<T, Id, H>
  : never;
type SameSetup<PS, S> = string extends PS
  ? true
  : string extends S
    ? true
    : [PS] extends [S]
      ? [S] extends [PS]
        ? true
        : false
      : false;
// Whether a frame on setup `S` could run on from shot `P` in one take: `P` is a narrative shot on
// the same declared setup. A pass-through `never` (a computed direction) answers true.
type RunsOnFrom<P, S> = [P] extends [never]
  ? true
  : P extends null
    ? false
    : P extends { kind: "aside" | "graphic" }
      ? false
      : P extends { setup: infer PS }
        ? SameSetup<PS, S>
        : false;
type CutinRunsOnFrom<P, S> = [P] extends [never]
  ? true
  : P extends { cutin: { setup: infer PS } }
    ? SameSetup<PS, S>
    : false;
// `join-impossible`, on a literal `continuous`: the shot before on the clock has to be one the take
// could run on from. Blamed in the `join` position; a widened join or shot list passes through.
type ConstrainJoin<B, Shots> = B extends {
  join: "continuous";
  id: infer Id extends string;
  setup: infer S;
}
  ? RunsOnFrom<ShotBefore<Shots, Id>, S> extends true
    ? unknown
    : {
        join: DirectionViolation<"konte: `continuous` is one unbroken take with the shot before it on the clock, so that shot is a narrative shot on this same setup — declare a jump, or drop the join">;
      }
  : unknown;
type ConstrainCutinJoin<B, Shots> = B extends {
  id: infer Id extends string;
  cutin: { join: "continuous"; setup: infer S };
}
  ? CutinRunsOnFrom<ShotBefore<Shots, Id>, S> extends true
    ? unknown
    : {
        cutin: {
          join: DirectionViolation<"konte: a `continuous` cutin runs on from the cutin over the shot before it on the clock, so that shot carries a cutin on this same setup — declare a jump, or drop the join">;
        };
      }
  : unknown;
type ConstrainShotIds<Arr, Subjects extends string, Speech, Roles extends string, Shots> = {
  [K in keyof Arr]: Omit<Arr[K], "id" | "lineup" | "lineupTo" | "cutin"> & {
    id: ValidatedIdentifier<Arr[K] extends { id: infer I extends string } ? I : never>;
  } & ConstrainFrameLineups<Arr[K], Subjects> &
    ConstrainDuration<Arr[K]> &
    ConstrainAction<Arr[K]> &
    ConstrainSpeech<Arr[K], Speech> &
    ConstrainRole<Arr[K], Roles> &
    ConstrainJoin<Arr[K], Shots> &
    ConstrainCutinJoin<Arr[K], Shots> &
    (Arr[K] extends { cutin: infer C }
      ? { cutin: Omit<C, "lineup" | "lineupTo"> & ConstrainFrameLineups<C, Subjects> }
      : unknown);
};
// Preserve the full node (so the sibling-array covariance check still sees every field) and override
// only the id-bearing positions, recursing through both node bodies to any depth. `Shots` is the
// whole arc flattened, for the checks that read the shot before on the clock.
type ConstrainNodeIds<N, Subjects extends string, Speech, Lenses, Shots> = N &
  (N extends { id: infer I extends string } ? { id: ValidatedIdentifier<I> } : unknown) &
  ConstrainSynopsis<N> &
  (N extends { shots: infer S }
    ? {
        shots: ConstrainShotIds<S, Subjects, Speech, LensRolesOf<LensNameOf<N>, Lenses>, Shots>;
      }
    : unknown) &
  (N extends { sequences: infer Q }
    ? {
        sequences: ConstrainSequenceIds<
          Q,
          Subjects,
          Speech,
          Lenses,
          LensRolesOf<LensNameOf<N>, Lenses>,
          Shots
        >;
      }
    : unknown);
type LensNameOf<N> = N extends { lens: infer L } ? L : string;
// A child node is an item in its PARENT's arc, so its own `role` is blamed against the parent's
// lens while it recurses carrying its own.
type ConstrainSequenceIds<
  Arr,
  Subjects extends string,
  Speech,
  Lenses,
  ParentRoles extends string,
  Shots,
> = {
  [K in keyof Arr]: ConstrainNodeIds<Arr[K], Subjects, Speech, Lenses, Shots> &
    ConstrainRole<Arr[K], ParentRoles>;
};
// A cast voice's `id` is an address part like any other, but it sits in a value rather than a key, so
// it is blamed at its own position instead of through `ConstrainRosterIds`.
type ConstrainVoiceId<V> = V extends { id: infer I extends string }
  ? { id: ValidatedIdentifier<I> }
  : unknown;
type ConstrainCastVoiceIds<R> = {
  [K in keyof R]: R[K] &
    (R[K] extends { voice: infer V } ? { voice: ConstrainVoiceId<V> } : unknown);
};
// A landmark id is an id like any other, blamed inside the location that declares it.
type ConstrainLandmarkIds<R> = {
  [K in keyof R]: R[K] &
    (R[K] extends { landmarks: infer L } ? { landmarks: ConstrainRosterIds<L> } : unknown);
};
// The landmark ids one setup's `holds` may name: those of the location it is set in, reached through
// its own `location` literal. A widened roster or an unknown place answers `string`, so a computed
// direction passes through here and is caught by `holds-unknown-id`.
type LandmarkIdOf<D extends DirectionInput, S> = S extends { location: infer L }
  ? L extends keyof D["locations"]
    ? D["locations"][L] extends { landmarks: infer M }
      ? Extract<keyof M, string>
      : string
    : string
  : string;
// The `holds` twin of `LineupSubjectViolation` — a branded object in the offending element's own
// position, so a typo draws its line where it was typed.
type HoldsLandmarkViolation<T extends string> = {
  [P in `konte: holds id "${T}" is not a landmark of this setup's location`]: never;
};
type ConstrainHolds<H, Ids extends string> = {
  [K in keyof H]: string extends H[K]
    ? H[K]
    : H[K] extends Ids
      ? H[K]
      : H[K] extends string
        ? HoldsLandmarkViolation<H[K]>
        : never;
};
// An `insert` fills the frame with an object and shows no set, so it is the one framing whose
// `holds` may be empty. Every other frame carries something only its place has: an empty tuple is
// asked for a first element it cannot supply, which draws the line on the `holds` that was written.
type HoldsRequired = {
  "konte: this setup is not an insert, so `holds` must name at least one landmark": never;
};
type ConstrainSetupHolds<S, Ids extends string> = S extends { holds: infer H }
  ? { holds: ConstrainHolds<H, Ids> } &
      // A computed `framing` could be `"insert"` at runtime, so it passes through here exactly as a
      // widened id does and `holds-empty` receives it — only a framing that CANNOT be an insert is
      // asked for a first element.
      (S extends { framing: infer F }
        ? "insert" extends F
          ? unknown
          : H extends readonly []
            ? { holds: readonly [HoldsRequired] }
            : unknown
        : unknown)
  : unknown;
// The framings a `within` target may take, per the framing the window itself declares. `wide` is the
// widest, and `insert` is off the axis, so both answer with nothing.
type WiderThan<F> = F extends "close" ? "wide" | "medium" : F extends "medium" ? "wide" : never;
// A branded error in the `within` position, the way `HoldsRequired` brands the `holds` one: an object
// where a string was written, so the line is drawn on the `within` that was typed.
type WithinViolation<M extends string> = { [P in M]: never };
// Every guard is written non-distributively (`[X] extends [Y]`) and lets a widened type through: a
// computed roster has no literal to blame, and the runtime `within-*` errors are the receivers.
type ConstrainWithinTarget<S, T, W extends string, F> = T extends {
  location: infer TL;
  framing: infer TF;
}
  ? S extends { location: infer SL }
    ? string extends SL
      ? unknown
      : string extends TL
        ? unknown
        : [SL] extends [TL]
          ? Framing extends TF
            ? unknown
            : [TF] extends [WiderThan<F>]
              ? unknown
              : {
                  within: WithinViolation<`konte: within "${W}" is ${TF & string}, not wider than this ${F & string}`>;
                }
          : { within: WithinViolation<`konte: within "${W}" is set in another location`> }
    : unknown
  : unknown;
type ConstrainSetupWithin<S, Setups> = S extends { within: infer W }
  ? [W] extends [null | undefined]
    ? unknown
    : string extends W
      ? unknown
      : S extends { framing: infer F }
        ? Framing extends F
          ? unknown
          : [F] extends ["insert"]
            ? { within: WithinViolation<"konte: an insert holds nothing, so it is no window"> }
            : W extends keyof Setups & string
              ? ConstrainWithinTarget<S, Setups[W], W, F>
              : W extends string
                ? { within: WithinViolation<`konte: within id "${W}" is not a declared setup`> }
                : unknown
        : unknown
  : unknown;
type ConstrainSetupIds<D extends DirectionInput> = ConstrainRosterIds<D["setups"]> & {
  [K in keyof D["setups"]]: ConstrainSetupHolds<D["setups"][K], LandmarkIdOf<D, D["setups"][K]>> &
    ConstrainSetupWithin<D["setups"][K], D["setups"]>;
};
// What the piece declares about its own lines, read off the literal policy; widened (a computed
// policy) leaves every shot's `script` alone.
type SpeechOf<D extends DirectionInput> = D["policy"] extends { speech: infer S }
  ? S
  : SpeechPolicy;
type ConstrainIds<D extends DirectionInput> = {
  characters: ConstrainRosterIds<D["characters"]> & ConstrainCastVoiceIds<D["characters"]>;
  locations: ConstrainRosterIds<D["locations"]> & ConstrainLandmarkIds<D["locations"]>;
  setups: ConstrainSetupIds<D>;
  sequence: ConstrainNodeIds<
    D["sequence"],
    SubjectIdOf<D>,
    SpeechOf<D>,
    DeclaredLensNameOf<D>,
    DirectionShotTuple<D>
  >;
} & (D extends { props: infer P } ? { props: ConstrainRosterIds<P> } : unknown) &
  (D extends { narrator: infer N } ? { narrator: ConstrainVoiceId<N> } : unknown);

// The shot ids this direction declares, flattened across the arc tree in direction order.
export type ShotIdOf<D> = DirectionIdTuple<D>[number];

// The resolved direction, indexed by shot id. `defineDirection` walks the arc tree once and stamps this
// onto the entry; `defineAnimatic`/`defineVideo` read it (via `getDirectionIndex`) to mint their
// stage-bound `shot` starters, injecting each shot's duration/action/setup/framing/location/script
// from the one source of truth. `format` is the canvas both stages derive their working size/fps from,
// `typography` how every stage sets its type (`policy.lang` + `policy.fonts`).
export interface DirectionIndex {
  format: ResolvedDirectionFormat;
  typography: Typography;
  // Every shot, aside included — its key order IS the direction order, which is what the stage
  // chains read to find each shot's successor. An aside occupies the clock, so it must be walked
  // like any other shot; the maps below that describe a camera view simply have no entry for one.
  durationById: Map<string, number>;
  actionById: Map<string, string>;
  setupById: Map<string, string>;
  // Resolved through the shot's setup rather than declared per shot, and kept as their own maps so
  // every reader (the shot contexts, the arc checker's items) reads one already-resolved value.
  framingById: Map<string, Framing>;
  locationById: Map<string, string>;
  scriptById: Map<string, readonly ScriptLine[]>;
  // The shot's declared frame order, and the order it leaves behind. Every narrative shot has a
  // `lineup` entry; `lineupTo` is absent rather than empty when the shot ends on the frame it opened
  // on, which is what a build branches on.
  lineupById: Map<string, readonly string[]>;
  lineupToById: Map<string, readonly string[]>;
  // Per shot and lane, the shot whose frame runs on from this one in one take — a `join:
  // "continuous"` where the take is possible: the shot just before on the clock, narrative, its
  // frame in the same lane on the same declared setup. The board reads it to know which last panel
  // is no landing frame.
  continuedById: Map<string, { main?: string; cutin?: string }>;
  // The graphic shots — arc shots with no camera, so `actionById` and `scriptById` hold them and
  // the camera maps above do not.
  graphicIds: Set<string>;
  // The second camera frame each shot declares, on either kind of arc shot, and the framing and
  // location resolved through its setup as a shot's own are — absent where the setup is undeclared.
  cutinById: Map<string, Cutin>;
  cutinFrameById: Map<string, { framing: Framing; location: string }>;
  // The aside shots, and what each one's slug/review prints. Kept as their own maps rather than a
  // `kind` map so a reader asks the question it actually has ("is this one an aside", "what does it
  // say") without re-deriving it.
  asideIds: Set<string>;
  labelById: Map<string, string>;
  // The shape each roster id's reference sheet is sized to (see `deriveReferenceSize`). A name
  // outside the rosters — a shared bed, a look proof — has no entry.
  referenceShapeById: Map<string, ReferenceShape>;
}

// The direction handle rides on the entry under two symbols with a division of labour. `DIRECTION` is a
// type-only brand keying the handle in `DirectionEntry`'s type; its phantom `__direction` recovers
// the direction's literal type `D` by inference at the `defineAnimatic`/`defineVideo` call site, so
// the injected `shot` starter can pin ids to this exact direction (`FirstShotId<D>`,
// `ChainRest<D>`). `DIRECTION_KEY` is the runtime storage key — a GLOBAL-registry symbol
// (`Symbol.for`) so it is the same key even when the loader evaluates a user's direction.ts and
// animatic.tsx against separate konte module instances; a module-private `Symbol()` would differ
// between them and `getDirectionIndex` would read `undefined`.
declare const DIRECTION: unique symbol;
const DIRECTION_KEY = Symbol.for("konte.direction");
type DirectionHandle<D> = DirectionIndex & { readonly __direction?: D };

// `defineDirection`'s return: the direction's own data (so `direction.policy.format`, `.characters`
// etc. read through) plus the direction handle. No `shot`/`pendingShot` methods — a stage shot is minted
// by the stage-bound `shot` that `defineAnimatic`/`defineVideo` inject into their timeline ctx.
export type DirectionEntry<D> = D & { readonly [DIRECTION]: DirectionHandle<D> };

export function getDirectionIndex(direction: DirectionEntry<unknown>): DirectionIndex {
  return (direction as Record<symbol, DirectionIndex>)[DIRECTION_KEY]!;
}

// The `shot` injected into a stage's timeline ctx — one starter type for both, since both stages
// author a shot the same way. `id` is pinned to `FirstShotId<D>` (the walk begins at the first shot)
// and it returns a chain whose `.nextShot` mints the successor shot; order and full coverage are
// enforced by the type (see StageChain). Its build returns a `<Composition>`.
export type StageShotStarter<D, TStage extends ShotStage> = <
  TId extends NarrativeIdOf<D, FirstShotId<D>>,
>(
  id: TId,
  // `shot` is here so the ctx has one shape across the whole chain; its `TIds` is `never` at the
  // first shot, so there is no id it will take.
  build: (
    ctx: StageShotContext<
      ScriptOf<D, TId>,
      LineupOf<D, TId>,
      LineupToOf<D, TId>,
      CutinOf<D, TId>
    > & {
      shot: StageShots<never>;
    },
  ) => ReturnType<ShotFunction>,
) => StageChain<D, ChainRest<D>, TId, TStage>;

// The `graphicShot` injected alongside `shot`, for a shot of the arc with no camera. Its build
// receives no frame, and returns a `<Composition>` whose picture is its own layers.
export type StageGraphicShotStarter<D, TStage extends ShotStage> = <
  TId extends GraphicIdOf<D, FirstShotId<D>>,
>(
  id: TId,
  build: (
    ctx: GraphicShotContext<ScriptOf<D, TId>, CutinOf<D, TId>> & { shot: StageShots<never> },
  ) => ReturnType<ShotFunction>,
) => StageChain<D, ChainRest<D>, TId, TStage>;

// The `pendingShot` injected alongside `shot`: starts the chain from an undeveloped shot (everything
// about it — duration, action — is the direction's, so it takes nothing but the id), so a stage file
// can mirror the whole direction before every shot is built. Swap it for `shot` or `graphicShot` to
// develop.
export type StagePendingShotStarter<D, TStage extends ShotStage> = <
  TId extends ArcIdOf<D, FirstShotId<D>>,
>(
  id: TId,
) => StageChain<D, ChainRest<D>, TId, TStage>;

// The `asideShot` starters, one per stage, because the two place an aside differently (see
// `AsideShotInput`). The animatic's takes the id alone; the video's builds the picture.
export type StageAsideShotStarter<D> = <TId extends AsideIdOf<D, FirstShotId<D>>>(
  id: TId,
) => StageChain<D, ChainRest<D>, TId, "animatic">;
export type VideoAsideShotStarter<D> = <TId extends AsideIdOf<D, FirstShotId<D>>>(
  id: TId,
  build: (ctx: AsideShotContext) => ReturnType<ShotFunction>,
) => StageChain<D, ChainRest<D>, TId, "video">;

// The chain's `shot` — the by-name accessors below, resolving against an already-placed shot's
// build. It cannot be a bare proxy: a stage discovers its shots only after `timeline()` has
// returned, so the names have to be learned by running the closure.
const makeStageShots = (stage: ShotStage, placed: readonly AnyShotInput[]): StageShots => {
  let byId: Map<string, AnyShotInput> | null = null;
  return (shotId: string): ShotHandle => {
    // Lazily, because most builds never reach for another shot and the chain mints one accessor per
    // link — indexing eagerly would cost a pass over every placed shot at every link.
    byId ??= new Map(placed.map((input) => [input.id, input]));
    const target = byId.get(shotId);
    if (target === undefined) {
      throw new Error(
        `shot("${shotId}"): the ${stage} chain has not placed a shot "${shotId}" yet. A build ` +
          `reaches the shots BEFORE it, in direction order. Placed so far: ` +
          `${[...byId.keys()].join(", ") || "(none)"}.`,
      );
    }
    return makeAssetNameHandle(stage, `shot("${shotId}")`, shotId, () =>
      shotAssetKinds(stage, target),
    );
  };
};

// Learning what a shot's build declared means running it — the chain holds only its closure. It is a
// pure function, so run it lazily in discovery mode (a nested run saves/restores the ambient
// context) and memoize per shot input. Keyed by the input object rather than the id: the chain
// re-wraps its list at every link but carries the same input objects through, so one run per shot
// serves the whole chain however many later shots reach back to it.
const assetKindsByInput = new WeakMap<AnyShotInput, Map<string, MediaKind>>();

const shotAssetKinds = (stage: ShotStage, input: AnyShotInput): Map<string, MediaKind> => {
  const cached = assetKindsByInput.get(input);
  if (cached) return cached;
  if (isPendingShotInput(input)) {
    throw new Error(
      `shot("${input.id}"): ${stage} shot "${input.id}" is still an undeveloped pendingShot and ` +
        `declares no assets. Develop it (swap pendingShot for shot) before referencing it.`,
    );
  }
  if (input.fn === undefined) {
    throw new Error(
      `shot("${input.id}"): ${stage} shot "${input.id}" is an aside the ${stage} does not board, ` +
        `so it declares no assets. Reach the media it drops in from a timeline or reference asset instead.`,
    );
  }
  const kinds = runInDiscoveryMode(stage, input.id, input.fn).assetKinds;
  assetKindsByInput.set(input, kinds);
  return kinds;
};

// The `shot` a chain's FIRST shot receives. Its `TIds` is `never`, so typed code cannot call it.
const noShotsPlaced =
  (stage: ShotStage): StageShots =>
  (shotId: string): ShotHandle => {
    throw new Error(
      `shot("${shotId}"): this is the ${stage} chain's first shot, so no earlier shot exists yet.`,
    );
  };

// The by-name, by-kind accessors `shot(id)` offers. A shot's asset names are invisible to the type
// system (its build returns JSX), so each accessor checks the name and the media kind against what
// was actually declared: an unknown name or a kind mismatch throws while the definition loads,
// rather than minting a placeholder that dangles until render.
const makeAssetNameHandle = (
  stage: ShotStage,
  label: string,
  shotId: string,
  kinds: () => Map<string, MediaKind>,
): ShotHandle => {
  const get = <T extends MediaKind>(assetName: string, want: T): MediaAsset<T> => {
    const found = kinds().get(assetName);
    if (found === undefined) {
      const names = [...kinds().keys()];
      throw new Error(
        `${label}.${want}("${assetName}"): ${stage} shot "${shotId}" declares no asset named ` +
          `"${assetName}". Declared: ${names.join(", ") || "(none)"}.`,
      );
    }
    if (found !== want) {
      throw new Error(
        `${label}.${want}("${assetName}"): ${stage} shot "${shotId}"'s asset "${assetName}" is ` +
          `${found}, not ${want}. Use ${label}.${found}("${assetName}").`,
      );
    }
    return makeMediaAsset<T>(makePlaceholder(stage, shotId, assetName));
  };
  return {
    video: (assetName) => get(assetName, "video"),
    image: (assetName) => get(assetName, "image"),
    audio: (assetName) => get(assetName, "audio"),
  };
};

// The direction shot that follows `lastId`, with the passed-in `id` validated against it. Both guards
// are type-enforced already (a complete chain has no `.nextShot`; `id` is pinned to the successor);
// these catch a computed/forged call at runtime. `index.durationById`'s key order IS the direction order.
const directionSuccessor = (index: DirectionIndex, lastId: string, passedId: string): string => {
  const ids = [...index.durationById.keys()];
  const nextId = ids[ids.indexOf(lastId) + 1];
  if (nextId === undefined) {
    throw new Error(
      `nextShot() was called after the final direction shot "${lastId}"; the chain already covers every shot.`,
    );
  }
  if (passedId !== nextId) {
    throw new Error(
      `nextShot("${passedId}") is not the shot that follows "${lastId}" in the direction; expected "${nextId}".`,
    );
  }
  return nextId;
};

const shotScriptOf = (index: DirectionIndex, shotId: string): ShotScript =>
  makeShotScript(index.scriptById.get(shotId) ?? []);

// The mirror of `asideShotContext`'s guard, for the starters that place a shot of the ARC. `.nextShot` reads
// its shot eagerly through `stageShotContext` and carries its own; the starters and `.nextPendingShot` build
// lazily or not at all, so they check here rather than at discovery. `pendingShot` takes either kind
// of arc shot; `shot` only a narrative one.
const requireArcShot = (index: DirectionIndex, fnName: string, id: string): void => {
  if (index.asideIds.has(id)) {
    throw new Error(
      `${fnName}("${id}") is an aside shot — it has no setup, and nothing acts or speaks in it. Use asideShot("${id}").`,
    );
  }
};

const requireNarrativeShot = (index: DirectionIndex, fnName: string, id: string): void => {
  requireArcShot(index, fnName, id);
  if (index.graphicIds.has(id)) {
    throw new Error(
      `${fnName}("${id}") is a graphic shot — it has no camera, so it has no setup or lineup to build a frame from. Use graphicShot("${id}", …).`,
    );
  }
};

// The cutin a shot declares, as its build receives it — framing and location read through its setup
// the way a shot's own are, and the same loud failure for an undeclared one.
const cutinContext = (index: DirectionIndex, shotId: string) => {
  const cutin = index.cutinById.get(shotId);
  if (!cutin) return null;
  const setup = index.cutinFrameById.get(shotId);
  if (!setup) {
    throw new Error(
      `shot "${shotId}" has a cutin on setup "${cutin.setup}", which direction.ts does not declare in \`setups\`.`,
    );
  }
  const context: StageCutinContext = {
    setup: cutin.setup,
    framing: setup.framing,
    location: setup.location,
    lineup: cutin.lineup ?? [],
    lineupTo: cutin.lineupTo ?? null,
  };
  return context;
};

// The shot facts a graphic build receives. The kind guard is the runtime twin of `GraphicIdOf`.
const graphicShotContext = (
  index: DirectionIndex,
  shotId: string,
): GraphicShotContext<readonly ScriptLine[]> => {
  if (!index.graphicIds.has(shotId)) {
    throw new Error(
      `graphicShot("${shotId}") is not a graphic shot — direction.ts declares it as ${index.asideIds.has(shotId) ? "an aside. Use asideShot" : "a narrative shot. Use shot"}("${shotId}", …).`,
    );
  }
  return {
    duration: index.durationById.get(shotId)!,
    script: shotScriptOf(index, shotId),
    cutin: cutinContext(index, shotId),
  };
};

// The shot facts an aside build receives — the span and what the span is. The kind guard is the
// runtime twin of `AsideIdOf`: the type already forbids a narrative id here, so this only catches a
// computed one, and it fails before the author's build reads a `label` the direction never gave.
const asideShotContext = (index: DirectionIndex, shotId: string): AsideShotContext => {
  const label = index.labelById.get(shotId);
  if (label === undefined) {
    throw new Error(
      `asideShot("${shotId}") is not an aside shot — direction.ts declares it as an ordinary shot. Use shot("${shotId}", …).`,
    );
  }
  return { duration: index.durationById.get(shotId)!, label };
};

// The shot facts a stage build receives. One reader for the starter and the chain step, so a field
// can never reach one callback and miss another.
//
// An unknown `setup` leaves framing/location unindexed, and this runs BEFORE the direction gate — a
// stage file's builds are evaluated when the definition loads, which every command does first. So it
// throws here rather than handing `undefined` to the author's prompt and failing somewhere unrelated;
// `setup-unknown` is the same fault reported structurally, for the paths that never load a stage.
const stageShotContext = (
  index: DirectionIndex,
  shotId: string,
): StageShotContext<readonly ScriptLine[]> => {
  requireNarrativeShot(index, "shot", shotId);
  const setup = index.setupById.get(shotId)!;
  const framing = index.framingById.get(shotId);
  const location = index.locationById.get(shotId);
  if (framing === undefined || location === undefined) {
    throw new Error(
      `shot "${shotId}" has setup "${setup}", which direction.ts does not declare in \`setups\`.`,
    );
  }
  return {
    duration: index.durationById.get(shotId)!,
    setup,
    framing,
    location,
    script: shotScriptOf(index, shotId),
    lineup: index.lineupById.get(shotId) ?? [],
    lineupTo: index.lineupToById.get(shotId) ?? null,
    cutin: cutinContext(index, shotId),
  };
};

// `index.durationById` is populated in direction order, so its key order IS the shot order — the chain
// reads it to find each shot's successor.
interface StageChainRuntime {
  __complete: true;
  __shots: AnyShotInput[];
  __shotIds: undefined;
  nextShot(
    id: string,
    build: (
      ctx: StageShotContext<readonly ScriptLine[]> & { shot: StageShots },
    ) => ReturnType<ShotFunction>,
  ): StageChainRuntime;
  nextGraphicShot(
    id: string,
    build: (
      ctx: GraphicShotContext<readonly ScriptLine[]> & { shot: StageShots },
    ) => ReturnType<ShotFunction>,
  ): StageChainRuntime;
  nextPendingShot(id: string): StageChainRuntime;
  nextAsideShot(
    id: string,
    build?: (ctx: AsideShotContext) => ReturnType<ShotFunction>,
  ): StageChainRuntime;
}

// An aside's input, built the same way from either end of the chain. The video owes a build (an
// aside still has to come from somewhere) and the animatic must not have one; the type says so per
// stage, and this is the runtime twin for a computed call.
const makeAsideInput = (
  stage: ShotStage,
  index: DirectionIndex,
  id: string,
  build?: (ctx: AsideShotContext) => ReturnType<ShotFunction>,
): AsideShotInput => {
  const facts = asideShotContext(index, id);
  if (stage === "video" && !build) {
    throw new Error(
      `asideShot("${id}") on the video needs a build — an aside is not boarded, so the video is where its picture comes from.`,
    );
  }
  if (stage === "animatic" && build) {
    throw new Error(
      `asideShot("${id}") on the animatic takes no build — the board is a drawing of the story, and konte fills an aside's span with a labelled slug.`,
    );
  }
  return {
    __shotInput: true,
    __asideShot: true,
    id,
    ...(build ? { fn: () => build(facts) } : {}),
    options: { duration: facts.duration, label: facts.label },
  };
};

const makeStageChain = (
  stage: ShotStage,
  index: DirectionIndex,
  shots: AnyShotInput[],
): StageChainRuntime => ({
  __complete: true,
  __shots: shots,
  __shotIds: undefined,
  nextShot(id, build) {
    const nextId = directionSuccessor(index, shots[shots.length - 1]!.id, id);
    const placedShot = makeStageShots(stage, shots);
    const facts = stageShotContext(index, nextId);
    const nextInput: ShotInput = {
      __shotInput: true,
      id: nextId,
      fn: () => build({ ...facts, shot: placedShot }),
      options: { duration: index.durationById.get(nextId)!, action: index.actionById.get(nextId)! },
    };
    return makeStageChain(stage, index, [...shots, nextInput]);
  },
  nextGraphicShot(id, build) {
    const nextId = directionSuccessor(index, shots[shots.length - 1]!.id, id);
    const placedShot = makeStageShots(stage, shots);
    const facts = graphicShotContext(index, nextId);
    const nextInput: ShotInput = {
      __shotInput: true,
      __graphicShot: true,
      id: nextId,
      fn: () => build({ ...facts, shot: placedShot }),
      options: { duration: index.durationById.get(nextId)!, action: index.actionById.get(nextId)! },
    };
    return makeStageChain(stage, index, [...shots, nextInput]);
  },
  nextPendingShot(id) {
    const nextId = directionSuccessor(index, shots[shots.length - 1]!.id, id);
    requireArcShot(index, "nextPendingShot", nextId);
    const nextInput: PendingShotInput = {
      __shotInput: true,
      __pendingShot: true,
      id: nextId,
      options: { duration: index.durationById.get(nextId)!, action: index.actionById.get(nextId)! },
    };
    return makeStageChain(stage, index, [...shots, nextInput]);
  },
  nextAsideShot(id, build) {
    const nextId = directionSuccessor(index, shots[shots.length - 1]!.id, id);
    return makeStageChain(stage, index, [...shots, makeAsideInput(stage, index, nextId, build)]);
  },
});

// Builds the `shot`/`pendingShot` starters bound to `index` and a stage. `defineAnimatic` and
// `defineVideo` each inject their pair into their timeline ctx (typed `StageShotStarter<D>` /
// `StagePendingShotStarter<D>`). No ambient stage lookup: the factory already knows the stage.
function makeStageShotStarter(stage: ShotStage, index: DirectionIndex) {
  const requireShot = (fnName: string, id: string): number => {
    validateShotId(id);
    const duration = index.durationById.get(id);
    if (duration === undefined) {
      // The type system already forbids unknown ids; this only guards a computed/forged id.
      throw new Error(
        `${fnName}("${id}") is not a declared direction shot. ` +
          `Declared: ${[...index.durationById.keys()].join(", ") || "(none)"}.`,
      );
    }
    return duration;
  };

  const shot = (
    id: string,
    build: (
      ctx: StageShotContext<readonly ScriptLine[]> & { shot: StageShots },
    ) => ReturnType<ShotFunction>,
  ): StageChainRuntime => {
    const duration = requireShot("shot", id);
    // Eagerly, because the build below is lazy: `stageShotContext` runs inside `fn`, so without this an
    // aside placed through `shot` would only fail once discovery reached it. `.nextShot` reads its
    // shot eagerly and needs no twin.
    requireNarrativeShot(index, "shot", id);
    const firstInput: ShotInput = {
      __shotInput: true,
      id,
      fn: () => build({ ...stageShotContext(index, id), shot: noShotsPlaced(stage) }),
      options: { duration, action: index.actionById.get(id)! },
    };
    return makeStageChain(stage, index, [firstInput]);
  };

  const graphicShot = (
    id: string,
    build: (
      ctx: GraphicShotContext<readonly ScriptLine[]> & { shot: StageShots },
    ) => ReturnType<ShotFunction>,
  ): StageChainRuntime => {
    const duration = requireShot("graphicShot", id);
    const facts = graphicShotContext(index, id);
    const firstInput: ShotInput = {
      __shotInput: true,
      __graphicShot: true,
      id,
      fn: () => build({ ...facts, shot: noShotsPlaced(stage) }),
      options: { duration, action: index.actionById.get(id)! },
    };
    return makeStageChain(stage, index, [firstInput]);
  };

  const pendingShot = (id: string): StageChainRuntime => {
    const duration = requireShot("pendingShot", id);
    requireArcShot(index, "pendingShot", id);
    const firstInput: PendingShotInput = {
      __shotInput: true,
      __pendingShot: true,
      id,
      options: { duration, action: index.actionById.get(id)! },
    };
    return makeStageChain(stage, index, [firstInput]);
  };

  const asideShot = (
    id: string,
    build?: (ctx: AsideShotContext) => ReturnType<ShotFunction>,
  ): StageChainRuntime => {
    requireShot("asideShot", id);
    return makeStageChain(stage, index, [makeAsideInput(stage, index, id, build)]);
  };

  return { shot, graphicShot, pendingShot, asideShot };
}

export function makeAnimaticShotStarter(index: DirectionIndex) {
  return makeStageShotStarter("animatic", index);
}

export function makeVideoShotStarter(index: DirectionIndex) {
  return makeStageShotStarter("video", index);
}

// Even, because the delivered frame is encoded as yuv420p, which has no odd dimension. The derived
// canvas and the cover frame land even on their own; only the authored delivery can be odd.
function assertDeliveryDimensions(size: CanvasSize, field: string): void {
  for (const axis of ["width", "height"] as const) {
    const value = size[axis];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${field}.${axis} must be a positive integer, got ${value}`);
    }
    if (value % 2 !== 0) {
      throw new Error(
        `${field}.${axis} must be even (the delivered frame is encoded as yuv420p), got ${value}`,
      );
    }
  }
}

// The one place the authored budget becomes a canvas. Every reader holding a bare `Direction`
// rather than a `DirectionIndex` (the part hashes, the review pages, a patch's render format) goes
// through here.
export function resolveDirectionFormat(direction: Direction): ResolvedDirectionFormat {
  const format = direction.policy.format;
  return {
    fps: format.fps,
    size: { ...format.size, base: deriveCanvasBase(format.size) },
  };
}

// The widest budget the derivation will resolve: past this, a stated budget is far likelier to be a
// unit slip (pixels typed where megapixels were meant) than a deliberate choice.
const MAX_MEGAPIXELS = 16;

// Runs before the direction is reviewed, so a canvas that cannot be resolved is rejected at the
// earliest point there is — the acceptance gate and every stage file come after this. There is no
// grid check and no base/delivery aspect check: neither number is authored.
export function assertCanvasFormat(format: DirectionFormat): void {
  const { megapixels, delivery } = format.size;
  assertDeliveryDimensions(delivery, "policy.format.size.delivery");
  if (!Number.isFinite(megapixels) || megapixels <= 0 || megapixels > MAX_MEGAPIXELS) {
    throw new Error(
      `policy.format.size.megapixels must be a positive number of megapixels up to ` +
        `${MAX_MEGAPIXELS}, got ${megapixels}. It is the generation budget the working canvas is ` +
        `derived from — 0.9 lands on roughly 720p worth of pixels at the delivery's aspect.`,
    );
  }
  // The budget only means what it says while both axes of the size it asks for clear the grid. Below
  // that the short axis floors at 32 and the long one stretches to hold the aspect, so the canvas
  // walks away from the budget — a lopsided delivery resolves to many times the pixels asked for,
  // and the ceiling above stops bounding anything.
  const ideal = idealSize(format.size);
  const shortest = Math.min(ideal.width, ideal.height);
  if (shortest < CANVAS_GRID) {
    const base = deriveCanvasBase(format.size);
    throw new Error(
      `policy.format.size.megapixels (${megapixels}) is too small to hold the ` +
        `${ratioOf(delivery)} aspect of a ${delivery.width}×${delivery.height} delivery: it asks ` +
        `for a ${Math.round(shortest)}-pixel axis, under the ${CANVAS_GRID}-pixel grid models ` +
        `sample on, so it resolves to ${base.width}×${base.height} instead. Raise the budget or ` +
        `deliver a less lopsided frame.`,
    );
  }
  // The canvas clock. Every stage derives its working fps from here, and a frame interval that is
  // zero, negative or not finite has no meaning downstream: each consumer would then invent its own
  // reading (a sampler falling back to 30, a capture passing the value straight to the renderer),
  // and the disagreement would only surface after the spend, at preview or export.
  if (!Number.isFinite(format.fps) || format.fps <= 0) {
    throw new Error(
      `policy.format.fps must be a positive, finite number of frames per second, got ${format.fps}`,
    );
  }
}

export function defineDirection<const D extends DirectionInput>(
  direction: D & ConstrainIds<D>,
): DirectionEntry<D> {
  const durationById = new Map<string, number>();
  const actionById = new Map<string, string>();
  const framingById = new Map<string, Framing>();
  const locationById = new Map<string, string>();
  const scriptById = new Map<string, readonly ScriptLine[]>();
  const lineupById = new Map<string, readonly string[]>();
  const lineupToById = new Map<string, readonly string[]>();
  const joinById = new Map<string, string>();
  const setupById = new Map<string, string>();
  const graphicIds = new Set<string>();
  const cutinById = new Map<string, Cutin>();
  const cutinFrameById = new Map<string, { framing: Framing; location: string }>();
  const asideIds = new Set<string>();
  const labelById = new Map<string, string>();
  const referenceShapeById = new Map<string, ReferenceShape>();
  const dir = direction as unknown as Direction;
  assertLanguageTag(dir.policy.lang);
  if (dir.policy.fonts) assertFontFamilies(dir.policy.fonts);
  assertCanvasFormat(dir.policy.format);
  const resolvedFormat = resolveDirectionFormat(dir);
  // A shot's framing/location are its setup's. An unknown setup id leaves both unindexed rather than
  // guessing: `validateDirectionStructure` reports it as `setup-unknown`, and `stageShotContext` throws
  // for the readers that run before that gate.
  const indexShot = (s: Shot) => {
    durationById.set(s.id, s.duration);
    // An aside is a span with a name and nothing a camera or a speaker fills, so it enters the clock
    // (`durationById`) and the label map only. Every other map stays without an entry for it, which
    // is what makes a reader that needs a setup fail loudly rather than read an invented one.
    if (isAsideShot(s)) {
      asideIds.add(s.id);
      labelById.set(s.id, s.label);
      return;
    }
    actionById.set(s.id, s.action);
    scriptById.set(s.id, s.script ?? []);
    if (s.cutin) {
      cutinById.set(s.id, s.cutin);
      const setup = (dir.setups ?? {})[s.cutin.setup];
      if (setup) cutinFrameById.set(s.id, { framing: setup.framing, location: setup.location });
    }
    if (isGraphicShot(s)) {
      graphicIds.add(s.id);
      return;
    }
    setupById.set(s.id, s.setup);
    const setup = (dir.setups ?? {})[s.setup];
    if (setup) {
      framingById.set(s.id, setup.framing);
      locationById.set(s.id, setup.location);
    }
    if (s.lineup) lineupById.set(s.id, s.lineup);
    if (s.lineupTo) lineupToById.set(s.id, s.lineupTo);
    if (s.join) joinById.set(s.id, s.join);
  };
  // Walk the arc tree depth-first so `durationById` fills in direction order (its key order IS the shot
  // order the chain walks). A leaf indexes its shots; a branch recurses into its child nodes.
  const indexNode = (node: DirectionNode) => {
    if (Array.isArray(node.shots)) {
      for (const s of node.shots) indexShot(s);
    } else if (Array.isArray(node.sequences)) {
      for (const child of node.sequences) indexNode(child);
    }
  };
  indexNode(dir.sequence);

  // The clock walk, asides included: a take runs on only from the shot just before it, in the same
  // lane, on the same declared setup (what `join-impossible` enforces).
  const continuedById = new Map<string, { main?: string; cutin?: string }>();
  let previousFrames: { id: string; lane: "main" | "cutin"; setup: string }[] = [];
  for (const id of durationById.keys()) {
    const frames: { id: string; lane: "main" | "cutin"; setup: string; join?: string }[] = [];
    if (!asideIds.has(id)) {
      const mainSetup = setupById.get(id);
      const main = mainSetup === undefined ? undefined : (dir.setups ?? {})[mainSetup];
      if (mainSetup !== undefined && main) {
        const join = joinById.get(id);
        frames.push({ id, lane: "main", setup: mainSetup, ...(join ? { join } : {}) });
      }
      const cutin = cutinById.get(id);
      if (cutin && (dir.setups ?? {})[cutin.setup]) {
        frames.push({
          id,
          lane: "cutin",
          setup: cutin.setup,
          ...(cutin.join ? { join: cutin.join } : {}),
        });
      }
    }
    for (const frame of frames) {
      if (frame.join !== "continuous") continue;
      const before = previousFrames.find((f) => f.lane === frame.lane);
      if (!before || before.setup !== frame.setup) continue;
      continuedById.set(before.id, { ...continuedById.get(before.id), [frame.lane]: id });
    }
    previousFrames = frames;
  }

  for (const id of Object.keys(dir.characters)) referenceShapeById.set(id, "portrait");
  for (const id of Object.keys(dir.props ?? {})) referenceShapeById.set(id, "square");
  for (const id of Object.keys(dir.locations)) referenceShapeById.set(id, "master");

  const index: DirectionIndex = {
    format: resolvedFormat,
    typography: {
      lang: dir.policy.lang,
      ...(dir.policy.fonts?.length ? { fonts: [...dir.policy.fonts] } : {}),
    },
    durationById,
    actionById,
    setupById,
    framingById,
    locationById,
    scriptById,
    lineupById,
    lineupToById,
    continuedById,
    graphicIds,
    cutinById,
    cutinFrameById,
    asideIds,
    labelById,
    referenceShapeById,
  };

  const entry = { ...direction } as Record<symbol, unknown>;
  entry[DIRECTION_KEY] = index;
  return entry as unknown as DirectionEntry<D>;
}
