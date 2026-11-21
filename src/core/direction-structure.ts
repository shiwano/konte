import { findBuiltinLens } from "./lenses.js";
import { frameSubject, type LensSpec } from "./direction-check.js";
import {
  collectArcShots,
  collectCameraShots,
  collectShotFrames,
  collectShots,
  frameLabel,
  joinBoundaries,
  setupView,
} from "./direction-frames.js";
import {
  declaredViews,
  type Direction,
  type DirectionNode,
  type Location,
  type Setup,
  type View,
} from "./dsl/direction.js";
import { lineSingers, lyricText, singersOf } from "./dsl/direction-timeline.js";
import { isAsideShot } from "./dsl/shot-kind.js";
import { isIdentifier } from "./dsl/validate-identifier.js";
import { isView } from "./view.js";

// Definition bugs: fixed, never waived. Kept apart from
// `DirectionFindingCode`, the codes the arc and roster checks report.
export type DirectionErrorCode =
  | "direction-missing"
  | "empty-direction"
  | "duplicate-id"
  | "unknown-lens"
  | "payoff-not-in-roles"
  | "payoff-function-mismatch"
  | "empty-roles"
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
  | "prop-empty-prompt-depiction"
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
  // The ways a camera faces in a place: `front` is always one, every key is one of the four `VIEWS`,
  // and a view's `holds` names landmarks of its own place (`holds-unknown-id`).
  | "view-front-missing"
  // A landmark id that collides with a character / prop / location id, or with a landmark of another
  // place. The direction has one id space; unlike the three rosters a landmark maps to no reference
  // asset, so the collision is the id space's, not the namespace's.
  | "landmark-id-conflict"
  // Two declared `promptDepiction`s one substring scan cannot tell apart, characters, props and
  // landmarks in one depiction space.
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
  // named must be a landmark of the place the setup is set in, seen by the view it faces.
  | "holds-empty"
  | "holds-unknown-id"
  | "holds-outside-view"
  // The `within` axis's own contract, the `join` pair's twin: a frame that could step in from a
  // wider one and says nothing about whether it does, a `within` no step could have, and a chain of
  // them that closes on itself. None is a creative call, so none is waivable.
  | "within-undeclared"
  | "within-impossible"
  | "within-cyclic"
  // The way the camera faces: declared by every frame that is no window, inherited by every window,
  // and one its location declares. `view-unknown` is a location's `views` key outside the four `VIEWS`.
  | "view-missing"
  | "view-on-window"
  | "view-undeclared"
  | "view-unknown"
  // A single id declared in more than one of the characters / props / locations rosters — all three
  // share the `reference:<id>` namespace, so a collision names one reference asset for two entities.
  | "reference-id-conflict"
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
  | "passing-overlap"
  // The frame `props` contract, the lineup's twin: a frame silent on the props it shows once the
  // roster declares one, an id no prop roster holds, and a prop listed twice.
  | "props-missing"
  | "props-unknown-id"
  | "props-duplicate"
  // The join's own contract. Both are definition bugs with no creative reading, so neither is
  // waivable: a boundary where a long take is possible and nothing says whether it is one, and a
  // `continuous` at a boundary no unbroken take could cross.
  | "join-undeclared"
  | "join-impossible"
  // A coverage shot declaring a frame after its opening one — a `lineupTo` or a `cutin`, where the
  // camera after the opening is the model's cut.
  | "coverage-overdeclared"
  // A shot whose span is not the one the policy counts in: `beats` on a direction with
  // `policy.song`, `duration` on one without, and never both.
  | "shot-span-mismatch"
  // The lyrics' own contract: they are sung on the song, by declared characters, in lines with
  // words in them.
  | "lyrics-without-song"
  | "lyrics-singer-unknown"
  | "lyrics-singer-empty"
  | "lyrics-empty-line";

export type DirectionStructureError = {
  code: DirectionErrorCode;
  subject?: string;
  message: string;
};

export function resolveLens(
  name: string,
  customLenses: readonly LensSpec<string>[] | undefined,
): LensSpec<string> | undefined {
  return customLenses?.find((l) => l.name === name) ?? findBuiltinLens(name);
}

// Every node of the arc tree (root + every descendant), depth-first.
function collectNodes(node: DirectionNode): DirectionNode[] {
  return [node, ...(node.sequences ?? []).flatMap(collectNodes)];
}

// All shot ids declared by the direction, asides included: they share one id namespace with the
// shots and the arc nodes, and a duplicate must be caught wherever it is declared.
function collectShotIds(direction: Direction): string[] {
  return collectShots(direction).map((s) => s.id);
}

function lensSpecErrors(lens: LensSpec<string>): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  if (lens.roles.length === 0) {
    errors.push({
      code: "empty-roles",
      subject: lens.name,
      message: "declares no roles",
    });
    return errors;
  }
  if (!lens.roles.some((b) => b.role === lens.payoff)) {
    errors.push({
      code: "payoff-not-in-roles",
      subject: lens.name,
      message: `payoff "${lens.payoff}" is not one of its roles`,
    });
  }
  // A role carries the dramatic function it performs, so a lens whose declared climax is a
  // grounding or settling role is misusing the vocabulary — a definition bug, never a creative
  // call. A container role with no `fn` is exempt — it claims no function to contradict.
  const payoffFunction = lens.roles.find((b) => b.role === lens.payoff)?.fn;
  if (payoffFunction !== undefined && payoffFunction !== "payoff") {
    errors.push({
      code: "payoff-function-mismatch",
      subject: lens.name,
      message: `payoff "${lens.payoff}" is a ${payoffFunction} role`,
    });
  }
  // Share bounds are fractions of the total, so an out-of-[0,1] value or an inverted min/max is a
  // lens-definition bug (never a creative call) — the act-ratio check would then be meaningless or
  // dead. Hard-fail it here alongside the other LensSpec validity errors.
  for (const decl of lens.roles) {
    for (const [field, value] of [
      ["minShare", decl.minShare],
      ["maxShare", decl.maxShare],
    ] as const) {
      if (value !== undefined && (value < 0 || value > 1)) {
        errors.push({
          code: "invalid-share",
          subject: `${lens.name}.${decl.role}`,
          message: `${field} is ${value}`,
        });
      }
    }
    if (
      decl.minShare !== undefined &&
      decl.maxShare !== undefined &&
      decl.minShare > decl.maxShare
    ) {
      errors.push({
        code: "invalid-share",
        subject: `${lens.name}.${decl.role}`,
        message: `minShare ${decl.minShare} is greater than maxShare ${decl.maxShare}`,
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
      if (setupView(setups, otherId) !== setup.view) return false;
      const otherWidth = FRAMING_WIDTH[other.framing];
      return otherWidth !== undefined && otherWidth < width;
    })
    .filter(([, other]) => isOrderedSubsequence(setup.holds ?? [], other.holds ?? []))
    .map(([otherId]) => otherId);
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
        message: `could step in from ${candidates.map((c) => `"${c}"`).join(", ")}`,
      });
      continue;
    }
    if (within === null) continue;
    const impossible = (why: string) =>
      errors.push({
        code: "within-impossible",
        subject: id,
        message: `\`within: "${within}"\` — ${why}`,
      });
    if (setup.framing === "insert") {
      impossible("the setup is an insert");
      continue;
    }
    const target = setups[within];
    if (target === undefined) {
      impossible("not a declared setup");
      continue;
    }
    if (target.location !== setup.location) {
      impossible(`"${within}" is set in "${target.location}", this frame in "${setup.location}"`);
      continue;
    }
    const width = FRAMING_WIDTH[setup.framing];
    const targetWidth = FRAMING_WIDTH[target.framing];
    if (width === undefined || targetWidth === undefined || targetWidth >= width) {
      impossible(`"${within}" is ${target.framing}, this frame ${setup.framing}`);
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
      message: "its `within` chain leads back to it",
    });
  }
  return errors;
}

function viewErrors(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  for (const [id, setup] of Object.entries(direction.setups ?? {})) {
    const location = direction.locations?.[setup.location];
    const view = (setup as { view?: unknown }).view;
    if (typeof setup.within === "string") {
      if (view === undefined) continue;
      errors.push({
        code: "view-on-window",
        subject: id,
        message: `declares \`view\` as a window of "${setup.within}"`,
      });
      continue;
    }
    if (view === undefined) {
      errors.push({
        code: "view-missing",
        subject: id,
        message: `declares no \`view\` ("front" is the way reference.${setup.location} faces)`,
      });
      continue;
    }
    // A place no roster declares is `setup-unknown-location`.
    if (location === undefined) continue;
    const declared = declaredViews(location.views)
      .map(([v]) => v)
      .filter(isView);
    if (!declared.includes(view as View)) {
      errors.push({
        code: "view-undeclared",
        subject: id,
        message:
          `faces view "${String(view)}", which "${setup.location}" does not declare ` +
          `(its views: ${declared.map((v) => `"${v}"`).join(", ") || "none"})`,
      });
    }
  }
  return errors;
}

// The lyric lines in singing order, each with its place in the sections — `<section>.<line>`, both
// counted from 1, the subject a finding about the line names.
export function lyricLines(
  direction: Direction,
): { key: string; text: string; singer: readonly string[]; section: string }[] {
  return (direction.lyrics ?? []).flatMap((section, s) =>
    section.lines.map((line, l) => ({
      key: `${s + 1}.${l + 1}`,
      text: lyricText(line),
      singer: lineSingers(section, line),
      section: section.label,
    })),
  );
}

// Every `characters` id the lyrics name, on a section or a line.
export function lyricSingerIds(direction: Direction): Set<string> {
  const ids = new Set<string>();
  for (const section of direction.lyrics ?? []) {
    for (const id of singersOf(section.singer)) ids.add(id);
    for (const line of section.lines) {
      if (typeof line !== "string") for (const id of singersOf(line.singer)) ids.add(id);
    }
  }
  return ids;
}

function validateLyrics(direction: Direction): DirectionStructureError[] {
  const lyrics = direction.lyrics;
  if (!lyrics) return [];
  const errors: DirectionStructureError[] = [];
  if (!direction.policy?.song) {
    errors.push({
      code: "lyrics-without-song",
      message: "`lyrics` are declared with no `policy.song`",
    });
  }
  for (const id of lyricSingerIds(direction)) {
    if (Object.hasOwn(direction.characters ?? {}, id)) continue;
    errors.push({
      code: "lyrics-singer-unknown",
      subject: id,
      message: "the lyric singer is not a declared character",
    });
  }
  for (const line of lyricLines(direction)) {
    if (line.singer.length === 0) {
      errors.push({
        code: "lyrics-singer-empty",
        subject: line.key,
        message: "the lyric line is sung by nobody",
      });
    }
    if (line.text.trim() === "") {
      errors.push({
        code: "lyrics-empty-line",
        subject: line.key,
        message: "the lyric line has no words",
      });
    }
  }
  return errors;
}

// Hard, never-waivable structural validity (DirectionErrorCode). Returns errors instead of throwing
// so doctor can report them and the gate can decide to abort.
// The direction's ids in the `reference:<id>` namespace, by roster.
function referenceRosterIds(direction: Direction): {
  characters: Set<string>;
  props: Set<string>;
  locations: Set<string>;
  voices: Set<string>;
} {
  const voices = new Set<string>();
  for (const character of Object.values(direction.characters ?? {})) {
    if (character.voice) voices.add(character.voice.id);
  }
  if (direction.narrator) voices.add(direction.narrator.id);
  return {
    characters: new Set(Object.keys(direction.characters ?? {})),
    props: new Set(Object.keys(direction.props ?? {})),
    locations: new Set(Object.keys(direction.locations ?? {})),
    voices,
  };
}

function validateShots(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];

  const shots = collectShots(direction);
  // A blank label leaves an unnamed hole in the runtime.
  for (const s of shots) {
    if (isAsideShot(s) && s.label.trim() === "") {
      errors.push({
        code: "aside-empty-label",
        subject: s.id,
        message: "the aside's `label` is empty",
      });
    }
  }

  // Which span a shot owes is the policy's: `beats` on the song, `duration` without one. The type
  // layer refuses both mistakes on a literal; this is the computed direction's receiver.
  const clocked = direction.policy?.song !== undefined;
  for (const s of shots) {
    const owed = clocked ? s.beats : s.duration;
    const foreign = clocked ? s.duration : s.beats;
    if (typeof owed === "number" && foreign === undefined) continue;
    errors.push({
      code: "shot-span-mismatch",
      subject: s.id,
      message: clocked
        ? "the direction is cut to policy.song: declare `beats` alone"
        : "the direction declares no policy.song: declare `duration` alone",
    });
  }
  return errors;
}

function validateShotIds(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];

  const shotIds = collectShotIds(direction);
  if (shotIds.length === 0) {
    errors.push({
      code: "empty-direction",
      message: "the direction declares no shots",
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
        message: "the id is declared more than once",
      });
    }
    seen.add(id);
  }
  return errors;
}

function validateRosters(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];

  // The characters are a hard contract: an `id` (the roster key) must be a valid asset name (it maps
  // to reference:<id>), and `name`/`description` must be non-empty. The record key makes a
  // duplicate id structurally impossible, so there is no duplicate-id check here.
  // Two members sharing ONE id is deliberate and allowed — a narrator who is the protagonist, twins —
  // and their `description`s are two performance briefs on one sample, not a contradiction.
  const checkVoice = (
    voice: { id: string; description: string } | undefined,
    codes: { invalidId: DirectionErrorCode; emptyDescription: DirectionErrorCode },
    subject: string | undefined,
  ) => {
    if (!voice) return;
    if (!isIdentifier(voice.id)) {
      errors.push({
        code: codes.invalidId,
        ...(subject ? { subject } : {}),
        message: `voice id "${voice.id}" is not a valid asset name`,
      });
    }
    if (voice.description.trim() === "") {
      errors.push({
        code: codes.emptyDescription,
        ...(subject ? { subject } : {}),
        message: `voice "${voice.id}" has an empty \`description\``,
      });
    }
  };

  for (const [id, character] of Object.entries(direction.characters ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "character-invalid-id",
        subject: id,
        message: "the character id is not a valid asset name",
      });
    }
    if (character.name.trim() === "") {
      errors.push({
        code: "character-empty-name",
        subject: id,
        message: "the character's `name` is empty",
      });
    }
    if (character.description.trim() === "") {
      errors.push({
        code: "character-empty-description",
        subject: id,
        message: "the character's `description` is empty",
      });
    }
    if ((character.promptDepiction ?? "").trim() === "") {
      errors.push({
        code: "character-empty-prompt-depiction",
        subject: id,
        message: "the character declares no `promptDepiction`",
      });
    }
    checkVoice(
      character.voice,
      {
        invalidId: "character-voice-invalid-id",
        emptyDescription: "character-voice-empty-description",
      },
      id,
    );
  }

  checkVoice(
    direction.narrator,
    { invalidId: "narrator-invalid-id", emptyDescription: "narrator-empty-description" },
    undefined,
  );

  // Props are the same hard contract as the characters — an `id` (the roster key) maps to
  // reference:<id>, `name`/`description` are non-empty. Their `id`s share the reference namespace
  // with the characters, so a prop id that collides with a character id would name the same reference
  // asset for two entities: a hard error, reported by the three-way conflict check below. As with
  // characters, the record key rules out a within-roster duplicate id.
  for (const [id, prop] of Object.entries(direction.props ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "prop-invalid-id",
        subject: id,
        message: "the prop id is not a valid asset name",
      });
    }
    if (prop.name.trim() === "") {
      errors.push({
        code: "prop-empty-name",
        subject: id,
        message: "the prop's `name` is empty",
      });
    }
    if (prop.description.trim() === "") {
      errors.push({
        code: "prop-empty-description",
        subject: id,
        message: "the prop's `description` is empty",
      });
    }
    if ((prop.promptDepiction ?? "").trim() === "") {
      errors.push({
        code: "prop-empty-prompt-depiction",
        subject: id,
        message: "the prop declares no `promptDepiction`",
      });
    }
  }

  // Locations are the same hard contract as the characters and props — an `id` (the roster key) maps
  // to reference:<id>, `name`/`description` are non-empty. The record key rules out a within-roster
  // duplicate id; cross-roster collisions are the three-way conflict check below.
  for (const [id, location] of Object.entries(direction.locations ?? {})) {
    if (!isIdentifier(id) || id === "view") {
      errors.push({
        code: "location-invalid-id",
        subject: id,
        message:
          id === "view"
            ? "the location id `view` is reserved for reference:view.<locationId>.<view>"
            : "the location id is not a valid asset name",
      });
    }
    if (location.name.trim() === "") {
      errors.push({
        code: "location-empty-name",
        subject: id,
        message: "the location's `name` is empty",
      });
    }
    if (location.description.trim() === "") {
      errors.push({
        code: "location-empty-description",
        subject: id,
        message: "the location's `description` is empty",
      });
    }
    // A place with nothing only it has in it is a place no frame can be recognized as. Required and
    // non-empty, because the cost is one id and every setup in it names from this list.
    const landmarks = Object.entries(location.landmarks ?? {});
    if (landmarks.length === 0) {
      errors.push({
        code: "landmarks-empty",
        subject: id,
        message: "the location declares no `landmarks`",
      });
    }
    for (const [landmarkId, landmark] of landmarks) {
      const subject = `${id}.${landmarkId}`;
      if (!isIdentifier(landmarkId)) {
        errors.push({
          code: "landmark-invalid-id",
          subject,
          message: `landmark id "${landmarkId}" is not a valid identifier`,
        });
      }
      if (landmark.name.trim() === "") {
        errors.push({
          code: "landmark-empty-name",
          subject,
          message: "the landmark's `name` is empty",
        });
      }
      if (landmark.description.trim() === "") {
        errors.push({
          code: "landmark-empty-description",
          subject,
          message: "the landmark's `description` is empty",
        });
      }
      if ((landmark.promptDepiction ?? "").trim() === "") {
        errors.push({
          code: "landmark-empty-prompt-depiction",
          subject,
          message: "the landmark declares no `promptDepiction`",
        });
      }
    }
    errors.push(...locationViewErrors(id, location));
  }
  return errors;
}

function locationViewErrors(id: string, location: Location): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const views = declaredViews(location.views);
  if (!views.some(([view]) => view === "front")) {
    errors.push({
      code: "view-front-missing",
      subject: id,
      message: `the location declares no \`views.front\`, the way reference.${id} faces`,
    });
  }
  const landmarks = new Set(Object.keys(location.landmarks ?? {}));
  for (const [view, declared] of views) {
    if (!isView(view)) {
      errors.push({
        code: "view-unknown",
        subject: `${id}.${view}`,
        message: `\`views.${view}\` is not a view`,
      });
      continue;
    }
    for (const landmarkId of declared.holds ?? []) {
      if (landmarks.has(landmarkId)) continue;
      errors.push({
        code: "holds-unknown-id",
        subject: `${id}.${view}:${landmarkId}`,
        message: `\`views.${view}.holds\` names "${landmarkId}", which is not a landmark of "${id}"`,
      });
    }
  }
  return errors;
}

// The landmark ids a setup's frame may hold: those the view it faces sees. Undefined where the view
// or its declaration is unknown — a structural error of its own.
function seenFromSetup(direction: Direction, id: string): ReadonlySet<string> | undefined {
  const setups = direction.setups ?? {};
  const view = setupView(setups, id);
  const location = direction.locations?.[setups[id]?.location ?? ""];
  if (view === undefined || location === undefined) return undefined;
  const declared = declaredViews(location.views).find(([v]) => v === view)?.[1];
  return declared ? new Set(declared.holds ?? []) : undefined;
}

function validateIdNamespace(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const ids = referenceRosterIds(direction);
  // Every landmark id, with the places that declare it — the direction has one id space, so a second
  // declarant is a collision rather than a second thing of the same name.
  const landmarkLocations = new Map<string, string[]>();
  for (const [id, location] of Object.entries(direction.locations ?? {})) {
    for (const landmarkId of Object.keys(location.landmarks ?? {})) {
      landmarkLocations.set(landmarkId, [...(landmarkLocations.get(landmarkId) ?? []), id]);
    }
  }

  // Characters, props, and locations share the `reference:<id>` namespace, so one id declared in two
  // of the rosters would name the same reference asset for two entities. Report each collision once,
  // naming the two rosters it appears in.
  for (const id of ids.props) {
    if (ids.characters.has(id)) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: "declared as both a character and a prop",
      });
    }
  }
  for (const id of ids.locations) {
    if (ids.characters.has(id)) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: "declared as both a character and a location",
      });
    }
    if (ids.props.has(id)) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: "declared as both a prop and a location",
      });
    }
  }
  // A cast voice names a reference asset too, so it shares that namespace with the three rosters: a
  // voice id equal to a roster id would make one asset both the look and the sound.
  for (const id of ids.voices) {
    const roster = ids.characters.has(id)
      ? "character"
      : ids.props.has(id)
        ? "prop"
        : ids.locations.has(id)
          ? "location"
          : null;
    if (roster) {
      errors.push({
        code: "reference-id-conflict",
        subject: id,
        message: `cast as a voice and declared as a ${roster}`,
      });
    }
  }

  // A landmark maps to no reference asset, so it joins none of the checks above — but the direction
  // keeps ONE id space, so a landmark named after a character, a prop, a place, or a landmark of
  // another place makes two things answer to one word in a prompt.
  for (const [landmarkId, declaredIn] of landmarkLocations) {
    if (declaredIn.length > 1) {
      errors.push({
        code: "landmark-id-conflict",
        subject: landmarkId,
        message: `declared as a landmark of ${declaredIn.map((id) => `"${id}"`).join(" and ")}`,
      });
    }
    const roster = ids.characters.has(landmarkId)
      ? "character"
      : ids.props.has(landmarkId)
        ? "prop"
        : ids.locations.has(landmarkId)
          ? "location"
          : null;
    if (roster) {
      errors.push({
        code: "landmark-id-conflict",
        subject: landmarkId,
        message: `declared as both a landmark and a ${roster}`,
      });
    }
  }
  return errors;
}

// Every declared `promptDepiction`, characters, props, then landmarks; `key` is the form the naming
// checks match on.
function declaredDepictions(direction: Direction): {
  subject: string;
  kind: "character" | "prop" | "landmark";
  depiction: string;
  key: string;
}[] {
  const declared: {
    subject: string;
    kind: "character" | "prop" | "landmark";
    depiction?: string;
  }[] = [
    ...Object.entries(direction.characters ?? {}).map(([id, c]) => ({
      subject: id,
      kind: "character" as const,
      depiction: c.promptDepiction,
    })),
    ...Object.entries(direction.props ?? {}).map(([id, p]) => ({
      subject: id,
      kind: "prop" as const,
      depiction: p.promptDepiction,
    })),
    ...Object.entries(direction.locations ?? {}).flatMap(([id, location]) =>
      Object.entries(location.landmarks ?? {}).map(([landmarkId, l]) => ({
        subject: `${id}.${landmarkId}`,
        kind: "landmark" as const,
        depiction: l.promptDepiction,
      })),
    ),
  ];
  return declared.flatMap(({ subject, kind, depiction }) =>
    depiction !== undefined && depiction.trim() !== ""
      ? [{ subject, kind, depiction, key: depiction.trim().toLowerCase() }]
      : [],
  );
}

function validatePromptDepictions(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const depictions = declaredDepictions(direction);

  // The naming checks read a prompt for a declared depiction anywhere in it, so one contained in
  // another is undecidable: a prompt that says only "girl in a purple hoodie" also answers for a
  // bare "girl". One depiction space across the three rosters, since a panel's chain carries its
  // plate's own prompt as well.
  for (let i = 0; i < depictions.length; i++) {
    for (let j = i + 1; j < depictions.length; j++) {
      const first = depictions[i]!;
      const second = depictions[j]!;
      const [outer, inner] =
        first.key.length >= second.key.length ? [first, second] : [second, first];
      if (!outer.key.includes(inner.key)) continue;
      errors.push({
        code: "prompt-depiction-conflict",
        subject: inner.subject,
        message:
          `${inner.kind} \`promptDepiction\` "${inner.depiction}" is inside ` +
          `${outer.kind} "${outer.subject}"'s "${outer.depiction}"`,
      });
    }
  }
  return errors;
}

function validateSetups(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const locationIds = new Set(Object.keys(direction.locations ?? {}));
  const setupIds = new Set(Object.keys(direction.setups ?? {}));

  // Setups are the same hard contract minus the reference mapping — a setup's plate is an animatic
  // timeline asset, so its id lives in its own namespace and joins no conflict check above. The
  // `location` it names must still be a declared one: a frame is always somewhere.
  for (const [id, setup] of Object.entries(direction.setups ?? {})) {
    if (!isIdentifier(id)) {
      errors.push({
        code: "setup-invalid-id",
        subject: id,
        message: "the setup id is not a valid asset name",
      });
    }
    if (setup.name.trim() === "") {
      errors.push({
        code: "setup-empty-name",
        subject: id,
        message: "the setup's `name` is empty",
      });
    }
    if (setup.description.trim() === "") {
      errors.push({
        code: "setup-empty-description",
        subject: id,
        message: "the setup's `description` is empty",
      });
    }
    if (locationIds.size > 0 && !locationIds.has(setup.location)) {
      errors.push({
        code: "setup-unknown-location",
        subject: id,
        message: `location "${setup.location}" is not a declared location`,
      });
    }
    // What the frame carries of its set, left to right. An `insert` fills the frame with one object
    // and shows no set, so it is the one framing with nothing to hold.
    const holds = setup.holds ?? [];
    if (holds.length === 0 && setup.framing !== "insert") {
      errors.push({
        code: "holds-empty",
        subject: id,
        message: `a ${setup.framing} frame in "${setup.location}" holds nothing`,
      });
    }
    // Only against a declared place: an unknown one is `setup-unknown-location`, and reporting every
    // id as unknown as well would name the wrong fix.
    const landmarksHere = direction.locations?.[setup.location]?.landmarks;
    if (landmarksHere) {
      // Own keys only: `in` would answer true for "toString", letting a computed `holds` name an
      // inherited function that every reader after this then treats as a landmark.
      const declared = new Set(Object.keys(landmarksHere));
      const seen = seenFromSetup(direction, id);
      for (const landmarkId of holds) {
        if (!declared.has(landmarkId)) {
          errors.push({
            code: "holds-unknown-id",
            subject: `${id}:${landmarkId}`,
            message: `"${landmarkId}" is not a landmark of "${setup.location}"`,
          });
          continue;
        }
        if (seen === undefined || seen.has(landmarkId)) continue;
        const view = setupView(direction.setups ?? {}, id);
        errors.push({
          code: "holds-outside-view",
          subject: `${id}:${landmarkId}`,
          message:
            `"${landmarkId}" is not in "${setup.location}"'s \`views.${view}.holds\`, the view ` +
            `this frame faces`,
        });
      }
    }
  }

  errors.push(...withinErrors(direction), ...viewErrors(direction));

  // Every frame is taken from somewhere: its `setup` must resolve to a declared setup. An empty roster
  // (while frames exist) is `setup-empty` — reported once rather than as one `setup-unknown` per
  // frame; a non-empty roster reports each frame whose `setup` is not in it.
  const frames = collectShotFrames(direction);
  if (setupIds.size === 0) {
    if (frames.length > 0) {
      errors.push({
        code: "setup-empty",
        message: "the direction declares no setups",
      });
    }
  } else {
    for (const f of frames) {
      if (!setupIds.has(f.setup)) {
        errors.push({
          code: "setup-unknown",
          subject: frameSubject(f),
          message: `\`${f.lane === "cutin" ? "cutin.setup" : "setup"}: "${f.setup}"\` is not a declared setup`,
        });
      }
    }
  }

  // A location with no setup in it is unreachable — every shot arrives through a setup, so the roster
  // entry could never be used. Reported once the setups roster is non-empty (an empty one is already
  // `setup-empty`).
  if (locationIds.size === 0 && setupIds.size > 0) {
    errors.push({
      code: "location-empty",
      message: "the direction declares setups but no locations",
    });
  }
  return errors;
}

function validateFrames(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const characterIds = new Set(Object.keys(direction.characters ?? {}));
  const propIds = new Set(Object.keys(direction.props ?? {}));

  // The lineups. All three faults are "this declares nothing usable" — a shot with no `lineup` at
  // all, an id no character roster holds, a subject listed twice — so none is a creative call and
  // none is waivable. The type layer requires the field and blames a bad id at the position it was
  // written; this catches a computed direction, and a roster typed rather than literal.
  for (const f of collectShotFrames(direction)) {
    if (!f.lineup) {
      errors.push({
        code: "lineup-missing",
        subject: frameSubject(f),
        message: "the frame declares no `lineup`",
      });
    }
    for (const [field, lineup] of [
      ["lineup", f.lineup],
      ["lineupTo", f.lineupTo],
      ["passing", f.passing],
    ] as const) {
      if (!lineup) continue;
      const seen = new Set<string>();
      for (const subjectId of lineup) {
        if (!characterIds.has(subjectId)) {
          errors.push({
            code: "lineup-unknown-id",
            subject: `${frameSubject(f)}:${subjectId}`,
            message: `\`${field}\` names "${subjectId}", which is not a declared character`,
          });
        }
        if (seen.has(subjectId)) {
          errors.push({
            code: "lineup-duplicate",
            subject: `${frameSubject(f)}:${subjectId}`,
            message: `\`${field}\` lists "${subjectId}" twice`,
          });
        }
        if (
          field === "passing" &&
          [...(f.lineup ?? []), ...(f.lineupTo ?? [])].includes(subjectId)
        ) {
          errors.push({
            code: "passing-overlap",
            subject: `${frameSubject(f)}:${subjectId}`,
            message: `"${subjectId}" is in \`passing\` and an endpoint lineup`,
          });
        }
        seen.add(subjectId);
      }
    }
    if (!f.props) {
      if (propIds.size > 0) {
        errors.push({
          code: "props-missing",
          subject: frameSubject(f),
          message: "the direction declares props, but the frame does not state the ones it shows",
        });
      }
      continue;
    }
    const seenProps = new Set<string>();
    for (const propId of f.props) {
      if (!propIds.has(propId)) {
        errors.push({
          code: "props-unknown-id",
          subject: `${frameSubject(f)}:${propId}`,
          message: `\`props\` names "${propId}", which is not a declared prop`,
        });
      }
      if (seenProps.has(propId)) {
        errors.push({
          code: "props-duplicate",
          subject: `${frameSubject(f)}:${propId}`,
          message: `\`props\` lists "${propId}" twice`,
        });
      }
      seenProps.add(propId);
    }
  }

  // The type layer refuses both on a literal; this catches a computed direction.
  for (const s of collectCameraShots(direction)) {
    if (!s.coverage) continue;
    for (const [field, declared] of [
      ["lineupTo", s.lineupTo !== undefined],
      ["cutin", s.cutin !== undefined],
    ] as const) {
      if (!declared) continue;
      errors.push({
        code: "coverage-overdeclared",
        subject: s.id,
        message: `\`${field}\` on a coverage shot`,
      });
    }
  }

  // Where a long take is possible, omission is the one reading nothing could mean, so the boundary
  // has to choose one of the three.
  for (const { frame, previous, previousFrame, runOn } of joinBoundaries(direction)) {
    // Asking a frame whose setup is not declared about its join on top of `setup-unknown` names the
    // wrong fix.
    if (direction.setups?.[frame.setup] === undefined) continue;
    const field = frame.lane === "cutin" ? "cutin.join" : "join";
    if (frame.join === "continuous" && !runOn) {
      const why =
        previous === undefined
          ? "it opens the piece"
          : isAsideShot(previous)
            ? `"${previous.id}" before it is an aside`
            : previousFrame === undefined
              ? frame.lane === "cutin"
                ? `"${previous.id}" before it carries no cutin`
                : `"${previous.id}" before it is a graphic shot`
              : previousFrame.coverage
                ? `"${previous.id}" before it is a coverage shot, whose camera ends wherever the ` +
                  "model cut to"
                : `it sits on setup "${frame.setup}" while ${frameLabel(previousFrame)} before it is ` +
                  `on "${previousFrame.setup}"`;
      errors.push({
        code: "join-impossible",
        subject: frameSubject(frame),
        message: `declares \`${field}: "continuous"\`, and ${why}`,
      });
    } else if (runOn && frame.join === undefined) {
      errors.push({
        code: "join-undeclared",
        subject: frameSubject(frame),
        message: `follows ${frameLabel(runOn)} on setup "${frame.setup}" with no \`${field}\``,
      });
    }
  }
  return errors;
}

function validateLines(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];
  const characterIds = new Set(Object.keys(direction.characters ?? {}));

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
            message: `a line for "${line.character}" has an empty \`acting\` note`,
          });
        }
        if (!characterIds.has(line.character)) {
          errors.push({
            code: "script-unknown-character",
            subject: `${s.id}:${line.character}`,
            message: `a script line is spoken by "${line.character}", not a declared character`,
          });
        }
        if (line.text.trim() === "") {
          errors.push({
            code: "script-empty-text",
            subject: s.id,
            message: `a line for "${line.character}" has empty text`,
          });
        }
      } else if ("speaker" in line) {
        if (line.text.trim() === "") {
          errors.push({
            code: "script-empty-text",
            subject: s.id,
            message: `a line for "${line.speaker}" has empty text`,
          });
        }
      } else if (line.narration.trim() === "") {
        errors.push({
          code: "script-empty-text",
          subject: s.id,
          message: "a narration line has empty text",
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
          message: "a telop entry has empty text",
        });
      }
    }
  }
  return errors;
}

function validateLenses(direction: Direction): DirectionStructureError[] {
  const errors: DirectionStructureError[] = [];

  // Every node names a lens; resolve and validate each. A node's id (absent on the root) qualifies
  // the "unknown lens" message so a reader knows which node it fired on.
  for (const node of collectNodes(direction.sequence)) {
    const lens = resolveLens(node.lens, direction.lenses);
    if (!lens) {
      errors.push({
        code: "unknown-lens",
        subject: node.lens,
        message: node.id
          ? `sequence "${node.id}" names an unknown lens`
          : "the direction names an unknown lens",
      });
    } else {
      errors.push(...lensSpecErrors(lens));
    }
  }
  return errors;
}

export function validateDirectionStructure(direction: Direction): DirectionStructureError[] {
  return [
    ...validateShots(direction),
    ...validateLyrics(direction),
    ...validateShotIds(direction),
    ...validateRosters(direction),
    ...validateIdNamespace(direction),
    ...validatePromptDepictions(direction),
    ...validateSetups(direction),
    ...validateFrames(direction),
    ...validateLines(direction),
    ...validateLenses(direction),
  ];
}
