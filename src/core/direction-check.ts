// The generic arc types and their checker. Deliberately free of any DSL/runtime import so the
// doctor, the generate gate, and unit tests can pull it in standalone. `checkArc` is the single
// engine reused at every scale of the arc tree (a run of shots, a run of sequences, a run of runs);
// it is generic over `Role`. A role is a plain string scoped to its lens — each lens declares its
// own roles and each carries the dramatic `fn` the theory checks read, so there is no global role
// vocabulary or function map; the engine reads `fn` off the matched role.

import { formatCompositionAddress, formatPlateAddress, formatShotAddress } from "./address.js";
import { formatSeconds, formatSecondsRange } from "./format-duration.js";
import type { AcceptJudgedCode } from "./finding.js";
import type { PanelLane, ShotJoin } from "./types/definition.js";
import { parseViewName, type View } from "./view.js";

/**
 * The dramatic function a role performs — the five-stage skeleton the classical arc schemas share
 * (Freytag's pyramid, three-act, kishōtenketsu): ground establishes a state, turn breaks it, build
 * escalates it, payoff lands the climax, settle lets it ring.
 */
export type RoleFunction = "ground" | "turn" | "build" | "payoff" | "settle";

export type ArcItem<Role extends string> = {
  id: string;
  role: Role;
  // The item's descriptive prose — a shot's `action` at leaf scale, a sequence's `synopsis` at
  // branch scale. The engine is scale-generic, so it holds one field; the caller names it per scale
  // via `CheckArcOptions.textLabel` when a finding message must speak the author's own word.
  synopsis: string;
  duration?: number;
};

export type LensRole<Role extends string> = {
  role: Role;
  // The dramatic function this role performs in *this* lens — the five-stage skeleton the classical
  // arc schemas share (ground establishes a state, turn breaks it, build escalates, payoff lands the
  // climax, settle lets it ring). It is what lets the engine check theory ("a climax must be earned")
  // generically. Omit it for a container role — a role with no `fn` is exempt from every function
  // check. No built-in lens does: a lens of function-less roles is a lens with no rules.
  fn?: RoleFunction;
  required?: boolean;
  minConsecutive?: number;
  // Share of the arc's total duration this role must hold, as a fraction in [0, 1] — the act-ratio
  // guard at sequence scale: a setup act eating the runtime (`maxShare`), a climax reduced to a
  // sliver (`minShare`) — but usable at either scale.
  minShare?: number;
  maxShare?: number;
};

export type LensSpec<Role extends string> = {
  name: string;
  roles: LensRole<Role>[];
  payoff: Role;
};

/**
 * Fixed contract, like KonteErrorCode: doctor / waiver keys / scripts branch on these. The same
 * codes are reused at both scales — the subject (role / id / range) distinguishes instances.
 */
export type DirectionFindingCode =
  | "missing-role"
  | "no-payoff"
  | "role-out-of-order"
  | "lens-role-mismatch"
  | "too-few-consecutive"
  | "empty-synopsis"
  | "unearned-payoff"
  | "role-overweight"
  | "role-underweight"
  | "character-unreferenced"
  | "unused-character"
  | "character-voice-missing"
  | "character-voice-unreferenced"
  | "unused-character-voice"
  | "narrator-missing"
  | "narrator-unreferenced"
  | "unused-narrator"
  | "prop-unreferenced"
  | "unused-prop"
  | "location-unreferenced"
  | "unused-location"
  | "setup-unrealized"
  | "plate-unanchored"
  | "setup-unconsumed"
  // A window's plate cut outside the plate of the frame it declares itself a window of.
  | "plate-unnested"
  // The axis read as a shared frame: a cut along one, with no plate holding its two ends to one
  // master.
  | "axis-unrealized"
  // A plate neither of the two above asks for.
  | "plate-unowed"
  | "unused-setup"
  | "setup-atomized"
  // The views: a way a setup faces with no image of it, a plate standing on another view's image,
  // a view image drawn from nothing of its location, and an image of a view whose prompt does not
  // ask for a landmark a setup facing that way holds.
  | "view-unrealized"
  | "plate-unviewed"
  | "view-unanchored"
  | "view-unnamed"
  | "multi-sentence-action"
  | "off-grid-duration"
  | "off-beat-cut"
  | "fonts-undeclared"
  // The staging class: who the frame holds, left to right, declared per shot and accumulated per
  // place. Four settle a RELATION between two subjects across two shots; the two the board feeds
  // settle the declared frame against what the keyframe was conditioned on — who it took
  // (`character-unconsumed`) and in what order (`slot-order-mismatch`). The last settles the frame
  // itself: a keyframe that crops the plate it stands on.
  | "lineup-flipped"
  | "lineup-gap"
  | "lineup-vacuous"
  | "lineup-inconsistent"
  // A character's route: a frame back in a place they left, with no jump between.
  | "location-backtrack"
  | "character-unconsumed"
  | "slot-order-mismatch"
  | "plate-recropped"
  // The seam a `continuous` join declares: one take across a shot boundary, so the frame at the end
  // of the one and the start of the next is a single frame — the opening keyframe of the shot that
  // owns the boundary. The two shots must agree on who it holds, and the take before must land on
  // it.
  | "join-lineup-mismatch"
  | "join-unpinned"
  // The seam frame is pinned, and the composition's window over the take leaves it out.
  | "join-unshown"
  // A frame's key pinned as the first frame of a take whose model could have taken it as a reference.
  | "opening-key"
  // A cut along one camera axis: the camera does not move, so the frame does not restart.
  | "panel-unlinked"
  // A cut back to a setup across a cutaway.
  | "return-unlinked"
  // `landmark-flipped` is the `lineup-flipped` of things that do not move, read across the setups
  // of one place. Each `-unnamed` asks whether the text calls a thing by the name the direction
  // declared: a frame's subjects and props in its keyframes' prompts, a passer in the take's, and a
  // landmark the frame holds in the prompt that first draws the frame — its plate's, or its
  // keyframes' where the setup has none.
  | "landmark-flipped"
  | "subject-unnamed"
  | "prop-unnamed"
  | "passer-unconsumed"
  | "passer-unnamed"
  | "plate-unnamed"
  | "landmark-unnamed"
  // The song's: the song the piece is cut to is not a reference asset, and a lyric line no reading
  // of the take places.
  | "song-unreferenced"
  | "lyric-unplaced"
  // The timeline runs on past the end of the take of the song.
  | "song-overrun";

type DirectionFindingFields = {
  // role / shot id / id-range, depending on the code; omitted for no-payoff.
  subject?: string;
  // The field path of the arc node the finding fired on — `["sequence"]` at the root, one
  // `["sequences", <id>]` pair deeper per level (the same path its review address is built from).
  // The engine itself is path-blind; the caller that walks the tree stamps it.
  path?: readonly string[];
  message: string;
};

export type DirectionFinding =
  | (DirectionFindingFields & {
      code: Extract<DirectionFindingCode, AcceptJudgedCode>;
      // The addresses whose accept judges it. Once each is accepted against its current definition
      // it holds nothing, and its waiver stays in use.
      judgedBy: readonly string[];
    })
  | (DirectionFindingFields & {
      code: Exclude<DirectionFindingCode, AcceptJudgedCode>;
      judgedBy?: never;
    });

export type CheckArcOptions = {
  // The scale's item word woven into messages ("shot" for a run of shots, "sequence" for a run of
  // sequences) so the same engine reads naturally at every scale — the finding *codes* stay identical.
  noun?: string;
  // The author's word for an item's descriptive prose, woven into the empty-text message: "action"
  // at leaf scale, "synopsis" at branch scale. Defaults to "synopsis".
  textLabel?: string;
};

// The one generic arc checker. Reports findings; it never throws and never decides severity — the
// caller (doctor reports / generate gate) owns waivers and abort policy.
export function checkArc<Role extends string>(
  lens: LensSpec<Role>,
  items: ArcItem<Role>[],
  options: CheckArcOptions = {},
): DirectionFinding[] {
  const { noun = "shot", textLabel = "synopsis" } = options;
  const findings: DirectionFinding[] = [];

  const roleIndex = new Map<string, number>();
  lens.roles.forEach((b, i) => roleIndex.set(b.role, i));
  const declByRole = new Map<string, LensRole<Role>>();
  for (const b of lens.roles) declByRole.set(b.role, b);
  // A role's dramatic function is declared on the lens (a role outside the lens has none — exempt).
  const fnOf = (role: string): RoleFunction | undefined => declByRole.get(role)?.fn;
  const presentRoles = new Set<string>(items.map((it) => it.role));

  for (const decl of lens.roles) {
    if (decl.required === false) continue;
    if (!presentRoles.has(decl.role)) {
      findings.push({
        code: "missing-role",
        subject: decl.role,
        message: `${lens.name} has no ${decl.role} ${noun}`,
      });
    }
  }

  if (!presentRoles.has(lens.payoff)) {
    findings.push({
      code: "no-payoff",
      message: `${lens.name} marks no "${lens.payoff}" ${noun}`,
    });
  }

  for (const it of items) {
    if (!roleIndex.has(it.role)) {
      findings.push({
        code: "lens-role-mismatch",
        subject: it.id,
        message: `${noun}.${it.id} uses role "${it.role}", but lens is "${lens.name}"`,
      });
    }
  }

  // Walk the in-lens items tracking the highest role seen; a later item with a lower role index
  // means the earlier later-placed role appeared ahead of schedule (e.g. "release before pressure").
  let maxIdx = -1;
  let maxRole: string | null = null;
  const reportedOutOfOrder = new Set<string>();
  for (const it of items) {
    const idx = roleIndex.get(it.role);
    if (idx === undefined) continue;
    if (idx < maxIdx && maxRole !== null) {
      if (!reportedOutOfOrder.has(maxRole)) {
        reportedOutOfOrder.add(maxRole);
        findings.push({
          code: "role-out-of-order",
          subject: maxRole,
          message: `${maxRole} appears before ${it.role}`,
        });
      }
    } else if (idx > maxIdx) {
      maxIdx = idx;
      maxRole = it.role;
    }
  }

  // A role that only lands once when its lens wants it to build (a comedy escalation, a process
  // montage) is hollow. Measured on the role's longest run — an absent required role is already
  // `missing-role`, so only under-repeated *present* roles fire here.
  const longestRun = new Map<string, number>();
  for (let i = 0; i < items.length; ) {
    const role = items[i]!.role;
    let j = i + 1;
    while (j < items.length && items[j]!.role === role) j++;
    longestRun.set(role, Math.max(longestRun.get(role) ?? 0, j - i));
    i = j;
  }
  for (const decl of lens.roles) {
    if (decl.minConsecutive === undefined || !presentRoles.has(decl.role)) continue;
    const run = longestRun.get(decl.role) ?? 0;
    if (run < decl.minConsecutive) {
      findings.push({
        code: "too-few-consecutive",
        subject: decl.role,
        message: `"${decl.role}" needs a run of at least ${decl.minConsecutive} but the longest is ${run}`,
      });
    }
  }

  for (const it of items) {
    if (it.synopsis.trim() === "") {
      findings.push({
        code: "empty-synopsis",
        subject: it.id,
        message: `${noun}.${it.id} has an empty ${textLabel}`,
      });
    }
  }

  // A climax must be earned (rising action precedes it — Freytag, McKee's progressive
  // complications): the declared payoff cannot land before at least one grounding, turning, or
  // building item. This is what makes a degenerate one-role lens — or a direction that opens on
  // its climax — visible instead of silently passing; a deliberate cold-open waives it.
  const payoffIdx = items.findIndex((it) => it.role === lens.payoff);
  if (payoffIdx !== -1 && fnOf(lens.payoff) === "payoff") {
    const earned = items.slice(0, payoffIdx).some((it) => {
      const fn = fnOf(it.role);
      return fn === "ground" || fn === "turn" || fn === "build";
    });
    if (!earned) {
      findings.push({
        code: "unearned-payoff",
        subject: lens.payoff,
        message: `${noun}.${items[payoffIdx]!.id} lands the "${lens.payoff}" payoff with no ${noun} grounding or building toward it first`,
      });
    }
  }

  // Act-ratio pacing: each role's share of the arc's total duration against its min/maxShare.
  // Relative, so it reads the *shape* of the arc independent of overall length — a setup act that
  // swallows the runtime, a climax that never gets room. Runs only when every item has a duration
  // (a direction always does) and the total is positive, so an empty or duration-less arc stays silent.
  if (items.length > 0 && items.every((it) => it.duration !== undefined)) {
    const total = items.reduce((sum, it) => sum + (it.duration ?? 0), 0);
    if (total > 0) {
      const roleDuration = new Map<string, number>();
      for (const it of items) {
        roleDuration.set(it.role, (roleDuration.get(it.role) ?? 0) + (it.duration ?? 0));
      }
      const pct = (share: number) => Math.round(share * 100);
      for (const decl of lens.roles) {
        if (!presentRoles.has(decl.role)) continue;
        const share = (roleDuration.get(decl.role) ?? 0) / total;
        if (decl.maxShare !== undefined && share > decl.maxShare) {
          findings.push({
            code: "role-overweight",
            subject: decl.role,
            message: `"${decl.role}" holds ${pct(share)}% of the runtime, over its ${pct(decl.maxShare)}% budget`,
          });
        }
        if (decl.minShare !== undefined && share < decl.minShare) {
          findings.push({
            code: "role-underweight",
            subject: decl.role,
            message: `"${decl.role}" holds only ${pct(share)}% of the runtime, under its ${pct(decl.minShare)}% minimum`,
          });
        }
      }
    }
  }

  return findings;
}

// A declared entity anchored to a reference asset — the shared shape of a character and a prop.
// Minimal structural form (not the DSL `Character`/`Prop`) so this engine stays DSL-free: `id` is the
// controlled-vocabulary token that must equal a reference asset name, `name` the canonical prose
// token every shot action refers to it by.
export type AnchoredEntityRef = { id: string; name: string };

// The `locations` id a setup stands in names the reference asset its plate and its shots are held to.
export type SetupRef = AnchoredEntityRef & {
  location: string;
  framing: string;
  // The wider frame this one steps in from, `null` at the root of its axis. Read by
  // `plate-unnested`, which names it as the plate to build from.
  within?: string | null;
  // The way the camera faces, a window's resolved through its root.
  view?: string;
};

export type AxisCut = {
  // The two setups the cut runs between, by id. Sorted, not in cut order: the plates it owes are the
  // same either way round.
  pair: readonly [string, string];
  // Each of the two, and every frame they step in from up to the one they share. `plate-unnested`
  // holds a frame to its parent's plate and needs BOTH, so a gap anywhere along here leaves the two
  // ends nesting in nothing.
  chain: readonly string[];
};

// What the setups class needs from the board: which setups have a plate, which of those plates stand
// on no location reference, and which developed shots reach neither anchor. Assembled by
// `animaticSetupState`; undefined stands for "the animatic could not be read", the same contract
// `referenceAssetNames` carries for the rosters.
//
// The view half rides along: which plates and plate-less shots reach their location through another
// view's image only, and which view images (`<locationId>.<view>`) stand on no location master.
export type AnimaticSetupState = {
  plateIds: readonly string[];
  unanchoredPlateIds: readonly string[];
  unnestedPlateIds: readonly string[];
  unconsumedBy: ReadonlyMap<string, readonly string[]>;
  // The keyframes of the frames in `unconsumedBy`, keyed by setup.
  unconsumedPanels: ReadonlyMap<string, readonly string[]>;
  deterministicShotsPerSetup: ReadonlyMap<string, number>;
  // The keyframes of each generated frame, keyed by setup and then shot. An undeveloped frame holds
  // its shot's composition, which no accept has signed.
  framePanels: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  deterministicPlateIds: readonly string[];
  unviewedPlateIds: readonly string[];
  unviewedBy: ReadonlyMap<string, readonly string[]>;
  unanchoredViews: readonly string[];
  referenceImageTexts: Readonly<Record<string, readonly string[]>>;
  // Setup ids whose plate has an accepted take.
  acceptedPlateIds: readonly string[];
};
type CharacterRef = AnchoredEntityRef;

// The anchored-entity checks — a distinct pass from the arc engine because they cross-reference the
// reference stage and the shot-action prose, neither of which `checkArc` sees. Two safe, exact-match
// findings (both waivable via `direction.waivers`):
//   - <noun>-unreferenced: a declared entity with no matching reference asset to anchor on.
//   - unused-<noun>: a declared entity never named in any shot action (and, for a character, never
//     given a script line) — drift between the roster and the shots. Deliberately one-directional —
//     "a prose noun with no declared entity" can't be detected without NL parsing, so that gap is a
//     guide convention, not a finding.
function checkAnchoredEntities(
  entities: readonly AnchoredEntityRef[],
  referenceAssetNames: readonly string[],
  actions: readonly string[],
  alwaysUsedIds: ReadonlySet<string>,
  codes: {
    unreferenced: Exclude<DirectionFindingCode, AcceptJudgedCode>;
    unused: Exclude<DirectionFindingCode, AcceptJudgedCode>;
    // How the entity is "used" — woven into the `unused` message so it reads true for each roster:
    // a character/prop is named in a shot action, a location is a shot's `location` field.
    usedBy: string;
  },
  noun: string,
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const referenced = new Set(referenceAssetNames);
  for (const e of entities) {
    if (!referenced.has(e.id)) {
      findings.push({
        code: codes.unreferenced,
        subject: e.id,
        message: `${noun} "${e.id}" has no reference asset`,
      });
    }
  }
  for (const e of entities) {
    // An entity with an "always used" signal (a character's script line) needs no prose scan.
    if (alwaysUsedIds.has(e.id)) continue;
    // An empty name would make `.includes` always match; that hollow declaration is a structural
    // error (validateDirectionStructure), so skip it here rather than reporting a misleading pass.
    if (e.name.trim() === "") continue;
    if (!actions.some((a) => a.includes(e.name))) {
      findings.push({
        code: codes.unused,
        subject: e.id,
        message: `${noun} "${e.name}" is ${codes.usedBy}`,
      });
    }
  }
  return findings;
}

// A character no frame's lineup holds is never on screen, so owes no reference.
export function checkCharacters(
  characters: readonly CharacterRef[],
  referenceAssetNames: readonly string[],
  actions: readonly string[],
  scriptCharacterIds: ReadonlySet<string>,
  framedCharacterIds: ReadonlySet<string>,
): DirectionFinding[] {
  return checkAnchoredEntities(
    characters,
    referenceAssetNames,
    actions,
    scriptCharacterIds,
    {
      unreferenced: "character-unreferenced",
      unused: "unused-character",
      usedBy: "named in no shot action",
    },
    "character",
  ).filter((f) => f.code !== "character-unreferenced" || framedCharacterIds.has(f.subject ?? ""));
}

// Props are anchored like the characters but never speak, so there is no script signal — a prop is "used"
// only by being named in a shot action.
export function checkProps(
  props: readonly AnchoredEntityRef[],
  referenceAssetNames: readonly string[],
  actions: readonly string[],
): DirectionFinding[] {
  return checkAnchoredEntities(
    props,
    referenceAssetNames,
    actions,
    new Set(),
    {
      unreferenced: "prop-unreferenced",
      unused: "unused-prop",
      usedBy: "named in no shot action",
    },
    "prop",
  );
}

// A cast member's voice in the DSL-free form these checks take: `voiceAssetId` is the exposed
// reference asset holding the sample (null when none is cast), `speaks` whether the piece actually
// gives this member lines. `id`/`name` are the character's; the narrator has neither.
export type CharacterVoiceRef = {
  id: string;
  name: string;
  voiceAssetId: string | null;
  speaks: boolean;
};

// The voice checks — a pass of their own rather than part of `checkAnchoredEntities`, because what
// makes a voice required is a script line, not a name in the prose. Three waivable findings per cast
// member: `<noun>-voice-missing` (they speak, nothing is cast), `<noun>-voice-unreferenced` (the cast
// sample is not exposed), and `unused-<noun>-voice` (a sample for someone who never speaks — which
// the `unused-character` prose scan misses, a character named in an action reading as used there).
export function checkCharacterVoices(
  characters: readonly CharacterVoiceRef[],
  referenceAssetNames: readonly string[],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const referenced = new Set(referenceAssetNames);
  for (const c of characters) {
    if (c.voiceAssetId === null) {
      if (c.speaks) {
        findings.push({
          code: "character-voice-missing",
          subject: c.id,
          message: `character "${c.name}" speaks but has no voice`,
        });
      }
      continue;
    }
    if (!referenced.has(c.voiceAssetId)) {
      findings.push({
        code: "character-voice-unreferenced",
        subject: c.id,
        message: `character "${c.id}" casts voice "${c.voiceAssetId}", which has no reference asset`,
      });
    }
    if (!c.speaks) {
      findings.push({
        code: "unused-character-voice",
        subject: c.id,
        message: `character "${c.name}" has a voice but no script line`,
      });
    }
  }
  return findings;
}

// The narrator's twin of `checkCharacterVoices`. Piece-wide and singular, so the findings carry no
// subject: a `{ narration }` line names no speaker, so there is only ever one narrator to cast.
export function checkNarrator(
  voiceAssetId: string | null,
  referenceAssetNames: readonly string[],
  hasNarration: boolean,
): DirectionFinding[] {
  if (voiceAssetId === null) {
    return hasNarration
      ? [
          {
            code: "narrator-missing",
            message: "the direction declares narration lines but casts no narrator",
          },
        ]
      : [];
  }
  const findings: DirectionFinding[] = [];
  if (!referenceAssetNames.includes(voiceAssetId)) {
    findings.push({
      code: "narrator-unreferenced",
      message: `the narrator's voice "${voiceAssetId}" has no reference asset`,
    });
  }
  if (!hasNarration) {
    findings.push({
      code: "unused-narrator",
      message: "a narrator is cast but no shot declares a narration line",
    });
  }
  return findings;
}

// Locations are anchored like the characters and props, but a place does not appear in the `action`
// prose (it does not act) — a shot reaches its location through its setup. So "used" is exact id
// membership in `usedLocationIds` (the set of ids the setups the shots point at are set in), not a
// prose scan: passed as `alwaysUsedIds` with an empty `actions`, so a location in the set is used and
// one outside it raises `unused-location`. The unreferenced check is identical to the other rosters.
export function checkLocations(
  locations: readonly AnchoredEntityRef[],
  referenceAssetNames: readonly string[],
  usedLocationIds: ReadonlySet<string>,
): DirectionFinding[] {
  return checkAnchoredEntities(
    locations,
    referenceAssetNames,
    [],
    usedLocationIds,
    {
      unreferenced: "location-unreferenced",
      unused: "unused-location",
      usedBy: "the location of no setup",
    },
    "location",
  );
}

// Setups are the fourth roster but not a fourth anchored one: what realizes a setup is its PLATE, an
// `animatic:plate.<id>` asset, so this cannot reuse `checkAnchoredEntities` — the anchor pool is a
// different namespace and the demand is conditional.
//
// A plate exists to hold two or more GENERATED shots to one frame. A setup only one shot names has
// nothing to hold together, so it owes no plate: `shotsPerSetup` is what draws that line, and it is
// why making `shot.setup` required does not price a one-off frame at a generation. A developed shot
// with no generative step is dropped from that count: a `file` keyframe takes no inputs at all, so a
// plate no generated shot stands on would be review work no accept could ever reach.
//
// Standing on the place is not conditional. Every developed shot builds on its setup's anchor — the
// plate where the setup has one, the location's own `reference:<id>` where it does not — and the
// plate itself builds on that same reference. So the three findings are one rule read at three
// points:
//
//   - `setup-unrealized`: a shared frame with nothing pinning it.
//   - `plate-unanchored`: a plate pinning a frame it invented.
//   - `setup-unconsumed`: a shot ignoring the anchor it has.
//
// `plate-unnested` rides alongside them on the other axis the direction declares: where `within` says
// this frame is a step in from a wider one, the plate must be built from that one's plate.
//
// `setup-unrealized` stops the other two for that setup: there is no anchor yet to ignore, and the
// plate it asks for is what the shots will stand on. So waiving a setup out of owing a plate waives
// its shots out of standing on anything. An unanchored plate is still the frame its shots owe, so
// those two findings stand together.
//
// Both anchor findings wait on the reference existing. A location with no `reference:<id>` is already
// `location-unreferenced`, which gates the same spend and whose fix is written in reference.tsx;
// demanding that a picture be built from it meanwhile names a file that is not there.
//
// How many shots a location must hold before never returning to a frame reads as a choice. Below it
// there is nothing to share: a four-shot scene covered wide/medium/close/insert has one shot per
// frame because that IS the coverage.
export const ATOMIZED_LOCATION_SHOTS = 8;

// The axis read as a shared frame. `setup-unrealized` asks for a plate where one CAMERA POSITION is
// shared; this asks for one where one camera AXIS is cut along — two set-showing sizes of a place
// that the direction says are one camera at two focal lengths.
//
// Keyed by the two setups rather than the two shots, and joined on `.` like `plate-unnamed`'s: the
// plates are what the fix declares, one pair cut four times is one piece of work, and a `-` would not
// say where one id ends (a hyphen is a legal identifier character).
function checkAxisCuts(
  cuts: readonly AxisCut[],
  plates: ReadonlySet<string>,
  judgedBy: (setupId: string) => string[],
  generated: (setupId: string) => number,
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const seen = new Set<string>();
  for (const cut of cuts) {
    const subject = cut.pair.join(".");
    if (seen.has(subject)) continue;
    const missing = cut.chain.filter((id) => !plates.has(id));
    if (missing.length === 0) continue;
    // No generated shot on either end has a frame to hold.
    if (cut.pair.every((id) => generated(id) === 0)) continue;
    seen.add(subject);
    const owed = missing.map((id) => `"${id}"`).join(", ");
    findings.push({
      code: "axis-unrealized",
      subject,
      message:
        `${owed} ${missing.length === 1 ? "has" : "have"} no plate on the axis of setups ` +
        `"${cut.pair[0]}" and "${cut.pair[1]}"`,
      judgedBy: cut.pair.flatMap(judgedBy),
    });
  }
  return findings;
}

// The plates neither `setup-unrealized` nor `axis-unrealized` asks for: a setup at most one generated
// shot stands on, cut along no axis that nests it. One with no generative step is exempt, and so is
// one under a single generated shot once it is accepted.
function checkUnowedPlates(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
  animatic: AnimaticSetupState,
  axisCuts: readonly AxisCut[],
): DirectionFinding[] {
  const byId = new Map(setups.map((setup) => [setup.id, setup]));
  const nested = new Set(axisCuts.flatMap((cut) => cut.chain));
  const deterministic = new Set(animatic.deterministicPlateIds);
  const accepted = new Set(animatic.acceptedPlateIds);
  const findings: DirectionFinding[] = [];
  for (const id of animatic.plateIds) {
    const setup = byId.get(id);
    if (setup === undefined || nested.has(id) || deterministic.has(id)) continue;
    const generated =
      (shotsPerSetup.get(id) ?? 0) - (animatic.deterministicShotsPerSetup.get(id) ?? 0);
    if (generated >= 2 || (generated === 1 && accepted.has(id))) continue;
    findings.push({
      code: "plate-unowed",
      subject: id,
      message:
        `setup "${id}" has a plate and ${generated === 1 ? "one generated shot" : "no generated shot"} ` +
        `— build from \`${placeRefOf(setup)}\``,
    });
  }
  return findings;
}

// A location the piece lives in and never returns to a frame of. A setup only one shot names owes no
// plate, so a place built out of one-offs has nothing pinning it: every shot there works from the
// location's `reference:<id>` alone, and a room re-invented that many times drifts.
// `setup-unrealized` catches the same disease from the other side — a shared frame with no plate —
// and is silent here by construction, which is what leaves this gap open.
//
// Read as a SHARE of the location's shots, not as a count of its setups: how many frames a place
// needs is a property of how much of the piece happens there, and a scene with four shots cannot
// both vary its sizes and reuse a frame. So it takes a place holding `ATOMIZED_LOCATION_SHOTS` shots
// and asks whether most of them stand on a frame some other shot stands on too. One shared setup in
// twenty is one plate and nineteen loose frames, which is the case a bare "nothing is shared" test
// would let through.
//
// Unused setups are excluded (`unused-setup` owns those). The count is of shots rather than generated
// shots: this reads the direction alone, so like `unused-setup` it fires on a pass with no board.
function checkAtomizedSetups(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
  judgedBy: ((setupId: string) => string[]) | undefined,
  generated: ((setupId: string) => number) | undefined,
): DirectionFinding[] {
  const byLocation = new Map<
    string,
    { shots: number; onShared: number; frames: number; drawn: number; panels: string[] }
  >();
  for (const setup of setups) {
    const shots = shotsPerSetup.get(setup.id) ?? 0;
    if (shots === 0) continue;
    const entry = byLocation.get(setup.location) ?? {
      shots: 0,
      onShared: 0,
      frames: 0,
      drawn: 0,
      panels: [],
    };
    byLocation.set(setup.location, entry);
    entry.shots += shots;
    entry.drawn += generated ? generated(setup.id) : shots;
    entry.panels.push(...(judgedBy?.(setup.id) ?? []));
    entry.frames += 1;
    if (shots >= 2) entry.onShared += shots;
  }
  const findings: DirectionFinding[] = [];
  for (const [location, { shots, onShared, frames, drawn, panels }] of [...byLocation].sort(
    (a, b) => a[0].localeCompare(b[0]),
  )) {
    if (shots < ATOMIZED_LOCATION_SHOTS || onShared * 2 >= shots || drawn === 0) continue;
    findings.push({
      code: "setup-atomized",
      subject: location,
      message:
        `location "${location}" holds ${shots} shots across ${frames} setups, ${onShared} of them ` +
        `on a shared frame — ${Math.ceil(shots / 2)} needed`,
      judgedBy: panels,
    });
  }
  return findings;
}

// The view images the reference stage files, as `<locationId>.<view>` (`reference:view.…`).
function viewImagesOf(referenceAssetNames: readonly string[] | undefined): Set<string> {
  return new Set(
    (referenceAssetNames ?? []).flatMap((name) => {
      const view = parseViewName(name);
      return view ? [`${view.location}.${view.view}`] : [];
    }),
  );
}

/**
 * What a fix names as the picture a setup stands on in its place: the image of the way it faces,
 * whether or not it exists yet, else the location's master.
 */
export function placeRefOf(setup: Pick<SetupRef, "location" | "view">): string {
  return setup.view && setup.view !== "front"
    ? `reference.view.${setup.location}.${setup.view}`
    : `reference.${setup.location}`;
}

// The setups a shot is taken on, and every wider frame one of them is a window of — a master no
// shot stands on is still what its windows' plates are cut out of.
export function usedSetupIds(
  setups: readonly Pick<SetupRef, "id" | "within">[],
  shotsPerSetup: ReadonlyMap<string, number>,
): Set<string> {
  const within = new Map(setups.map((s) => [s.id, s.within]));
  const used = new Set<string>();
  for (const [id, shots] of shotsPerSetup) {
    let next: string | null | undefined = shots > 0 ? id : undefined;
    while (typeof next === "string" && !used.has(next)) {
      used.add(next);
      next = within.get(next);
    }
  }
  return used;
}

// `animatic` is undefined when the board could not be read, in which case the whole class stays
// silent rather than reporting every setup as unrealized. `referenceAssetNames` carries the rosters'
// own contract: undefined = "the reference stage could not be read", so the anchor findings hold.
export function checkSetups(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
  animatic: AnimaticSetupState | undefined,
  referenceAssetNames: readonly string[] | undefined,
  axisCuts: readonly AxisCut[] = [],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const plates = animatic === undefined ? undefined : new Set(animatic.plateIds);
  const judgedBy =
    animatic === undefined
      ? undefined
      : (setupId: string): string[] =>
          [...(animatic.framePanels.get(setupId)?.values() ?? [])].flat();
  const generated =
    animatic === undefined
      ? undefined
      : (setupId: string): number =>
          (shotsPerSetup.get(setupId) ?? 0) -
          (animatic.deterministicShotsPerSetup.get(setupId) ?? 0);
  const unanchored = animatic === undefined ? undefined : new Set(animatic.unanchoredPlateIds);
  const unnested = animatic === undefined ? undefined : new Set(animatic.unnestedPlateIds);
  const anchored = referenceAssetNames === undefined ? undefined : new Set(referenceAssetNames);
  const viewImages = viewImagesOf(referenceAssetNames);
  const placeRef = placeRefOf;
  const hasOwnView = (setup: SetupRef): boolean =>
    setup.view === "front"
      ? (anchored?.has(setup.location) ?? false)
      : viewImages.has(`${setup.location}.${setup.view}`);
  const unviewed = animatic === undefined ? undefined : new Set(animatic.unviewedPlateIds);
  const shotsPerLocation = new Map<string, number>();
  for (const setup of setups) {
    const n = (shotsPerLocation.get(setup.location) ?? 0) + (shotsPerSetup.get(setup.id) ?? 0);
    shotsPerLocation.set(setup.location, n);
  }
  const used = usedSetupIds(setups, shotsPerSetup);
  for (const setup of setups) {
    const shots = shotsPerSetup.get(setup.id) ?? 0;
    if (shots === 0) {
      if (!used.has(setup.id)) {
        findings.push({
          code: "unused-setup",
          subject: setup.id,
          message: `setup "${setup.id}" is the setup of no shot, nor the \`within\` of one`,
        });
      }
      continue;
    }
    if (!plates) continue;
    const plated = plates.has(setup.id);
    const generated = shots - (animatic!.deterministicShotsPerSetup.get(setup.id) ?? 0);
    if (generated >= 2 && !plated) {
      findings.push({
        code: "setup-unrealized",
        subject: setup.id,
        message: `setup "${setup.id}" is shared by ${generated} generated shots but has no plate`,
        judgedBy: judgedBy!(setup.id),
      });
      continue;
    }
    const hasReference = anchored?.has(setup.location) ?? false;
    if (plated && hasReference && unanchored!.has(setup.id)) {
      findings.push({
        code: "plate-unanchored",
        subject: setup.id,
        message:
          `the plate for setup "${setup.id}" is built from no location reference — take ` +
          `\`${placeRef(setup)}\``,
      });
    }
    if (plated && hasOwnView(setup) && unviewed!.has(setup.id)) {
      findings.push({
        code: "plate-unviewed",
        subject: setup.id,
        message:
          `the plate for setup "${setup.id}" faces "${setup.view}" but stands on another view of ` +
          `"${setup.location}" — build from \`${placeRef(setup)}\``,
      });
    }
    const unviewedShots = plated ? [] : (animatic!.unviewedBy.get(setup.id) ?? []);
    if (!plated && hasOwnView(setup) && unviewedShots.length > 0) {
      findings.push({
        code: "plate-unviewed",
        subject: setup.id,
        message:
          `shot ${unviewedShots.map((id) => `"${id}"`).join(", ")} sits on setup "${setup.id}", ` +
          `which faces "${setup.view}", but its keyframe stands on another view of ` +
          `"${setup.location}" — build from \`${placeRef(setup)}\``,
      });
    }
    if (plated && setup.within && unnested!.has(setup.id)) {
      findings.push({
        code: "plate-unnested",
        subject: setup.id,
        message:
          `setup "${setup.id}" is within "${setup.within}", but its plate is neither a cut from ` +
          `\`plates.${setup.within}.image\` nor a window inside it`,
      });
    }
    const ignoring = plated || hasReference ? (animatic!.unconsumedBy.get(setup.id) ?? []) : [];
    if (ignoring.length > 0) {
      const shotList = ignoring.map((id) => `"${id}"`).join(", ");
      findings.push({
        code: "setup-unconsumed",
        subject: setup.id,
        message: plated
          ? `shot ${shotList} sits on setup "${setup.id}" but no keyframe is built from its plate — ` +
            `take \`plates.${setup.id}\``
          : `shot ${shotList} sits on setup "${setup.id}", which has no plate, but no keyframe is ` +
            `built from its location — take \`${placeRef(setup)}\`` +
            // One frame sees the place, so the reference can be that frame.
            (shotsPerLocation.get(setup.location) === 1
              ? `, or regenerate \`reference.${setup.location}\` to hold what the shot needs and ` +
                `show it as the keyframe`
              : ""),
        judgedBy: [...(animatic!.unconsumedPanels.get(setup.id) ?? [])],
      });
    }
  }
  findings.push(...checkAtomizedSetups(setups, shotsPerSetup, judgedBy, generated));
  // Board-gated like the three anchor findings: with no plates read there is nothing to be missing.
  if (plates) findings.push(...checkAxisCuts(axisCuts, plates, judgedBy!, generated!));
  if (animatic) findings.push(...checkUnowedPlates(setups, shotsPerSetup, animatic, axisCuts));
  if (animatic && referenceAssetNames !== undefined) {
    findings.push(...checkViews(setups, shotsPerSetup, viewImages, anchored!, animatic));
  }
  return findings;
}

// A way a used setup faces is owed an image of it, made from the location's master. `front` is the
// master itself. Keyed `<locationId>.<view>`.
function checkViews(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
  viewImages: ReadonlySet<string>,
  anchored: ReadonlySet<string>,
  animatic: AnimaticSetupState,
): DirectionFinding[] {
  const facing = new Map<string, string[]>();
  for (const setup of setups) {
    if (!setup.view || setup.view === "front" || (shotsPerSetup.get(setup.id) ?? 0) === 0) continue;
    const key = `${setup.location}.${setup.view}`;
    facing.set(key, [...(facing.get(key) ?? []), setup.id]);
  }
  const findings: DirectionFinding[] = [];
  for (const [key, ids] of [...facing].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (viewImages.has(key)) continue;
    const [location, view] = key.split(".") as [string, string];
    findings.push({
      code: "view-unrealized",
      subject: key,
      message:
        `setup ${ids.map((id) => `"${id}"`).join(", ")} ${ids.length === 1 ? "faces" : "face"} ` +
        `"${view}" in "${location}", which has no image of that view`,
    });
  }
  findings.push(...checkViewAnchors(animatic.unanchoredViews, anchored));
  return findings;
}

/**
 * `view-unanchored` over the view images `listViewAnchorGaps` names (`<locationId>.<view>`), held
 * back for a location with no master yet.
 */
export function checkViewAnchors(
  unanchoredViews: readonly string[],
  anchored: ReadonlySet<string>,
): DirectionFinding[] {
  return unanchoredViews.flatMap((key) => {
    const [location, view] = key.split(".") as [string, string];
    if (!anchored.has(location)) return [];
    return [
      {
        code: "view-unanchored" as const,
        subject: key,
        message:
          `the view image \`reference.view.${location}.${view}\` is built from no ` +
          `\`reference.${location}\``,
      },
    ];
  });
}

/**
 * One camera frame as the lineup checker reads it: the declarations, plus the place they are filed
 * under and the prose `lineup-missing` scans. A shot with a cutin arrives as two entries, its main
 * frame first; a graphic shot as its cutin alone. Asides never reach here — they declare none of it.
 */
export type LineupShot = {
  shotId: string;
  lane: PanelLane;
  // Resolved through the frame's setup. Undefined (an unknown setup, reported structurally) files
  // the frame under no place, so it neither reads nor writes an accumulated order.
  location: string | undefined;
  action: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  // Who enters and exits during the shot, absent at both ends.
  passing?: readonly string[];
  join?: ShotJoin;
  // The shot whose frame in this lane runs on from this one in one take (`join: "continuous"`,
  // where it is possible). This frame's last panel then answers for no `lineupTo`.
  continuedBy?: string;
  // A coverage shot's frame: its `lineup` is the opening, and where anyone stands after the model's
  // cuts is unknown.
  coverage?: true;
};

type FrameRef = Pick<LineupShot, "shotId" | "lane">;

// A frame as a finding or an error names it: the shot's own frame is the shot, a cutin is
// `<shotId>.cutin`, so a waiver written for one never silences the other.
export const frameSubject = (frame: FrameRef): string =>
  frame.lane === "cutin" ? `${frame.shotId}.cutin` : frame.shotId;
const frameName = (frame: FrameRef): string =>
  frame.lane === "cutin" ? `the cutin over shot ${frame.shotId}` : `shot ${frame.shotId}`;

/**
 * Where the composition plays a pinned take: `opensAt`/`closesAt` on the shot's clock, `from`/`to`
 * in the take's own seconds. `clipSec` is absent where the adapter declares no length, and then the
 * last frame cannot be located. Absent altogether where no `<Video>` plays the take directly.
 */
export type PinWindow = {
  address: string;
  shotSec: number;
  opensAt: number;
  closesAt: number;
  from: number;
  to: number;
  clipSec?: number;
  // Where in the take an end image lands (see `PinOccurrence.clip`).
  landsAt?: number;
  frameSec: number;
};

/**
 * One developed VIDEO shot's frame-pinning inputs, per lane — what `join-unpinned` reads. A shot the
 * video still leaves as a `pendingShot` is absent, so a seam it touches is not judged yet.
 */
export type VideoShotPins = {
  shotId: string;
  lane: PanelLane;
  // The ends this take actually pins, each with every address the pinned source's chain reaches —
  // the source itself, and the frame behind a wrapper such as a resize.
  pins: readonly {
    pin: "start" | "end";
    input?: string;
    reaches: readonly string[];
    window?: PinWindow;
    // The take's model also takes an unpinned image (`PinOccurrence.referable`).
    referable?: true;
    // The take the pin is an input of.
    take: string;
  }[];
  // The ends its adapter declares a slot for, wired or not — what says the take COULD carry a seam.
  slots: readonly ("start" | "end")[];
  // Every take of the frame with a pin slot.
  takes: readonly string[];
};

/**
 * One keyframe's `reference:<id>` inputs, in the order that panel's own call declares them — the
 * stage-side half of `slot-order-mismatch`. Panels of one lane arrive in panel order.
 */
export type PanelSlots = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  slots: readonly string[];
};

/**
 * One keyframe's reference REACH — every `reference:<id>` the chain behind that panel stands on, and
 * whether it generates at all. The stage-side half of `character-unconsumed`; panels of one lane
 * arrive in panel order.
 */
export type PanelReach = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  refs: readonly string[];
  generative: boolean;
};

function panelsByFrame<T extends { shotId: string; lane: PanelLane }>(
  panels: readonly T[],
): (frame: FrameRef) => T[] | undefined {
  const byFrame = new Map<string, T[]>();
  for (const panel of panels) {
    const key = `${panel.shotId}/${panel.lane}`;
    byFrame.set(key, [...(byFrame.get(key) ?? []), panel]);
  }
  return (frame) => byFrame.get(`${frame.shotId}/${frame.lane}`);
}

// "a is left of b", keyed so the pair reads the same however the two are ordered.
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

type PairState = Map<string, { left: string; source: string }>;

// Every ordered pair a lineup states, as edges of the accumulated order.
function lineupPairs(lineup: readonly string[]): { a: string; b: string; key: string }[] {
  const out: { a: string; b: string; key: string }[] = [];
  for (let i = 0; i < lineup.length; i++) {
    for (let j = i + 1; j < lineup.length; j++) {
      const a = lineup[i]!;
      const b = lineup[j]!;
      out.push({ a, b, key: pairKey(a, b) });
    }
  }
  return out;
}

function writePairs(state: PairState, lineup: readonly string[], shotId: string): void {
  for (const { a, key } of lineupPairs(lineup)) state.set(key, { left: a, source: shotId });
}

// A `lineupTo` states the frame the shot ENDS on, in full — so a subject the frame held at the start
// and not at the end has walked out of it, and where they now stand is not something this shot says.
// Their pairs go, and the next frame that holds them beside someone settles their place again.
function dropSubjects(state: PairState, gone: ReadonlySet<string>): void {
  for (const key of [...state.keys()]) {
    if (key.split("|").some((id) => gone.has(id))) state.delete(key);
  }
}

// The ids of one cycle in the accumulated order, or null. A cycle means the pairs cannot be laid out
// on a line at all — which is what a partial `lineupTo` produces when the camera came round and only
// two of the frame were re-declared.
function findCycle(state: PairState): string[] | null {
  const edges = new Map<string, string[]>();
  for (const [key, { left }] of state) {
    const [x, y] = key.split("|") as [string, string];
    const right = left === x ? y : x;
    edges.set(left, [...(edges.get(left) ?? []), right]);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const walk = (node: string): string[] | null => {
    if (done.has(node)) return null;
    if (visiting.has(node)) return path.slice(path.indexOf(node));
    visiting.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(node);
    done.add(node);
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return null;
}

// "is a left of b", read off the accumulated pairs. Unknown (the two have never shared a frame)
// answers false.
const isLeftOf = (state: PairState, a: string, b: string): boolean =>
  state.get(pairKey(a, b))?.left === a;

// Everyone the accumulated order has an opinion about, in this place.
function placedSubjects(state: PairState): string[] {
  const out = new Set<string>();
  for (const key of state.keys()) for (const id of key.split("|")) out.add(id);
  return [...out];
}

// Whoever the accumulated order puts strictly BETWEEN this frame's leftmost and rightmost subject.
// A frame runs from one edge to the other, so anything between two things it holds is inside it.
// Read off the OUTERMOST pair, not each neighbouring one: the span is what the frame covers, and a
// subject whose place beside the middle of the list was never declared is inside it all the same.
//
// A subject the accumulation has no pairs for stands nowhere, so it is never between anything — which
// is what a `lineupTo` leaving them out of the frame buys.
function skippedBetween(state: PairState, lineup: readonly string[]): string[] {
  if (lineup.length < 2) return [];
  const left = lineup[0]!;
  const right = lineup[lineup.length - 1]!;
  return placedSubjects(state).filter(
    (c) => !lineup.includes(c) && isLeftOf(state, left, c) && isLeftOf(state, c, right),
  );
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

// A frame, for a message. An empty one is a real frame — it holds nobody — so it is named.
const formatFrame = (lineup: readonly string[]): string =>
  lineup.length === 0 ? "a frame holding no one" : lineup.join(", ");

// A jump in either frame moves story time for the whole shot, so the places empty before its first
// frame is read.
function opensJump(shots: readonly LineupShot[], index: number): boolean {
  const shot = shots[index]!;
  if (index > 0 && shots[index - 1]!.shotId === shot.shotId) return false;
  let end = index;
  while (end < shots.length && shots[end]!.shotId === shot.shotId) end++;
  return shots.slice(index, end).some((b) => b.join === "jump-back" || b.join === "jump-forward");
}

// Returns the cycle the writes closed, after restarting the place from the order this frame leaves,
// so later shots do not report the same ring again.
function writeFrame(state: PairState, shot: LineupShot): string[] | null {
  writePairs(state, shot.lineup, shot.shotId);
  if (shot.lineupTo) {
    const exits = shot.lineupTo;
    dropSubjects(state, new Set(shot.lineup.filter((id) => !exits.includes(id))));
    writePairs(state, exits, shot.shotId);
  }
  const cycle = findCycle(state);
  if (cycle) {
    state.clear();
    writePairs(state, shot.lineupTo ?? shot.lineup, shot.shotId);
  }
  return cycle;
}

export type OffscreenFigure = { id: string; side: "left" | "right" };

/**
 * Who stands out of each frame and on which side, keyed `<shotId>/<lane>` — read off the same
 * per-place accumulation as `checkLineups`, at the frame's opening. A subject the place has placed,
 * last seen in this place, and not held by the frame is off screen on the side every pair it has
 * with a held subject puts it; one between two held subjects, or with no pair to a held one, is left
 * out, and so is every subject of a frame that flips the place's order. Both lanes of a shot read
 * before either writes: a cutin opens beside the main frame's opening, not its `lineupTo`.
 */
export function offscreenFigures(shots: readonly LineupShot[]): Map<string, OffscreenFigure[]> {
  const out = new Map<string, OffscreenFigure[]>();
  const byLocation = new Map<string, PairState>();
  const lastSeenIn = new Map<string, string>();
  const stateOf = (location: string): PairState => {
    const state = byLocation.get(location) ?? new Map();
    byLocation.set(location, state);
    return state;
  };
  for (let index = 0; index < shots.length; ) {
    if (opensJump(shots, index)) byLocation.clear();
    let end = index;
    while (end < shots.length && shots[end]!.shotId === shots[index]!.shotId) end++;
    const frames = shots.slice(index, end);
    index = end;

    for (const shot of frames) {
      if (shot.location === undefined) continue;
      const figures = readOffscreen(
        stateOf(shot.location),
        shot.lineup,
        (id) => lastSeenIn.get(id) === shot.location,
      );
      if (figures.length > 0) out.set(`${shot.shotId}/${shot.lane}`, figures);
    }
    for (const shot of frames) {
      if (shot.location === undefined) continue;
      writeFrame(stateOf(shot.location), shot);
      for (const id of [...shot.lineup, ...(shot.lineupTo ?? []), ...(shot.passing ?? [])]) {
        lastSeenIn.set(id, shot.location);
      }
      if (shot.coverage) byLocation.delete(shot.location);
    }
  }
  return out;
}

function readOffscreen(
  state: PairState,
  lineup: readonly string[],
  isHere: (id: string) => boolean,
): OffscreenFigure[] {
  const agrees = lineupPairs(lineup).every(({ a, key }) => (state.get(key)?.left ?? a) === a);
  if (!agrees) return [];
  return placedSubjects(state)
    .flatMap((id): OffscreenFigure[] => {
      if (lineup.includes(id) || !isHere(id)) return [];
      const sides = new Set(
        lineup.flatMap((held) => {
          const pair = state.get(pairKey(id, held));
          return pair ? [pair.left === id ? "left" : "right"] : [];
        }),
      );
      return sides.size === 1 ? [{ id, side: [...sides][0] as OffscreenFigure["side"] }] : [];
    })
    .sort((a, b) => (a.side === b.side ? 0 : a.side === "left" ? -1 : 1));
}

/**
 * The staging findings that read the direction's declared lineups, plus the two the board feeds when
 * the caller has it. Pure: the caller flattens the arc tree and resolves each shot's location.
 *
 * The state is one `Map` of pairs per LOCATION — "a is left of b", with the shot that said so. A
 * shot's `lineup` is checked against it, then written into it, then its `lineupTo` over that; a
 * `join` of `jump-back`/`jump-forward` empties every place, because given time people move anywhere,
 * and a coverage shot empties its own after its opening frame is read. There is no carry-over of
 * the LIST: each shot states only what its own frame holds, and the pairs are what remember.
 */
export function checkLineups(
  shots: readonly LineupShot[],
  options: {
    // The board's keyframe slot orders, in panel order. Undefined leaves `slot-order-mismatch` silent.
    panelSlots?: readonly PanelSlots[];
    // The board's keyframe reference reach, in panel order. Undefined leaves `character-unconsumed`
    // silent.
    panelReach?: readonly PanelReach[];
    // The keyframes that crop their setup's plate. Undefined leaves `plate-recropped` silent.
    plateRecrops?: readonly PlateRecrop[];
    // What `plate-recropped` names as the picture each setup stands on in its place (`placeRefOf`).
    placeRefs?: ReadonlyMap<string, string>;
    // The conditioning text behind each keyframe, in panel order. Undefined leaves `subject-unnamed`
    // silent.
    panelPrompts?: readonly PanelPrompts[];
    // The word a prompt calls each character by, keyed by roster id. Read only with `panelPrompts`.
    subjectPromptDepictions?: ReadonlyMap<string, string>;
    referenceAssetNames?: readonly string[];
  } = {},
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const byLocation = new Map<string, PairState>();

  for (const [index, shot] of shots.entries()) {
    if (opensJump(shots, index)) byLocation.clear();

    const subject = frameSubject(shot);
    const name = frameName(shot);

    // Read the previous frame's exit the way every other check does (`lineupTo ?? lineup`), so a
    // frame that ends where it began is not asked to restate it. The frame before it IN ITS OWN
    // LANE: a `continuous` only reaches here where that is the shot just before on the clock.
    const previous = shots
      .slice(0, index)
      .reverse()
      .find((b) => b.lane === shot.lane);
    if (shot.join === "continuous" && previous) {
      const seam = previous.lineupTo ?? previous.lineup;
      if (!sameOrder(seam, shot.lineup)) {
        findings.push({
          code: "join-lineup-mismatch",
          subject,
          message:
            `${name} runs on from ${frameName(previous)} in one take, but ${previous.shotId} leaves ` +
            `${formatFrame(seam)} and ${shot.shotId} opens on ${formatFrame(shot.lineup)}`,
        });
      }
    }

    if (shot.lineupTo && sameOrder(shot.lineup, shot.lineupTo)) {
      findings.push({
        code: "lineup-vacuous",
        subject,
        message: `${name} declares a \`lineupTo\` identical to its \`lineup\``,
      });
    }

    // One accumulation per place whichever frame reads it: a main frame and a wipe taken in the same
    // room are two claims about the same seating.
    if (shot.location === undefined) continue;
    const state = byLocation.get(shot.location) ?? new Map();
    byLocation.set(shot.location, state);

    const flipped = lineupPairs(shot.lineup).flatMap(({ a, b, key }) => {
      const held = state.get(key);
      return held && held.left !== a ? [{ a, b, source: held.source }] : [];
    });
    if (flipped.length > 0) {
      findings.push({
        code: "lineup-flipped",
        subject,
        message:
          `${name} puts ${flipped.map((f) => `${f.a} left of ${f.b}`).join(", ")} in ` +
          `"${shot.location}", the other way round from ${[...new Set(flipped.map((f) => `shot ${f.source}`))].join(", ")}`,
      });
    }

    // Only where the order itself still holds: a flipped pair means the accumulation and this frame
    // already disagree about the axis, and betweenness read off it would name the wrong body.
    const skipped = flipped.length === 0 ? skippedBetween(state, shot.lineup) : [];
    if (skipped.length > 0) {
      findings.push({
        code: "lineup-gap",
        subject,
        message:
          `${name} frames ${shot.lineup[0]} to ${shot.lineup[shot.lineup.length - 1]}, but ` +
          `"${shot.location}" puts ${skipped.join(", ")} between them`,
      });
    }

    const cycle = writeFrame(state, shot);
    if (cycle) {
      findings.push({
        code: "lineup-inconsistent",
        subject,
        message:
          `after ${name} the order in "${shot.location}" cannot be laid out on a line: ` +
          `${cycle.join(" → ")} → ${cycle[0]}`,
      });
    }
    if (shot.coverage) byLocation.delete(shot.location);
  }

  if (options.panelSlots) findings.push(...checkSlotOrder(shots, options.panelSlots));
  if (options.panelReach) {
    findings.push(
      ...checkCharacterAnchors(shots, options.panelReach, options.referenceAssetNames ?? []),
    );
  }
  if (options.plateRecrops) {
    findings.push(...checkPlateRecrops(options.plateRecrops, options.placeRefs));
  }
  if (options.panelPrompts) {
    findings.push(
      ...checkSubjectNaming(
        shots,
        options.panelPrompts,
        options.subjectPromptDepictions ?? new Map(),
      ),
    );
  }
  return findings;
}

/**
 * Each character's route through the places, walked in direction order: a frame putting them back
 * in a place they left, with no jump since, is `location-backtrack`. Read per frame, so a cutaway
 * holding someone else, or no one, moves nobody. A jump in either frame of a shot clears every route.
 */
export function checkRoutes(shots: readonly LineupShot[]): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const routes = new Map<string, { at: string; lastShot: string; left: Map<string, string> }>();

  for (const [index, shot] of shots.entries()) {
    if (index === 0 || shots[index - 1]!.shotId !== shot.shotId) {
      const frames = shots.filter((b) => b.shotId === shot.shotId);
      if (frames.some((b) => b.join === "jump-back" || b.join === "jump-forward")) routes.clear();
    }
    if (shot.location === undefined) continue;

    for (const id of new Set([...shot.lineup, ...(shot.passing ?? []), ...(shot.lineupTo ?? [])])) {
      const route = routes.get(id);
      if (!route) {
        routes.set(id, { at: shot.location, lastShot: shot.shotId, left: new Map() });
        continue;
      }
      if (route.at !== shot.location) {
        const leftAfter = route.left.get(shot.location);
        if (leftAfter !== undefined) {
          findings.push({
            code: "location-backtrack",
            subject: `${frameSubject(shot)}.${id}`,
            message:
              `${frameName(shot)} puts ${id} back in "${shot.location}", which they left after ` +
              `shot ${leftAfter}`,
          });
        }
        route.left.set(route.at, route.lastShot);
        route.at = shot.location;
      }
      route.lastShot = shot.shotId;
    }
  }
  return findings;
}

// The seam a `continuous` join declares is ONE frame: the opening keyframe of the shot that owns the
// boundary. The take before it has to pin its end to that frame. Nothing is demanded of the take
// after.
//
// Judged where the take before is developed and the board holds the shot's opening keyframe — the
// take after need not exist yet, so the demand lands before the take before is spent on. A model
// with no end slot has no wiring to forget, so the seam is silent rather than uniformly waived —
// the same line `panel-unlinked` draws (see `checkPanelLinks`).
export function checkJoinPins(
  shots: readonly LineupShot[],
  videoPins: readonly VideoShotPins[],
  shotPanels: readonly ShotPanels[],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const pinsOf = new Map(videoPins.map((s) => [`${s.shotId}/${s.lane}`, s]));
  const panelsOf = new Map(shotPanels.map((s) => [`${s.shotId}/${s.lane}`, s]));
  for (const [index, shot] of shots.entries()) {
    if (shot.join !== "continuous") continue;
    // The frame before in the same lane — a `continuous` only reaches here where that is the shot
    // just before on the clock.
    const previous = shots
      .slice(0, index)
      .reverse()
      .find((b) => b.lane === shot.lane);
    if (!previous) continue;
    const before = pinsOf.get(`${previous.shotId}/${previous.lane}`);
    const seam = panelsOf.get(`${shot.shotId}/${shot.lane}`)?.firstPanel;
    if (seam === undefined) continue;
    const after = pinsOf.get(`${shot.shotId}/${shot.lane}`);
    const judgedBy = [
      formatCompositionAddress("video", previous.shotId),
      formatCompositionAddress("video", shot.shotId),
      ...(before?.takes ?? []),
      ...(after?.takes ?? []),
    ];
    findings.push(...checkSeamWindows(previous, shot, seam, before, after, judgedBy));
    if (!before) continue;
    if (!before.slots.includes("end")) continue;
    if (before.pins.some((p) => p.pin === "end" && p.reaches.includes(seam))) continue;
    const pinned = before.pins.find((p) => p.pin === "end");
    // The frame behind a wrapper declared in video.tsx, where there is one.
    const pinnedFrame = pinned?.reaches.find((a) => !a.startsWith("video:")) ?? pinned?.reaches[0];
    const takes = shot.lane === "cutin" ? "cutin takes" : "takes";
    findings.push({
      code: "join-unpinned",
      subject: frameSubject(shot),
      message:
        `${frameName(previous)} and ${frameName(shot)} are one take, and the ${takes} of ` +
        `${formatShotAddress("video", previous.shotId)} ` +
        (pinnedFrame === undefined
          ? `pins nothing at its end`
          : `pins its end to another frame (${pinnedFrame})`) +
        ` — pin it to \`${seam}\``,
      judgedBy,
    });
  }
  return findings;
}

// A frame boarded on one keyframe is its key unless it runs on from the frame before.
export function checkKeyPins(
  shots: readonly LineupShot[],
  videoPins: readonly VideoShotPins[],
  shotPanels: readonly ShotPanels[],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const pinsOf = new Map(videoPins.map((s) => [`${s.shotId}/${s.lane}`, s]));
  const panelsOf = new Map(shotPanels.map((s) => [`${s.shotId}/${s.lane}`, s]));
  for (const shot of shots) {
    if (shot.join === "continuous") continue;
    const panels = panelsOf.get(`${shot.shotId}/${shot.lane}`);
    if (!panels || panels.firstPanel !== panels.lastPanel) continue;
    const key = panels.firstPanel;
    const opening = pinsOf
      .get(`${shot.shotId}/${shot.lane}`)
      ?.pins.filter((p) => p.pin === "start" && p.referable && p.reaches.includes(key));
    if (!opening || opening.length === 0) continue;
    const inputs = [...new Set(opening.flatMap((p) => (p.input ? [`\`${p.input}\``] : [])))];
    const takes = shot.lane === "cutin" ? "cutin take" : "take";
    findings.push({
      code: "opening-key",
      subject: frameSubject(shot),
      message:
        `the ${takes} of ${formatShotAddress("video", shot.shotId)} opens on ${frameName(shot)}'s key \`${key}\`` +
        `${inputs.length > 0 ? ` (${inputs.join(", ")})` : ""}`,
      judgedBy: opening.map((p) => p.take),
    });
  }
  return findings;
}

// A seam pinned on both takes is one frame only if the composition plays it: the take before has to
// close the shot on its last frame, the take after has to open the shot on its first. A `mediaStart`
// or a `duration` that moves either off it turns the seam back into a jump.
function checkSeamWindows(
  previous: FrameRef,
  shot: FrameRef,
  seam: string,
  before: VideoShotPins | undefined,
  after: VideoShotPins | undefined,
  judgedBy: readonly string[],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  // The take before cuts on its landing: the next shot opens on the landing frame, or the shot ends
  // showing it. A workflow that anchors the image at the frame past the shot lands it there when the
  // take plays from its head; one pinned to its last frame, when the take plays to its end.
  const landing = before?.pins.find((p) => p.pin === "end" && p.reaches.includes(seam))?.window;
  if (landing?.landsAt !== undefined) {
    const tol = landing.frameSec;
    const endsShot = landing.closesAt >= landing.shotSec - tol;
    const onLanding =
      landing.to >= landing.landsAt - tol && landing.to <= landing.landsAt + landing.frameSec + tol;
    if (!endsShot || !onLanding) {
      const played = landing.closesAt - landing.opensAt;
      const start = Math.max(0, landing.landsAt - played);
      findings.push({
        code: "join-unshown",
        subject: frameSubject(shot),
        judgedBy,
        message:
          `${frameName(previous)} and ${frameName(shot)} are one take, and ${landing.address} lands ` +
          `on the seam \`${seam}\` ${formatSeconds(landing.landsAt, 2)} in — but ${frameName(previous)} plays ` +
          `${formatSecondsRange(landing.from, landing.to, 2)} of it` +
          (endsShot
            ? ""
            : `, ending ${formatSeconds(landing.shotSec - landing.closesAt, 2)} before the shot does`) +
          ` — play it with \`mediaStart={${Number(start.toFixed(3))}}\` for the ` +
          `${formatSeconds(played, 2)} window`,
      });
    }
  }

  const opening = after?.pins.find((p) => p.pin === "start" && p.reaches.includes(seam))?.window;
  if (opening) {
    const tol = opening.frameSec;
    if (opening.opensAt > tol || opening.from > tol) {
      findings.push({
        code: "join-unshown",
        subject: frameSubject(shot),
        judgedBy,
        message:
          `${frameName(previous)} and ${frameName(shot)} are one take, and ${opening.address} opens on ` +
          `the seam \`${seam}\` at its first frame — but ${frameName(shot)} ` +
          (opening.from > tol
            ? `starts it ${formatSeconds(opening.from, 2)} in (\`mediaStart\`)`
            : `does not start it until ${formatSeconds(opening.opensAt, 2)}`),
      });
    }
  }
  return findings;
}

/**
 * The conditioning text one keyframe stands on — the panel's own positive prompts and those of every
 * step behind it. Built by the CLI off the board and handed in, like `PanelSlots`.
 */
export type PanelPrompts = {
  shotId: string;
  lane: PanelLane;
  panel: string;
  texts: readonly string[];
  // False when nothing in the chain generates — a `file` keyframe has no prompt to name anyone in.
  generative: boolean;
};

// A declared noun is looked for as itself, case-blind and anywhere in the text: "desk" is named by
// "the desk" and by "a wooden desk", and a prompt that opens on a subject and goes on with "she" has
// named them. Where the noun sits, and whether it sits on the side the frame declares, is what the
// critic reads the printed `lineup:`/`set:` lines against.
const namesIn = (texts: readonly string[], promptDepiction: string): boolean => {
  const needle = promptDepiction.trim().toLowerCase();
  if (needle === "") return false;
  return texts.some((text) => text.toLowerCase().includes(needle));
};

// A subject the frame holds, against the words the keyframe drawing that frame was conditioned on.
// The twin of `character-unconsumed`: that one asks whether the reference picture was passed in,
// this one whether the text calls them by the name the direction declared — a model handed three
// sheets and told about one of them decides the other two for itself.
//
// Same panel rule as its twin — the first panel answers for the `lineup`, the last for the
// `lineupTo`, a one-panel shot for its `lineup` alone — and the same exemptions: a panel that
// generates nothing has no prompt to name anyone in, and an undeveloped shot has no panel. The text
// is read down the whole chain behind the panel, so a keyframe cut from an earlier one passes on the
// naming that one did.
//
// One finding per subject, keyed `<shotId>.<characterId>` (`<shotId>.cutin.<characterId>` for a
// wipe), so a shot-wide waiver cannot swallow the next subject added beside the one it was written
// for.
function checkSubjectNaming(
  shots: readonly LineupShot[],
  panelPrompts: readonly PanelPrompts[],
  promptDepictions: ReadonlyMap<string, string>,
): DirectionFinding[] {
  const panelsOf = panelsByFrame(panelPrompts);
  const findings: DirectionFinding[] = [];
  for (const shot of shots) {
    const panels = panelsOf(shot);
    if (!panels || panels.length === 0) continue;
    const against: { panel: PanelPrompts; order: readonly string[] }[] = [
      { panel: panels[0]!, order: shot.lineup },
    ];
    if (shot.lineupTo && panels.length > 1 && shot.continuedBy === undefined) {
      against.push({ panel: panels[panels.length - 1]!, order: shot.lineupTo });
    }
    const missing = new Map<string, string[]>();
    for (const { panel, order } of against) {
      if (!panel.generative) continue;
      for (const id of order) {
        const promptDepiction = promptDepictions.get(id);
        // An id no roster answers to is `lineup-unknown-id`, a structural error; a blank
        // `promptDepiction` is `character-empty-prompt-depiction`. Neither is this finding's to
        // repeat.
        if (promptDepiction === undefined || promptDepiction.trim() === "") continue;
        if (namesIn(panel.texts, promptDepiction)) continue;
        missing.set(id, [...(missing.get(id) ?? []), panel.panel]);
      }
    }
    for (const [id, panels] of missing) {
      findings.push({
        code: "subject-unnamed",
        subject: `${frameSubject(shot)}.${id}`,
        message:
          `${frameName(shot)} frames "${id}" but no prompt behind the keyframe holding them contains ` +
          `"${promptDepictions.get(id)}"`,
        judgedBy: panels,
      });
    }
  }
  return findings;
}

export type PropNamingRef = { id: string; name: string; promptDepiction: string };

// A prop a shot's `action` names, against the words its keyframes were conditioned on — the prop's
// twin of `subject-unnamed`. No frame declares which props it holds, so the `action` is the
// declaration: the same scan `unused-prop` makes. Any one keyframe of the shot, in either lane,
// answers for it. A shot with no developed panel, or none that generates, has no prompt to name it
// in. Keyed `<shotId>.<propId>`.
export function checkPropNaming(
  shots: readonly { id: string; action: string }[],
  panelPrompts: readonly PanelPrompts[],
  shownReferences: Readonly<Record<string, readonly string[]>>,
  props: readonly PropNamingRef[],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const shot of shots) {
    const panels = panelPrompts.filter((p) => p.shotId === shot.id && p.generative);
    if (panels.length === 0) continue;
    const texts = panels.flatMap((p) => p.texts);
    const shown = shownReferences[shot.id] ?? [];
    for (const prop of props) {
      if (prop.name.trim() === "" || prop.promptDepiction.trim() === "") continue;
      if (!shot.action.includes(prop.name)) continue;
      if (shown.includes(prop.id)) continue;
      if (namesIn(texts, prop.promptDepiction)) continue;
      findings.push({
        code: "prop-unnamed",
        subject: `${shot.id}.${prop.id}`,
        message:
          `shot ${shot.id}'s action names "${prop.name}" but no prompt behind its keyframes contains ` +
          `"${prop.promptDepiction}"`,
        judgedBy: panels.map((p) => p.panel),
      });
    }
  }
  return findings;
}

/**
 * One developed board shot as the seam check reads it. Built by the CLI off the board and handed in,
 * like `PanelSlots`.
 */
export type ShotPanels = {
  shotId: string;
  // Each lane is its own camera, so a shot with a cutin answers two seams.
  lane: PanelLane;
  // The keyframe this shot opens on (the seam of a long take), and the one the next shot cuts from.
  firstPanel: string;
  lastPanel: string;
  // The opening keyframe's model reads a previous panel as the frame it cuts from.
  carries: boolean;
  // Every address the previous panel it was handed reaches.
  linked: readonly string[];
};

/**
 * One boundary a frame has to carry across, as the board answered it.
 */
export type PanelSeam = {
  // The shot the cut lands in — the one that owns the boundary, as `join` does.
  id: string;
  lane: PanelLane;
  // The shot before it, and the keyframe it ends on.
  from: string;
  fromPanel: string;
  // Every address this shot's opening keyframe was handed of the frame it cuts from.
  linked: readonly string[];
  // This shot's opening keyframe.
  opening: string;
};

// The frame a seam's opening keyframe was not handed. Only seams whose opening keyframe's model
// READS a previous panel reach here.
function checkSeamLinks(
  seams: readonly PanelSeam[],
  code: "panel-unlinked" | "return-unlinked",
): DirectionFinding[] {
  return seams.flatMap((seam) => {
    if (seam.linked.includes(seam.fromPanel)) return [];
    const frame = seam.lane === "cutin" ? `the cutin over shot ${seam.id}` : `shot ${seam.id}`;
    const took = seam.linked.length === 0 ? "takes no frame" : "cuts from another frame";
    return [
      {
        code,
        subject: `${seam.from}-${seam.id}${seam.lane === "cutin" ? ".cutin" : ""}`,
        message: `${frame}'s opening keyframe ${took} — pass \`${seam.fromPanel}\``,
        judgedBy: [seam.opening],
      },
    ];
  });
}

// The frame across a cut along one camera axis — a push in or out along `within`: a keyframe drawn
// without the one before it re-invents the subject's light, size and place in the room.
export function checkPanelLinks(seams: readonly PanelSeam[]): DirectionFinding[] {
  return checkSeamLinks(seams, "panel-unlinked");
}

// The frame a cutaway cuts back to (see `frameReturns`).
export function checkReturnLinks(seams: readonly PanelSeam[]): DirectionFinding[] {
  return checkSeamLinks(seams, "return-unlinked");
}

/**
 * A landmark a frame holds, with the place that declares it and the noun it is asked for by.
 */
export type HeldLandmark = { id: string; location: string; promptDepiction: string };

/**
 * One plated setup read for its own generation: the positive prompts its plate is generated with,
 * and the landmarks that frame declares it carries. Assembled by the caller from the direction and
 * the board.
 */
export type PlateNaming = {
  setupId: string;
  texts: readonly string[];
  holds: readonly HeldLandmark[];
};

// Reported per landmark, keyed `<setupId>.<landmarkId>`.
export function checkPlateNaming(namings: readonly PlateNaming[]): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const naming of namings) {
    for (const landmark of naming.holds) {
      if (landmark.promptDepiction.trim() === "") continue;
      if (namesIn(naming.texts, landmark.promptDepiction)) continue;
      findings.push({
        code: "plate-unnamed",
        subject: `${naming.setupId}.${landmark.id}`,
        message:
          `the prompt plate "${naming.setupId}" is generated with does not say ` +
          `"${landmark.promptDepiction}", which its \`holds\` declares the frame carries`,
        judgedBy: [formatPlateAddress(naming.setupId)],
      });
    }
  }
  return findings;
}

/**
 * The image one view of a location stands on — `reference:<location>` for `front`, its view image
 * for the rest.
 */
export type ViewNaming = {
  location: string;
  view: View;
  image: string;
  texts: readonly string[];
  holds: readonly (HeldLandmark & { setups: readonly string[] })[];
};

// Reported per landmark, keyed `<locationId>.<view>.<landmarkId>`.
export function checkViewNaming(namings: readonly ViewNaming[]): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const naming of namings) {
    for (const landmark of naming.holds) {
      if (landmark.promptDepiction.trim() === "") continue;
      if (namesIn(naming.texts, landmark.promptDepiction)) continue;
      const setups = landmark.setups.map((id) => `"${id}"`).join(", ");
      findings.push({
        code: "view-unnamed",
        subject: `${naming.location}.${naming.view}.${landmark.id}`,
        message:
          `the prompt \`${naming.image}\` is generated with does not say ` +
          `"${landmark.promptDepiction}", which setup ${setups} facing "${naming.view}" ` +
          `${landmark.setups.length === 1 ? "holds" : "hold"}`,
        judgedBy: [naming.image],
      });
    }
  }
  return findings;
}

/**
 * One frame on a setup with no plate, read for the landmarks it holds. Assembled by the caller from
 * the direction and the board.
 */
export type LandmarkFrame = {
  shotId: string;
  lane: PanelLane;
  holds: readonly HeldLandmark[];
};

// Read only on a setup with no plate. Every panel whose chain reads a prompt answers, its text read
// down that whole chain.
//
// One finding per landmark, keyed `<shotId>.<landmarkId>` (`<shotId>.cutin.<landmarkId>` for a
// wipe).
export function checkLandmarkNaming(
  frames: readonly LandmarkFrame[],
  panelPrompts: readonly PanelPrompts[],
): DirectionFinding[] {
  const panelsOf = panelsByFrame(panelPrompts);
  const findings: DirectionFinding[] = [];
  for (const frame of frames) {
    const panels = (panelsOf(frame) ?? []).filter(
      (panel) => panel.generative && panel.texts.length > 0,
    );
    for (const landmark of frame.holds) {
      if (landmark.promptDepiction.trim() === "") continue;
      const lacking = panels.filter((panel) => !namesIn(panel.texts, landmark.promptDepiction));
      if (lacking.length === 0) continue;
      findings.push({
        code: "landmark-unnamed",
        subject: `${frameSubject(frame)}.${landmark.id}`,
        message:
          `${frameName(frame)} holds "${landmark.id}" but a keyframe drawing it has no prompt ` +
          `containing "${landmark.promptDepiction}"`,
        judgedBy: lacking.map((panel) => panel.panel),
      });
    }
  }
  return findings;
}

/**
 * One setup as the landmark accumulation reads it: the place it is set in, and what its frame holds
 * left to right.
 */
export type HoldsSetupRef = { id: string; location: string; holds: readonly string[] };

// The `lineup-flipped` of things that do not move. A landmark's screen position is a property of the
// camera, not of a shot, so this reads the setups roster alone: every frame of one place is a claim
// about the same axis, and two frames disagreeing about which side the desk is on means one of them
// crossed the set's line. An intended reverse angle is exactly what the waiver is for.
export function checkLandmarkOrder(setups: readonly HoldsSetupRef[]): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const byLocation = new Map<string, PairState>();
  // By id, not in roster order: a roster is a set (its record order moves no hash), so which frame a
  // pair is blamed against — and therefore which waiver key answers for it — must not change when the
  // author reorders the record.
  for (const setup of [...setups].sort((a, b) => a.id.localeCompare(b.id))) {
    const state = byLocation.get(setup.location) ?? new Map();
    byLocation.set(setup.location, state);
    const flipped = lineupPairs(setup.holds).flatMap(({ a, b, key }) => {
      const held = state.get(key);
      return held && held.left !== a ? [{ a, b, source: held.source }] : [];
    });
    if (flipped.length > 0) {
      findings.push({
        code: "landmark-flipped",
        subject: setup.id,
        message:
          `setup "${setup.id}" holds ${flipped.map((f) => `${f.a} left of ${f.b}`).join(", ")} in ` +
          `"${setup.location}", the other way round from ${[...new Set(flipped.map((f) => `setup "${f.source}"`))].join(", ")}`,
      });
    }
    // The first frame to state a pair fixes the place's axis and nothing rewrites it — a landmark
    // does not move, so unlike a shot's lineup there is no later truth to accumulate. Overwriting
    // would make one waived reverse angle report every frame after it, each needing a waiver of its
    // own for agreeing with the original.
    for (const { a, key } of lineupPairs(setup.holds)) {
      if (!state.has(key)) state.set(key, { left: a, source: setup.id });
    }
  }
  return findings;
}

/**
 * A keyframe on a plated setup that crops the plate on its way in. Built by the CLI off the board
 * and handed in, like `PanelSlots`.
 */
export type PlateRecrop = {
  setupId: string;
  shotId: string;
  lane: PanelLane;
  panel: string;
};

// Reported per frame: the shot is what has to move onto a setup of its own.
function checkPlateRecrops(
  recrops: readonly PlateRecrop[],
  placeRefs: ReadonlyMap<string, string> = new Map(),
): DirectionFinding[] {
  const byFrame = new Map<string, PlateRecrop[]>();
  for (const recrop of recrops) {
    const subject = frameSubject(recrop);
    byFrame.set(subject, [...(byFrame.get(subject) ?? []), recrop]);
  }
  return [...byFrame].map(([subject, [first, ...rest]]) => {
    const all = [first!, ...rest];
    const panels = all.map((r) => `\`${r.panel}\``).join(", ");
    const setupId = first!.setupId;
    return {
      code: "plate-recropped" as const,
      subject,
      message:
        `${frameName(first!)} crops plate "${setupId}" in ` +
        `${panels} — its own setup stands on a crop of ` +
        `\`${placeRefs.get(setupId) ?? "reference.<location>"}\``,
      judgedBy: all.map((r) => r.panel),
    };
  });
}

// The keyframe's reference slots against the order the shot declares. The first panel answers for
// the `lineup`, the last for the `lineupTo`; what a middle panel holds is nothing the direction
// states, so it is the critic's. Reported once per shot — the waiver is the shot's.
//
// A shot with ONE panel answers for its `lineup` alone: the single keyframe is the frame the shot
// opens on, and the order it ends on is carried by that panel's `blocking` into a picture no
// keyframe holds. Holding that one panel to both would demand two orders of one call. A shot the
// next shot runs on from in one take is the same case: the frame it ends on is that shot's opening
// keyframe, read there against the `lineup` the seam makes equal.
function checkSlotOrder(
  shots: readonly LineupShot[],
  panelSlots: readonly PanelSlots[],
): DirectionFinding[] {
  const panelsOf = panelsByFrame(panelSlots);
  const findings: DirectionFinding[] = [];
  for (const shot of shots) {
    const panels = panelsOf(shot);
    if (!panels || panels.length === 0) continue;
    const against: { panel: PanelSlots; order: readonly string[] }[] = [];
    if (shot.lineup) against.push({ panel: panels[0]!, order: shot.lineup });
    if (shot.lineupTo && panels.length > 1 && shot.continuedBy === undefined) {
      against.push({ panel: panels[panels.length - 1]!, order: shot.lineupTo });
    }
    const mismatches = against.flatMap(({ panel, order }) => {
      // Only the subjects the order names: a panel also conditions on the place and on anchors the
      // lineup has no opinion about, and those sit anywhere among the slots.
      const slots = [...new Set(panel.slots)].filter((id) => order.includes(id));
      if (slots.length < 2) return [];
      const expected = order.filter((id) => slots.includes(id));
      return sameOrder(slots, expected) ? [] : [{ panel, slots, expected }];
    });
    if (mismatches.length === 0) continue;
    findings.push({
      code: "slot-order-mismatch",
      subject: frameSubject(shot),
      message: mismatches
        .map(
          (m) =>
            `${m.panel.panel} passes its reference images as ${m.slots.join(", ")}, but ` +
            `${frameName(shot)} declares the frame as ${m.expected.join(", ")} left to right`,
        )
        .join("; "),
      judgedBy: mismatches.map((m) => m.panel.panel),
    });
  }
  return findings;
}

// A subject the frame holds, against the references the keyframe drawing that frame stands on. The
// twin of `slot-order-mismatch`: that one reads the ORDER a panel passes its references in, this one
// whether it passes them at all. Same panel rule — the first answers for the `lineup`, the last for
// the `lineupTo`, and a one-panel shot answers for its `lineup` alone.
//
// Three cases sit outside it: a panel that generates nothing has no input to pass a reference as; a
// character with no `reference:<id>` is already `character-unreferenced`; an undeveloped shot has no
// panel to read.
//
// One finding per subject rather than per shot — a shot-wide waiver would swallow the next subject
// added beside the one it was written for.
function checkCharacterAnchors(
  shots: readonly LineupShot[],
  panelReach: readonly PanelReach[],
  referenceAssetNames: readonly string[],
): DirectionFinding[] {
  const anchored = new Set(referenceAssetNames);
  const panelsOf = panelsByFrame(panelReach);
  const findings: DirectionFinding[] = [];
  for (const shot of shots) {
    const panels = panelsOf(shot);
    if (!panels || panels.length === 0) continue;
    const against: { panel: PanelReach; order: readonly string[] }[] = [
      { panel: panels[0]!, order: shot.lineup },
    ];
    if (shot.lineupTo && panels.length > 1 && shot.continuedBy === undefined) {
      against.push({ panel: panels[panels.length - 1]!, order: shot.lineupTo });
    }
    const missing = new Map<string, string[]>();
    for (const { panel, order } of against) {
      if (!panel.generative) continue;
      for (const id of order) {
        if (!anchored.has(id) || panel.refs.includes(id)) continue;
        missing.set(id, [...(missing.get(id) ?? []), panel.panel]);
      }
    }
    for (const [id, panels] of missing) {
      findings.push({
        code: "character-unconsumed",
        subject: `${frameSubject(shot)}.${id}`,
        message:
          `${frameName(shot)} frames "${id}" but the keyframe holding them is built from no reference ` +
          `to them`,
        judgedBy: panels,
      });
    }
  }
  return findings;
}
