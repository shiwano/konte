// The generic arc types and their checker. Deliberately free of any DSL/runtime import so the
// doctor, the generate gate, and unit tests can pull it in standalone. `checkArc` is the single
// engine reused at every scale of the arc tree (a run of shots, a run of sequences, a run of runs);
// it is generic over `Role`. A role is a plain string scoped to its lens — each lens declares its
// own beats and each beat carries the dramatic `fn` the theory checks read, so there is no global
// role vocabulary or function map; the engine reads `fn` off the matched beat.

/**
 * The dramatic function a role performs — the five-stage skeleton the classical arc schemas share
 * (Freytag's pyramid, three-act, kishōtenketsu): ground establishes a state, turn breaks it, build
 * escalates it, payoff lands the climax, settle lets it ring.
 */
export type BeatFunction = "ground" | "turn" | "build" | "payoff" | "settle";

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
  // The camera axis this item's frame stands on (opaque, like `framing`) — the caller's own token,
  // equal for two frames that are one camera position at two focal lengths. Present only at leaf
  // scale, and absent where the item names no axis at all.
  axis?: string;
  // Something the caller dropped from `items` sits between this one and the one before it, so the
  // two are adjacent here and not on the clock.
  afterGap?: true;
};

export type Beat<Role extends string> = {
  role: Role;
  // The dramatic function this role performs in *this* lens — the five-stage skeleton the classical
  // arc schemas share (ground establishes a state, turn breaks it, build escalates, payoff lands the
  // climax, settle lets it ring). It is what lets the engine check theory ("a climax must be earned")
  // generically. Omit it for a container role — a beat with no `fn` is exempt from every function
  // check. No built-in lens does: a lens of function-less beats is a lens with no rules.
  fn?: BeatFunction;
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
  beats: Beat<Role>[];
  payoff: Role;
};

/**
 * Fixed contract, like KonteErrorCode: doctor / waiver keys / scripts branch on these. The same
 * codes are reused at both scales — the subject (role / id / range) distinguishes instances.
 */
export type DirectionFindingCode =
  | "missing-beat"
  | "no-payoff"
  | "beat-out-of-order"
  | "lens-role-mismatch"
  | "too-many-consecutive"
  | "too-few-consecutive"
  | "empty-synopsis"
  | "unearned-payoff"
  | "unrealized"
  | "stage-order-mismatch"
  | "beat-overweight"
  | "beat-underweight"
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
  | "unused-setup"
  // The roster read as a whole rather than one entry at a time: two frames of one place nothing
  // distinguishes, and a place made only of frames no second shot returns to.
  | "setup-indistinct"
  | "setup-atomized"
  | "unexpected-script"
  | "multi-sentence-action"
  | "off-grid-duration"
  | "undeclared-continuity"
  | "re-established-wide"
  | "fonts-undeclared"
  // The staging class: who the frame holds, left to right, declared per shot and accumulated per
  // place. Four settle a RELATION between two subjects across two shots; the two the board feeds
  // settle the declared frame against what the keyframe was conditioned on — who it took
  // (`character-unconsumed`) and in what order (`slot-order-mismatch`). The last settles the frame
  // itself: the plate's own sentence against the prompts of the panels standing on it.
  | "lineup-flipped"
  | "lineup-gap"
  | "lineup-vacuous"
  | "lineup-inconsistent"
  | "character-unconsumed"
  | "slot-order-mismatch"
  | "plate-undescribed"
  // The seam a `continuous` join declares: one take across a shot boundary, so the frame at the end
  // of the one and the start of the next is a single frame — the opening keyframe of the shot that
  // owns the boundary. The two shots must agree on who it holds, and the take before must land on
  // it.
  | "join-lineup-mismatch"
  | "join-unpinned"
  // The seam frame is pinned, and the composition's window over the take leaves it out.
  | "join-unshown"
  // A cut along one camera axis: the camera does not move, so the frame does not restart.
  | "panel-unlinked"
  // The set's own three. `landmark-flipped` is the `lineup-flipped` of things that do not move, read
  // across the setups of one place; the two `-unnamed` are the naming twins of `character-unconsumed`
  // and `plate-undescribed` — those ask whether the picture was passed in, these whether the text
  // calls it by the name the direction declared.
  | "landmark-flipped"
  | "subject-unnamed"
  | "plate-unnamed";

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
  // The framing vocabulary the space checks read (framing stays opaque to this engine; the caller
  // supplies the words). `exposedFramings` are the sizes that keep most of the set in frame — two
  // different ones cut adjacently in one location bind backgrounds. `establishingFraming` is the
  // size that opens a whole set. Omit either to skip its check.
  exposedFramings?: readonly string[];
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

  const beatIndex = new Map<string, number>();
  lens.beats.forEach((b, i) => beatIndex.set(b.role, i));
  const beatByRole = new Map<string, Beat<Role>>();
  for (const b of lens.beats) beatByRole.set(b.role, b);
  // A role's dramatic function is declared on its beat (a role outside the lens has none — exempt).
  const fnOf = (role: string): BeatFunction | undefined => beatByRole.get(role)?.fn;
  const presentRoles = new Set<string>(items.map((it) => it.role));

  for (const beat of lens.beats) {
    if (beat.required === false) continue;
    if (!presentRoles.has(beat.role)) {
      findings.push({
        code: "missing-beat",
        subject: beat.role,
        message: `${lens.name} has no ${beat.role} ${noun}`,
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
    if (!beatIndex.has(it.role)) {
      findings.push({
        code: "lens-role-mismatch",
        subject: it.id,
        message: `${noun}.${it.id} uses role "${it.role}", but lens is "${lens.name}"`,
      });
    }
  }

  // Walk the in-lens items tracking the highest beat seen; a later item with a lower beat index
  // means the earlier high-beat role appeared ahead of schedule (e.g. "release before pressure").
  let maxIdx = -1;
  let maxRole: string | null = null;
  const reportedOutOfOrder = new Set<string>();
  for (const it of items) {
    const idx = beatIndex.get(it.role);
    if (idx === undefined) continue;
    if (idx < maxIdx && maxRole !== null) {
      if (!reportedOutOfOrder.has(maxRole)) {
        reportedOutOfOrder.add(maxRole);
        findings.push({
          code: "beat-out-of-order",
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
      const beat = beatByRole.get(prevRole);
      const len = i - runStart;
      if (beat?.maxConsecutive !== undefined && len > beat.maxConsecutive) {
        findings.push({
          code: "too-many-consecutive",
          subject: prevRole,
          message: `${len} consecutive "${prevRole}" ${noun}s exceed maxConsecutive ${beat.maxConsecutive}`,
        });
      }
    }
  }

  // The mirror of maxConsecutive: a beat that only lands once when its lens wants it to build (a
  // comedy escalation, a process montage) is hollow. Measured on the role's longest run — an absent
  // required role is already `missing-beat`, so only under-repeated *present* roles fire here.
  const longestRun = new Map<string, number>();
  for (let i = 0; i < items.length; ) {
    const role = items[i]!.role;
    let j = i + 1;
    while (j < items.length && items[j]!.role === role) j++;
    longestRun.set(role, Math.max(longestRun.get(role) ?? 0, j - i));
    i = j;
  }
  for (const beat of lens.beats) {
    if (beat.minConsecutive === undefined || !presentRoles.has(beat.role)) continue;
    const run = longestRun.get(beat.role) ?? 0;
    if (run < beat.minConsecutive) {
      findings.push({
        code: "too-few-consecutive",
        subject: beat.role,
        message: `"${beat.role}" needs a run of at least ${beat.minConsecutive} but the longest is ${run}`,
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
  // building item. This is what makes a degenerate one-beat lens — or a direction that opens on
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

  // The space checks. Constructive editing is the default — space assembled from fragments is never
  // asked to match — so what gets flagged is the spend: two set-showing sizes cut adjacently in one
  // location bind backgrounds generation can't hold. Vocabulary comes from the caller
  // (`exposedFramings`), and a branch item has no `location`, so both checks walk a leaf's shots only.
  if (options.exposedFramings !== undefined) {
    for (let i = 0; i + 1 < items.length; i++) {
      const a = items[i]!;
      const b = items[i + 1]!;
      if (a.location === undefined || a.location !== b.location) continue;
      // One camera axis is the case the author has DECLARED the match on: `within` says this frame
      // steps in from that one, which is the claim this check would otherwise refuse. What
      // is left here is two different cameras, where nothing binds the backgrounds together.
      //
      // Only across a real cut, though. An aside between the two is a card the piece breaks for, and
      // the seam check reads it as no seam at all — so nothing would be left asking whether the room
      // comes back the same.
      if (a.axis !== undefined && a.axis === b.axis && !b.afterGap) continue;
      if (a.framing === undefined || b.framing === undefined || a.framing === b.framing) continue;
      if (!options.exposedFramings.includes(a.framing)) continue;
      if (!options.exposedFramings.includes(b.framing)) continue;
      findings.push({
        code: "undeclared-continuity",
        subject: `${a.id}-${b.id}`,
        message: `${noun}s ${a.id}–${b.id} cut ${a.framing}→${b.framing} inside "${a.location}" — a background match generation can't hold`,
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
          message: `${noun}.${it.id} re-establishes "${it.location}" at ${options.establishingFraming} — a second full view of the set`,
        });
      }
      established.add(it.location);
    }
  }

  // Act-ratio pacing: each role's share of the arc's total duration against its beat's min/maxShare.
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
      for (const beat of lens.beats) {
        if (!presentRoles.has(beat.role)) continue;
        const share = (roleDuration.get(beat.role) ?? 0) / total;
        if (beat.maxShare !== undefined && share > beat.maxShare) {
          findings.push({
            code: "beat-overweight",
            subject: beat.role,
            message: `"${beat.role}" holds ${pct(share)}% of the runtime, over its ${pct(beat.maxShare)}% budget`,
          });
        }
        if (beat.minShare !== undefined && share < beat.minShare) {
          findings.push({
            code: "beat-underweight",
            subject: beat.role,
            message: `"${beat.role}" holds only ${pct(share)}% of the runtime, under its ${pct(beat.minShare)}% minimum`,
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

// The `locations` id a setup stands in names the reference asset its plate and its shots are held to.
// `framing` and `holds` come along for `setup-indistinct`: what a frame is set in, how big it is, and
// what it carries of the set are all a camera position declares, so two setups agreeing on all three
// have declared one frame twice.
export type SetupRef = AnchoredEntityRef & {
  location: string;
  framing: string;
  holds: readonly string[];
  // The wider frame this one steps in from, `null` at the root of its axis. Read by
  // `plate-unnested`, which names it as the plate to build from.
  within?: string | null;
};

/**
 * One cut along a single camera axis. Assembled by the caller from the same walk the
 * `undeclared-continuity` skip reads, so the pairs that check waives through are exactly the pairs
 * this one asks a plate of.
 */
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
// on no location reference, and which developed shots reach neither anchor. Assembled by the CLI (see
// loadAnimaticSetupState); undefined stands for "the animatic could not be read", the same contract
// `referenceAssetNames` carries for the rosters.
export type AnimaticSetupState = {
  plateIds: readonly string[];
  unanchoredPlateIds: readonly string[];
  unnestedPlateIds: readonly string[];
  unconsumedBy: ReadonlyMap<string, readonly string[]>;
  deterministicShotsPerSetup: ReadonlyMap<string, number>;
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

export function checkCharacters(
  characters: readonly CharacterRef[],
  referenceAssetNames: readonly string[],
  actions: readonly string[],
  scriptCharacterIds: ReadonlySet<string>,
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
  );
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
const ATOMIZED_LOCATION_SHOTS = 8;

// The axis read as a shared frame. `setup-unrealized` asks for a plate where one CAMERA POSITION is
// shared; this asks for one where one camera AXIS is cut along — two set-showing sizes of a place
// that the direction says are one camera at two focal lengths. Without the plates nothing holds them
// to one master, and `undeclared-continuity` has already waived the pair through on the strength of
// the `within` declaration alone.
//
// Keyed by the two setups rather than the two shots, and joined on `.` like `plate-unnamed`'s: the
// plates are what the fix declares, one pair cut four times is one piece of work, and a `-` would not
// say where one id ends (a hyphen is a legal identifier character).
function checkAxisCuts(cuts: readonly AxisCut[], plates: ReadonlySet<string>): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const seen = new Set<string>();
  for (const cut of cuts) {
    const subject = cut.pair.join(".");
    if (seen.has(subject)) continue;
    const missing = cut.chain.filter((id) => !plates.has(id));
    if (missing.length === 0) continue;
    seen.add(subject);
    const owed = missing.map((id) => `"${id}"`).join(", ");
    findings.push({
      code: "axis-unrealized",
      subject,
      message:
        `setups "${cut.pair[0]}" and "${cut.pair[1]}" are cut between along one camera axis, so the ` +
        `two frames have to come off one master — and ${owed} ` +
        `${missing.length === 1 ? "has" : "have"} no plate, so nothing nests them. Declare ` +
        `${missing.length === 1 ? "it" : "them"} in \`plates\` in animatic.tsx, or waive the pair ` +
        `to cut it as two separate frames`,
    });
  }
  return findings;
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
): DirectionFinding[] {
  const byLocation = new Map<string, { shots: number; onShared: number; frames: number }>();
  for (const setup of setups) {
    const shots = shotsPerSetup.get(setup.id) ?? 0;
    if (shots === 0) continue;
    const entry = byLocation.get(setup.location) ?? { shots: 0, onShared: 0, frames: 0 };
    byLocation.set(setup.location, entry);
    entry.shots += shots;
    entry.frames += 1;
    if (shots >= 2) entry.onShared += shots;
  }
  const findings: DirectionFinding[] = [];
  for (const [location, { shots, onShared, frames }] of [...byLocation].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (shots < ATOMIZED_LOCATION_SHOTS || onShared * 2 >= shots) continue;
    findings.push({
      code: "setup-atomized",
      subject: location,
      message:
        `location "${location}" holds ${shots} shots across ${frames} setups, and only ${onShared} of ` +
        `those shots stands on a frame another shot stands on too — so almost nothing there earns a ` +
        `plate and nothing holds the room across ${frames} frames. Put a second shot on a frame the ` +
        `piece returns to, or the place is only as steady as \`reference.${location}\` and each ` +
        `prompt happen to be`,
    });
  }
  return findings;
}

// `animatic` is undefined when the board could not be read, in which case the whole class stays
// silent rather than reporting every setup as unrealized. `referenceAssetNames` carries the rosters'
// own contract: undefined = "the reference stage could not be read", so the anchor findings hold.
//
// Two more read the roster as a whole rather than one entry at a time, and neither needs the board:
// `setup-indistinct` (two entries of one place nothing tells apart) and `setup-atomized` (a place no
// frame of which a second shot returns to).
export function checkSetups(
  setups: readonly SetupRef[],
  shotsPerSetup: ReadonlyMap<string, number>,
  animatic: AnimaticSetupState | undefined,
  referenceAssetNames: readonly string[] | undefined,
  axisCuts: readonly AxisCut[] = [],
): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  const plates = animatic === undefined ? undefined : new Set(animatic.plateIds);
  const unanchored = animatic === undefined ? undefined : new Set(animatic.unanchoredPlateIds);
  const unnested = animatic === undefined ? undefined : new Set(animatic.unnestedPlateIds);
  const anchored = referenceAssetNames === undefined ? undefined : new Set(referenceAssetNames);
  for (const setup of setups) {
    const shots = shotsPerSetup.get(setup.id) ?? 0;
    if (shots === 0) {
      findings.push({
        code: "unused-setup",
        subject: setup.id,
        message: `setup "${setup.id}" is declared but no shot's setup points at it`,
      });
      continue;
    }
    if (!plates) continue;
    const plated = plates.has(setup.id);
    const generated = shots - (animatic!.deterministicShotsPerSetup.get(setup.id) ?? 0);
    if (generated >= 2 && !plated) {
      findings.push({
        code: "setup-unrealized",
        subject: setup.id,
        message:
          `setup "${setup.id}" is shared by ${generated} generated shots but has no plate — declare ` +
          `it in \`plates\` in animatic.tsx for them to build their frame on`,
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
          `\`reference.${setup.location}\` as an input image, or every shot on this setup is held ` +
          `to a place the plate invented`,
      });
    }
    if (plated && setup.within && unnested!.has(setup.id)) {
      findings.push({
        code: "plate-unnested",
        subject: setup.id,
        message:
          `setup "${setup.id}" declares itself within "${setup.within}", but its plate is neither a ` +
          `cut from that one's nor a window inside it — so the two frames disagree about how far ` +
          `away the set is, and this ${setup.framing} comes back at the distance its plate was drawn ` +
          `at. Pass \`plates.${setup.within}.image\` as is to a model that reads a previous frame ` +
          `(\`cut\` in \`konte adapter show\`) and write the step in as a cut from it, or crop inside ` +
          `that plate's window with \`adapters.imageCrop\``,
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
            `take \`plates.${setup.id}\` as an input image, or the frame is only as steady as the ` +
            `prompt happens to be`
          : `shot ${shotList} sits on setup "${setup.id}", which has no plate, but no keyframe is ` +
            `built from its location — take \`reference.${setup.location}\` as an input image, or ` +
            `the place is only as steady as the prompt happens to be`,
      });
    }
  }
  findings.push(...checkIndistinctSetups(setups, shotsPerSetup));
  findings.push(...checkAtomizedSetups(setups, shotsPerSetup));
  // Board-gated like the three anchor findings: with no plates read there is nothing to be missing.
  if (plates) findings.push(...checkAxisCuts(axisCuts, plates));
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
    // silent.
    panelReach?: readonly PanelReach[];
    // How each developed shot on a plated setup carries its plate's own sentence. Undefined leaves
    // `plate-undescribed` silent.
    plateUses?: readonly PlateUse[];
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
    );
  }
  if (options.plateUses) findings.push(...checkPlateDescriptions(options.plateUses));
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

const sec = (n: number): string => `${Number(n.toFixed(2))}s`;

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
          `on the seam \`${seam}\` ${sec(landing.landsAt)} in — but ${frameName(previous)} plays ` +
          `${sec(landing.from)}–${sec(landing.to)} of it` +
          (endsShot
            ? ""
            : `, ending ${sec(landing.shotSec - landing.closesAt)} before the shot does`) +
          `, so the cut is not on the landing and jumps. Play it so the shot ends there ` +
          `(\`mediaStart={${Number(start.toFixed(3))}}\` for the ${sec(played)} window). ` +
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
            ? `starts it ${sec(opening.from)} in (\`mediaStart\`)`
            : `does not start it until ${sec(opening.opensAt)}`) +
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
 * One plated setup read for its own sentence: the `plates.<id>.prompt` its author wrote, and the
 * landmarks that frame declares it carries. Assembled by the caller from the direction and the board.
 */
export type PlateNaming = {
  setupId: string;
  prompt: string;
  holds: readonly { id: string; promptDepiction: string }[];
};

// The plate's sentence against what its frame declares it holds. `plate-undescribed` asks whether
// the shots on a plate carry that sentence at all; this asks whether the sentence says what is in
// the frame — the finding that E1c settled, where a room stayed a room only once the line named
// what only that room has.
//
// Reported per landmark, keyed `<setupId>.<landmarkId>`: a waiver written for a lamp that is out of
// this crop must not also waive the desk that is in it.
export function checkPlateNaming(namings: readonly PlateNaming[]): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const naming of namings) {
    for (const landmark of naming.holds) {
      if (landmark.promptDepiction.trim() === "") continue;
      if (namesIn([naming.prompt], landmark.promptDepiction)) continue;
      findings.push({
        code: "plate-unnamed",
        subject: `${naming.setupId}.${landmark.id}`,
        message:
          `the sentence for plate "${naming.setupId}" does not say "${landmark.promptDepiction}", which ` +
          `its \`holds\` declares the frame carries — write the contents into the sentence, or crop ` +
          `the frame where the thing is not`,
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
  lane: FrameLane;
  // The shot before it, and the keyframe it ends on.
  from: string;
  fromPanel: string;
  // Every address this shot's opening keyframe was handed of the frame it cuts from.
  linked: readonly string[];
};

// The frame across a cut along one camera axis — a push in or out along `within`: a keyframe drawn
// without the one before it re-invents the subject's light, size and place in the room. Only seams whose
// opening keyframe's model READS a previous panel reach here (see `panelSeams`), so a board drawn with
// a model that carries no frame is silent.
export function checkPanelLinks(seams: readonly PanelSeam[]): DirectionFinding[] {
  const findings: DirectionFinding[] = [];
  for (const seam of seams) {
    if (seam.linked.includes(seam.fromPanel)) continue;
    const shots = seam.lane === "cutin" ? "the cutins over shots" : "shots";
    const took =
      seam.linked.length === 0
        ? "its opening keyframe takes no frame to cut from"
        : `its opening keyframe cuts from another frame instead`;
    findings.push({
      code: "panel-unlinked",
      subject: `${seam.from}-${seam.id}${seam.lane === "cutin" ? ".cutin" : ""}`,
      message:
        `${shots} ${seam.from}–${seam.id} cut along one camera axis, so the frame carries across ` +
        `the seam — and ${took}. Pass \`${seam.fromPanel}\` to one of the keyframe's image inputs ` +
        `and name it \`[Shot 1]\` in the prompt, or waive the seam where the cut is meant to re-open ` +
        `the frame`,
    });
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

/**
 * How one developed shot on a plated setup carries its plate in text. Built by the CLI off the
 * board and handed in, like `PanelSlots`.
 */
export type PlateUse = {
  setupId: string;
  shotId: string;
  lane: FrameLane;
  describes: boolean;
};

// The text half of the anchor rule, paired with `setup-unconsumed`: that one asks whether the shot
// stands on the plate, this one whether it says what the plate holds. Presence of the sentence is
// all it reads — which input slot the picture arrives in and how the prompt names it are the
// adapter's grammar, and the prompt critic's.
//
// Reported per setup: the sentence is the plate's, so one waiver answers for the frame rather than
// for one shot on it.
function checkPlateDescriptions(uses: readonly PlateUse[]): DirectionFinding[] {
  const bySetup = new Map<string, string[]>();
  for (const use of uses) {
    if (use.describes) continue;
    const shots = bySetup.get(use.setupId) ?? [];
    shots.push(use.lane === "cutin" ? `"${use.shotId}" (cutin)` : `"${use.shotId}"`);
    bySetup.set(use.setupId, shots);
  }
  return [...bySetup].map(([setupId, shots]) => ({
    code: "plate-undescribed" as const,
    subject: setupId,
    message:
      `shot ${shots.join(", ")} carries no \`plates.${setupId}.prompt\` in ` +
      `its prompt — write the sentence into the keyframe's own prompt, or the frame survives only ` +
      `as long as the model keeps the picture`,
  }));
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
