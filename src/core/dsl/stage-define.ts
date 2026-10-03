import { formatReferenceAddress, type ShotStage } from "../address.js";
import { partitionShotRefs } from "../composition-refs.js";
import { renderToHtml, type RenderContext } from "../jsx-html.js";
import type {
  ShotDefinition,
  StageDefinition,
  TimelineFunction,
  Typography,
  VideoFormat,
} from "../types/index.js";
import { KonteError } from "../errors.js";
import type { AnyShotInput, MediaKind, SoundtrackEntry } from "./builders.js";
import type { OverlayDefinition } from "../types/index.js";
import { shotSongStem, spanSongContext } from "./direction.js";
import { isAsideShotInput, isPendingShotInput } from "./builders.js";
import { Composition } from "./composition/index.js";
import type { DirectionIndex } from "./direction.js";
import { endClipLengthCollection, type ClipLength } from "./clip-length-collect.js";
import { endImageInputCollection } from "./image-input-collect.js";
import { endPinCollection } from "./pin-collect.js";
import { endPromptCollection } from "./prompt-collect.js";
import { endRespellCollection } from "./respell.js";
import {
  collectPlaceholderRefs,
  parsePlaceholder,
  runInDiscoveryMode,
  runTimelineInDiscoveryMode,
} from "./shot-context.js";

// The two composition stages are built the same way — one timeline callback that declares shared
// assets and walks the direction, then one discovery pass per shot. This module is that shared
// build; `defineAnimatic` and `defineVideo` supply what is theirs (an animatic's keyframes and
// stem, a video's export wiring) through `perShot`.

// A shot's discovery-mode element is the raw `jsx(Composition, …)` result (Composition itself runs
// later, at renderToHtml), so its `type` is the Composition function reference — the signal that
// the shot's build returned a `<Composition>` at its top.
export function isCompositionElement(element: React.ReactElement): boolean {
  return (
    element != null &&
    typeof element === "object" &&
    (element as { type?: unknown }).type === Composition
  );
}

// What a stage's `timeline` returns: the completed shot chain under `shots` (a bare `[]` for an
// empty or not-yet-authored stage), plus optional timeline-spanning `soundtracks` whose anchors are
// checked against the shots' ids.
export function normalizeStageTimeline(result: unknown): {
  shots: Array<AnyShotInput>;
  soundtracks: SoundtrackEntry[];
  overlay: OverlayBuild | undefined;
} {
  const obj = (result ?? {}) as { shots?: unknown; soundtracks?: unknown; overlay?: unknown };
  const rawShots = obj.shots;
  // `shots` is either the chain (its shots in `__shots`) or a bare `[]` (an empty or
  // not-yet-authored stage).
  const shots = Array.isArray(rawShots)
    ? (rawShots as Array<AnyShotInput>)
    : ((rawShots as { __shots?: Array<AnyShotInput> } | undefined)?.__shots ?? []);
  return {
    shots,
    soundtracks: (obj.soundtracks as SoundtrackEntry[] | undefined) ?? [],
    overlay: typeof obj.overlay === "function" ? (obj.overlay as OverlayBuild) : undefined,
  };
}

// The stage's per-shot work, run after the shared discovery of one developed shot. Returns the
// fields to merge onto the shot definition.
export type PerShotHook = (args: {
  input: { id: string };
  element: React.ReactElement;
  context: RenderContext;
  assets: Record<string, ShotDefinition["assets"][string]>;
  compositionRefs: readonly string[];
  // The shot's `<Cutin>`, as the stage recorded it — undefined where it renders none.
  cutin: ShotDefinition["cutin"];
}) => Partial<ShotDefinition>;

export interface DefineStageArgs {
  stage: ShotStage;
  index: DirectionIndex;
  runTimeline: (format: VideoFormat) => unknown;
  waivers?: Record<string, string>;
  perShot?: PerShotHook;
}

export interface StageBuild {
  definition: StageDefinition;
  // Each shot's declared asset kinds, captured as it was discovered. An AssetDefinition carries no
  // media kind, so the cross-stage ref handle's kind check reads this.
  assetKindsByShot: ReadonlyMap<string, ReadonlyMap<string, MediaKind>>;
  // How long a clip each declared asset asks its model for. Read by the animatic's cue-fit check
  // and by the pass that narrows a count konte derived from the words.
  clipLengths: readonly ClipLength[];
}

export function defineStage(args: DefineStageArgs): StageBuild {
  const { stage, index, runTimeline, perShot } = args;
  const format: VideoFormat = { size: index.format.size.base, fps: index.format.fps };
  const typography: Typography = index.typography;

  // Run the timeline callback once under a shared discovery context: top-level asset() calls
  // register as timeline assets, and the return value is the shot inputs. Each shot's fn is then
  // discovered in its own shot context, and the prompt collection spans both.
  const discovery = runTimelineInDiscoveryMode(stage, () => runTimeline(format), {
    ...format,
    typography,
  });
  const topLevelAssets = discovery.assets;
  const normalized = normalizeStageTimeline(discovery.result);
  const shotInputs = normalized.shots;
  const timelineSoundtracks = normalized.soundtracks;
  const clock = index.timeline.clock;
  const song = clock ? formatReferenceAddress(clock.song) : undefined;
  if (song) assertSongNotInSoundtracks(song, timelineSoundtracks);

  const assetKindsByShot = new Map<string, ReadonlyMap<string, MediaKind>>();
  const shots: ShotDefinition[] = shotInputs.map((input) => {
    if (isPendingShotInput(input)) {
      return {
        id: input.id,
        duration: input.options.duration,
        action: input.options.action,
        assets: {},
        pending: true as const,
      };
    }
    const aside = isAsideShotInput(input);
    const graphic = !aside && input.__graphicShot === true;
    // The definition layer's `action` is the prose a reader is shown for this shot; for an aside
    // that is its label.
    const action = aside ? input.options.label : input.options.action;
    const shotFn = input.fn;
    // Only an aside the stage does not board reaches here — a developed shot's `fn` is required. It
    // carries the span and its label and nothing else; the renderers fill it with a slug exactly as
    // they do a pending shot's tile.
    if (shotFn === undefined) {
      return {
        id: input.id,
        duration: input.options.duration,
        action,
        assets: {},
        aside: true as const,
      };
    }
    const buildFormat = { ...format, duration: input.options.duration, typography };
    const context: RenderContext = {
      shotId: input.id,
      width: format.size.width,
      height: format.size.height,
      duration: input.options.duration,
      nested: false,
      typography,
    };
    const { assets, assetKinds, element } = runInDiscoveryMode(
      stage,
      input.id,
      shotFn,
      buildFormat,
    );
    assetKindsByShot.set(input.id, assetKinds);
    // Guard the shape here — it is the only runtime check that the top of a shot is a Composition
    // (JSX collapses every element to the same type, so the compiler cannot enforce it).
    if (!isCompositionElement(element)) {
      throw new Error(
        `${stage === "video" ? "Video" : "Animatic"} shot "${input.id}" build must return a ` +
          `<Composition>…</Composition> at its top level.`,
      );
    }
    const { compositionRefs, pictureRefs, stemRefs, cutin } = partitionShotRefs(
      element,
      context,
      collectPlaceholderRefs(element),
    );
    if (cutin) assertCutinDeclared(stage, input.id, index, cutin.count);
    const cutinDefinition =
      cutin && cutin.count > 0
        ? {
            refs: cutin.refs,
            ...(cutin.sharedRefs.length > 0 ? { sharedRefs: cutin.sharedRefs } : {}),
          }
        : undefined;
    const timing = index.timeline.timings.get(input.id);
    const songCue =
      song && stage === "animatic" && timing
        ? { src: song, mediaStart: timing.start, duration: timing.duration }
        : undefined;
    const base: ShotDefinition = {
      id: input.id,
      duration: input.options.duration,
      action,
      assets,
      shotFn,
      compositionRefs,
      pictureRefs,
      stemRefs,
      ...(songCue
        ? {
            songCue,
            songStem: shotSongStem(index, input.id, songCue.mediaStart, songCue.duration),
          }
        : {}),
      ...(cutinDefinition ? { cutin: cutinDefinition } : {}),
      ...(aside ? { aside: true as const } : {}),
      ...(graphic ? { graphic: true as const } : {}),
    };
    if (!perShot) return base;
    return {
      ...base,
      ...perShot({ input, element, context, assets, compositionRefs, cutin: cutinDefinition }),
    };
  });

  assertSoundtrackAnchors(shotInputs, timelineSoundtracks);

  const overlay = normalized.overlay
    ? defineOverlay(stage, index, normalized.overlay, { ...format, typography })
    : undefined;

  const timelineFn: TimelineFunction = ({ format: renderFormat }) => {
    const run = normalizeStageTimeline(runTimeline(renderFormat));
    return {
      // Pending shots have no composition fn; drop them here. Consumers look shots up by id and
      // fall back to the plan's (null) shotFn, so an absent pending shot renders as its fallback.
      // Pending shots and the animatic's asides have no composition fn; drop them here. Consumers
      // look shots up by id and fall back to the plan's (null) shotFn, so an absent one renders as
      // its fallback tile.
      shots: run.shots.flatMap((s) =>
        isPendingShotInput(s) || s.fn === undefined ? [] : [{ id: s.id, fn: s.fn }],
      ),
      soundtracks: run.soundtracks,
      ...(run.overlay ? { overlay: overlayFn(run.overlay, index) } : {}),
    };
  };

  const prompts = endPromptCollection();
  const pins = endPinCollection();
  const { imageInputs, prevPanelReaders } = endImageInputCollection();
  const clipLengths = endClipLengthCollection();
  const respellings = endRespellCollection();

  return {
    definition: {
      stage,
      format,
      typography,
      shots,
      topLevelAssets: Object.keys(topLevelAssets).length > 0 ? topLevelAssets : undefined,
      timelineSoundtracks: timelineSoundtracks.length > 0 ? timelineSoundtracks : undefined,
      ...(song ? { song } : {}),
      overlay,
      timelineFn,
      prompts: prompts.length > 0 ? prompts : undefined,
      pins: pins.length > 0 ? pins : undefined,
      imageInputs: imageInputs.length > 0 ? imageInputs : undefined,
      prevPanelReaders: prevPanelReaders.length > 0 ? prevPanelReaders : undefined,
      waivers: args.waivers,
      respellings,
    },
    assetKindsByShot,
    clipLengths,
  };
}

// A composition and its direction agree on whether the shot has a second camera frame.
function assertCutinDeclared(
  stage: ShotStage,
  shotId: string,
  index: DirectionIndex,
  rendered: number,
): void {
  const label = `${stage === "video" ? "Video" : "Animatic"} shot "${shotId}"`;
  const declared = index.cutinById.has(shotId);
  if (declared && rendered === 0) {
    throw new KonteError(
      "CUTIN_REQUIRED",
      `${label} renders no <Cutin>, but direction.ts declares a \`cutin\` on this shot. Place ` +
        `the wipe's ${stage === "video" ? "<Video>" : "<Panel>"} inside <Cutin>, or drop the ` +
        `\`cutin\` from the shot.`,
    );
  }
  if (!declared && rendered > 0) {
    throw new KonteError(
      "CUTIN_UNDECLARED",
      `${label} renders a <Cutin>, but direction.ts declares no \`cutin\` on this shot. Declare ` +
        `it — \`cutin: { setup, lineup }\` — so its frame is checked like any other, or place the ` +
        `layer as an <Image> instead.`,
    );
  }
  if (rendered > 1) {
    throw new KonteError(
      "CUTIN_UNDECLARED",
      `${label} renders ${rendered} <Cutin>s. A shot declares one cutin frame.`,
    );
  }
}

// konte lays the song under the timeline itself; a soundtrack of it would play it twice.
function assertSongNotInSoundtracks(song: string, soundtracks: readonly SoundtrackEntry[]): void {
  const doubled = soundtracks.find((st) => parsePlaceholder(st.src.src) === song);
  if (!doubled) return;
  throw new KonteError(
    "SONG_DOUBLED",
    `soundtrack "${doubled.id}" plays ${song}, the song policy.clock counts on. konte lays the ` +
      `song under the whole timeline itself — drop the soundtrack.`,
  );
}

// Validate soundtrack anchors against the declared shots. The shot-id types are checked at compile
// time (NoInfer in the timeline return), but a computed id or an out-of-range `at` only surfaces
// here, so fail fast at definition time rather than at render.
function assertSoundtrackAnchors(
  shotInputs: ReadonlyArray<AnyShotInput>,
  soundtracks: readonly SoundtrackEntry[],
): void {
  const shotDurations = new Map(shotInputs.map((s) => [s.id, s.options.duration]));
  for (const st of soundtracks) {
    for (const anchor of [st.options.from, st.options.until]) {
      if (!anchor) continue;
      const dur = shotDurations.get(anchor.shot);
      if (dur === undefined) {
        throw new Error(
          `soundtrack "${st.id}" anchors to unknown shot "${anchor.shot}". ` +
            `Valid shots: ${[...shotDurations.keys()].join(", ") || "(none)"}.`,
        );
      }
      if (anchor.at !== undefined && (anchor.at < 0 || anchor.at > dur)) {
        throw new Error(
          `soundtrack "${st.id}" anchor at=${anchor.at} is outside shot "${anchor.shot}" ` +
            `(duration ${dur}s).`,
        );
      }
    }
  }
}

type OverlayBuild = (ctx: never) => React.ReactElement;

function timelineLength(index: DirectionIndex): number {
  const last = [...index.timeline.timings.values()].at(-1);
  return last ? last.start + last.duration : 0;
}

// The build with its context bound: what the timeline hears and counts.
function overlayFn(build: OverlayBuild, index: DirectionIndex): () => React.ReactElement {
  const duration = timelineLength(index);
  const ctx = { duration, ...spanSongContext(index, 0, duration) };
  // The build is typed against the direction it was written for (`OverlayContext<D>`); this context
  // is that shape, built from the same direction.
  return () => build(ctx as never);
}

// The overlay and the refs its composition draws, found by running its build once. It declares no
// asset of its own — what it shows is a timeline or reference asset — and plays no media.
function defineOverlay(
  stage: ShotStage,
  index: DirectionIndex,
  build: OverlayBuild,
  format: VideoFormat & { typography: Typography },
): OverlayDefinition {
  const duration = timelineLength(index);
  const fn = overlayFn(build, index);
  const { assets, element } = runInDiscoveryMode(stage, "overlay", fn, { ...format, duration });
  if (Object.keys(assets).length > 0) {
    throw new Error(
      `the overlay declares ${Object.keys(assets).join(", ")} with asset() — it shows timeline ` +
        `or reference assets; declare the asset at the top of the timeline.`,
    );
  }
  if (!isCompositionElement(element)) {
    throw new Error(
      "the overlay build must return a <Composition>…</Composition> at its top level.",
    );
  }
  let media = false;
  renderToHtml(
    element,
    {
      shotId: "overlay",
      width: format.size.width,
      height: format.size.height,
      duration,
      typography: format.typography,
    },
    (tag) => {
      if (tag === "audio" || tag === "video") media = true;
    },
  );
  if (media) {
    throw new Error(
      "the overlay plays a <Video> or an <Audio> — an overlay is text, images and animation. " +
        "Place the media in a shot, or a sound in the timeline's soundtracks.",
    );
  }
  return { duration, fn, compositionRefs: collectPlaceholderRefs(element) };
}
