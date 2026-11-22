import type { Pleasure } from "../lenses.js";
import type { CanvasBudget, CanvasSize, ReferenceShape } from "../canvas.js";
import { CANVAS_GRID, deriveCanvasBase, idealSize } from "../canvas.js";
import { ratioOf } from "../aspect.js";
import type { ScriptLine } from "../types/script.js";
import type { PanelLane, ShotJoin, Typography } from "../types/definition.js";
import type { ArcItem, LensSpec } from "../direction-check.js";
import type { DirectionIdTuple } from "./animatic-builders.js";
import type {
  ConstrainIds,
  ConstrainKnownFields,
  DirectionInput,
} from "./direction-constraints.js";
import {
  placeDirectionLyrics,
  readDirectionTimeline,
  type DirectionTimeline,
  type LyricPlacementEntry,
} from "./direction-timeline.js";
import { isAsideShot, isGraphicShot } from "./shot-kind.js";
import { assertFontFamilies, assertLanguageTag, type LanguageTag } from "../typography.js";
import { isIdentifier } from "./validate-identifier.js";
import { formatReferenceAddress } from "../address.js";
import { KonteError } from "../errors.js";
import { songVariantAt } from "./song-context.js";
import { continuedFrames } from "../direction-frames.js";
import { parseSpan } from "../source-locator.js";

// Re-export the arc layer so the DSL surface (index.ts / template-entry.ts) has one import point.
export type { Pleasure } from "../lenses.js";
export type { ScriptLine } from "../types/script.js";
export { defineLens } from "../lenses.js";
export type {
  ArcItem,
  LensRole,
  RoleFunction,
  DirectionFinding,
  LensSpec,
} from "../direction-check.js";
export type { DirectionFindingCode } from "../direction-findings.js";

// A cast member's voice. `id` is an exposed `reference:<id>` asset name holding the sample —
// separate from the look anchor; two members may share one (twins). `description` is how
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
// (must equal an exposed `reference:<id>` asset name); `description` is the visual brief. The prop `id` shares the reference namespace with the
// characters, so it may not collide with a character `id`.
//
// `promptDepiction` is the noun a prompt calls it by, exactly as a character's is — a frame whose
// `props` holds the prop owes it in a keyframe's prompt (`prop-unnamed`).
export type Prop = { name: string; promptDepiction: string; description: string };

// A declared location — a recurring place (a set, a room, an exterior) a shot happens in, whose look
// must stay consistent across the shots set there, so it is anchored to a reference asset exactly
// like a character or prop. Keyed by its `id` (must equal an exposed `reference:<id>` asset name),
// which shares the reference namespace with the characters and props (a collision is a structural
// error). A shot reaches its location through its `setup`. `description` is the visual brief.
//
// A location is the place, not a view of it: it anchors what the set is made of, and the `setups`
// declared in it are the frames taken from it.
//
// `landmarks` is what the set is recognized by — required and non-empty (`landmarks-empty`), since a
// frame with nothing only this place has in it comes back as another room. Each `setups.<id>.holds`
// names the ones its frame carries.
//
// `views` is every way a camera faces in this place, each with the landmarks seen facing that way.
// `front` is required: it is the master, `reference:<id>`. Every other view owes an image of its own
// (`views` in reference.tsx, `view-unrealized`), and a setup faces only a view declared here.
export type Location = {
  name: string;
  description: string;
  landmarks: Record<string, Landmark>;
  views: LocationViews;
};

export type LocationViews = { front: LocationView } & { [V in ImagedView]?: LocationView };

// `holds` is the landmark ids seen facing this way — what that side of the set has, in no order.
// A setup facing it holds only these (`holds-outside-view`), and its image's prompt names each
// (`view-unnamed`).
export type LocationView = { holds: readonly string[] };

// A view left `undefined` declares none.
export function declaredViews(views: LocationViews | undefined): [string, LocationView][] {
  return Object.entries(views ?? {}).filter((e): e is [string, LocationView] => e[1] !== undefined);
}

// A thing only this place has — the desk, the arm lamp, the window it is always shot through. Keyed
// by its `id` inside its location's `landmarks`, and named left to right by the `holds` of every
// setup whose frame carries it.
//
// Its id is outside the `reference:<id>` namespace: what anchors a landmark is the plate its setup
// stands on, so there is no sheet to expose for it. It still shares the direction's one id space, so
// it may not collide with a character, a prop, a location, or a landmark of another place
// (`landmark-id-conflict`).
//
// `promptDepiction` is the noun a prompt calls it by, exactly as a character's is — `plate-unnamed`
// reads the plate's own generation prompt for it. `description` is where it stands and what it
// looks like.
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
//
// `view` is the way the camera faces in its location, one of the location's `views`. A setup with no
// `within: "<id>"` declares it, an insert included (the view is where the camera points); a window
// inherits its parent's and cannot write one. `holds` names only landmarks that view sees, and a
// plate stands on that view's image.
export type Setup = {
  name: string;
  description: string;
  location: string;
  framing: Framing;
  holds: readonly string[];
} & ({ within: string; view?: never } | { within?: null; view: View });

export { type View } from "../view.js";
import type { ImagedView, View } from "../view.js";

// The `locations` roster ids this direction declares.
export type LocationIdOf<D> = D extends { locations: infer L } ? Extract<keyof L, string> : string;

// The views location `L` declares.
export type ViewsOf<D, L> = D extends { locations: infer M }
  ? L extends keyof M
    ? M[L] extends { views: infer V }
      ? Extract<keyof V, View>
      : View
    : View
  : View;

// The agreed concept — what the piece is, for whom, and how it should feel — captured from the
// shaping conversation and reviewed in `konte preview direction` alongside the shots it
// constrains. Prose only: excluded from the acceptance hash (a wording pass never re-blocks the
// spend gate). Every field takes feedback of its own (`direction:brief.<field>`, see
// DIRECTION_BRIEF_FIELDS) and is hashed on its own, so a comment ages out only when the field it
// was written about is rewritten.
//
// `hook` is what the first two seconds put on screen — the frame that stops a scroll — so the
// first shot and the direction critic both read against one sentence.
//
// The two list fields run opposite ways: `outOfScope` is what the piece must not contain,
// `tolerances` what may show up in the output and is left alone. Unlike a feedback comment, a
// tolerance is not aged out by the next generation.
//
// `references` is what the piece takes from, and refuses of, each clip a human brought as "make it
// like this": `clip` is the file under the video (`konte study clip <clip>` reads it), `link` where
// it came from.
export type BriefReference = {
  clip: string;
  link?: string;
  take: string;
  avoid: string;
};

// `source` is the original the piece is adapted from, the video's `source/`: `span` the chunks the
// piece covers, and `keep` / `drop` the adaptation map's summary — what the piece must carry over,
// and what it leaves out.
export type BriefSource = {
  span: string;
  keep?: readonly string[];
  drop?: readonly string[];
};

export type DirectionBrief = {
  logline: string;
  hook?: string;
  audience?: string;
  tone?: string;
  look?: string;
  outOfScope?: readonly string[];
  tolerances?: readonly string[];
  references?: readonly BriefReference[];
  source?: BriefSource;
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

// The piece-wide, machine-checked policy: the canvas (`format`), the typesetting (`lang`, `fonts`),
// and the song (`song`). All feed the acceptance hash, and each is its own reviewed feedback part
// (`direction:policy.<field>`, see DIRECTION_POLICY_FIELDS), so a note on the fonts is not aged out
// by a canvas-size edit.
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
  // no system face is guaranteed to cover raises `fonts-undeclared`. Emoji fall back to Noto Color
  // Emoji, declared or not.
  fonts?: readonly string[];
  // The song the piece is cut to: the id of the `reference:<id>` asset that plays it. With a song
  // every shot's span is `beats`, counted on the beats a take of it is read to play, and the
  // timeline's 0s is the take's own start: the first shot also holds what the take plays before
  // beat 0, which is the take's own fact, never written here.
  song?: string;
};

// Shot-scale leaf: its span is required (it is the rhythm source of truth that pacing checks read) —
// `duration` in seconds, or `beats` on a direction with `policy.song`; exactly one of them.
// `role` is a plain string validated against the node's lens (a foreign role is a waivable finding,
// not a type error). `action` is the single on-screen action this clip lands — the leaf-scale twin
// of a branch node's `synopsis` (the engine holds both as one generic `ArcItem` field). `script` is
// the shot's spoken lines — the source of truth injected into both stages' builds so a video's
// subtitles derive from one place, never re-authored per stage; `telop` is its unspoken twin.
export type NarrativeShot = Omit<ArcItem<string>, "synopsis" | "duration"> & {
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
  duration?: number;
  beats?: number;
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
  passing?: readonly string[];
  // The `props` ids this frame shows, in no order. Required on every frame once the roster declares
  // a prop (`props-missing`), `[]` where the frame shows none.
  props?: readonly string[];
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
  join?: ShotJoin;
  // A second camera frame laid over this shot's picture (a wipe in the corner, a reaction over the
  // main frame). See `Cutin`.
  cutin?: Cutin;
  // A shot the model cuts inside: `setup` and `lineup` are its opening frame, and `action` may run
  // beat after beat. It declares no `lineupTo` or `cutin`, and the shot after it cannot run on from
  // it (`join: "continuous"`).
  coverage?: true;
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
  passing?: readonly string[];
  props?: readonly string[];
  join?: ShotJoin;
};

// A shot of the arc with no camera — a UI screen, a motion graphic, a chart. It carries everything
// the arc reads (`role`, `action`, `duration`, `script`, `telop`) and none of the four fields a
// camera view has (`setup`, `lineup`, `lineupTo`, `join`), so every spatial check passes over it.
// Its picture is built whole in the animatic's composition and placed again by the video; a
// character on screen is a `cutin` over it, never part of the graphic.
export type GraphicShot = Omit<
  NarrativeShot,
  "kind" | "setup" | "lineup" | "lineupTo" | "passing" | "props" | "join" | "coverage"
> & {
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
// (`asideShot(id, …)`, usually a `file`): the stage chain covers it like any other shot.
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
  duration?: number;
  beats?: number;
  // Text laid over it and never spoken — a title card's own words. Same field, same meaning as a
  // narrative shot's, and the only text an aside carries.
  telop?: readonly string[];
};

// A leaf's members. `Shot` stays the name of the whole because a leaf's `shots` array holds every
// kind and every reader that only needs "some shot" keeps reading one type; the members are named
// where a reader needs to know which it has.
export type Shot = NarrativeShot | GraphicShot | AsideShot;

// A node of the arc tree — the single recursive unit the whole direction is built from. Its `lens`
// names the arc its body forms: a LEAF carries `shots` (a run of shots), a BRANCH carries
// `sequences` (a run of child nodes), and a branch's lens governs the order/pacing/payoff of its
// children just as a leaf's lens governs its shots. Nesting is arbitrary: a branch's children may
// themselves be branches (an act of acts). Only a *child* node carries `id`/`role`/`synopsis` — it
// is an item in its parent's arc and an addressable review target; the root node has no parent, so
// it omits them. `pleasure` is the feeling this node aims for and the one thing a person with no
// craft vocabulary can argue with on the review page ("that act should not be scary") — required on
// every node, since a node that could stay silent would, and the reviewer would be left with nothing
// to take a position on. Both `pleasure` and the shape are in the acceptance hash — retargeting or
// restructuring a node re-blocks the spend gate.
export type DirectionNode = {
  id?: string;
  role?: string;
  synopsis?: string;
  lens: string;
  pleasure: Pleasure;
  shots?: Shot[];
  sequences?: DirectionNode[];
};

// Who sings: a `characters` id, or the ids singing together.
export type Singer = string | readonly [string, ...string[]];

// One sung line, as the words are written. A line with its own `singer` is sung by them.
export type LyricLine = string | { text: string; singer: Singer };

// A stretch of the song's form — a verse, a chorus — who sings it, and its lines in the order they
// are sung.
export type LyricSection = { label: string; singer: Singer; lines: readonly LyricLine[] };

// What the song sings, section by section. The words are the ones the song asset is generated with,
// a subtitle is set from, and a take is read against. Only a piece with `policy.song` has a song to
// sing them.
export type DirectionLyrics = readonly LyricSection[];

// The always-declared direction policy: `brief`, `characters`, and `policy` (canvas + typesetting)
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
  // The location roster, keyed by id (`id` -> location). Non-empty once any setup is declared: every
  // setup names one. Keyed by id like `characters`, sharing the reference
  // namespace (a collision with a character/prop id is a structural error).
  locations: Record<string, Location>;
  // The camera-setup roster, keyed by id (`id` -> setup). Non-empty once any camera frame exists: a
  // narrative shot and a cutin each point at one via its `setup` field. Unlike the three identity rosters this one
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
  // The machine-checked canvas + typesetting, each reviewed as its own feedback part.
  policy: DirectionPolicy;
  // The song's words, reviewed as one part (`direction:lyrics`).
  lyrics?: DirectionLyrics;
  // Every waived finding, keyed `<code>` or `<code>_<subject>` (`directionWaiverKey`), whichever arc
  // node or roster it fired on.
  waivers?: Record<string, string>;
  // The root of the arc tree. A leaf for a short piece (`{ lens, shots }`), a branch for a long one
  // (`{ lens, sequences }`). Named `sequence` because every node is a sequence — an ordered run that
  // forms an arc — whether it runs over shots or over sub-sequences.
  sequence: DirectionNode;
};

// The shot ids this direction declares, flattened across the arc tree in direction order.
export type ShotIdOf<D> = DirectionIdTuple<D>[number];

export function deriveShotHinges(
  direction: Direction,
  action: string,
  setupId: string,
  propIds: readonly string[],
): { name: string; notInSet: boolean }[] {
  const setup = direction.setups?.[setupId];
  const landmarks = setup ? (direction.locations?.[setup.location]?.landmarks ?? {}) : {};
  return [
    ...Object.entries(landmarks)
      .filter(([, landmark]) => action.includes(landmark.name))
      .map(([id, landmark]) => ({
        name: landmark.name,
        notInSet: !(setup?.holds ?? []).includes(id),
      })),
    ...propIds.flatMap((id) => {
      const prop = direction.props?.[id];
      return prop ? [{ name: prop.name, notInSet: false }] : [];
    }),
  ];
}

// The resolved direction, indexed by shot id. `defineDirection` walks the arc tree once and stamps this
// onto the entry; `defineAnimatic`/`defineVideo` read it (via `getDirectionIndex`) to mint their
// stage-bound `shot` starters, injecting each shot's duration/action/setup/framing/location/script
// from the one source of truth. `format` is the canvas both stages derive their working size/fps from,
// `typography` how every stage sets its type (`policy.lang` + `policy.fonts`).
export interface DirectionIndex {
  format: ResolvedDirectionFormat;
  typography: Typography;
  // Where every shot sits on the timeline, and the song beats it is counted on.
  timeline: DirectionTimeline;
  // Where each lyric line falls on the timeline, read off the video's song take; null on a direction
  // without lyrics.
  lyrics: LyricPlacementEntry[] | null;
  // Every shot, aside included — its key order IS the direction order, which is what the stage
  // chains read to find each shot's successor. An aside occupies the clock, so it must be walked
  // like any other shot; the maps below that describe a camera view simply have no entry for one.
  // The span is the timeline's, on the frame grid, never the number the author wrote; null on a
  // piece cut to its song while no take of it is read (see `shotDurationOf`).
  durationById: Map<string, number | null>;
  actionById: Map<string, string>;
  hingeById: Map<string, ReturnType<typeof deriveShotHinges>>;
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
  passingById: Map<string, readonly string[]>;
  // Per shot and lane, the shot whose frame runs on from this one in one take — a `join:
  // "continuous"` where the take is possible: the shot just before on the clock, narrative, its
  // frame in the same lane on the same declared setup. The board reads it to know which last panel
  // is no landing frame.
  continuedById: Map<string, { main?: string; cutin?: string }>;
  // The graphic shots — arc shots with no camera, so `actionById` and `scriptById` hold them and
  // the camera maps above do not.
  graphicIds: Set<string>;
  // The coverage shots — one take the model cuts inside, boarded on its opening frame alone.
  coverageIds: Set<string>;
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

// The handle's phantom `__direction` recovers the direction's literal type `D` by inference at the
// `defineAnimatic`/`defineVideo` call site, so the injected `shot` starter can pin ids to this exact
// direction (`StepId`). The key is a GLOBAL-registry symbol (`Symbol.for`) so it is the same key
// even when the loader evaluates a user's direction.ts and animatic.tsx against separate konte
// module instances.
const DIRECTION_KEY: unique symbol = Symbol.for("konte.direction");
type DirectionHandle<D> = DirectionIndex & { readonly __direction?: D };

// `defineDirection`'s return: the direction's own data (so `direction.policy.format`, `.characters`
// etc. read through) plus the direction handle. No `shot`/`pendingShot` methods — a stage shot is minted
// by the stage-bound `shot` that `defineAnimatic`/`defineVideo` inject into their timeline ctx.
export type DirectionEntry<D> = D & { readonly [DIRECTION_KEY]: DirectionHandle<D> };

export function getDirectionIndex(direction: DirectionEntry<unknown>): DirectionIndex {
  return direction[DIRECTION_KEY];
}

// The index a loaded direction carries, absent on one built without `defineDirection`.
export function loadedDirectionIndex(direction: Direction): DirectionIndex | undefined {
  return DIRECTION_KEY in direction
    ? (direction as DirectionEntry<Direction>)[DIRECTION_KEY]
    : undefined;
}

// Whether a take in the shot ends on the seam the next shot opens on. A take is declared before the
// composition places it, so the lane is the shot's only one — a graphic shot's cutin — else its main
// frame.
export function endsOnSeam(index: DirectionIndex, shotId: string): boolean {
  const continued = index.continuedById.get(shotId);
  return (index.graphicIds.has(shotId) ? continued?.cutin : continued?.main) !== undefined;
}

// Even, because the delivered frame is encoded as yuv420p, which has no odd dimension. The derived
// canvas and the cover frame land even on their own; only the authored delivery can be odd.
function assertDeliveryDimensions(size: CanvasSize, field: string): void {
  for (const axis of ["width", "height"] as const) {
    const value = size[axis];
    if (!Number.isInteger(value) || value <= 0) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `${field}.${axis} must be a positive integer, got ${value}`,
      );
    }
    if (value % 2 !== 0) {
      throw new KonteError(
        "VALIDATION_FAILED",
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

// The direction's timeline: the one its loaded index holds, else read off the direction alone, with
// no song take.
export function resolveDirectionTimeline(direction: Direction): DirectionTimeline {
  return loadedDirectionIndex(direction)?.timeline ?? readDirectionTimeline(direction, null);
}

// Runs before the direction is reviewed, beside `assertCanvasFormat`.
function assertDirectionSong(song: string | undefined): void {
  if (song === undefined) return;
  if (typeof song !== "string" || !isIdentifier(song)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `policy.song must name a reference asset id (a-z, A-Z, 0-9, -, _), got "${String(song)}"`,
    );
  }
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
    throw new KonteError(
      "VALIDATION_FAILED",
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
    throw new KonteError(
      "VALIDATION_FAILED",
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
    throw new KonteError(
      "VALIDATION_FAILED",
      `policy.format.fps must be a positive, finite number of frames per second, got ${format.fps}`,
    );
  }
}

// The span is written in the locator grammar; whether the chunks hold it is the locator check's.
function assertSourceSpan(span: string): void {
  if (!parseSpan(span)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `brief.source.span "${span}" is no span — a chunk or a range of them (c3-c5, v1.b3-b5, w2-w4), or a story or volume (s5, v1)`,
    );
  }
}

export function defineDirection<const D extends DirectionInput>(
  direction: D & ConstrainIds<D> & NoInfer<ConstrainKnownFields<D, DirectionInput>>,
): DirectionEntry<D> {
  const durationById = new Map<string, number | null>();
  const actionById = new Map<string, string>();
  const hingeById: DirectionIndex["hingeById"] = new Map();
  const framingById = new Map<string, Framing>();
  const locationById = new Map<string, string>();
  const scriptById = new Map<string, readonly ScriptLine[]>();
  const lineupById = new Map<string, readonly string[]>();
  const lineupToById = new Map<string, readonly string[]>();
  const passingById = new Map<string, readonly string[]>();
  const setupById = new Map<string, string>();
  const graphicIds = new Set<string>();
  const coverageIds = new Set<string>();
  const cutinById = new Map<string, Cutin>();
  const cutinFrameById = new Map<string, { framing: Framing; location: string }>();
  const asideIds = new Set<string>();
  const labelById = new Map<string, string>();
  const referenceShapeById = new Map<string, ReferenceShape>();
  const dir = direction as Direction;
  assertLanguageTag(dir.policy.lang);
  if (dir.policy.fonts) assertFontFamilies(dir.policy.fonts);
  assertCanvasFormat(dir.policy.format);
  assertDirectionSong(dir.policy.song);
  if (dir.brief.source) assertSourceSpan(dir.brief.source.span);
  const resolvedFormat = resolveDirectionFormat(dir);
  const song = dir.policy.song;
  const songVariant = song ? songVariantAt(formatReferenceAddress(song)) : null;
  const timeline = readDirectionTimeline(dir, songVariant);
  const lyrics = dir.lyrics ? placeDirectionLyrics(dir, songVariant) : null;
  // A shot's framing/location are its setup's. An unknown setup id leaves both unindexed rather than
  // guessing: `validateDirectionStructure` reports it as `setup-unknown`, and `stageShotContext` throws
  // for the readers that run before that gate.
  const indexShot = (s: Shot) => {
    durationById.set(s.id, timeline.timings.get(s.id)!.duration);
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
      hingeById.set(
        `${s.id}.cutin`,
        deriveShotHinges(dir, s.action, s.cutin.setup, s.cutin.props ?? []),
      );
      const setup = (dir.setups ?? {})[s.cutin.setup];
      if (setup) cutinFrameById.set(s.id, { framing: setup.framing, location: setup.location });
    }
    if (isGraphicShot(s)) {
      graphicIds.add(s.id);
      return;
    }
    setupById.set(s.id, s.setup);
    if (s.coverage) coverageIds.add(s.id);
    hingeById.set(s.id, deriveShotHinges(dir, s.action, s.setup, s.props ?? []));
    const setup = (dir.setups ?? {})[s.setup];
    if (setup) {
      framingById.set(s.id, setup.framing);
      locationById.set(s.id, setup.location);
    }
    if (s.lineup) lineupById.set(s.id, s.lineup);
    if (s.lineupTo) lineupToById.set(s.id, s.lineupTo);
    if (s.passing) passingById.set(s.id, s.passing);
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

  const continuedById = new Map<string, { main?: string; cutin?: string }>();
  for (const [key, nextId] of continuedFrames(dir)) {
    const [id, lane] = key.split("/") as [string, PanelLane];
    continuedById.set(id, { ...continuedById.get(id), [lane]: nextId });
  }

  for (const id of Object.keys(dir.characters)) referenceShapeById.set(id, "portrait");
  for (const id of Object.keys(dir.props ?? {})) referenceShapeById.set(id, "square");
  for (const id of Object.keys(dir.locations)) referenceShapeById.set(id, "master");

  const index: DirectionIndex = {
    format: resolvedFormat,
    timeline,
    lyrics,
    typography: {
      lang: dir.policy.lang,
      ...(dir.policy.fonts?.length ? { fonts: [...dir.policy.fonts] } : {}),
    },
    durationById,
    actionById,
    hingeById,
    setupById,
    framingById,
    locationById,
    scriptById,
    lineupById,
    lineupToById,
    passingById,
    continuedById,
    graphicIds,
    coverageIds,
    cutinById,
    cutinFrameById,
    asideIds,
    labelById,
    referenceShapeById,
  };

  return { ...direction, [DIRECTION_KEY]: index };
}
