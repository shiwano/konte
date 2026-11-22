import type { ShotFunction } from "../types/definition.js";
import { makeMediaAsset, type MediaAsset, type MediaKind } from "../types/media.js";
import type { ShotStage } from "../address.js";
import { formatAddress, formatSongStemAddress } from "../address.js";
import { KonteError } from "../errors.js";
import type { ScriptLine } from "../types/script.js";
import type {
  AsideShotContext,
  CutinOf,
  DirectionIdTuple,
  GraphicShotContext,
  LineupOf,
  LineupToOf,
  ScriptOf,
  ShotClockContext,
  ShotLyricsContext,
  ShotSongOf,
  StageChain,
  StageCutinContext,
  StageShotContext,
  StepId,
  StepIds,
  StepRest,
} from "./animatic-builders.js";
import type { ShotHandle, StageShots } from "./builders.js";
import {
  isPendingShotInput,
  type AnyShotInput,
  type AsideShotInput,
  type PendingShotInput,
  type ShotInput,
} from "./shot-input.js";
import type { DirectionIndex } from "./direction.js";
import {
  beatTime,
  lyricsInSpan,
  onFrames,
  shotStartsOf,
  songUnread,
} from "./direction-timeline.js";
import { markPanel, shotPanelsOf } from "./panel-collect.js";
import type { DiscoveryResult } from "./shot-context.js";
import {
  getActiveFormat,
  makeAddressPlaceholder,
  makePlaceholder,
  runInDiscoveryMode,
  withShotSongStem,
} from "./shot-context.js";
import type { ShotScript } from "./shot-script.js";
import { makeShotScript } from "./shot-script.js";
import { withSongSpan } from "./song-window.js";
import { validateShotId } from "./validate-identifier.js";

// The `shot` injected into a stage's timeline ctx — one starter type for both, since both stages
// author a shot the same way. `id` is pinned to the first direction shot (`StepId`) and it returns a
// chain whose `.nextShot` mints the successor shot; order and full coverage are enforced by the type
// (see StageChain). Its build returns a `<Composition>`.
export type StageShotStarter<D, TStage extends ShotStage> = <TId extends string>(
  id: StepId<D, DirectionIdTuple<D>, TId, "shot", true>,
  // `shot` is here so the ctx has one shape across the whole chain; its `TIds` is `never` at the
  // first shot, so there is no id it will take.
  build: (
    ctx: StageShotContext<ScriptOf<D, TId>, LineupOf<D, TId>, LineupToOf<D, TId>, CutinOf<D, TId>> &
      ShotSongOf<D> & {
        shot: StageShots<never>;
      },
  ) => ReturnType<ShotFunction>,
) => StartChain<D, TId, TStage>;

// The `graphicShot` injected alongside `shot`, for a shot of the arc with no camera. Its build
// receives no frame, and returns a `<Composition>` whose picture is its own layers.
export type StageGraphicShotStarter<D, TStage extends ShotStage> = <TId extends string>(
  id: StepId<D, DirectionIdTuple<D>, TId, "graphicShot", true>,
  build: (
    ctx: GraphicShotContext<ScriptOf<D, TId>, CutinOf<D, TId>> &
      ShotSongOf<D> & { shot: StageShots<never> },
  ) => ReturnType<ShotFunction>,
) => StartChain<D, TId, TStage>;

// The `pendingShot` injected alongside `shot`: starts the chain from an undeveloped shot (everything
// about it — duration, action — is the direction's, so it takes nothing but the id), so a stage file
// can mirror the whole direction before every shot is built. Swap it for `shot` or `graphicShot` to
// develop.
export type StagePendingShotStarter<D, TStage extends ShotStage> = <TId extends string>(
  id: StepId<D, DirectionIdTuple<D>, TId, "pendingShot", true>,
) => StartChain<D, TId, TStage>;

// The `asideShot` starters, one per stage, because the two place an aside differently (see
// `AsideShotInput`). The animatic's takes the id alone; the video's builds the picture.
export type StageAsideShotStarter<D> = <TId extends string>(
  id: StepId<D, DirectionIdTuple<D>, TId, "asideShot", true>,
) => StartChain<D, TId, "animatic">;
export type VideoAsideShotStarter<D> = <TId extends string>(
  id: StepId<D, DirectionIdTuple<D>, TId, "asideShot", true>,
  build: (ctx: AsideShotContext & ShotSongOf<D>) => ReturnType<ShotFunction>,
) => StartChain<D, TId, "video">;

type StartChain<D, TId extends string, TStage extends ShotStage> = StageChain<
  D,
  StepRest<DirectionIdTuple<D>, TId>,
  StepIds<DirectionIdTuple<D>, TId>,
  TStage
>;

// The chain's `shot` — the by-name accessors below, resolving against an already-placed shot's
// build. It cannot be a bare proxy: a stage discovers its shots only after `timeline()` has
// returned, so the names have to be learned by running the closure.
export const makeStageShots = (stage: ShotStage, placed: readonly AnyShotInput[]): StageShots => {
  let byId: Map<string, AnyShotInput> | null = null;
  return (shotId: string): ShotHandle => {
    // Lazily, because most builds never reach for another shot and the chain mints one accessor per
    // link — indexing eagerly would cost a pass over every placed shot at every link.
    byId ??= new Map(placed.map((input) => [input.id, input]));
    const target = byId.get(shotId);
    if (target === undefined) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `shot("${shotId}"): the ${stage} chain has not placed a shot "${shotId}" yet. A build ` +
          `reaches the shots BEFORE it, in direction order. Placed so far: ` +
          `${[...byId.keys()].join(", ") || "(none)"}.`,
      );
    }
    // An undeveloped shot declares nothing to check against: the address is minted as asked, and the
    // graph finds the asset built on it (`pending-reference`) until the shot is developed.
    if (isPendingShotInput(target)) return pendingShotHandle(stage, shotId);
    return makeAssetNameHandle(
      stage,
      `shot("${shotId}")`,
      shotId,
      () => shotDeclarations(stage, target),
      shotPanelsOf(target),
    );
  };
};

const pendingShotHandle = (stage: ShotStage, shotId: string): ShotHandle => {
  const get = <T extends MediaKind>(assetName: string): MediaAsset<T> =>
    makeMediaAsset<T>(makePlaceholder(stage, shotId, assetName));
  return { video: get, image: get, audio: get };
};

// Learning what a shot's build declared means running it — the chain holds only its closure. It is a
// pure function, so run it lazily in discovery mode (a nested run saves/restores the ambient
// context) and memoize per shot input. Keyed by the input object rather than the id: the chain
// re-wraps its list at every link but carries the same input objects through, so one run per shot
// serves the whole chain however many later shots reach back to it.
type ShotDeclarations = Pick<DiscoveryResult, "assetKinds" | "songSpans">;

const declarationsByInput = new WeakMap<AnyShotInput, ShotDeclarations>();

const shotDeclarations = (
  stage: ShotStage,
  input: Exclude<AnyShotInput, PendingShotInput>,
): ShotDeclarations => {
  const cached = declarationsByInput.get(input);
  if (cached) return cached;
  if (input.fn === undefined) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `shot("${input.id}"): ${stage} shot "${input.id}" is an aside the ${stage} does not board, ` +
        `so it declares no assets. Reach the media it drops in from a timeline or reference asset instead.`,
    );
  }
  const format = getActiveFormat();
  const { assetKinds, songSpans } = runInDiscoveryMode(
    stage,
    input.id,
    input.fn,
    format && { ...format, duration: input.options.duration },
  );
  const declarations = { assetKinds, songSpans };
  declarationsByInput.set(input, declarations);
  return declarations;
};

// The `shot` a chain's FIRST shot receives. Its `TIds` is `never`, so typed code cannot call it.
const noShotsPlaced =
  (stage: ShotStage): StageShots =>
  (shotId: string): ShotHandle => {
    throw new KonteError(
      "VALIDATION_FAILED",
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
  declarations: () => ShotDeclarations,
  panels?: ReadonlySet<string>,
): ShotHandle => {
  const get = <T extends MediaKind>(assetName: string, want: T): MediaAsset<T> => {
    const { assetKinds, songSpans } = declarations();
    const found = assetKinds.get(assetName);
    if (found === undefined) {
      const names = [...assetKinds.keys()];
      throw new KonteError(
        "VALIDATION_FAILED",
        `${label}.${want}("${assetName}"): ${stage} shot "${shotId}" declares no asset named ` +
          `"${assetName}". Declared: ${names.join(", ") || "(none)"}.`,
      );
    }
    if (found !== want) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `${label}.${want}("${assetName}"): ${stage} shot "${shotId}"'s asset "${assetName}" is ` +
          `${found}, not ${want}. Use ${label}.${found}("${assetName}").`,
      );
    }
    const handed = withSongSpan(
      makeMediaAsset<T>(makePlaceholder(stage, shotId, assetName)),
      songSpans.get(assetName),
    );
    return panels?.has(formatAddress(stage, shotId, assetName)) ? markPanel(handed) : handed;
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
    throw new KonteError(
      "VALIDATION_FAILED",
      `nextShot() was called after the final direction shot "${lastId}"; the chain already covers every shot.`,
    );
  }
  if (passedId !== nextId) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `nextShot("${passedId}") is not the shot that follows "${lastId}" in the direction; expected "${nextId}".`,
    );
  }
  return nextId;
};

const shotScriptOf = (index: DirectionIndex, shotId: string): ShotScript =>
  makeShotScript(index.scriptById.get(shotId) ?? []);

// A shot's span in seconds, for a build to read. A piece cut to its song has none until a take of it
// is read.
function shotDurationOf(index: DirectionIndex, shotId: string): number {
  const duration = index.durationById.get(shotId);
  if (duration === null) throw songUnread(index.timeline.song!);
  return duration!;
}

// `ctx.beat`, on a direction cut to its song, counted from the beat the shot's span starts on — the
// first shot's head is the take's start, before that beat.
const shotClockOf = (
  index: DirectionIndex,
  shotId: string,
): Partial<ShotClockContext & ShotLyricsContext> => {
  const { fps, timings } = index.timeline;
  const timing = timings.get(shotId);
  if (!timing || timing.start === null || timing.startBeat === undefined) return {};
  const startBeat = timing.startBeat;
  return {
    beat: (n: number) => onFrames(beatTime(index.timeline, startBeat + n) - timing.start, fps),
    ...(index.lyrics
      ? { lyrics: lyricsInSpan(index.lyrics, timing.start, timing.duration, fps) }
      : {}),
  };
};

// The mirror of `asideShotContext`'s guard, for the starters that place a shot of the ARC. `.nextShot` reads
// its shot eagerly through `stageShotContext` and carries its own; the starters and `.nextPendingShot` build
// lazily or not at all, so they check here rather than at discovery. `pendingShot` takes either kind
// of arc shot; `shot` only a narrative one.
const requireArcShot = (index: DirectionIndex, fnName: string, id: string): void => {
  if (index.asideIds.has(id)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${fnName}("${id}") is an aside shot. Use asideShot("${id}").`,
    );
  }
};

const requireNarrativeShot = (index: DirectionIndex, fnName: string, id: string): void => {
  requireArcShot(index, fnName, id);
  if (index.graphicIds.has(id)) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `${fnName}("${id}") is a graphic shot. Use graphicShot("${id}", …).`,
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
    throw new KonteError(
      "VALIDATION_FAILED",
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
    throw new KonteError(
      "VALIDATION_FAILED",
      `graphicShot("${shotId}") is not a graphic shot — direction.ts declares it as ${index.asideIds.has(shotId) ? "an aside. Use asideShot" : "a narrative shot. Use shot"}("${shotId}", …).`,
    );
  }
  return {
    duration: shotDurationOf(index, shotId),
    script: shotScriptOf(index, shotId),
    cutin: cutinContext(index, shotId),
    ...shotClockOf(index, shotId),
  };
};

// The shot facts an aside build receives — the span and what the span is. The kind guard is the
// runtime twin of `AsideIdOf`: the type already forbids a narrative id here, so this only catches a
// computed one, and it fails before the author's build reads a `label` the direction never gave.
const asideShotContext = (index: DirectionIndex, shotId: string): AsideShotContext => {
  const label = index.labelById.get(shotId);
  if (label === undefined) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `asideShot("${shotId}") is not an aside shot — direction.ts declares it as an ordinary shot. Use shot("${shotId}", …).`,
    );
  }
  return { duration: shotDurationOf(index, shotId), label, ...shotClockOf(index, shotId) };
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
    throw new KonteError(
      "VALIDATION_FAILED",
      `shot "${shotId}" has setup "${setup}", which direction.ts does not declare in \`setups\`.`,
    );
  }
  return {
    duration: shotDurationOf(index, shotId),
    setup,
    framing,
    location,
    script: shotScriptOf(index, shotId),
    lineup: index.lineupById.get(shotId) ?? [],
    lineupTo: index.lineupToById.get(shotId) ?? null,
    cutin: cutinContext(index, shotId),
    ...shotClockOf(index, shotId),
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

// A video shot of a piece cut to its song hears the board's `#songStem` of its own span.
const stageShotBuild = (
  stage: ShotStage,
  index: DirectionIndex,
  id: string,
  fn: ShotFunction,
): ShotFunction => {
  const timing = index.timeline.timings.get(id);
  if (stage !== "video" || !index.timeline.song || !timing) return fn;
  if (timing.start === null) throw songUnread(index.timeline.song);
  const shotStarts = shotStartsOf(index.timeline);
  const stem = makeMediaAsset<"audio">(makeAddressPlaceholder(formatSongStemAddress(id)));
  return withShotSongStem(fn, withSongSpan(stem, { start: timing.start, shotStarts }));
};

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
    throw new KonteError("VALIDATION_FAILED", `asideShot("${id}") on the video needs a build.`);
  }
  if (stage === "animatic" && build) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `asideShot("${id}") on the animatic takes no build — konte fills an aside's span with a labelled slug.`,
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
      fn: stageShotBuild(stage, index, nextId, () => build({ ...facts, shot: placedShot })),
      options: { duration: shotDurationOf(index, nextId), action: index.actionById.get(nextId)! },
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
      fn: stageShotBuild(stage, index, nextId, () => build({ ...facts, shot: placedShot })),
      options: { duration: shotDurationOf(index, nextId), action: index.actionById.get(nextId)! },
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
      options: { duration: shotDurationOf(index, nextId), action: index.actionById.get(nextId)! },
    };
    return makeStageChain(stage, index, [...shots, nextInput]);
  },
  nextAsideShot(id, build) {
    const nextId = directionSuccessor(index, shots[shots.length - 1]!.id, id);
    return makeStageChain(stage, index, [...shots, makeAsideInput(stage, index, nextId, build)]);
  },
});

// The starters a stage's timeline ctx receives, typed against the direction.
export type StageStarters<D, TStage extends ShotStage> = {
  shot: StageShotStarter<D, TStage>;
  graphicShot: StageGraphicShotStarter<D, TStage>;
  pendingShot: StagePendingShotStarter<D, TStage>;
  asideShot: TStage extends "video" ? VideoAsideShotStarter<D> : StageAsideShotStarter<D>;
};

// Builds the starters bound to `index` and a stage, untyped; `openStage` types them as
// `StageStarters`.
export function makeStageShotStarter(stage: ShotStage, index: DirectionIndex) {
  const requireShot = (fnName: string, id: string): number => {
    validateShotId(id);
    if (!index.durationById.has(id)) {
      // The type system already forbids unknown ids; this only guards a computed/forged id.
      throw new KonteError(
        "VALIDATION_FAILED",
        `${fnName}("${id}") is not a declared direction shot. ` +
          `Declared: ${[...index.durationById.keys()].join(", ") || "(none)"}.`,
      );
    }
    return shotDurationOf(index, id);
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
      fn: stageShotBuild(stage, index, id, () =>
        build({ ...stageShotContext(index, id), shot: noShotsPlaced(stage) }),
      ),
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
      fn: stageShotBuild(stage, index, id, () => build({ ...facts, shot: noShotsPlaced(stage) })),
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
