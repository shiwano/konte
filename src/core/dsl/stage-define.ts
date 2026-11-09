import {
  formatReferenceAddress,
  formatShotAddress,
  formatThumbnailAddress,
  formatTimelineStemAddress,
  type ShotStage,
  THUMBNAIL_FRAME_ADDRESS,
} from "../address.js";
import type { BuildFinding } from "../finding.js";
import { isConsumableAddress, partitionShotRefs } from "../composition-refs.js";
import { renderToHtml, type RenderContext } from "../jsx-html.js";
import type {
  AssetDefinition,
  LocalAssetDefinition,
  ShotDefinition,
  StageDefinition,
  ThumbnailCompose,
  ThumbnailDefinition,
  ThumbnailFrame,
  TimelineFunction,
  Typography,
  VideoFormat,
} from "../types/index.js";
import { KonteError } from "../errors.js";
import type { AnyShotInput, MediaKind, SoundtrackEntry, ThumbnailSpec } from "./builders.js";
import type { OverlayDefinition } from "../types/index.js";
import {
  endsOnSeam,
  makeStageShots,
  shotSongStem,
  spanSongContext,
  timedShot,
} from "./direction.js";
import { isAsideShotInput, isPendingShotInput, makeMediaAsset } from "./builders.js";
import { Composition } from "./composition/index.js";
import type { DirectionIndex } from "./direction.js";
import { endClipLengthCollection, type ClipLength } from "./clip-length-collect.js";
import { endImageInputCollection } from "./image-input-collect.js";
import { endPinCollection } from "./pin-collect.js";
import { endStemInputCollection } from "./stem-input-collect.js";
import { endPromptCollection } from "./prompt-collect.js";
import { endRespellCollection } from "./respell.js";
import {
  collectPlaceholderRefs,
  makeAddressPlaceholder,
  parsePlaceholder,
  runInDiscoveryMode,
  runInThumbnailMode,
  runTimelineInDiscoveryMode,
} from "./shot-context.js";

// The two composition stages are built the same way — one timeline callback that declares shared
// assets and walks the direction, then one discovery pass per shot. This module is that shared
// build; `defineAnimatic` and `defineVideo` supply what is theirs (an animatic's keyframes and
// stem, a video's export wiring) through `perShot`.

// A shot's discovery-mode element is the raw `jsx(Composition, …)` result (Composition itself runs
// later, at renderToHtml), so its `type` is the Composition function reference — the signal that
// the shot's build returned a `<Composition>` at its top.
function isCompositionElement(element: React.ReactElement): boolean {
  return (
    element != null &&
    typeof element === "object" &&
    (element as { type?: unknown }).type === Composition
  );
}

// What a stage's `timeline` returns: the completed shot chain under `shots` (a bare `[]` for an
// empty or not-yet-authored stage), plus optional timeline-spanning `soundtracks` whose anchors are
// checked against the shots' ids.
function normalizeStageTimeline(result: unknown): {
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
type PerShotHook = (args: {
  input: { id: string };
  element: React.ReactElement;
  context: RenderContext;
  assets: Record<string, ShotDefinition["assets"][string]>;
  compositionRefs: readonly string[];
  // The shot's `<Cutin>`, as the stage recorded it — undefined where it renders none.
  cutin: ShotDefinition["cutin"];
}) => Partial<ShotDefinition>;

interface DefineStageArgs {
  stage: ShotStage;
  index: DirectionIndex;
  runTimeline: (format: VideoFormat) => unknown;
  perShot?: PerShotHook;
  thumbnail?: ThumbnailSpec;
}

interface StageBuild {
  definition: StageDefinition;
  // Each shot's declared asset kinds, captured as it was discovered. An AssetDefinition carries no
  // media kind, so the cross-stage ref handle's kind check reads this.
  assetKindsByShot: ReadonlyMap<string, ReadonlyMap<string, MediaKind>>;
  // How long a clip each declared asset asks its model for. Read by the animatic's cue-fit check
  // and by the pass that narrows a count konte derived from the words.
  clipLengths: readonly ClipLength[];
  thumbnail?: ThumbnailDefinition;
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
  const buildFindings: BuildFinding[] = [];
  const timelineSoundtracks = placeableSoundtracks(
    stage,
    shotInputs,
    normalized.soundtracks,
    buildFindings,
  );
  const song = index.timeline.song ? formatReferenceAddress(index.timeline.song) : undefined;
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
    const buildFormat = {
      ...format,
      duration: input.options.duration,
      ...(endsOnSeam(index, input.id) ? { endsOnSeam: true } : {}),
      typography,
    };
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
    const cutinFinding = cutinAgreement(stage, input.id, index, cutin?.count ?? 0);
    if (cutinFinding) buildFindings.push(cutinFinding);
    const cutinDefinition =
      cutin && cutin.count > 0
        ? {
            refs: cutin.refs,
            ...(cutin.sharedRefs.length > 0 ? { sharedRefs: cutin.sharedRefs } : {}),
          }
        : undefined;
    const at = index.timeline.timings.get(input.id);
    const timing = song && stage === "animatic" && at ? timedShot(index.timeline, at) : undefined;
    const songCue = timing
      ? { src: song!, mediaStart: timing.start, duration: timing.duration }
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

  const overlay = normalized.overlay
    ? defineOverlay(stage, index, normalized.overlay, { ...format, typography })
    : undefined;
  const thumbnail = args.thumbnail
    ? defineThumbnail(stage, args.thumbnail, shotInputs, shots, overlay, { ...format, typography })
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
  const stemInputs = endStemInputCollection();
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
      stemInputs: stemInputs.length > 0 ? stemInputs : undefined,
      respellings,
      ...(buildFindings.length > 0 ? { buildFindings } : {}),
    },
    assetKindsByShot,
    clipLengths,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

// A composition and its direction agree on whether the shot has a second camera frame. Two
// `<Cutin>`s is the composition's own error; a disagreement with the direction is a finding.
function cutinAgreement(
  stage: ShotStage,
  shotId: string,
  index: DirectionIndex,
  rendered: number,
): BuildFinding | null {
  const label = `${stage === "video" ? "Video" : "Animatic"} shot "${shotId}"`;
  if (rendered > 1) {
    throw new KonteError(
      "CUTIN_INVALID",
      `${label} renders ${rendered} <Cutin>s. A shot declares one cutin frame.`,
    );
  }
  const declared = index.cutinById.has(shotId);
  const targets = [formatShotAddress(stage, shotId)];
  if (declared && rendered === 0) {
    return {
      code: "cutin-required",
      subject: formatShotAddress(stage, shotId),
      message: "renders no <Cutin>; direction.ts declares a `cutin` on the shot",
      targets,
    };
  }
  if (!declared && rendered > 0) {
    return {
      code: "cutin-undeclared",
      subject: formatShotAddress(stage, shotId),
      message: "renders a <Cutin>; direction.ts declares no `cutin` on the shot",
      targets,
    };
  }
  return null;
}

// konte lays the song under the timeline itself; a soundtrack of it would play it twice.
function assertSongNotInSoundtracks(song: string, soundtracks: readonly SoundtrackEntry[]): void {
  const doubled = soundtracks.find((st) => parsePlaceholder(st.src.src) === song);
  if (!doubled) return;
  throw new KonteError(
    "SONG_DOUBLED",
    `soundtrack "${doubled.id}" plays ${song}, the song policy.song names. konte lays the ` +
      `song under the whole timeline itself — drop the soundtrack.`,
  );
}

// The soundtracks the timeline can place. One anchored to a shot the timeline does not hold — the
// direction lost it — is left out and found; an `at` outside its shot is the timeline's own error.
// The shot-id types are checked at compile time (NoInfer in the timeline return), but a computed id
// only surfaces here.
function placeableSoundtracks(
  stage: ShotStage,
  shotInputs: ReadonlyArray<AnyShotInput>,
  soundtracks: readonly SoundtrackEntry[],
  findings: BuildFinding[],
): SoundtrackEntry[] {
  const shotDurations = new Map(shotInputs.map((s) => [s.id, s.options.duration]));
  return soundtracks.filter((st) => {
    for (const anchor of [st.options.from, st.options.until]) {
      if (!anchor) continue;
      const dur = shotDurations.get(anchor.shot);
      if (dur === undefined) {
        findings.push({
          code: "soundtrack-anchor-unknown",
          subject: st.id,
          message:
            `anchors to shot "${anchor.shot}" and is left out of the mix; the timeline holds: ` +
            `${[...shotDurations.keys()].join(", ") || "(none)"}`,
          targets: [formatTimelineStemAddress(stage)],
        });
        return false;
      }
      if (anchor.at !== undefined && (anchor.at < 0 || anchor.at > dur)) {
        throw new Error(
          `soundtrack "${st.id}" anchor at=${anchor.at} is outside shot "${anchor.shot}" ` +
            `(duration ${dur}s).`,
        );
      }
    }
    return true;
  });
}

type OverlayBuild = (ctx: never) => React.ReactElement;

function timelineLength(index: DirectionIndex): number {
  const last = [...index.timeline.timings.values()].at(-1);
  if (!last) return 0;
  const timed = timedShot(index.timeline, last);
  return timed.start + timed.duration;
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
  assertStillComposition("the overlay", element, { ...format, duration });
  return { duration, fn, compositionRefs: collectPlaceholderRefs(element) };
}

// A build that returns a `<Composition>` of text, images and animation and plays no media. Returns
// every ref a host element's `src` reaches, a function component's pulled in from a closure among
// them.
function assertStillComposition(
  label: string,
  element: React.ReactElement,
  format: VideoFormat & { typography: Typography; duration: number },
): string[] {
  if (!isCompositionElement(element)) {
    throw new Error(`${label} build must return a <Composition>…</Composition> at its top level.`);
  }
  let media = false;
  const refs: string[] = [];
  renderToHtml(
    element,
    {
      shotId: label.replace(/^the /, ""),
      width: format.size.width,
      height: format.size.height,
      duration: format.duration,
      typography: format.typography,
    },
    (tag, props) => {
      if (tag === "audio" || tag === "video") media = true;
      const ref = typeof props.src === "string" ? parsePlaceholder(props.src) : null;
      if (ref && isConsumableAddress(ref)) refs.push(ref);
    },
  );
  if (media) {
    throw new Error(
      `${label} plays a <Video> or an <Audio>. ` +
        "Place the media in a shot, or a sound in the timeline's soundtracks.",
    );
  }
  return refs;
}

// The length a thumbnail's still is laid out on; it is captured at t=0.
const THUMBNAIL_DURATION = 1;

// The composition id the still's stage and document carry: a jsxImage's, whose `render` op captures it.
const THUMBNAIL_SHOT_ID = "still";

export type ThumbnailLayout = {
  size: { width: number; height: number };
  fps: number;
  // The frame captured from the centre of `size` (an export's delivery crop).
  crop?: { width: number; height: number };
  typography: Typography;
};

export function thumbnailRenderContext(layout: ThumbnailLayout, nested: boolean): RenderContext {
  return {
    shotId: THUMBNAIL_SHOT_ID,
    width: layout.size.width,
    height: layout.size.height,
    duration: THUMBNAIL_DURATION,
    still: true,
    nested,
    typography: layout.typography,
    ...(layout.crop ? { crop: layout.crop } : {}),
  };
}

/** The thumbnail's stage on `layout`, its asset refs left as placeholders. */
export function renderThumbnailStage(fn: ThumbnailCompose["fn"], layout: ThumbnailLayout): string {
  // A png capture forces html/body transparent, so the ground is painted on the stage.
  const stage = runInThumbnailMode("render", () =>
    renderToHtml(fn({ size: layout.size, fps: layout.fps }), thumbnailRenderContext(layout, true)),
  ).result;
  return `<style>#stage { background: #000; }</style>${stage}`;
}

// The thumbnail's frame at `at` on the timeline: a `cutFrame` of the shot under it, its inputs the
// takes that shot's picture and the overlay draw. konte adds what its definition moves with — that
// shot's picture and the overlay — once the entry is loaded.
function defineThumbnailFrame(
  at: number,
  shots: readonly ShotDefinition[],
  overlay: OverlayDefinition | undefined,
): ThumbnailFrame {
  const total = shots.reduce((sum, s) => sum + s.duration, 0);
  if (!Number.isFinite(at) || at < 0 || at >= total) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `thumbnail.at is ${String(at)}s, outside the timeline's 0–${String(total)}s`,
    );
  }
  let start = 0;
  const shot = shots.find((s) => {
    if (at < start + s.duration) return true;
    start += s.duration;
    return false;
  })!;
  const shotTime = Math.round((at - start) * 1000) / 1000;
  const refs = [
    ...new Set([
      ...(shot.pictureRefs ?? shot.compositionRefs ?? []),
      ...(overlay?.compositionRefs ?? []),
    ]),
  ].filter(isConsumableAddress);
  return {
    at,
    shotId: shot.id,
    shotTime,
    asset: {
      kind: "local",
      operation: "cutFrame",
      mediaType: "image",
      deterministic: true,
      inputs: { shot: shot.id, at: shotTime, refs: refs.map(makeAddressPlaceholder) },
    },
  };
}

// The thumbnail: its frame, and its compose, the assets it declared and the refs its still draws,
// found by running its build once after the timeline placed every shot.
// Whether `refs` reach the thumbnail's frame, directly or through a thumbnail asset built on it.
function drawsThumbnailFrame(
  refs: readonly string[],
  assets: Record<string, AssetDefinition>,
): boolean {
  const seen = new Set<string>();
  const queue = [...refs];
  while (queue.length > 0) {
    const ref = queue.pop()!;
    if (ref === THUMBNAIL_FRAME_ADDRESS) return true;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const name = Object.keys(assets).find((n) => formatThumbnailAddress(n) === ref);
    if (name !== undefined) queue.push(...collectPlaceholderRefs(assets[name]));
  }
  return false;
}

function defineThumbnail(
  stage: ShotStage,
  spec: ThumbnailSpec,
  shotInputs: readonly AnyShotInput[],
  shots: readonly ShotDefinition[],
  overlay: OverlayDefinition | undefined,
  format: VideoFormat & { typography: Typography },
): ThumbnailDefinition {
  const build = spec.compose;
  if (spec.at === undefined && !build) {
    throw new KonteError("VALIDATION_FAILED", "the thumbnail declares neither `at` nor `compose`");
  }
  const frameDef = spec.at === undefined ? null : defineThumbnailFrame(spec.at, shots, overlay);
  if (!build) return { frame: frameDef, assets: {}, compose: null };
  const shot = makeStageShots(stage, shotInputs);
  const frame = makeMediaAsset<"image">(makeAddressPlaceholder(THUMBNAIL_FRAME_ADDRESS));
  const fn = (canvas: VideoFormat): React.ReactElement => build({ format: canvas, shot, frame });
  const { assets, result } = runInThumbnailMode(
    "discovery",
    () => {
      const element = fn({ size: format.size, fps: format.fps });
      const rendered = assertStillComposition("the thumbnail", element, {
        ...format,
        duration: THUMBNAIL_DURATION,
      });
      return [...new Set([...collectPlaceholderRefs(element), ...rendered])].filter(
        isConsumableAddress,
      );
    },
    format,
  );
  const { width, height } = format.size;
  const still: LocalAssetDefinition = {
    kind: "local",
    operation: "render",
    mediaType: "image",
    deterministic: true,
    inputs: {
      stage: renderThumbnailStage(fn, format),
      width,
      height,
      typography: format.typography,
      refs: result.map(makeAddressPlaceholder),
    },
  };
  const drawsFrame = drawsThumbnailFrame(result, assets);
  if (drawsFrame && spec.at === undefined) {
    throw new KonteError(
      "VALIDATION_FAILED",
      "thumbnail.compose draws `frame`, and the thumbnail declares no `at`",
    );
  }
  if (!drawsFrame && spec.at !== undefined) {
    throw new KonteError(
      "VALIDATION_FAILED",
      "thumbnail.at names a frame thumbnail.compose never draws — draw `frame`, or drop `at`",
    );
  }
  return { frame: frameDef, assets, compose: { fn, compositionRefs: result, still } };
}
