// The generic arc types and their checker. Deliberately free of any DSL/runtime import so the
// doctor, the generate gate, and unit tests can pull it in standalone. `checkArc` is the single
// engine reused at every scale of the arc tree (a run of shots, a run of sequences, a run of runs);
// it is generic over `Role`. A role is a plain string scoped to its lens — each lens declares its
// own roles and each carries the dramatic `fn` the theory checks read, so there is no global role
// vocabulary or function map; the engine reads `fn` off the matched role.

import { formatSeconds, formatSecondsRange } from "./format-duration.js";

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
  // The shot's framing token (kept an opaque string so this engine stays DSL-free). Present only at
  // leaf scale — a branch item carries none, so the space checks skip branches naturally.
  framing?: string;
  // The shot's location id (opaque, like `framing`). Present only at leaf scale, so the space
  // checks skip branches naturally.
  location?: string;
  // The boundary into this item (opaque, like `framing`). Only `"continuous"` is read here, and only
  // by the re-established wide.
  join?: string;
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
  maxConsecutive?: number;
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
  | "too-many-consecutive"
  | "too-few-consecutive"
  | "empty-synopsis"
  | "unearned-payoff"
  | "unrealized"
  | "stage-order-mismatch"
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
  | "unused-setup"
  // The roster read as a whole rather than one entry at a time: two frames of one place nothing
  // distinguishes.
  | "setup-indistinct"
  | "unexpected-script"
  | "multi-sentence-action"
  | "off-grid-duration"
  | "re-established-wide"
  | "fonts-undeclared"
  // The staging class: who the frame holds, left to right, declared per shot and accumulated per
  // place. Four settle a RELATION between two subjects across two shots; the three the board feeds
  // settle the declared frame against what the keyframe was conditioned on — who it took
  // (`character-unconsumed`), where it stands (`location-unconsumed`) and in what order
  // (`slot-order-mismatch`).
  | "lineup-flipped"
  | "lineup-gap"
  | "lineup-vacuous"
  | "lineup-inconsistent"
  | "character-unconsumed"
  | "location-unconsumed"
  | "slot-order-mismatch"
  // The seam a `continuous` join declares: one take across a shot boundary, so the frame at the end
  // of the one and the start of the next is a single frame — the opening keyframe of the shot that
  // owns the boundary. The two shots must agree on who it holds, and the take before must land on
  // it.
  | "join-lineup-mismatch"
  | "join-unpinned"
  // The seam frame is pinned, and the composition's window over the take leaves it out.
  | "join-unshown"
  // `landmark-flipped` is the `lineup-flipped` of things that do not move, read across the setups of
  // one place; `subject-unnamed` is the naming twin of `character-unconsumed` — that one asks whether
  // the picture was passed in, this one whether the text calls it by the name the direction declared.
  | "landmark-flipped"
  | "subject-unnamed"
  // The song's: the song the piece is cut to is not a reference asset, and a lyric line no reading
  // of the take places.
  | "song-unreferenced"
  | "lyric-unplaced"
  // The timeline runs on past the end of the take of the song.
  | "song-overrun";

export type DirectionFinding = {
  code: DirectionFindingCode;
  // role / shot id / id-range, depending on the code; omitted for no-payoff and stage-order-mismatch.
  subject?: string;
  // The field path of the arc node the finding fired on — `["sequence"]` at the root, one
  // `["sequences", <id>]` pair deeper per level (the same path its review address is built from).
  // The engine itself is path-blind; the caller that walks the tree stamps it.
  path?: readonly string[];
  message: string;
};

export type CheckArcOptions = {
  // The stage's realized id order; enables the stage-coverage checks (unrealized / order).
  realizedIds?: readonly string[];
  // The ids coverage is measured over, in direction order — defaults to `items`. They come apart at
  // leaf scale, where `items` holds the narrative shots only: an aside is absent from every check
  // that reads a role, a framing or an adjacency, and present in these two.
  coverageIds?: readonly string[];
  // The scale's item word woven into messages ("shot" for a run of shots, "sequence" for a run of
  // sequences) so the same engine reads naturally at every scale — the finding *codes* stay identical.
  noun?: string;
  // The author's word for an item's descriptive prose, woven into the empty-text message: "action"
  // at leaf scale, "synopsis" at branch scale. Defaults to "synopsis".
  textLabel?: string;
  // The framing vocabulary the space check reads (framing stays opaque to this engine; the caller
  // supplies the word). `establishingFraming` is the size that opens a whole set. Omit it to skip
  // the check.
  establishingFraming?: string;
};

// The one generic arc checker. Reports findings; it never throws and never decides severity — the
// caller (doctor reports / generate gate) owns waivers and abort policy.
export function checkArc<Role extends string>(
  lens: LensSpec<Role>,
  items: ArcItem<Role>[],
  options: CheckArcOptions = {},
): DirectionFinding[] {
  const { realizedIds, noun = "shot", textLabel = "synopsis" } = options;
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
      message: `${lens.name} needs a "${lens.payoff}" ${noun} but none is marked`,
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

  for (let i = 0; i <= items.length; i++) {
    const role = i < items.length ? items[i]!.role : null;
    const prevRole = i > 0 ? items[i - 1]!.role : null;
    if (role === prevRole) continue;
    if (prevRole !== null) {
      let runStart = i - 1;
      while (runStart > 0 && items[runStart - 1]!.role === prevRole) runStart--;
      const decl = declByRole.get(prevRole);
      const len = i - runStart;
      if (decl?.maxConsecutive !== undefined && len > decl.maxConsecutive) {
        findings.push({
          code: "too-many-consecutive",
          subject: prevRole,
          message: `${len} consecutive "${prevRole}" ${noun}s exceed maxConsecutive ${decl.maxConsecutive}`,
        });
      }
    }
  }

  // The mirror of maxConsecutive: a role that only lands once when its lens wants it to build (a
  // comedy escalation, a process montage) is hollow. Measured on the role's longest run — an absent
  // required role is already `missing-role`, so only under-repeated *present* roles fire here.
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
        message: `${noun}.${items[payoffIdx]!.id} lands the "${lens.payoff}" payoff with no ${noun} grounding or building toward it first — waive this if the arc is meant to open on its payoff`,
      });
    }
  }

  // Establishing a set is a spend, once per act: a second full view of the same location re-opens
  // the whole set for matching. An act break re-establishes by right, so establishment resets at a
  // role change just as it does at a leaf boundary — the check then reads the same whether the acts
  // are nested as sequences or flattened into one leaf's roles.
  //
  // A `continuous` shot is the take before it running on, so it opens no second view.
  if (options.establishingFraming !== undefined) {
    const established = new Set<string>();
    let establishedRole: Role | undefined;
    for (const it of items) {
      if (it.role !== establishedRole) {
        established.clear();
        establishedRole = it.role;
      }
      if (it.location === undefined || it.framing !== options.establishingFraming) continue;
      if (established.has(it.location) && it.join !== "continuous") {
        findings.push({
          code: "re-established-wide",
          subject: it.id,
          message: `${noun}.${it.id} re-establishes "${it.location}" at ${options.establishingFraming} — a second full view of the set; waive this if the space itself changed`,
        });
      }
      established.add(it.location);
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

  if (realizedIds) {
    const realizedSet = new Set(realizedIds);
    const directionIds = options.coverageIds ?? items.map((it) => it.id);
    for (const id of directionIds) {
      if (!realizedSet.has(id)) {
        findings.push({
          code: "unrealized",
          subject: id,
          message: `${noun}.${id} is declared in direction but never realized`,
        });
      }
    }
    const expectedOrder = directionIds.filter((id) => realizedSet.has(id));
    const actualOrder = realizedIds.filter((id) => directionIds.includes(id));
    if (expectedOrder.join("\0") !== actualOrder.join("\0")) {
      findings.push({
        code: "stage-order-mismatch",
        message: "realized stage order differs from direction order",
      });
    }
  }

  return findings;
}

// A declared entity anchored to a reference asset — the shared shape of a character and a prop.
// Minimal structural form (not the DSL `Character`/`Prop`) so this engine stays DSL-free: `id` is the
// controlled-vocabulary token that must equal a reference asset name, `name` the canonical prose
// token every shot action refers to it by.
export type AnchoredEntityRef = { id: string; name: string };

// `framing` and `holds` come along for `setup-indistinct`: what a frame is set in, how big it is, and
// what it carries of the set are all a camera position declares, so two setups agreeing on all three
// have declared one frame twice.
export type SetupRef = AnchoredEntityRef & {
  location: string;
  framing: string;
  holds: readonly string[];
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
    unreferenced: DirectionFindingCode;
    unused: DirectionFindingCode;
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
        message: `${noun} "${e.id}" has no reference asset — expose reference:${e.id} in reference.tsx`,
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
        message: `${noun} "${e.name}" is declared but ${codes.usedBy}`,
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
      usedBy: "never named in any shot action",
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
      usedBy: "never named in any shot action",
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
          message: `character "${c.name}" speaks but has no voice — declare \`voice\` on the roster entry, or waive this if the lines are not spoken aloud`,
        });
      }
      continue;
    }
    if (!referenced.has(c.voiceAssetId)) {
      findings.push({
        code: "character-voice-unreferenced",
        subject: c.id,
        message: `character "${c.id}" casts voice "${c.voiceAssetId}", which has no reference asset — expose reference:${c.voiceAssetId} in reference.tsx`,
      });
    }
    if (!c.speaks) {
      findings.push({
        code: "unused-character-voice",
        subject: c.id,
        message: `character "${c.name}" has a voice but no script line names them`,
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
            message:
              "the direction declares narration lines but casts no narrator — declare `narrator`, or waive this if the narration is not read aloud",
          },
        ]
      : [];
  }
  const findings: DirectionFinding[] = [];
  if (!referenceAssetNames.includes(voiceAssetId)) {
    findings.push({
      code: "narrator-unreferenced",
      message: `the narrator's voice "${voiceAssetId}" has no reference asset — expose reference:${voiceAssetId} in reference.tsx`,
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
      usedBy: "no setup is set in it",
    },
    "location",
  );
}

// Two setups of one place that declare the same frame. A camera position is what it is set in, how
// big the frame is, and what that frame carries of the set — so two entries agreeing on all three
// have said one thing twice, and the shots on them cannot read as two angles.
//
// An `insert` is exempt: it fills the frame with one object and shows no set, so its `holds` is empty
// by contract and has nothing in it to tell two inserts apart. Any other frame with an empty `holds`
// is already `holds-empty`, a structural error, and is skipped for the same reason.
//
// By id, not in roster order, and blamed on the LATER entry: a roster is a set, so which of the two
// answers for the finding — and therefore which waiver key cancels it — must not move when the author
// reorders the record. Only setups a shot names are read; a duplicate nothing points at is
// `unused-setup`, whose fix is to delete it rather than to tell it apart.
function checkIndistinctSetups(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const seen = new Map<string, string>();
  for (const setup of [...setups].sort((a, b) => a.id.localeCompare(b.id))) {
    if ((shotsPerSetup.get(setup.id) ?? 0) === 0) continue;
    if (setup.framing === "insert" || setup.holds.length === 0) continue;
    const key = JSON.stringify([setup.location, setup.framing, setup.holds]);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, setup.id);
      continue;
    }
    findings.push({
      code: "setup-indistinct",
      subject: setup.id,
      message:
        `setup "${setup.id}" declares the same frame as setup "${first}" — same place ` +
        `("${setup.location}"), same framing ("${setup.framing}"), same \`holds\` in the same order. ` +
        `Point both shots at one of them, or move the camera: a reverse angle reverses \`holds\` and ` +
        `a different size changes \`framing\`, so a frame that is really two says so here`,
    });
  }
  return findings;
}

// Setups are the fourth roster but not a fourth anchored one: nothing realizes a setup, so both of
// its findings read the direction alone — `unused-setup`, and `setup-indistinct` (two entries of one
// place nothing tells apart).
export function checkSetups(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const setup of setups) {
    if ((shotsPerSetup.get(setup.id) ?? 0) > 0) continue;
    findings.push({
      code: "unused-setup",
      subject: setup.id,
      message: `setup "${setup.id}" is declared but no shot's setup points at it`,
    });
  }
  findings.push(...checkIndistinctSetups(setups, shotsPerSetup));
  return findings;
}

/**
 * Which camera frame of a shot an entry is: the shot's own picture, or the cutin laid over it.
 */
export type FrameLane = "main" | "cutin";

/**
 * One camera frame as the lineup checker reads it: the declarations, plus the place they are filed
 * under and the prose `lineup-missing` scans. A shot with a cutin arrives as two entries, its main
 * frame first; a graphic shot as its cutin alone. Asides never reach here — they declare none of it.
 */
export type LineupShot = {
  id: string;
  frame: FrameLane;
  // Resolved through the frame's setup. Undefined (an unknown setup, reported structurally) files
  // the frame under no place, so it neither reads nor writes an accumulated order.
  location: string | undefined;
  action: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  join?: "continuous" | "jump-back" | "jump-forward";
  // The shot whose frame in this lane runs on from this one in one take (`join: "continuous"`,
  // where it is possible). This frame's last panel then answers for no `lineupTo`.
  continuedBy?: string;
};

// A cutin's subject is `<shotId>.cutin`, so a waiver for the main frame never silences the wipe.
const frameSubject = (shot: Pick<LineupShot, "id" | "frame">): string =>
  shot.frame === "cutin" ? `${shot.id}.cutin` : shot.id;
const frameName = (shot: Pick<LineupShot, "id" | "frame">): string =>
  shot.frame === "cutin" ? `the cutin over shot ${shot.id}` : `shot ${shot.id}`;

/**
 * Where the composition plays a pinned take: `opensAt`/`closesAt` on the shot's clock, `from`/`to`
 * in the take's own seconds. `clipSec` is absent where the adapter declares no length, and then the
 * last frame cannot be located. Absent altogether where no `<Video>` plays the take directly.
 */
export type PinWindow = {
  take: string;
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
  lane: FrameLane;
  // The ends this take actually pins, each with every address the pinned source's chain reaches —
  // the source itself, and the frame behind a wrapper such as a resize.
  pins: readonly { pin: "start" | "end"; reaches: readonly string[]; window?: PinWindow }[];
  // The ends its adapter declares a slot for, wired or not — what says the take COULD carry a seam.
  slots: readonly ("start" | "end")[];
};

/**
 * One keyframe's `reference:<id>` inputs, in the order that panel's own call declares them — the
 * stage-side half of `slot-order-mismatch`. Panels of one lane arrive in panel order.
 */
export type PanelSlots = {
  shotId: string;
  lane: FrameLane;
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
  lane: FrameLane;
  panel: string;
  refs: readonly string[];
  generative: boolean;
};

function panelsByFrame<T extends { shotId: string; lane: FrameLane }>(
  panels: readonly T[],
): (shot: Pick<LineupShot, "id" | "frame">) => T[] | undefined {
  const byFrame = new Map<string, T[]>();
  for (const panel of panels) {
    const key = `${panel.shotId}/${panel.lane}`;
    byFrame.set(key, [...(byFrame.get(key) ?? []), panel]);
  }
  return (shot) => byFrame.get(`${shot.id}/${shot.frame}`);
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

/**
 * The staging findings that read the direction's declared lineups, plus the two the board feeds when
 * the caller has it. Pure: the caller flattens the arc tree and resolves each shot's location.
 *
 * The state is one `Map` of pairs per LOCATION — "a is left of b", with the shot that said so. A
 * shot's `lineup` is checked against it, then written into it, then its `lineupTo` over that; a
 * `join` of `jump-back`/`jump-forward` empties every place, because given time people move anywhere.
 * There is no carry-over of the LIST: each shot states only what its own frame holds, and the pairs
 * are what remember.
 */
export function checkLineups(
  shots: readonly LineupShot[],
  options: {
    // The board's keyframe slot orders, in panel order. Undefined leaves `slot-order-mismatch` silent.
    panelSlots?: readonly PanelSlots[];
    // The board's keyframe reference reach, in panel order. Undefined leaves `character-unconsumed`
    // and `location-unconsumed` silent.
    panelReach?: readonly PanelReach[];
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
    // A jump in either frame moves story time for the whole shot, so the places empty before its
    // first frame is read.
    if (index === 0 || shots[index - 1]!.id !== shot.id) {
      let end = index;
      while (end < shots.length && shots[end]!.id === shot.id) end++;
      const frames = shots.slice(index, end);
      if (frames.some((b) => b.join === "jump-back" || b.join === "jump-forward")) {
        byLocation.clear();
      }
    }

    const subject = frameSubject(shot);
    const name = frameName(shot);
    const joinField = shot.frame === "cutin" ? "cutin.join" : "join";

    // Read the previous frame's exit the way every other check does (`lineupTo ?? lineup`), so a
    // frame that ends where it began is not asked to restate it. The frame before it IN ITS OWN
    // LANE: a `continuous` only reaches here where that is the shot just before on the clock.
    const previous = shots
      .slice(0, index)
      .reverse()
      .find((b) => b.frame === shot.frame);
    if (shot.join === "continuous" && previous) {
      const seam = previous.lineupTo ?? previous.lineup;
      if (!sameOrder(seam, shot.lineup)) {
        findings.push({
          code: "join-lineup-mismatch",
          subject,
          message:
            `${name} runs on from ${frameName(previous)} in one take, but ${previous.id} leaves ` +
            `${formatFrame(seam)} and ${shot.id} opens on ${formatFrame(shot.lineup)} — one take has ` +
            `one frame at the seam. Make the two agree, or the boundary is a cut and \`${joinField}\` ` +
            `should say so`,
        });
      }
    }

    if (shot.lineupTo && sameOrder(shot.lineup, shot.lineupTo)) {
      findings.push({
        code: "lineup-vacuous",
        subject,
        message:
          `${name} declares a \`lineupTo\` identical to its \`lineup\` — it says the frame ` +
          `ends where it began, which is what leaving it out already says. Drop it, or write the ` +
          `order the shot actually leaves behind`,
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
          `"${shot.location}", the other way round from ${[...new Set(flipped.map((f) => `shot ${f.source}`))].join(", ")}, ` +
          `and no shot between them declares the change. Write the move as the \`lineupTo\` of the ` +
          `shot it happens in, or \`join: "jump-back" | "jump-forward"\` where story time has moved`,
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
          `"${shot.location}" puts ${skipped.join(", ")} between them and this frame does not hold ` +
          `them — a frame runs edge to edge, so whoever stands in the middle is in it. Add them to ` +
          `the \`lineup\`, or, where they walked out of frame, say so in the \`lineupTo\` of the shot ` +
          `they leave in`,
      });
    }

    writePairs(state, shot.lineup, shot.id);
    if (shot.lineupTo) {
      const exits = shot.lineupTo;
      dropSubjects(state, new Set(shot.lineup.filter((id) => !exits.includes(id))));
      writePairs(state, exits, shot.id);
    }

    const cycle = findCycle(state);
    if (cycle) {
      findings.push({
        code: "lineup-inconsistent",
        subject,
        message:
          `after ${name} the order in "${shot.location}" cannot be laid out on a line: ` +
          `${cycle.join(" → ")} → ${cycle[0]}. Shots that never share a frame can each read right ` +
          `and still be impossible together — one of them has the place's seating wrong`,
      });
      // The pairs are unusable now, so the accumulation restarts from the order this frame leaves —
      // one list, so a total order, so nothing cyclic survives. Without this, every later shot in
      // the place reports the same ring again.
      state.clear();
      writePairs(state, shot.lineupTo ?? shot.lineup, shot.id);
    }
  }

  if (options.panelSlots) findings.push(...checkSlotOrder(shots, options.panelSlots));
  if (options.panelReach) {
    findings.push(
      ...checkCharacterAnchors(shots, options.panelReach, options.referenceAssetNames ?? []),
      ...checkLocationAnchors(shots, options.panelReach, options.referenceAssetNames ?? []),
    );
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

// The seam a `continuous` join declares is ONE frame: the opening keyframe of the shot that owns the
// boundary. The take before it has to pin its end to that frame. Nothing is demanded of the take
// after.
//
// Judged where the take before is developed and the board holds the shot's opening keyframe — the
// take after need not exist yet, so the demand lands before the take before is spent on. A model
// with no end slot has no wiring to forget, so the seam is silent rather than uniformly waived.
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
      .find((b) => b.frame === shot.frame);
    if (!previous) continue;
    const before = pinsOf.get(`${previous.id}/${previous.frame}`);
    const seam = panelsOf.get(`${shot.id}/${shot.frame}`)?.firstPanel;
    if (seam === undefined) continue;
    const after = pinsOf.get(`${shot.id}/${shot.frame}`);
    findings.push(...checkSeamWindows(previous, shot, seam, before, after));
    if (!before) continue;
    if (!before.slots.includes("end")) continue;
    if (before.pins.some((p) => p.pin === "end" && p.reaches.includes(seam))) continue;
    const pinned = before.pins.find((p) => p.pin === "end");
    // The frame behind a wrapper declared in video.tsx, where there is one.
    const pinnedFrame = pinned?.reaches.find((a) => !a.startsWith("video:")) ?? pinned?.reaches[0];
    const takes = shot.frame === "cutin" ? "cutin takes" : "takes";
    findings.push({
      code: "join-unpinned",
      subject: frameSubject(shot),
      message:
        `${frameName(previous)} and ${frameName(shot)} are declared one take, so the frame between ` +
        `them is \`${seam}\` — and the ${takes} of video:shot.${previous.id} ` +
        (pinnedFrame === undefined
          ? `pins nothing at its end`
          : `pins its end to another frame (${pinnedFrame})`) +
        `. Pin its end to \`${seam}\` in video.tsx; landing anywhere else, the seam is a cut with ` +
        `no cut in it`,
    });
  }
  return findings;
}

// A seam pinned on both takes is one frame only if the composition plays it: the take before has to
// close the shot on its last frame, the take after has to open the shot on its first. A `mediaStart`
// or a `duration` that moves either off it turns the seam back into a jump.
function checkSeamWindows(
  previous: Pick<LineupShot, "id" | "frame">,
  shot: Pick<LineupShot, "id" | "frame">,
  seam: string,
  before: VideoShotPins | undefined,
  after: VideoShotPins | undefined,
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const route =
    `Where the moment inside the take is what is off, regenerate the take or change the shot's ` +
    `duration in direction.ts — the seam is not the place to move it. A waiver is the human's call ` +
    `that the jump is worth it.`;

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
        message:
          `${frameName(previous)} and ${frameName(shot)} are one take, and ${landing.take} lands ` +
          `on the seam \`${seam}\` ${formatSeconds(landing.landsAt, 2)} in — but ${frameName(previous)} plays ` +
          `${formatSecondsRange(landing.from, landing.to, 2)} of it` +
          (endsShot
            ? ""
            : `, ending ${formatSeconds(landing.shotSec - landing.closesAt, 2)} before the shot does`) +
          `, so the cut is not on the landing and jumps. Play it so the shot ends there ` +
          `(\`mediaStart={${Number(start.toFixed(3))}}\` for the ${formatSeconds(played, 2)} window). ` +
          route,
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
        message:
          `${frameName(previous)} and ${frameName(shot)} are one take, and ${opening.take} opens on ` +
          `the seam \`${seam}\` at its first frame — but ${frameName(shot)} ` +
          (opening.from > tol
            ? `starts it ${formatSeconds(opening.from, 2)} in (\`mediaStart\`)`
            : `does not start it until ${formatSeconds(opening.opensAt, 2)}`) +
          `, so the seam frame is never shown and the cut jumps. Play the take from its first ` +
          `frame at the shot's start. ` +
          route,
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
  lane: FrameLane;
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
    const missing: string[] = [];
    for (const { panel, order } of against) {
      if (!panel.generative) continue;
      for (const id of order) {
        const promptDepiction = promptDepictions.get(id);
        // An id no roster answers to is `lineup-unknown-id`, a structural error; a blank
        // `promptDepiction` is `character-empty-prompt-depiction`. Neither is this finding's to
        // repeat.
        if (promptDepiction === undefined || promptDepiction.trim() === "") continue;
        if (namesIn(panel.texts, promptDepiction) || missing.includes(id)) continue;
        missing.push(id);
      }
    }
    for (const id of missing) {
      findings.push({
        code: "subject-unnamed",
        subject: `${frameSubject(shot)}.${id}`,
        message:
          `${frameName(shot)} frames "${id}" but no prompt behind the keyframe holding them contains ` +
          `"${promptDepictions.get(id)}" (verbatim, case-insensitive) — name every subject the frame ` +
          `holds by its promptDepiction, or the model decides for itself which sheet it was handed is ` +
          `the one the line is about; to call them by other words, change ` +
          `characters.${id}.promptDepiction`,
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
  lane: FrameLane;
  // The keyframe this shot opens on (the seam of a long take), and the one the next shot cuts from.
  firstPanel: string;
  lastPanel: string;
};

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
          `"${setup.location}", the other way round from ${[...new Set(flipped.map((f) => `setup "${f.source}"`))].join(", ")}. ` +
          `A landmark does not move, so two frames of one place cannot both be right — unless the ` +
          `camera crossed the set's line, which is a waiver`,
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
    for (const { panel, order } of against) {
      // Only the subjects the order names: a panel also conditions on the place and on anchors the
      // lineup has no opinion about, and those sit anywhere among the slots.
      const slots = [...new Set(panel.slots)].filter((id) => order.includes(id));
      if (slots.length < 2) continue;
      const expected = order.filter((id) => slots.includes(id));
      if (sameOrder(slots, expected)) continue;
      findings.push({
        code: "slot-order-mismatch",
        subject: frameSubject(shot),
        message:
          `${panel.panel} passes its reference images as ${slots.join(", ")}, but ${frameName(shot)} ` +
          `declares the frame as ${expected.join(", ")} left to right — pass them in that order. A ` +
          `take that came back with the wrong person on the wrong side is a slot fix, not a waiver`,
      });
      break;
    }
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
    const missing: string[] = [];
    for (const { panel, order } of against) {
      if (!panel.generative) continue;
      for (const id of order) {
        if (!anchored.has(id) || panel.refs.includes(id) || missing.includes(id)) continue;
        missing.push(id);
      }
    }
    for (const id of missing) {
      findings.push({
        code: "character-unconsumed",
        subject: `${frameSubject(shot)}.${id}`,
        message:
          `${frameName(shot)} frames "${id}" but the keyframe holding them is built from no reference ` +
          `to them — take \`reference.${id}\` as an input image, or the look is only as steady as ` +
          `the prompt happens to be`,
      });
    }
  }
  return findings;
}

// The place a frame is set in, against the references its keyframes stand on: any one keyframe
// reaching `reference:<location>` holds the place for the shot.
function checkLocationAnchors(
  shots: readonly LineupShot[],
  panelReach: readonly PanelReach[],
  referenceAssetNames: readonly string[],
): DirectionFinding[] {
  const anchored = new Set(referenceAssetNames);
  const panelsOf = panelsByFrame(panelReach);
  const findings: DirectionFinding[] = [];
  for (const shot of shots) {
    const location = shot.location;
    if (location === undefined || !anchored.has(location)) continue;
    const panels = (panelsOf(shot) ?? []).filter((panel) => panel.generative);
    if (panels.length === 0 || panels.some((panel) => panel.refs.includes(location))) continue;
    findings.push({
      code: "location-unconsumed",
      subject: frameSubject(shot),
      message:
        `${frameName(shot)} is set in "${location}" but no keyframe of it is built from a reference ` +
        `to the place — take \`reference.${location}\`, or a reference asset built from it, as an ` +
        `input image, or the place is only as steady as the prompt happens to be`,
    });
  }
  return findings;
}
