import { formatShotStemAddress } from "../address.js";
import type { ShotStage } from "../address.js";
import { KonteError } from "../errors.js";
import type { AnimaticDefinition } from "../types/animatic.js";
import type { AssetDefinition } from "../types/index.js";
import type { ScriptLine } from "../types/script.js";
import { lineText } from "../types/script.js";
import type { ShotScript } from "./shot-script.js";
import type { AnyShotInput, MediaAsset, OverlayContext, SoundtrackEntry } from "./builders.js";
import { readAnimaticShot } from "./animatic.js";
import { type AnimaticRef, createAnimaticRef } from "./animatic-ref.js";
import type {
  DirectionEntry,
  Framing,
  StageAsideShotStarter,
  StageGraphicShotStarter,
  StagePendingShotStarter,
  StageShotStarter,
} from "./direction.js";
import {
  getDirectionIndex,
  makeAnimaticShotStarter,
  shotDurationOf,
  shotStartsOf,
  type DirectionIndex,
} from "./direction.js";
import { beginPromptCollection } from "./prompt-collect.js";
import { assertRespellings, beginRespellCollection } from "./respell.js";
import { getShotContext, makeDraftPlaceholder, runInDraftDiscoveryMode } from "./shot-context.js";
import { asset } from "./adapter.js";
import { videoFrame } from "./adapters/local.js";
import { makeMediaAsset } from "./builders.js";
import type { Identifier } from "./validate-identifier.js";
import { deriveDraftSize } from "../canvas.js";
import { formatDraftAssetPath } from "../address.js";
import { scriptTexts } from "./shot-script.js";
import type { ShotFunction } from "./shot-context.js";
import { defineStage } from "./stage-define.js";
import { assertCuesFitShot, tightenDerivedClipLengths } from "../clip-fit.js";
import {
  assertNarrationAttributable,
  attachCueKinds,
  saysLine,
  spokenTextsUnder,
} from "../spoken-text.js";

// The direction's shot ids as an ORDERED tuple, flattened across the arc tree in depth-first direction order.
// Unlike `ShotIdOf<D>` (an unordered union) this preserves order, so a chain can compute each shot's
// successor and enforce that a stage walks the direction start-to-end with nothing skipped.
// A leaf's ids: a homomorphic mapped type over the tuple, so the whole leaf is one pass. A recursive
// `[H["id"], ...MapIds<T>]` walk would instead cap at ~50 shots (TypeScript's non-tail recursion
// limit) and cost O(N²) below that, since every link re-materializes the tuple it accumulated.
type MapIds<S extends readonly { id: string }[]> = { [K in keyof S]: S[K]["id"] };
// One node's shot ids in order: a leaf's `shots`, or a branch's children flattened recursively (a
// child may itself be a branch, so the recursion nests to any depth).
type NodeIdTuple<N> = N extends { shots: infer S extends readonly { id: string }[] }
  ? MapIds<S>
  : N extends { sequences: infer Q extends readonly unknown[] }
    ? FlattenNodeIds<Q>
    : [];
// The sibling walk accumulates (tail position, so no ~50 ceiling). It concatenates once per arc
// *node* rather than once per shot, and an arc holds a handful of nodes, so the quadratic term here
// is over the node count and stays negligible.
type FlattenNodeIds<Q extends readonly unknown[], Acc extends string[] = []> = Q extends readonly [
  infer H,
  ...infer T extends readonly unknown[],
]
  ? FlattenNodeIds<T, [...Acc, ...NodeIdTuple<H>]>
  : Acc;
export type DirectionIdTuple<D> = D extends { sequence: infer Root } ? NodeIdTuple<Root> : never;

// The same walk over the shots themselves rather than their ids, so a chain step can read the shot it
// is placing — today its `script`, which types that shot's speaker keys. Kept apart from the id tuple,
// which is threaded through every chain link as a cursor.
type NodeShotTuple<N> = N extends { shots: infer S extends readonly { id: string }[] }
  ? S
  : N extends { sequences: infer Q extends readonly unknown[] }
    ? FlattenNodeShots<Q>
    : [];
type FlattenNodeShots<
  Q extends readonly unknown[],
  Acc extends readonly { id: string }[] = [],
> = Q extends readonly [infer H, ...infer T extends readonly unknown[]]
  ? FlattenNodeShots<T, [...Acc, ...NodeShotTuple<H>]>
  : Acc;
export type DirectionShotTuple<D> = D extends { sequence: infer Root }
  ? NodeShotTuple<Root>
  : never;

type ShotOf<D, TId extends string> = Extract<DirectionShotTuple<D>[number], { id: TId }>;

// One shot's script, as a literal tuple. No such shot (a `D` that never inferred as a direction
// literal — the runtime path) widens to `ScriptLine[]`; a shot that declares no script is the empty
// tuple, which leaves the injected script with no keys.
export type ScriptOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? readonly ScriptLine[]
  : ShotOf<D, TId> extends { script: infer S extends readonly ScriptLine[] }
    ? S
    : readonly [];

// One shot's `lineup` / `lineupTo`, as a literal tuple — so a build reads `ctx.lineup[0]` as the id
// it actually is and a typo in the prompt-writing code is a type error. `lineup` is required, so it
// widens to the empty tuple rather than to `null` (the `ScriptOf` shape); `lineupTo` keeps `null`
// where the shot ends on the frame it opened on, which is what a build branches on.
export type LineupOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? readonly string[]
  : ShotOf<D, TId> extends { lineup: infer L extends readonly string[] }
    ? L
    : readonly [];
export type LineupToOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? readonly string[] | null
  : ShotOf<D, TId> extends { lineupTo: infer L extends readonly string[] }
    ? L
    : null;

// One shot's `cutin`, as the frame a build receives — its lineup pair as literal tuples the way
// `LineupOf` / `LineupToOf` read the shot's own, `null` where the shot declares none.
export type CutinOf<D, TId extends string> = [ShotOf<D, TId>] extends [never]
  ? StageCutinContext | null
  : ShotOf<D, TId> extends { cutin: infer C }
    ? StageCutinContext<
        C extends { lineup: infer L extends readonly string[] } ? L : readonly [],
        C extends { lineupTo: infer L extends readonly string[] } ? L : null
      >
    : null;

/**
 * The first direction shot — the only id a chain may start at. Everything after is computed, never typed.
 */
export type FirstShotId<D> = Head<DirectionIdTuple<D>>;

// The shots a chain has yet to cover, in direction order — the cursor both stages thread, and the
// only thing they carry about the direction. A step reads its own id off the front (`Head`) and hands
// the remainder on (`Tail`). Carrying the last *id* instead would make every step re-scan the id
// tuple for the shot it just placed, so a long piece pays for the walk twice over.
export type ChainRest<D> = Tail<DirectionIdTuple<D>>;
// `never` on an empty rest, which is what closes the chain: `.nextShot`'s `id` becomes uncallable.
export type Head<Ids extends readonly string[]> = Ids extends readonly [
  infer A extends string,
  ...string[],
]
  ? A
  : never;
export type Tail<Ids extends readonly string[]> = Ids extends readonly [
  string,
  ...infer R extends string[],
]
  ? R
  : [];

/**
 * The shot values a stage `build` receives, injected from the direction. `framing` and `location` are
 * read through the shot's `setup`.
 */
export type StageShotContext<
  S extends readonly ScriptLine[],
  L extends readonly string[] | null = readonly string[] | null,
  LT extends readonly string[] | null = readonly string[] | null,
  C extends StageCutinContext | null = StageCutinContext | null,
> = {
  duration: number;
  // The frame this shot is taken from — the `setups` roster id.
  setup: string;
  framing: Framing;
  location: string;
  script: ShotScript<S>;
  // The direction's declaration, handed over unchanged: who this frame holds, left to right, and
  // the order the shot leaves behind. konte never expands either into prompt text, so a prompt says
  // them only because the author wrote them out. `null` = the shot declares none.
  lineup: L;
  // Non-null exactly when the order changes inside the shot — `if (ctx.lineupTo)` is the branch that
  // owes the panel a `blocking` note carrying the move.
  lineupTo: LT;
  // The second camera frame the shot lays over its picture, `null` where it declares none. Its
  // keyframes go inside `<Cutin>`.
  cutin: C;
};

/**
 * The second camera frame over a shot, as a build receives it: the direction's `cutin` with its
 * `framing` and `location` read through its setup, and its lineup pair handed over unchanged.
 */
export type StageCutinContext<
  L extends readonly string[] = readonly string[],
  LT extends readonly string[] | null = readonly string[] | null,
> = {
  setup: string;
  framing: Framing;
  location: string;
  lineup: L;
  lineupTo: LT;
};

/**
 * The shot values a GRAPHIC build receives.
 */
export type GraphicShotContext<
  S extends readonly ScriptLine[],
  C extends StageCutinContext | null = StageCutinContext | null,
> = {
  duration: number;
  script: ShotScript<S>;
  cutin: C;
};

/**
 * `beat(n)`: the second, from the shot's head, of its `n`th beat — read off the song's own grid, so a
 * beat lands on the same frame whichever shot counts to it. Only a direction with `policy.song` has
 * one.
 */
export type ShotClockContext = { beat: (n: number) => number };
export type ShotClockOf<D> = D extends { policy: { song: string } } ? ShotClockContext : {};

/**
 * `lyrics`: the lyric lines the shot hears, each with the `characters` ids singing it and its
 * seconds from the shot's head — where the song take sings it. A line sung from before the shot
 * starts at 0; one sung past its end runs past it. Only a direction with `lyrics` has them.
 */
export type ShotLyricsContext = {
  lyrics: readonly { text: string; singer: readonly string[]; start: number; end: number }[];
};
export type ShotLyricsOf<D> = D extends { lyrics: object } ? ShotLyricsContext : {};
// Everything a shot's build reads off the song: its beat grid and its lines.
export type ShotSongOf<D> = ShotClockOf<D> & ShotLyricsOf<D>;

/**
 * The shot values an ASIDE build receives. The four fields describing a camera view are absent, not
 * blank. Only the video builds an aside.
 */
export type AsideShotContext = {
  duration: number;
  label: string;
};

// The next shot's id, narrowed to the kind of starter that may place it. It reads one shot at one
// position, so it costs an `Extract` per chain link rather than a filtered walk of the id tuple.
//
// A `D` that never inferred as a direction literal (the runtime path) leaves `ShotOf` as `never`;
// both helpers pass the id straight through there, so an untyped caller is unconstrained rather
// than locked out. `never` in (a chain that reached the end) yields `never` out, which is what
// closes the chain.
type IsAsideShot<D, Id extends string> = ShotOf<D, Id> extends { kind: "aside" } ? true : false;
type IsGraphicShot<D, Id extends string> = ShotOf<D, Id> extends { kind: "graphic" } ? true : false;
export type NarrativeIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsAsideShot<D, Id> extends true
    ? never
    : IsGraphicShot<D, Id> extends true
      ? never
      : Id;
export type GraphicIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsGraphicShot<D, Id> extends true
    ? Id
    : never;
// A shot of the arc of either kind — what `pendingShot` takes.
export type ArcIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsAsideShot<D, Id> extends true
    ? never
    : Id;
export type AsideIdOf<D, Id extends string> = [ShotOf<D, Id>] extends [never]
  ? Id
  : IsAsideShot<D, Id> extends true
    ? Id
    : never;

/**
 * A chain that has not yet reached the final direction shot carries this branded string as `__complete`
 * instead of `true`, so returning it from `timeline` fails with a message naming the first gap.
 */
export type ChainIncomplete<Missing extends string> =
  `konte: shot chain is missing shot "${Missing}" — keep calling .nextShot until every direction shot is covered`;
export type ChainComplete<TRest extends readonly string[]> = TRest extends readonly []
  ? true
  : ChainIncomplete<Head<TRest>>;

export type { ShotHandle, StageShots } from "./builders.js";

/**
 * A stage's shot list, built by walking the direction with `.nextShot` / `.nextPendingShot`. The
 * injected `shot(firstId, …)` or `pendingShot(firstId)` starts it (id pinned to `FirstShotId`); each
 * step mints the *successor* shot — its id is computed from the direction, never passed — and hands
 * every shot placed so far to the build as `shot`. `timeline` must return a chain whose `__complete` is
 * `true`, which only holds once the last shot is reached, so order and full coverage are both
 * enforced by the type. `__shotIds` accumulates the covered ids so timeline soundtrack anchors are
 * checked against them. No terminal call: the engine reads `__shots` directly.
 */
export interface StageChain<
  D,
  TRest extends readonly string[],
  TIds extends string,
  TStage extends ShotStage,
> {
  readonly __complete: ChainComplete<TRest>;
  readonly __shots: readonly AnyShotInput[];
  readonly __shotIds: TIds;
  // `id` is required for legibility (each block self-labels which shot it is) and pinned to the
  // direction's successor of the current shot — passing any other id is a type error, so the label can
  // never drift from the order the chain actually walks. An aside successor makes this uncallable:
  // there is no camera view to author, so the id resolves to `never` and `.nextAsideShot` is the
  // only step that fits. A graphic successor likewise leaves `.nextGraphicShot` the only build.
  nextShot(
    id: NarrativeIdOf<D, Head<TRest>>,
    build: (
      ctx: StageShotContext<
        ScriptOf<D, Head<TRest>>,
        LineupOf<D, Head<TRest>>,
        LineupToOf<D, Head<TRest>>,
        CutinOf<D, Head<TRest>>
      > &
        ShotSongOf<D> & {
          shot: import("./builders.js").StageShots<TIds>;
        },
    ) => ReturnType<ShotFunction>,
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
  // The graphic successor: a shot of the arc with no camera. Its composition is the picture itself —
  // no `<Panel>` outside a `<Cutin>` on the board.
  nextGraphicShot(
    id: GraphicIdOf<D, Head<TRest>>,
    build: (
      ctx: GraphicShotContext<ScriptOf<D, Head<TRest>>, CutinOf<D, Head<TRest>>> &
        ShotSongOf<D> & {
          shot: import("./builders.js").StageShots<TIds>;
        },
    ) => ReturnType<ShotFunction>,
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
  // The undeveloped successor: everything about it is the direction's, so it takes nothing but the
  // id — a narrative or a graphic shot alike.
  nextPendingShot(
    id: ArcIdOf<D, Head<TRest>>,
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
  // The aside successor. The video builds it (usually a `file`); the animatic takes the id alone and
  // konte fills the span with a labelled slug.
  nextAsideShot(
    id: AsideIdOf<D, Head<TRest>>,
    ...build: TStage extends "video"
      ? [build: (ctx: AsideShotContext & ShotSongOf<D>) => ReturnType<ShotFunction>]
      : []
  ): StageChain<D, Tail<TRest>, TIds | Head<TRest>, TStage>;
}

/**
 * The structural witness a stage's `timeline.shots` requires: a chain that reached the end.
 */
export type StageTerminal<TIds extends string = string> = {
  readonly __complete: true;
  readonly __shots: readonly AnyShotInput[];
  readonly __shotIds: TIds;
};

/**
 * A stage `timeline` always returns an object: the completed shot chain under `shots` (a bare `[]`
 * for an empty or not-yet-authored stage), plus optional timeline-spanning `soundtracks` whose
 * anchors are checked against the shots' ids.
 */
export type StageTimelineReturn<Ids extends string = string, D = unknown> = {
  shots: StageTerminal<Ids> | readonly never[];
  // NoInfer: the shot-id set is fixed by the chain; soundtrack anchors are checked against it.
  soundtracks?: ReadonlyArray<SoundtrackEntry<NoInfer<Ids>>>;
  // The picture layer over every shot (see `OverlayContext`).
  overlay?: (ctx: OverlayContext<D>) => React.ReactElement;
};

/**
 * The shot ids a draft may cover. A `D` that never inferred as a direction literal leaves it `string`.
 */
export type DraftShotIdOf<D> = [DirectionIdTuple<D>] extends [never]
  ? string
  : DirectionIdTuple<D>[number];

/**
 * A draft's cut list as a multi-shot prompt takes it: the first shot's text, then each later shot
 * with the second its cut falls on, counted from the take's head on the direction's clock.
 */
export type DraftCuts = [string, ...{ at: number; text: string }[]];

/**
 * What one draft's build receives.
 */
export type DraftBuildContext<TId extends string = string> = {
  // The take's length: the sum of its shots' durations, in seconds.
  duration: number;
  // One text per shot of the draft, in order, laid on the direction's cut times.
  cuts: (text: (id: TId) => string) => DraftCuts;
  // The draft take just before this one in direction order, cut to its last seconds — as many as
  // this take runs — a reference clip to continue from. `undefined` on the first take and wherever the
  // place changes between the two.
  previous: MediaAsset<"video"> | undefined;
};

/**
 * One draft take as `timeline` receives it. `frame` declares an asset of the shot being built —
 * `animatic:shot.<id>.<name>`, the take's frame at `at` seconds — for a panel to be drawn from.
 */
export interface AnimaticDraft<TId extends string = string> {
  frame<TName extends string>(
    id: TId,
    name: TName & Identifier<TName>,
    opts: { at: number },
  ): MediaAsset<"image">;
}

export type DraftStarter<D> = <
  const TIds extends readonly [DraftShotIdOf<D>, ...DraftShotIdOf<D>[]],
>(
  ids: TIds,
  build: (ctx: DraftBuildContext<TIds[number]>) => MediaAsset<"video">,
) => AnimaticDraft<TIds[number]>;

// Not `AnimaticDraft<string>`: `frame`'s id is a parameter, so a draft over two ids is not
// assignable to one over every string.
export type AnimaticDrafts = Record<string, AnimaticDraft<never>>;

export interface DefineAnimaticOptions<
  D = unknown,
  Ids extends string = string,
  TDrafts extends AnimaticDrafts = AnimaticDrafts,
> {
  // The draft takes, each addressed `animatic:draft.<name>`: consecutive camera shots generated as
  // one small clip. A panel is drawn from a frame of it (`drafts.<name>.frame(…)`). konte derives
  // each take's cut times, length and size. It runs before `timeline`, which receives what it
  // returned.
  drafts?: (args: { draft: DraftStarter<D> }) => TDrafts;
  // Prompt findings this stage accepts, keyed the way `konte status` prints them
  // (`prompt-negation:<hash>`) over the reason each is right for the model it is written for. One
  // key covers every address a shared phrase reaches; never a fixable one — rewrite that prompt.
  waivers?: Record<string, string>;
  // The single authoring surface: declare any timeline assets with asset() at the top, then walk the
  // direction — `shot(firstId, …).nextShot(…)…` — and return it under `shots`, optionally with
  // timeline-spanning `soundtracks` (a temp bed to judge the pacing against). The chain must be
  // complete (every direction shot covered), which its `__complete` brand enforces at this return.
  // `format` is the working canvas derived from the direction.
  timeline: (args: {
    format: import("../types/index.js").VideoFormat;
    shot: StageShotStarter<D, "animatic">;
    // The graphic starter: a shot with no camera, its picture built whole in the composition.
    graphicShot: StageGraphicShotStarter<D, "animatic">;
    pendingShot: StagePendingShotStarter<D, "animatic">;
    // The aside starter. It takes the id alone; konte fills the span with a labelled slug.
    asideShot: StageAsideShotStarter<D>;
    // The drafts `drafts` returned — `{}` when it declared none.
    drafts: TDrafts;
  }) => StageTimelineReturn<Ids, D>;
}

/**
 * The animatic: the storyboard laid on the direction's clock, with the shot's lines sounding over
 * it. Each shot returns a `<Composition>` whose keyframes are `<Panel>`s and whose spoken lines are
 * `<Audio>`; konte derives the shot's mixed-down `#stem` from those cues, clamped to the shot, and
 * the video stage takes both the keyframes and the stem as its inputs.
 */
export function defineAnimatic<
  const D,
  Ids extends string = string,
  TDrafts extends AnimaticDrafts = AnimaticDrafts,
>(
  direction: DirectionEntry<D>,
  opts: DefineAnimaticOptions<D, Ids, TDrafts>,
): AnimaticDefinition & AnimaticRef {
  const index = getDirectionIndex(direction);
  const starter = makeAnimaticShotStarter(index);
  const shot = starter.shot as unknown as StageShotStarter<D, "animatic">;
  const graphicShot = starter.graphicShot as unknown as StageGraphicShotStarter<D, "animatic">;
  const pendingShot = starter.pendingShot as unknown as StagePendingShotStarter<D, "animatic">;
  const asideShot = starter.asideShot as unknown as StageAsideShotStarter<D>;

  beginPromptCollection(scriptTexts(index.scriptById));
  beginRespellCollection();
  // Before the timeline: a shot's panel takes a frame of its draft as an input, so the placeholders
  // must exist by the time the chain is walked. Prompt collection already spans both.
  const drafts = buildDrafts(index, opts.drafts as DraftsCallback | undefined);
  const built = defineStage({
    stage: "animatic",
    index,
    runTimeline: (format) =>
      opts.timeline({
        format,
        shot,
        graphicShot,
        pendingShot,
        asideShot,
        drafts: drafts.returned as TDrafts,
      }),
    waivers: opts.waivers,
    perShot: ({ input, element, context, cutin }) => {
      const continuedBy = index.continuedById.get(input.id);
      const { panels, cutinPanels } = readAnimaticShot({
        shotId: input.id,
        element,
        context,
        ...(continuedBy ? { continuedBy } : {}),
      });
      if (index.graphicIds.has(input.id)) {
        if (panels.length > 0) {
          throw new KonteError(
            "ANIMATIC_INVALID",
            `Animatic shot "${input.id}" is a graphic shot, but it declares <Panel> ` +
              `"${panels[0]!.assetName}" outside a <Cutin>. A graphic shot has no camera: place ` +
              `its images as <Image> layers and move them with <Animate>. A keyframe belongs inside ` +
              `the <Cutin> of a shot that declares a \`cutin\`.`,
          );
        }
      } else if (panels.length === 0) {
        throw new KonteError(
          "PANEL_REQUIRED",
          `Animatic shot "${input.id}" declares no <Panel>. A board shot IS its keyframes — mark ` +
            `at least one image with <Panel>; a plain <Image> is a layer, not a keyframe.`,
        );
      }
      if (cutin && cutinPanels.length === 0) {
        throw new KonteError(
          "PANEL_REQUIRED",
          `Animatic shot "${input.id}" renders a <Cutin> with no <Panel> inside it. A cutin is a ` +
            `camera frame, and a board frame IS its keyframes — mark its image with <Panel>.`,
        );
      }
      return {
        ...(panels.length > 0 || !index.graphicIds.has(input.id) ? { panels } : {}),
        ...(cutin ? { cutin: { ...cutin, panels: cutinPanels } } : {}),
        ...(continuedBy ? { continuedBy } : {}),
      };
    },
  });
  const definition = built.definition as AnimaticDefinition;
  if (drafts.assets) {
    definition.drafts = drafts.assets;
    definition.draftShots = drafts.shots;
  }

  assertRespellings(definition.respellings, index.scriptById);
  assertScriptVoiced(definition, index);
  tightenDerivedClipLengths(definition, built.clipLengths);
  assertCuesFitShot(definition, built.clipLengths);
  assertNarrationAttributable(definition, index.scriptById);
  attachCueKinds(definition, index.scriptById);
  splitNarrationStems(definition);

  const songShotStarts = index.timeline.song ? shotStartsOf(index.timeline) : undefined;
  return Object.assign(
    definition,
    createAnimaticRef(definition, built.assetKindsByShot, songShotStarts),
  );
}

// A narration cue feeds `#narrationStem`, never the `#stem` a motion model takes.
function splitNarrationStems(definition: AnimaticDefinition): void {
  for (const shot of definition.shots) {
    const cues = shot.stemRefs ?? [];
    const narration = cues.filter((ref) => shot.cueKinds?.[ref] === "narration");
    if (narration.length === 0) continue;
    shot.stemRefs = cues.filter((ref) => shot.cueKinds?.[ref] !== "narration");
    shot.narrationStemRefs = narration;
  }
}

// A shot the direction gives spoken lines to must sound them. The same class of definition error as
// a cycle or a missing ref, and reported the same way by every command that loads the animatic:
// without a voice take the piece comes out silent, with no failure until it is watched.
// State-independent by design — it turns only on whether the direction gives the shot lines and
// whether animatic.tsx answers with audio. A pending shot is exempt; a `telop`-only shot is not
// scripted, so it never applies.
function assertScriptVoiced(
  definition: AnimaticDefinition,
  index: { scriptById: ReadonlyMap<string, readonly ScriptLine[]> },
): void {
  for (const shot of definition.shots) {
    if (shot.pending) continue;
    const lines = index.scriptById.get(shot.id) ?? [];
    if (lines.length === 0) continue;
    if ((shot.stemRefs?.length ?? 0) === 0) {
      throw new KonteError(
        "SCRIPT_UNVOICED",
        `Animatic shot "${shot.id}" has spoken lines in the direction but plays no audio. Place them ` +
          `with <Audio src={asset("vo", …)}> in its <Composition>: the lines are what the motion is ` +
          `driven by, so they are recorded and reviewed before the shot is spent on. ` +
          `(${formatShotStemAddress("animatic", shot.id)} is derived from those cues.)`,
      );
    }
    // Per LINE, not per shot: a two-hander whose second line was never wired plays back short, and
    // the whole-shot rule passes it.
    //
    // A cue carrying no words is OPAQUE — a recording — and konte can say neither which lines it
    // holds nor how many, so ONE of them drops the whole shot back to the whole-shot rule. Counting
    // opaque cues as one line each instead refuses a single recording of a two-hander, and this is a
    // load error with no waiver to answer it.
    const perCue = (shot.stemRefs ?? []).map((ref) => spokenTextsUnder(definition, [ref]));
    if (perCue.some((texts) => texts.length === 0)) continue;
    const voiced = perCue.flat();
    // Either spelling answers for the line: the words the direction wrote, or one a `respell()`
    // declared for them.
    const unmatched = lines.filter((line) => !saysLine(definition, shot.id, voiced, line));
    if (unmatched[0]) {
      throw new KonteError(
        "SCRIPT_UNVOICED",
        `Animatic shot "${shot.id}" never voices the line \u201c${lineText(unmatched[0])}\u201d. Every ` +
          `line the direction gives the shot owes an <Audio src={asset(…)}> carrying it — add one, or ` +
          `move the words to \`telop\` if nobody says them. A model that misreads the words takes ` +
          `respell(script.<who>[n], "…") in their place.`,
      );
    }
  }
}

type DraftsCallback = (args: { draft: DraftStarter<unknown> }) => object;

type DraftEntry = {
  ids: readonly string[];
  build: (ctx: DraftBuildContext) => MediaAsset<"video">;
  handle: AnimaticDraft;
  name?: string;
  // Set once its build has run.
  take?: MediaAsset<"video">;
  duration?: number;
};

function invalidDraft(message: string): KonteError {
  return new KonteError("INVALID_DRAFT", `defineAnimatic: ${message}`);
}

// Run the `drafts` callback under its own discovery context. `draft()` only records a take; the
// builds run once the callback has returned, in direction order, so each can be handed the take
// before it.
function buildDrafts(
  index: DirectionIndex,
  fn: DraftsCallback | undefined,
): {
  assets: Record<string, AssetDefinition> | undefined;
  returned: object;
  shots: Record<string, string[]>;
} {
  if (!fn) return { assets: undefined, returned: {}, shots: {} };
  const clock = [...index.durationById.keys()];
  const fps = index.format.fps;
  const onFrames = (sec: number) => Math.round(sec * fps) / fps;
  const size = deriveDraftSize(index.format.size.delivery);
  const entries: DraftEntry[] = [];
  const draftOfShot = new Map<string, DraftEntry>();

  const draft = (ids: readonly string[], build: DraftEntry["build"]): AnimaticDraft => {
    if (ids.length === 0) throw invalidDraft("draft([]) covers no shot.");
    for (const id of ids) {
      if (!index.durationById.has(id)) {
        throw invalidDraft(`draft([…]) names shot "${id}", which direction.ts does not declare.`);
      }
      if (index.asideIds.has(id) || index.graphicIds.has(id)) {
        throw invalidDraft(
          `draft([…]) names shot "${id}", ${index.asideIds.has(id) ? "an aside" : "a graphic shot"}. ` +
            `A draft covers camera shots only — end the take before it and start the next after it.`,
        );
      }
    }
    const first = clock.indexOf(ids[0]!);
    ids.forEach((id, i) => {
      if (clock[first + i] !== id) {
        throw invalidDraft(
          `draft([${ids.join(", ")}]) is not a run of consecutive shots in direction order: ` +
            `"${clock[first + i] ?? "(the end)"}" follows "${ids[i - 1]}", not "${id}".`,
        );
      }
    });
    const entry: DraftEntry = {
      ids,
      build,
      handle: {
        frame: ((id: string, name: string, opts: { at: number }) =>
          draftFrame(entry, id, name, opts)) as AnimaticDraft["frame"],
      },
    };
    for (const id of ids) {
      if (draftOfShot.has(id)) {
        throw invalidDraft(`shot "${id}" is in two drafts. A shot's panels come from one take.`);
      }
      draftOfShot.set(id, entry);
    }
    entries.push(entry);
    return entry.handle;
  };

  // The take this one continues: the one holding the camera shot just before its first, asides and
  // graphic shots passed over, where both stand in one place.
  const previousOf = (entry: DraftEntry): DraftEntry | undefined => {
    for (let at = clock.indexOf(entry.ids[0]!) - 1; at >= 0; at--) {
      const id = clock[at]!;
      if (index.asideIds.has(id) || index.graphicIds.has(id)) continue;
      const before = draftOfShot.get(id);
      if (before?.take === undefined || before.ids.at(-1) !== id) return undefined;
      return index.locationById.get(id) === index.locationById.get(entry.ids[0]!)
        ? before
        : undefined;
    }
    return undefined;
  };

  const discovery = runInDraftDiscoveryMode((pool) => {
    const declared = fn({ draft: draft as DraftStarter<unknown> }) as Record<string, unknown>;
    for (const [name, handle] of Object.entries(declared)) {
      const entry = entries.find((e) => e.handle === handle);
      if (!entry) throw invalidDraft(`drafts."${name}" must be a draft([…], …) of this callback.`);
      if (entry.name !== undefined) {
        throw invalidDraft(`drafts."${entry.name}" and drafts."${name}" return the same draft.`);
      }
      entry.name = name;
    }
    const unreturned = entries.find((e) => e.name === undefined);
    if (unreturned) {
      throw invalidDraft(
        `draft([${unreturned.ids.join(", ")}]) was not returned from \`drafts\`. Return every draft ` +
          `under the name its asset("<name>", …) declares.`,
      );
    }

    entries.sort((a, b) => clock.indexOf(a.ids[0]!) - clock.indexOf(b.ids[0]!));
    for (const entry of entries) {
      const name = entry.name!;
      const durations = entry.ids.map((id) => shotDurationOf(index, id));
      const duration = onFrames(durations.reduce((sum, d) => sum + d, 0));
      entry.duration = duration;
      pool.format = { size, fps, duration, typography: index.typography };

      let previous: MediaAsset<"video"> | undefined | null = null;
      const ctx: DraftBuildContext = {
        duration,
        cuts: (text) => {
          let at = 0;
          const [first, ...rest] = entry.ids.map((id, i) => {
            const cut = { at: onFrames(at), text: text(id) };
            at += durations[i]!;
            return cut;
          });
          return [first!.text, ...rest];
        },
        // Read lazily: the cut is an asset of its own, declared only for a build that takes it.
        get previous() {
          if (previous !== null) return previous;
          const before = previousOf(entry);
          if (!before) return (previous = undefined);
          const cut = `${name}#previous`;
          pool.assets.set(cut, {
            kind: "local",
            operation: "trim",
            mediaType: "video",
            deterministic: true,
            inputs: { source: before.take!.src, start: "tail", duration },
          });
          return (previous = makeMediaAsset<"video">(makeDraftPlaceholder(cut)));
        },
      };
      const take = entry.build(ctx) as { src?: unknown } | null | undefined;
      if (take?.src !== makeDraftPlaceholder(name)) {
        throw invalidDraft(
          `drafts."${name}" must return the take its build declares as asset("${name}", …).`,
        );
      }
      // A take is replaced by `reroll` alone, which a file or a deterministic asset has none of.
      const def = pool.assets.get(name)!;
      if (def.kind === "file" || def.deterministic === true) {
        throw invalidDraft(
          `drafts."${name}" is ${def.kind === "file" ? "a file" : "a deterministic asset"}. A draft ` +
            `take is generated, so that a reroll can replace it — hand footage to a take as a ` +
            `reference.tsx asset instead.`,
        );
      }
      entry.take = take as MediaAsset<"video">;
    }
    // The pool holds takes and konte's own cuts, so an address under `animatic:draft` says which it
    // is with no definition to ask.
    const takes = new Set(entries.flatMap((e) => [e.name!, `${e.name!}#previous`]));
    const helper = [...pool.assets.keys()].find((name) => !takes.has(name));
    if (helper !== undefined) {
      throw invalidDraft(
        `asset("${helper}", …) under \`drafts\` is not a take a draft returns. \`drafts\` declares ` +
          `takes only — declare what a take is built from in reference.tsx and pass it in.`,
      );
    }
    return declared;
  });

  return {
    assets: Object.keys(discovery.assets).length > 0 ? discovery.assets : undefined,
    returned: discovery.result as object,
    shots: Object.fromEntries(entries.map((entry) => [entry.name!, [...entry.ids]])),
  };
}

// `drafts.<name>.frame(id, name, { at })`: `asset(name, videoFrame, { source: <the take>, at })` in
// the shot being built.
function draftFrame(
  entry: DraftEntry,
  id: string,
  name: string,
  opts: { at: number },
): MediaAsset<"image"> {
  const address = formatDraftAssetPath(entry.name ?? "?");
  if (entry.take === undefined || entry.duration === undefined) {
    throw invalidDraft(`${address}'s frame() was called before its take was declared.`);
  }
  if (!entry.ids.includes(id)) {
    throw invalidDraft(
      `${address} does not cover shot "${id}" — it covers ${entry.ids.join(", ")}.`,
    );
  }
  const shot = getShotContext();
  if (shot?.stage !== "animatic" || shot.shotId !== id) {
    throw invalidDraft(
      `frame("${id}", "${name}", …) declares an asset of animatic shot "${id}", so it is called ` +
        `inside that shot's build` +
        (shot ? `, not shot "${shot.shotId}"'s.` : "."),
    );
  }
  const at = opts.at;
  if (!Number.isFinite(at) || at < 0 || at >= entry.duration) {
    throw invalidDraft(
      `frame("${id}", "${name}", { at: ${String(at)} }) is outside ${address}, which runs ` +
        `${entry.duration}s. \`at\` is seconds from the take's head.`,
    );
  }
  return asset(name as never, videoFrame, { source: entry.take, at });
}
