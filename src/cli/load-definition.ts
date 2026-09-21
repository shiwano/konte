import {
  type DefinitionLike,
  type Stage,
  formatReferenceAddress,
  getAssetEntryByAddress,
  getStage,
  listAssetPaths,
} from "../core/address.js";
import { assertNever } from "../core/assert.js";
import {
  assertDirectionGate,
  collectShotFrames,
  type SpendCommand,
  type StagingStageState,
} from "../core/direction.js";
import {
  directionAcceptanceView,
  isDirectionSpendGateSatisfied,
} from "../core/direction-acceptance.js";
import { StateManager } from "../core/state/index.js";
import type { Character, Direction } from "../core/dsl/direction.js";
import { KonteError } from "../core/errors.js";
import {
  listBoardlessVideoShots,
  listPanelPromptText,
  listPanelReferenceReach,
  listPanelReferenceSlots,
  listPlateDescriptionUses,
  listSetupAnchorGaps,
  listSetupNestGaps,
  listShotContinuity,
  listVideoShotPins,
  type DependencyGraph,
} from "../core/graph.js";
import type { AnimaticSetupState } from "../core/direction-check.js";
import { assertPinGate, type PinCheckSubject } from "../core/pin-check.js";
import { assertNarrationStemsPlaced } from "../core/narration-stem.js";
import { assertPromptGate, type PromptCheckSubject } from "../core/prompt-check.js";
import { assertTailwindClasses } from "../core/tailwind-classes.js";
import { assertPrerequisitesMet, findUnmetPrerequisites } from "../core/review-prerequisites.js";
import {
  loadAnimatic,
  loadDirectionDefinition,
  loadIfPresent,
  loadReference,
  loadVideoDefinition,
} from "../core/loader.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  VideoDefinition,
} from "../core/types/index.js";
import { harvestShotPictureCues } from "../core/composition-builder.js";
import { STAGE_ENTRY_FILE, stageEntryPath } from "../core/roots.js";

// The direction (direction.ts). Absent file => null; an existing but invalid file throws.
export function loadDirectionIfPresent(videoRoot: string): Promise<Direction | null> {
  return loadIfPresent(stageEntryPath(videoRoot, "direction"), loadDirectionDefinition);
}

// The spend-command gate: load direction.ts and abort (DIRECTION_CHECK_FAILED) when the running
// command's scope has an unresolved structural problem. `realizedIds` is the stage's realized shot
// order (undefined skips the stage/completeness checks). The reference stage carries no direction,
// so it is never gated. A missing direction.ts is itself a hard failure for animatic/video.
export async function gateDirectionForStage(opts: {
  videoRoot: string;
  command: SpendCommand;
  stage: Stage;
  realizedIds?: readonly string[];
}): Promise<void> {
  if (opts.stage === "reference") return;
  const direction = await loadDirectionIfPresent(opts.videoRoot);
  if (!direction) {
    throw new KonteError(
      "DIRECTION_CHECK_FAILED",
      "No direction.ts found — declare the video's direction (lens + shots) before generating. [direction-missing]",
    );
  }
  // The characters checks need the reference pool's exposed asset names; an unreadable reference.tsx
  // yields an empty list, so any declared character is (correctly) reported as unreferenced.
  const reference = await loadReference(opts.videoRoot).catch(() => null);
  // A broken/absent state can't be gated here — later steps fail on it — so skip those gates.
  const manager = await StateManager.load(opts.videoRoot).catch(() => null);
  const acceptance = manager?.getDirectionAcceptance();
  assertDirectionGate(direction, {
    command: opts.command,
    stage: opts.stage,
    realizedIds: opts.realizedIds,
    referenceAssetNames: reference?.exposedAssetNames ?? [],
    animaticSetups: await loadAnimaticSetupState(opts.videoRoot, direction),
    stagingStage: await loadStagingStageState(opts.videoRoot, direction),
    directionAccepted: isDirectionSpendGateSatisfied(direction, acceptance ?? null),
  });

  // The character-acceptance gate rides the same spend-command gate, so generate/reroll/export all
  // enforce it (the reference stage already returned above — it is where a character is made and
  // accepted).
  if (manager) {
    assertDirectionAccepted({ manager, direction });
    await assertCharactersAccepted({
      videoRoot: opts.videoRoot,
      manager,
      direction,
      reference,
    });
    // Both composition stages sound the shot's lines, so both spend on TTS and both are gated.
    if (opts.stage === "animatic" || opts.stage === "video") {
      await assertVoicesAccepted({ videoRoot: opts.videoRoot, manager, direction, reference });
    }
  }
}

// The stage-file gates, run beside the direction gate at every spend: a `"prompt"` input still
// naming an exclusion aborts with PROMPT_CHECK_FAILED, a `pin` input wired to something that is not
// a frame with PIN_CHECK_FAILED, a `jsxImage` class Tailwind cannot build with
// COMPOSITION_CLASS_INVALID. Stage-scoped like the direction gate — an untouched stage never blocks
// a spend on this one. A finding points the author at the stage's entry file.
export async function gateStageChecks(
  definition: PromptCheckSubject & PinCheckSubject & DefinitionLike,
  stage: Stage,
): Promise<void> {
  const where = STAGE_ENTRY_FILE[stage];
  assertPromptGate(definition, where);
  assertPinGate(definition, where);
  if (stage === "direction") return;
  await assertTailwindClasses(
    listAssetPaths(definition, stage).flatMap((address) => {
      const entry = getAssetEntryByAddress(definition, address);
      return entry.kind === "local" && entry.operation === "render"
        ? [{ label: address, html: entry.inputs.html as string }]
        : [];
    }),
  );
}

// The direction must be reviewed and accepted by a human (in `konte preview direction`) before any
// animatic/video spend — the gate mirrors `assertCharactersAccepted`. Which parts it demands
// narrows once the piece has been signed off end to end; `directionAcceptanceView` owns that split.
//
// The blocking parts are named, with both ways to clear one: the page is where a reviewer reads a
// whole box, but a single part settled elsewhere is a one-liner.
export function assertDirectionAccepted(opts: {
  manager: StateManager;
  direction: Direction;
}): void {
  const acceptance = opts.manager.getDirectionAcceptance();
  if (isDirectionSpendGateSatisfied(opts.direction, acceptance)) return;

  const { gateBlocking } = directionAcceptanceView(opts.direction, acceptance);
  const clear = "`konte preview direction`, or `konte accept direction:<part>` per part";
  if (gateBlocking.length === 0) {
    // Nothing live is blocking, so what re-blocked the gate is a part that was DELETED since it was
    // accepted — there is no address to point at, only the fact that the page changed shape.
    throw new KonteError(
      "DIRECTION_ACCEPTANCE_REQUIRED",
      `The direction lost a part that was accepted — review and re-accept it before this spend: ${clear} (\`--off\` clears a deleted part's sign-off).`,
    );
  }
  const lines = gateBlocking.map(
    ({ address, status }) =>
      `  ${address} — ${status === "stale" ? "changed since it was accepted" : "never accepted"}`,
  );
  throw new KonteError(
    "DIRECTION_ACCEPTANCE_REQUIRED",
    `${gateBlocking.length} part(s) of the direction must be reviewed and accepted before this ` +
      `spend — ${clear}:\n${lines.join("\n")}`,
  );
}

// Sign-off a spend may build on: strict resolution's own verdict, which is what the spend then
// resolves with. It keeps the acceptance-only policy — a HUMAN accept passes however stale it has
// since become — while refusing the two an accept does not stand behind: a take that produced no
// file, and one konte accepted itself that has since gone stale.
function acceptedForSpend(manager: StateManager, address: string): boolean {
  return manager.selectVariant(address, { requireAccepted: true }) !== null;
}

// A cast reference asset is "satisfied" when `reference:<id>` has an accepted variant.
async function isCastReferenceSatisfied(
  id: string,
  opts: {
    videoRoot: string;
    manager: StateManager;
    reference: ReferenceDefinition | null;
  },
): Promise<boolean> {
  return acceptedForSpend(opts.manager, formatReferenceAddress(id));
}

// The characters whose `reference:<id>` look anchor is not satisfied yet.
export async function unsatisfiedCharacters(opts: {
  videoRoot: string;
  manager: StateManager;
  direction: Direction | null;
  reference: ReferenceDefinition | null;
}): Promise<Array<{ id: string } & Character>> {
  const out: Array<{ id: string } & Character> = [];
  for (const [id, c] of Object.entries(opts.direction?.characters ?? {})) {
    if (!(await isCastReferenceSatisfied(id, opts))) out.push({ id, ...c });
  }
  return out;
}

// The cast voices whose sample is not satisfied yet — every declared character voice plus the
// narrator's, each labelled by who it belongs to.
export async function unsatisfiedVoices(opts: {
  videoRoot: string;
  manager: StateManager;
  direction: Direction | null;
  reference: ReferenceDefinition | null;
}): Promise<Array<{ assetId: string; who: string }>> {
  // One sample may be cast twice (a narrator who is the protagonist, twins), and it is one asset to
  // accept — so it is named once, by everyone who is cast on it.
  const whoById = new Map<string, string[]>();
  const addCast = (assetId: string, who: string) => {
    const existing = whoById.get(assetId);
    if (existing) existing.push(who);
    else whoById.set(assetId, [who]);
  };
  for (const [id, c] of Object.entries(opts.direction?.characters ?? {})) {
    if (c.voice) addCast(c.voice.id, `${c.name} (${id})`);
  }
  if (opts.direction?.narrator) addCast(opts.direction.narrator.id, "the narrator");

  const out: Array<{ assetId: string; who: string }> = [];
  for (const [assetId, who] of whoById) {
    if (!(await isCastReferenceSatisfied(assetId, opts))) {
      out.push({ assetId, who: who.join(", ") });
    }
  }
  return out;
}

// A `direction` character is anchored to a `reference:<id>` asset that must be reviewed and
// accepted in `konte preview reference` — never implicitly through a shot that consumes it — so a
// spend command consuming an un-accepted character aborts with CHARACTER_ACCEPTANCE_REQUIRED.
export async function assertCharactersAccepted(opts: {
  videoRoot: string;
  manager: StateManager;
  direction: Direction | null;
  reference: ReferenceDefinition | null;
}): Promise<void> {
  const unsatisfied = await unsatisfiedCharacters(opts);
  if (unsatisfied.length === 0) return;

  const lines = unsatisfied.map((c) => {
    const hint =
      opts.reference?.topLevelAssets?.[c.id]?.kind === "file"
        ? "place its file under assets/files/, then accept it in `konte preview reference`"
        : "review and accept it in `konte preview reference`";
    return `  ${formatReferenceAddress(c.id)} — ${hint}`;
  });
  throw new KonteError(
    "CHARACTER_ACCEPTANCE_REQUIRED",
    `${unsatisfied.length} character reference(s) must be accepted before this spend — a character ` +
      `is never accepted implicitly through a shot that uses it:\n${lines.join("\n")}`,
  );
}

// The audio twin of `assertCharactersAccepted`: cloning a voice from a sample nobody listened to is
// the failure the look gate exists to prevent, one stage over. Both composition stages — the lines
// are recorded on the animatic, and a video build may still call an audio adapter of its own.
export async function assertVoicesAccepted(opts: {
  videoRoot: string;
  manager: StateManager;
  direction: Direction | null;
  reference: ReferenceDefinition | null;
}): Promise<void> {
  const unsatisfied = await unsatisfiedVoices(opts);
  if (unsatisfied.length === 0) return;

  const lines = unsatisfied.map((v) => {
    const hint =
      opts.reference?.topLevelAssets?.[v.assetId]?.kind === "file"
        ? "place its file under assets/files/, then accept it in `konte preview reference`"
        : "review and accept it in `konte preview reference`";
    return `  ${formatReferenceAddress(v.assetId)} — ${v.who}: ${hint}`;
  });
  throw new KonteError(
    "VOICE_ACCEPTANCE_REQUIRED",
    `${unsatisfied.length} cast voice sample(s) must be accepted before this spend — how someone ` +
      `sounds is a human call, never settled implicitly by a shot that speaks:\n${lines.join("\n")}`,
  );
}

// The stages that can sit upstream of a spend and are reviewed by a human, in pipeline order — so
// the ones a spend below them must find accepted, and the step that clears each. `direction` is
// absent because its acceptance is `assertDirectionAccepted`'s; `video` because nothing is
// downstream of it.
const GATED_UPSTREAM: ReadonlyArray<{ stage: Stage; review: string; generate: string }> = [
  { stage: "reference", review: "konte preview reference", generate: "konte generate reference" },
  { stage: "animatic", review: "konte preview animatic", generate: "konte generate animatic" },
];

// The reviewed upstream work a spend would build on, mapped to whether each has an output to review
// yet — the cross-stage twin of `assertDirectionAccepted`. Acceptance only: a stale accepted
// upstream still passes, staleness having its own reporting. `stage` is the stage doing the
// spending: its own nodes are walked through (so a `animatic → video → video` chain cannot slip
// past by targeting the far end), as are the deterministic ones. The walk stops at every gated
// upstream node — its own upstreams were reviewed as part of it, which is why accepting a board
// does not re-ask for the sheets under it. `extraRefs` carries addresses consumed by something with
// no graph node of its own, i.e. a patch definition's refs.
export function unacceptedUpstreamDeps(opts: {
  manager: StateManager;
  graph: DependencyGraph;
  assetPaths: Iterable<string>;
  stage: Stage;
  extraRefs?: Iterable<string>;
}): Map<string, boolean> {
  const blocking = new Map<string, boolean>();
  const seen = new Set<string>();
  const queue: string[] = [...(opts.extraRefs ?? [])];
  for (const assetPath of opts.assetPaths) {
    queue.push(...(opts.graph.dependencies.get(assetPath) ?? []));
  }

  while (queue.length > 0) {
    const dep = queue.pop()!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    const stage = getStage(dep);
    if (stage === opts.stage || !GATED_UPSTREAM.some((u) => u.stage === stage)) {
      queue.push(...(opts.graph.dependencies.get(dep) ?? []));
      continue;
    }
    if (acceptedForSpend(opts.manager, dep)) continue;
    const variants = Object.values(opts.manager.getState().assets[dep]?.variants ?? {});
    blocking.set(
      dep,
      // A dismissed take is not output awaiting a verdict: that upstream needs regenerating.
      variants.some((v) => v.file && v.status !== "dismissed"),
    );
  }
  return blocking;
}

// The upstream twin of the direction acceptance gate: a spend must not build on work no human has
// accepted. Two levels of the same rule — a video spend needs its boards accepted, and either
// creative stage needs the `reference:` sheets it conditions on accepted, since a sheet is where
// every take downstream of it gets its identity from and is never settled implicitly by whatever
// consumed it first. The upstream-most blocker is reported alone: accepting a board built on an
// unaccepted sheet is not the fix, so naming both would send the human at the wrong one.
export function assertUpstreamAccepted(opts: {
  manager: StateManager;
  graph: DependencyGraph;
  assetPaths: Iterable<string>;
  stage: Stage;
  extraRefs?: Iterable<string>;
  animatic: AnimaticDefinition;
}): void {
  // Whole-stage, matching the refusal of `konte preview animatic`: a board with an unwritten panel is
  // not reviewable, whatever this spend reaches.
  for (const { stage } of GATED_UPSTREAM) {
    if (stage === opts.stage) continue;
    assertPrerequisitesMet(
      findUnmetPrerequisites(stage, { animatic: opts.animatic }, opts.manager.getState()),
      `Cannot spend on ${opts.stage}`,
    );
  }

  const blocking = unacceptedUpstreamDeps(opts);
  if (blocking.size === 0) return;

  // GATED_UPSTREAM is in pipeline order, so the first entry with a blocker is the upstream-most.
  const upstream = GATED_UPSTREAM.find(({ stage }) =>
    [...blocking.keys()].some((address) => getStage(address) === stage),
  );
  if (!upstream) return;
  const named = [...blocking].filter(([address]) => getStage(address) === upstream.stage);

  const lines = named.map(
    ([address, hasOutput]) =>
      `  ${address} — ${
        hasOutput
          ? `review and accept it in \`${upstream.review}\``
          : `nothing generated yet — run \`${upstream.generate}\` first`
      }`,
  );
  throw new KonteError(
    upstream.stage === "reference"
      ? "REFERENCE_ACCEPTANCE_REQUIRED"
      : "ANIMATIC_ACCEPTANCE_REQUIRED",
    upstream.stage === "reference"
      ? `${named.length} reference asset(s) this ${opts.stage} spend conditions on must be accepted ` +
          `first — a sheet is never accepted implicitly through what consumes it:\n${lines.join("\n")}`
      : `${named.length} animatic asset(s) this video spend builds on must be accepted first — the ` +
          `board and the lines that drive the motion are reviewed before motion is spent on ` +
          `them:\n${lines.join("\n")}`,
  );
}

// The gate above only reaches the boards a video spend consumes, so a shot that consumes none at all
// routes around it. A shot the video is not ready to wire stays a `pendingShot`, which
// `PENDING_SHOTS` holds at export.
export function assertAnimaticConsumed(opts: {
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  graph: DependencyGraph;
  // The shots this run will put a vendor spend on. A whole-stage spend (`generate video`, `export`)
  // omits it and each shot's own `spends` answers. A targeted run (`reroll`, `patch apply`) names
  // them: what it spends on is not what the definition carries — one rerolled asset, a patch step —
  // and naming them also keeps a boardless shot it is not touching from blocking it.
  spendingShotIds?: Iterable<string>;
}): void {
  const named = opts.spendingShotIds ? new Set(opts.spendingShotIds) : null;
  // Only a shot that spends is refused — see `BoardlessVideoShot.spends`.
  const boardless = listBoardlessVideoShots(opts.video, opts.animatic, opts.graph)
    .filter((s) => (named ? named.has(s.shotId) : s.spends))
    .map((s) => s.shotId);
  if (boardless.length === 0) return;
  throw new KonteError(
    "ANIMATIC_UNCONSUMED",
    `${boardless.length} video shot(s) spend without building on the board they develop:\n` +
      boardless.map((id) => `  video:shot.${id} — animatic:shot.${id}`).join("\n") +
      `\nBuild each from its own board shot (a panel image, \`.stem\` — not \`.narrationStem\`, ` +
      `which builds nothing) — develop that board shot first if it is still a pendingShot — or ` +
      `leave the shot as pendingShot("<id>") in video.tsx ` +
      `until it is wired.`,
  );
}

// What the setups class reads off the board: which setups have a plate, which plates stand on no
// location reference, and which developed shots reach neither anchor. **undefined when the board
// could not be read**, and that distinction is the contract: an unreadable board cannot owe plates,
// while a readable one that declares none owes every plate its shared setups call for. Mirrors
// `reference?.exposedAssetNames` at the same call sites.
export async function loadAnimaticSetupState(
  videoRoot: string,
  direction: Direction,
): Promise<AnimaticSetupState | undefined> {
  const animatic = await loadAnimatic(videoRoot).catch(() => null);
  if (!animatic) return undefined;
  const locationBySetup = new Map(
    Object.entries(direction.setups ?? {}).map(([id, s]) => [id, s.location]),
  );
  const gaps = listSetupAnchorGaps(animatic, collectShotFrames(direction), locationBySetup);
  // Only the declared windows: a root (`within: null`) and an undeclared one are cut from whatever
  // they like.
  const withinBySetup = new Map(
    Object.entries(direction.setups ?? {}).flatMap(([id, s]) =>
      typeof s.within === "string" ? [[id, s.within] as const] : [],
    ),
  );
  return {
    plateIds: animatic.exposedPlateIds ?? Object.keys(animatic.plates ?? {}),
    unanchoredPlateIds: gaps.unanchoredPlates,
    unnestedPlateIds: listSetupNestGaps(animatic, withinBySetup),
    unconsumedBy: gaps.unanchoredShots,
    deterministicShotsPerSetup: gaps.deterministicShots,
  };
}

// The stage-side half of the staging class: the order the board hands each keyframe its references
// in, and how each shot on a plated setup carries its plate. Same contract as
// `loadAnimaticSetupState` — **undefined when the board could not be read**, so
// `slot-order-mismatch` stays silent rather than firing on nothing.
export async function loadStagingStageState(
  videoRoot: string,
  direction: Direction,
): Promise<StagingStageState | undefined> {
  const animatic = await loadAnimatic(videoRoot).catch(() => null);
  if (!animatic) return undefined;
  const frames = collectShotFrames(direction);
  // video.tsx is read for the seams alone, so it is read only when the direction declares one —
  // otherwise every status/doctor pass would evaluate the whole video stage for nothing.
  const seams = frames.some((f) => f.join === "continuous");
  const video = seams
    ? await loadVideoDefinition(stageEntryPath(videoRoot, "video")).catch(() => null)
    : null;
  return {
    panelSlots: listPanelReferenceSlots(animatic),
    panelReach: listPanelReferenceReach(animatic),
    plateUses: listPlateDescriptionUses(animatic, frames),
    panelPrompts: listPanelPromptText(animatic),
    platePrompts: animatic.platePrompts ?? {},
    videoPins: video ? listVideoShotPins(video, (id) => harvestShotPictureCues(video, id)) : [],
    shotPanels: listShotContinuity(animatic),
  };
}

export async function loadVideoAndAnimatic(
  videoRoot: string,
): Promise<{ video: VideoDefinition; animatic: AnimaticDefinition }> {
  // Load animatic before video, not in parallel: video.tsx statically imports the animatic
  // module, so a failure during animatic evaluation otherwise resurfaces from video's import as
  // an unrelated TDZ error ("Cannot access 'animatic' before initialization"). Surfacing the
  // animatic error first keeps the diagnostic pointed at the real cause.
  const animatic = await loadAnimatic(videoRoot);
  const videoPath = stageEntryPath(videoRoot, "video");
  const video = await loadVideoDefinition(videoPath);
  assertNarrationStemsPlaced(video, animatic);
  return { video, animatic };
}

// The three stage entries a video holds — what a whole-project read (status, generate, accept,
// prune, …) loads before resolving addresses or building the dependency graph.
export interface StageDefinitions {
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  reference: ReferenceDefinition;
}

export async function loadStageDefinitions(videoRoot: string): Promise<StageDefinitions> {
  const { video, animatic } = await loadVideoAndAnimatic(videoRoot);
  const reference = await loadReference(videoRoot);
  return { video, animatic, reference };
}

export async function loadDefinitionForAddress(
  videoRoot: string,
  address: string,
): Promise<DefinitionLike> {
  const stage = getStage(address);
  switch (stage) {
    case "reference":
      return loadReference(videoRoot);
    case "animatic":
      return loadAnimatic(videoRoot);
    case "video":
      return loadVideoDefinition(stageEntryPath(videoRoot, "video"));
    case "direction":
      throw new KonteError(
        "INVALID_ADDRESS",
        `Address "${address}" references the direction stage, which is feedback-only with no asset definition`,
      );
    default:
      return assertNever(stage, "loadDefinitionForAddress");
  }
}
