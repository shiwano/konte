import {
  type DefinitionLike,
  type Stage,
  formatPlateAssetPath,
  formatReferenceAddress,
  getStage,
  isMaterializedLeafAddress,
} from "../core/address.js";
import { assertNever } from "../core/assert.js";
import {
  collectFramedCharacterIds,
  collectShotFrames,
  setupView,
  type SongTakeState,
  type StagingStageState,
} from "../core/direction.js";
import { resolveSongTake, songAddressOf } from "../core/song-take.js";
import { mediaDurationSec } from "../core/variant-media.js";
import { StateManager } from "../core/state/index.js";
import type { Character, Direction } from "../core/dsl/direction.js";
import { KonteError } from "../core/errors.js";
import { type LoadedDefinitions, loadShotStages } from "../core/select-definition.js";
import {
  listPanelPromptText,
  listPanelReferenceReach,
  listPanelReferenceSlots,
  listPlateRecrops,
  listPlateTexts,
  listSetupAnchorGaps,
  listViewAnchorGaps,
  listSetupNestGaps,
  listShotContinuity,
  listShownReferences,
  listVideoShotPins,
  listVideoPasserInputs,
  type DependencyGraph,
} from "../core/graph.js";
import type { AnimaticSetupState } from "../core/direction-check.js";
import { assertNarrationStemsPlaced } from "../core/narration-stem.js";
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
import { stageEntryPath } from "../core/roots.js";
import { collectUndecidedUpstreamTakes, computeAcceptedStaleness } from "../core/staleness.js";
import { definitionHashForAddress } from "../core/composition-resource.js";

// The direction (direction.ts). Absent file => null; an existing but invalid file throws.
export function loadDirectionIfPresent(videoRoot: string): Promise<Direction | null> {
  return loadIfPresent(stageEntryPath(videoRoot, "direction"), loadDirectionDefinition);
}

// Sign-off a spend may build on: strict resolution's own verdict, which is what the spend then
// resolves with. It keeps the acceptance-only policy — a HUMAN accept passes however stale it has
// since become — while refusing the two an accept does not stand behind: a take that produced no
// file, and one konte accepted itself that has since gone stale.
function acceptedForSpend(manager: StateManager, address: string): boolean {
  return manager.selectVariant(address, { requireAccepted: true }) !== null;
}

// The characters some frame's lineup holds whose `reference:<id>` look anchor is not accepted yet.
export function unsatisfiedCharacters(opts: {
  manager: StateManager;
  direction: Direction | null;
}): Array<{ id: string } & Character> {
  if (!opts.direction) return [];
  const framed = collectFramedCharacterIds(opts.direction);
  const out: Array<{ id: string } & Character> = [];
  for (const [id, c] of Object.entries(opts.direction.characters ?? {})) {
    if (!framed.has(id)) continue;
    if (!acceptedForSpend(opts.manager, formatReferenceAddress(id))) out.push({ id, ...c });
  }
  return out;
}

// The cast voices whose sample is not accepted yet — every declared character voice plus the
// narrator's, each labelled by who it belongs to.
export function unsatisfiedVoices(opts: {
  manager: StateManager;
  direction: Direction | null;
}): Array<{ assetId: string; who: string }> {
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
    if (!acceptedForSpend(opts.manager, formatReferenceAddress(assetId))) {
      out.push({ assetId, who: who.join(", ") });
    }
  }
  return out;
}

// The stages that can sit upstream of a spend and are reviewed by a human, in pipeline order — so
// the ones a spend below them must find accepted, and the step that clears each. `direction` is
// absent because its acceptance is per part (`directionAcceptanceView`); `video` because nothing is
// downstream of it.
const GATED_UPSTREAM: ReadonlyArray<{ stage: Stage; review: string; generate: string }> = [
  { stage: "reference", review: "konte preview reference", generate: "konte generate reference" },
  { stage: "animatic", review: "konte preview animatic", generate: "konte generate animatic" },
];

export type UpstreamBlocker =
  | { kind: "unaccepted"; hasOutput: boolean }
  | { kind: "undecided"; acceptedVariantId: string; undecidedVariantId: string };

// The reviewed upstream work a spend would build on, mapped to what holds each back — the
// cross-stage twin of the direction's acceptance. A stale accepted upstream still passes, staleness
// having its own reporting. `stage` is the stage doing the
// spending: its own nodes are walked through (so a `animatic → video → video` chain cannot slip
// past by targeting the far end), as are the deterministic ones. The walk stops at every gated
// upstream node — its own upstreams were reviewed as part of it, which is why accepting a board
// does not re-ask for the sheets under it. `extraRefs` carries addresses consumed by something with
// no graph node of its own, i.e. a patch definition's refs. `redone` names upstreams this same run
// makes a fresh take of, which the spend builds on in place of the undecided one.
export function unacceptedUpstreamDeps(opts: {
  manager: StateManager;
  graph: DependencyGraph;
  assetPaths: Iterable<string>;
  stage: Stage;
  extraRefs?: Iterable<string>;
  redone?: ReadonlySet<string>;
}): Map<string, UpstreamBlocker> {
  const blocking = new Map<string, UpstreamBlocker>();
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
    if (acceptedForSpend(opts.manager, dep)) {
      if (opts.redone?.has(dep)) continue;
      const [take] = collectUndecidedUpstreamTakes(
        opts.manager.getState(),
        [dep],
        opts.manager.stalenessCache(),
      );
      if (take) {
        blocking.set(dep, {
          kind: "undecided",
          acceptedVariantId: take.acceptedVariantId,
          undecidedVariantId: take.undecidedVariantId,
        });
      }
      continue;
    }
    const variants = Object.values(opts.manager.getState().assets[dep]?.variants ?? {});
    blocking.set(dep, {
      kind: "unaccepted",
      // A dismissed take is not output awaiting a verdict: that upstream needs regenerating.
      hasOutput: variants.some((v) => v.file && v.status !== "dismissed"),
    });
  }
  return blocking;
}

// The upstream-most blockers alone: accepting a board built on an unaccepted sheet is not the fix,
// so naming both would send the human at the wrong one. GATED_UPSTREAM is in pipeline order, so the
// first entry with a blocker is the upstream-most.
export function upstreamMostBlockers(blocking: Map<string, UpstreamBlocker>): {
  upstream: (typeof GATED_UPSTREAM)[number];
  lines: string[];
} | null {
  const upstream = GATED_UPSTREAM.find(({ stage }) =>
    [...blocking.keys()].some((address) => getStage(address) === stage),
  );
  if (!upstream) return null;
  const lines = [...blocking]
    .filter(([address]) => getStage(address) === upstream.stage)
    .map(
      ([address, blocker]) =>
        `  ${address} — ${
          blocker.kind === "undecided"
            ? `${blocker.undecidedVariantId} is undecided beside accepted ` +
              `${blocker.acceptedVariantId} — review it in \`${upstream.review}\``
            : isMaterializedLeafAddress(address)
              ? `run \`konte accept ${address}\`, which materializes it`
              : blocker.hasOutput
                ? `review and accept it in \`${upstream.review}\``
                : `nothing generated yet — run \`${upstream.generate}\` first`
        }`,
    );
  return { upstream, lines };
}

// What the setups class reads off the board: which setups have a plate, which plates stand on no
// location reference, and which developed shots reach neither anchor. **undefined when the board
// could not be read**, and that distinction is the contract: an unreadable board cannot owe plates,
// while a readable one that declares none owes every plate its shared setups call for. Mirrors
// `reference?.exposedAssetNames` at the same call sites.
export async function loadAnimaticSetupState(
  videoRoot: string,
  direction: Direction,
  reference: ReferenceDefinition | null,
): Promise<AnimaticSetupState | undefined> {
  const animatic = await loadAnimatic(videoRoot).catch(() => null);
  if (!animatic) return undefined;
  const manager = await StateManager.load(videoRoot).catch(() => null);
  return animaticSetupState(direction, animatic, reference, manager);
}

// The same off a board already read.
export function animaticSetupState(
  direction: Direction,
  animatic: AnimaticDefinition,
  reference: ReferenceDefinition | null,
  manager: StateManager | null,
): AnimaticSetupState {
  const state = manager?.getState() ?? null;
  const setups = direction.setups ?? {};
  const locationBySetup = new Map(Object.entries(setups).map(([id, s]) => [id, s.location]));
  const viewBySetup = new Map(
    Object.keys(setups).flatMap((id) => {
      const view = setupView(setups, id);
      return view ? [[id, view] as const] : [];
    }),
  );
  const gaps = listSetupAnchorGaps(
    animatic,
    collectShotFrames(direction),
    locationBySetup,
    viewBySetup,
    (address) => manager !== null && isSignedOff(manager, animatic, address),
  );
  // Only the declared windows: a root (`within: null`) and an undeclared one are cut from whatever
  // they like.
  const withinBySetup = new Map(
    Object.entries(direction.setups ?? {}).flatMap(([id, s]) =>
      typeof s.within === "string" ? [[id, s.within] as const] : [],
    ),
  );
  const plateIds = animatic.exposedPlateIds ?? Object.keys(animatic.plates ?? {});
  return {
    plateIds,
    unanchoredPlateIds: gaps.unanchoredPlates,
    unnestedPlateIds: listSetupNestGaps(animatic, withinBySetup),
    unconsumedBy: gaps.unanchoredShots,
    signedOffUnconsumedBy: gaps.signedOffUnanchoredShots,
    deterministicShotsPerSetup: gaps.deterministicShots,
    signedOffShotsPerSetup: gaps.signedOffShots,
    deterministicPlateIds: gaps.deterministicPlates,
    unviewedPlateIds: gaps.unviewedPlates,
    unviewedBy: gaps.unviewedShots,
    unanchoredViews: reference ? listViewAnchorGaps(reference) : [],
    acceptedPlateIds: plateIds.filter((id) =>
      Object.values(state?.assets[formatPlateAssetPath(id)]?.variants ?? {}).some(
        (variant) => variant.status === "accepted",
      ),
    ),
  };
}

// The take of the song the piece is read against, as the song class reads it.
export function songTakeState(manager: StateManager, direction: Direction): SongTakeState {
  const address = songAddressOf(direction);
  const take = address ? resolveSongTake(manager.videoRoot, manager.getState(), address) : null;
  const media = take
    ? manager.getState().assets[take.address]?.variants?.[take.variantId]?.media
    : undefined;
  return { take, durationSec: mediaDurationSec(media ?? null) };
}

// The same off a video root, undefined where its state cannot be read.
export async function loadSongTakeState(
  videoRoot: string,
  direction: Direction,
): Promise<SongTakeState | undefined> {
  const manager = await StateManager.load(videoRoot).catch(() => null);
  return manager ? songTakeState(manager, direction) : undefined;
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
  const video = await loadVideoDefinition(stageEntryPath(videoRoot, "video")).catch(() => null);
  const manager = await StateManager.load(videoRoot).catch(() => null);
  return stagingStageState(direction, animatic, video, manager);
}

// The same off the stages already read.
export function stagingStageState(
  direction: Direction,
  animatic: AnimaticDefinition,
  video: VideoDefinition | null,
  manager: StateManager | null,
): StagingStageState {
  const frames = collectShotFrames(direction);
  const passers = frames.some((f) => (f.passing?.length ?? 0) > 0);
  const signedOff = (address: string) =>
    manager !== null && isSignedOff(manager, animatic, address);
  const mark = (address: string) => (signedOff(address) ? { signedOff: true as const } : {});
  const plateTexts = listPlateTexts(animatic);
  return {
    panelSlots: listPanelReferenceSlots(animatic),
    panelReach: listPanelReferenceReach(animatic).map((p) => ({ ...p, ...mark(p.panel) })),
    plateRecrops: listPlateRecrops(animatic, frames),
    panelPrompts: listPanelPromptText(animatic).map((p) => ({ ...p, ...mark(p.panel) })),
    plateTexts,
    signedOffPlateIds: Object.keys(plateTexts).filter((id) => signedOff(formatPlateAssetPath(id))),
    shownReferences: listShownReferences(animatic),
    videoPins: video
      ? listVideoShotPins(
          video,
          (id) => harvestShotPictureCues(video, id),
          manager ? (address) => isSignedOff(manager, video, address) : undefined,
        )
      : [],
    ...(passers && video
      ? {
          videoPassers: listVideoPasserInputs(video, animatic, (id) =>
            harvestShotPictureCues(video, id),
          ),
        }
      : {}),
    shotPanels: listShotContinuity(animatic).map((p) => ({ ...p, ...mark(p.firstPanel) })),
  };
}

// An accept whose inputs alone moved stands.
function isSignedOff(
  manager: StateManager,
  def: VideoDefinition | AnimaticDefinition,
  address: string,
): boolean {
  const accepted = computeAcceptedStaleness(
    manager.getState(),
    address,
    definitionHashForAddress(def, address),
    manager.stalenessCache(),
  );
  return accepted.variantId !== null && !accepted.definitionStale;
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
export async function loadStageDefinitions(videoRoot: string): Promise<LoadedDefinitions> {
  const shots = await loadShotStages(videoRoot, () => loadVideoAndAnimatic(videoRoot));
  return { reference: await loadReference(videoRoot), ...shots };
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
