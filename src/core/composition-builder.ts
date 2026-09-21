import * as path from "node:path";
import {
  addressFromCacheSegments,
  addressToUrlPath,
  formatAddress,
  formatCompositionAddress,
  formatTimelineAddress,
  type ParsedAddress,
  type ShotStage,
  parseAddress,
  assetNameOf,
} from "./address.js";
import { asideSlugHtml } from "./aside-slug.js";
import {
  clampEffectiveGain,
  cueBySrc,
  isVoiceKind,
  loudnessOf,
  shotCueLevels,
  type ShotCueLevels,
} from "./audio-level.js";
import {
  bedVolumeLane,
  buildDuckEnvelope,
  duckSettings,
  voiceTriggerSpan,
  type Span,
} from "./audio-duck.js";
import { buildFallbackComposition } from "./composition-fallback.js";
import { resolveCompositionRef, substituteAssetPlaceholders } from "./composition-refs.js";
import { computeBedLevels } from "./render-plan.js";
import {
  parsePlaceholder,
  runInDiscoveryMode,
  runInRenderMode,
  runTimelineInDiscoveryMode,
  runTimelineInRenderMode,
  type ShotFunction,
} from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import { HYPERFRAME_RUNTIME } from "./generated/hyperframes-assets.js";
import { type HostVisitor, type RenderContext, renderToHtml } from "./jsx-html.js";
import { fontFamilyStack, googleFontsHref } from "./typography.js";
import { buildRenderPlan, type RenderPlan, type ShotRenderPlan } from "./render-plan.js";
import { shotById } from "./shot-index.js";
import { assertTailwindClasses, type ClassSubject } from "./tailwind-classes.js";
import { TAILWIND_BROWSER_SRC } from "./tailwind-version.js";
import { resolveSoundtrackSpan } from "./timeline-audio.js";
import { mediaDurationSec } from "./variant-media.js";
import type { StateManager } from "./state/index.js";
import type { StageDefinition } from "./types/index.js";

interface ShotCompositionInfo {
  shotId: string;
  startTime: number;
  duration: number;
  resolvedVariants: Record<string, string>;
  unacceptedAssets: string[];
}

interface CompositionBuildResult {
  html: string;
  fps: number;
  shots: ShotCompositionInfo[];
  totalDuration: number;
  size: { width: number; height: number };
}

interface BuildShotCompositionOptions {
  video: StageDefinition;
  manager: StateManager;
  shotId: string;
  assetBaseUrl: string;
  variantOverride?: { assetName: string; variantId: string };
  // Render from whatever is ready — a not-ready asset stays a raw placeholder, which draws nothing —
  // instead of failing the build. Set by the read surfaces: the live preview, and the capture path
  // behind `probe`/`review record show`. Never set where a partial shot would be PERSISTED —
  // materializing a leaf bakes what it reads.
  allowNotReady?: boolean;
}

interface BuildFullCompositionOptions {
  video: StageDefinition;
  manager: StateManager;
  assetBaseUrl: string;
  // Live-preview only: force a specific variant per address, honored across every
  // resolution path — a shot-own asset (per-shot loop), a timeline-own asset (baked at
  // render), and a cross-shot ref such as a `reference` soundtrack or an animatic
  // panel (placeholder substitution). Lets the review UI audition an unaccepted take.
  variantOverrides?: Array<{ address: string; variantId: string }>;
  // Live-preview only — see BuildShotCompositionOptions.allowNotReady.
  allowNotReady?: boolean;
  // See BuildRenderPlanOptions.standIn. `konte preview video` passes the animatic's plan so the
  // whole timeline plays as one reel, an unmade shot showing its board.
  standIn?: RenderPlan | null;
  // See BuildRenderPlanOptions.pinnedStandInShotIds — the shots the page was told, exactly.
  pinnedStandInShotIds?: ReadonlySet<string>;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function buildAssetUrl(
  assetBaseUrl: string,
  address: string,
  variantId: string,
  filePath: string,
) {
  const filename = path.basename(filePath);
  return `${assetBaseUrl}/${addressToUrlPath(address)}/${encodeURIComponent(variantId)}/${encodeURIComponent(filename)}`;
}

function buildHttpResolvedFiles(
  stage: ShotStage,
  shotId: string,
  resolvedFiles: Record<string, string>,
  resolvedVariants: Record<string, string>,
  assetBaseUrl: string,
  isTimeline: boolean,
): Record<string, string> {
  const httpFiles: Record<string, string> = {};
  for (const [assetName, filePath] of Object.entries(resolvedFiles)) {
    const variantId = resolvedVariants[assetName];
    if (!variantId) continue;
    const address = isTimeline
      ? formatTimelineAddress(stage, assetName)
      : formatAddress(stage, shotId, assetName);
    httpFiles[assetName] = buildAssetUrl(assetBaseUrl, address, variantId, filePath);
  }
  return httpFiles;
}

// A composition reaches outside its own shot for an animatic panel (`animatic.shot("01").image("first")`),
// a reference asset pulled in by closure (`<Soundtrack src={reference.bgm}/>`), or a prior video
// shot's asset (`shot("01").video("motion")`). Only the shot's OWN assets are swapped for a file by
// `asset()` in render mode, so all of the above reach here as `__konte:…__` placeholders; substitute
// each with its served asset URL. `includeStale` tracks the plan's `allowNotReady`: a live preview
// shows a stale-but-present upstream rather than a broken src, exactly as it does for own assets.
function resolveAssetPlaceholdersInHtml(
  html: string,
  manager: StateManager,
  assetBaseUrl: string,
  includeStale: boolean,
  overrideByAddress?: ReadonlyMap<string, string>,
): string {
  return substituteAssetPlaceholders(html, (assetPath) => {
    const resolved = resolveCompositionRef(manager, assetPath, {
      includeStale,
      overrideByAddress,
    });
    if (!resolved) return null;
    return buildAssetUrl(assetBaseUrl, resolved.address, resolved.variantId, resolved.file);
  });
}

// Point one `assetName` slot of a resolved-files/variants pair at a specific variant, in
// place. The variant must belong to `address` (the slot's own address for this composition's
// profile) — a variantId that names a different asset or profile is not this slot's to take,
// so it is ignored, as is a missing or fileless one. Shared by the shot-own and timeline-own
// override paths; mirrors the address-bound lookup the placeholder path uses.
function overrideResolvedVariant(
  resolvedFiles: Record<string, string>,
  resolvedVariants: Record<string, string>,
  manager: StateManager,
  assetName: string,
  address: string,
  variantId: string,
): void {
  const variant = manager.getState().assets[address]?.variants?.[variantId];
  if (variant?.file) {
    resolvedFiles[assetName] = path.resolve(manager.videoRoot, variant.file);
    resolvedVariants[assetName] = variantId;
  }
}

function applyVariantOverride(
  stage: ShotStage,
  shotPlan: ShotRenderPlan,
  manager: StateManager,
  override: { assetName: string; variantId: string },
): { resolvedFiles: Record<string, string>; resolvedVariants: Record<string, string> } {
  const resolvedFiles = { ...shotPlan.resolvedFiles };
  const resolvedVariants = { ...shotPlan.resolvedVariants };
  overrideResolvedVariant(
    resolvedFiles,
    resolvedVariants,
    manager,
    override.assetName,
    formatAddress(stage, shotPlan.shotId, override.assetName),
    override.variantId,
  );
  return { resolvedFiles, resolvedVariants };
}

function injectRuntime(compositionHtml: string): string {
  const runtimeTag = `<script>${HYPERFRAME_RUNTIME}</script>`;
  const bodyCloseIdx = compositionHtml.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return `${compositionHtml.slice(0, bodyCloseIdx)}${runtimeTag}\n${compositionHtml.slice(bodyCloseIdx)}`;
  }
  return compositionHtml + runtimeTag;
}

// The runtime drives the composition clock from a captured gsap timeline. A shot
// without an <Animate> registers none, leaving the runtime's currentTime undefined
// and every timed element hidden. Guarantee a capturable timeline spanning the shot
// duration without clobbering a user-provided one.
export function injectBaseTimeline(
  compositionHtml: string,
  shotId: string,
  duration: number,
): string {
  const baseTag =
    `<script>(function(){var g=window.gsap;if(!g||!g.timeline)return;` +
    `window.__timelines=window.__timelines||{};var key=${JSON.stringify(`shot-${shotId}`)};` +
    `var tl=window.__timelines[key];if(!tl||typeof tl.set!=="function"){tl=g.timeline({paused:true});` +
    `window.__timelines[key]=tl;}tl.set({},{},${duration});})()</script>`;
  const bodyCloseIdx = compositionHtml.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return `${compositionHtml.slice(0, bodyCloseIdx)}${baseTag}\n${compositionHtml.slice(bodyCloseIdx)}`;
  }
  return compositionHtml + baseTag;
}

// Shift a shot-local `data-start` into its slot on the master timeline — but ONLY on <video>/<audio>.
// The runtime evaluates those two against the master clock (raw data-start), so their window must be
// pre-offset; every other timed element (<img>, a bare [data-start] div) it re-bases against the
// enclosing composition's own start, so a pre-offset there double-counts and pushes the element out
// of its shot's on-stage window entirely. Only `data-start` is timeline-absolute; `data-duration`,
// `data-media-start`, and `data-volume` are not and must not shift.
function offsetClipStarts(html: string, offset: number): string {
  if (offset === 0) return html;
  return html.replace(/<(?:video|audio)\b[^>]*>/g, (tag) =>
    tag.replace(
      /data-start="(\d+(?:\.\d+)?)"/,
      (_, value) => `data-start="${parseFloat(value) + offset}"`,
    ),
  );
}

// Mirror every `<Video hasAudio>` as an `<audio>` on the same source: the preview runtime
// schedules only `audio[data-start]` into its WebAudio transport and force-mutes every media
// element (a <video> included) while that transport is active. Preview-only. Every window
// attribute is copied verbatim — `data-start` included, so this must run on already-offset HTML;
// re-deriving the shift would diverge from `offsetClipStarts` wherever its numeric pattern skips
// a value. A clip with no `data-start` is not a timed clip to the runtime, so it is not mirrored.
// See the `arch-audio-guide` skill for the preview's remaining audio-parity gaps.
function buildEmbeddedAudioTags(html: string): string[] {
  const tags: string[] = [];
  for (const [tag] of html.matchAll(/<video\b[^>]*>/g)) {
    if (!/\sdata-has-audio="true"/.test(tag)) continue;
    const src = tag.match(/\ssrc="([^"]*)"/)?.[1];
    if (!src) continue;
    const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const start = attr("data-start");
    if (start == null) continue;
    const attrs = [
      `data-konte-track="embedded"`,
      `src="${src}"`,
      `data-start="${start}"`,
      attr("data-duration") != null ? `data-duration="${attr("data-duration")}"` : "",
      attr("data-media-start") != null ? `data-media-start="${attr("data-media-start")}"` : "",
      attr("data-volume") != null ? `data-volume="${attr("data-volume")}"` : "",
    ].filter(Boolean);
    tags.push(`<audio ${attrs.join(" ")}></audio>`);
  }
  return tags;
}

// Place mirrored clip audio in a standalone shot-level document (the single-shot preview).
function injectEmbeddedAudio(compositionHtml: string): string {
  const tags = buildEmbeddedAudioTags(compositionHtml);
  if (tags.length === 0) return compositionHtml;
  const group = `<div id="embedded-audio" style="display:none;">${tags.join("")}</div>`;
  const bodyCloseIdx = compositionHtml.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return `${compositionHtml.slice(0, bodyCloseIdx)}${group}\n${compositionHtml.slice(bodyCloseIdx)}`;
  }
  return compositionHtml + group;
}

// The address and variant a served asset URL (`buildAssetUrl`) names; null for any other src.
export function parseServedAssetUrl(
  src: string,
  assetBaseUrl: string,
): { address: string; variantId: string | null } | null {
  const prefix = `${assetBaseUrl}/`;
  if (!src.startsWith(prefix)) return null;
  const segs = src.slice(prefix.length).split("/");
  if (segs.length < 2) return null;
  try {
    const [stage, suffix, variantId] = segs.slice(0, 3).map((s) => decodeURIComponent(s));
    return { address: addressFromCacheSegments([stage!, suffix!]), variantId: variantId ?? null };
  } catch {
    return null;
  }
}

// Bound every `<audio>` with no `data-duration` to its take's recorded length. Preview-only: the
// runtime's seek sync reads an open-ended clip as endless, so pausing past a cue seeks its element
// beyond the source, Chrome errors the element, and the runtime never plays it again.
function boundOpenAudio(html: string, manager: StateManager, assetBaseUrl: string): string {
  const assets = manager.getState().assets;
  return html.replace(/<audio\b[^>]*>/g, (tag) => {
    if (/\sdata-duration="/.test(tag)) return tag;
    const src = tag.match(/\ssrc="([^"]*)"/)?.[1];
    const served = src ? parseServedAssetUrl(src, assetBaseUrl) : null;
    if (!served?.variantId) return tag;
    const sourceSec = mediaDurationSec(
      assets[served.address]?.variants?.[served.variantId]?.media ?? null,
    );
    if (sourceSec == null) return tag;
    const mediaStart = toNum(tag.match(/\sdata-media-start="([^"]*)"/)?.[1]) ?? 0;
    return `<audio data-duration="${Math.max(0, sourceSec - mediaStart)}"${tag.slice("<audio".length)}`;
  });
}

// The stage's own children. Matched by depth: `<Composition>` nests freely, and
// `injectEmbeddedAudio` appends a hidden sibling div after the stage. Null when the page has none.
function stageInnerHtml(html: string): string | null {
  const open = /<div id="stage"[^>]*>/.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tag = /<(\/?)div\b[^>]*?(\/?)>/g;
  tag.lastIndex = start;
  let depth = 1;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m[2] === "/") continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return null;
}

/**
 * Whether a built composition would put anything on screen: the rendered `#stage` with the layers
 * that resolved to nothing taken out. A tolerant build leaves an unresolved `src` as its raw
 * `__konte:…__` placeholder, which the browser draws as nothing; audio is never on screen either.
 *
 * Operates on the well-formed HTML our renderer emits, like `stripAudioFromHtml`.
 */
export function compositionDrawsSomething(html: string): boolean {
  const stage = stageInnerHtml(html);
  // Refusing is the answer that costs the author a shot they cannot get back, so a page this cannot
  // read is one it does not refuse.
  if (stage === null) return true;
  const drawn = stage
    .replace(/<audio\b[^>]*>[\s\S]*?<\/audio>/g, "")
    .replace(/<audio\b[^>]*\/?>/g, "")
    // A layer still holding a placeholder resolved to nothing. Media elements are void or empty in
    // this renderer, so dropping the tag drops the layer.
    .replace(/<[a-z]+\b[^>]*__konte:[^>]*\/?>(?:<\/[a-z]+>)?/g, "");
  // Anything still standing counts, an element with no text of its own included: what a bare `<div>`
  // draws is its CSS, which this does not read. The two ways to be wrong are not equal — a frame
  // captured over nothing is visibly nothing, while a shot refused is one `review record show` calls
  // unavailable and `probe contact-sheet` steps over, with no edit that brings it back.
  return drawn.replace(/<[^>]*>/g, "").trim() !== "" || /<[a-z]/i.test(drawn);
}

// Drop audio from rendered composition HTML so the composite's definition hash is
// audio-independent: audio is muxed onto the final video, never baked into a shot picture, so an
// audio-only edit must not churn the composite or its upscale. Removes every <audio> element and
// the audio-only attributes (`data-has-audio`, `data-volume`) on the remaining picture elements;
// keeps `data-media-start` (it seeks the frame a <video> shows). Operates on the well-formed HTML
// our renderer emits; collapses whitespace so the result is a stable hash input.
export function stripAudioFromHtml(html: string): string {
  return html
    .replace(/<audio\b[^>]*>[\s\S]*?<\/audio>/g, "")
    .replace(/<audio\b[^>]*\/>/g, "")
    .replace(/\s*data-has-audio="[^"]*"/g, "")
    .replace(/\s*data-volume="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type TimelineShotOverride = { id: string; fn: ShotFunction };

// One timeline discovery run per loaded definition, indexed by shot id. Uncached, every per-shot
// discovery (a definition hash, a stem harvest) re-executes the whole timelineFn — all N shots —
// to pick out one, turning any all-shots sweep O(N²). Keyed weakly on the definition object, so a
// reload (a new object) invalidates naturally; the run is deterministic per loaded definition.
const timelineDiscoveryCache = new WeakMap<StageDefinition, Map<string, TimelineShotOverride>>();

function timelineShotOverrides(video: StageDefinition): Map<string, TimelineShotOverride> {
  let cached = timelineDiscoveryCache.get(video);
  if (!cached) {
    const run = runTimelineInDiscoveryMode(
      video.stage,
      () => video.timelineFn!({ format: video.format }),
      video.format,
    );
    const result = run.result as { shots?: TimelineShotOverride[] };
    cached = new Map((result.shots ?? []).map((s) => [s.id, s]));
    timelineDiscoveryCache.set(video, cached);
  }
  return cached;
}

// The shot's element tree rendered in DISCOVERY mode (every `src` stays a `__konte:…__`
// placeholder, so the result is independent of which upstream variant resolves) plus its render
// context. Applies a timelineFn override of the shot's render fn the same way the real render
// resolves it. Returns null when the shot has no render function (a pending shot). The shared basis
// for the structure hash and the audio-stem harvest.
function shotDiscoveryRender(
  video: StageDefinition,
  shotId: string,
): { element: React.ReactElement; context: RenderContext } | null {
  const shot = shotById(video.shots, shotId);
  if (!shot) return null;
  const size = video.format.size;

  let renderFn: ShotFunction | null = shot.shotFn ?? null;
  if (video.timelineFn) {
    const override = timelineShotOverrides(video).get(shotId)?.fn;
    if (override) renderFn = override;
  }
  if (!renderFn) return null;

  const { element } = runInDiscoveryMode(video.stage, shotId, renderFn, video.format);
  return {
    element,
    context: {
      shotId,
      width: size.width,
      height: size.height,
      duration: shot.duration,
      nested: false,
      typography: video.typography,
      ...(shot.panels ? { panels: shot.panels } : {}),
      ...(shot.cutin?.panels ? { cutinPanels: shot.cutin.panels } : {}),
    },
  };
}

// Structural HTML for a shot's composition, rendered from the definition alone: the body only, what
// the author wrote under `<Composition>`. The document head is konte's runtime (script URLs, base
// CSS) — the typography it carries is hashed from the definition instead. A DELIVERED
// composition strips its audio, so the picture hash ignores an audio-only edit — audio is muxed onto
// the final video, never baked into a shot picture. The ANIMATIC keeps it: its audio and its timing
// are what the stage exists to get a decision on, so retiming a line has to age the accept out.
export function compositionStructureHtml(video: StageDefinition, shotId: string): string | null {
  const inputs = shotDiscoveryRender(video, shotId);
  if (!inputs) return null;
  const html = renderToHtml(inputs.element, { ...inputs.context, nested: true });
  return video.stage === "animatic" ? html.replace(/\s+/g, " ").trim() : stripAudioFromHtml(html);
}

// One audio cue harvested from a shot's composition: its source asset path (placeholder-decoded)
// and shot-local placement/params. The identity of a shot's audio stem — audio-only, so a picture
// edit never changes it (the mirror of stripAudioFromHtml).
export interface StemAudioEntry {
  src: string;
  track: "sound" | "embedded";
  start: number | null;
  duration: number | null;
  mediaStart: number | null;
  volume: number | null;
  fadeIn: number | null;
  fadeOut: number | null;
}

/** What the take resolved for a voice cue tells the duck. */
export interface VoiceTake {
  /** The cue's played length (the take's duration less its `mediaStart`); null when unmeasured. */
  length: number | null;
  /** The silence the take opens with, from the file's head (see `voiceTriggerSpan`). */
  leadInSec: number | undefined;
}

// The ordered audio cues of an already-rendered composition element (<Audio> → "sound",
// <Video hasAudio> → "embedded"), harvested from a discovery render — sources stay placeholder asset
// paths. Pure and element-level, so a composition that has no place in the video definition yet (a
// shot's `animatic`, discovered while `defineVideo` is still assembling the shot) harvests the same
// way the delivered stem does.
export function harvestAudioStructure(
  element: React.ReactElement,
  context: RenderContext,
): StemAudioEntry[] {
  const entries: StemAudioEntry[] = [];
  renderToHtml(element, context, (tag, props) => {
    const raw = props.src;
    const src = typeof raw === "string" ? (parsePlaceholder(raw) ?? raw) : null;
    if (src === null) return;
    const isSound = tag === "audio" || props["data-konte-track"] === "sound";
    const isEmbedded = tag === "video" && props["data-has-audio"] === "true";
    if (!isSound && !isEmbedded) return;
    entries.push({
      src,
      track: isSound ? "sound" : "embedded",
      start: toNum(props["data-start"]),
      duration: toNum(props["data-duration"]),
      mediaStart: toNum(props["data-media-start"]),
      volume: toNum(props["data-volume"]),
      fadeIn: toNum(props["data-fade-in"]),
      fadeOut: toNum(props["data-fade-out"]),
    });
  });
  return entries;
}

/**
 * Where the spoken lines sit on the timeline, from the definition alone — what a ducking bed yields
 * to. Declared durations, not rendered ones, so the preview and the stem's hash agree; the mux
 * builds the same spans off the real ones.
 */
/**
 * The voice cues of the shots a video plan is showing the BOARD for. A stand-in shot plays the
 * animatic's whole composition, audio and all, so its lines are what a bed must yield to there —
 * the video's own shot is a `pendingShot` and declares none. Offsets come from the video plan: the
 * clock the reel runs on. Preview only — an export refuses while any shot is still pending.
 */
function standInVoiceSpans(
  plan: RenderPlan,
  voiceTake: (cue: StemAudioEntry) => VoiceTake | null,
): Array<Span & { address: string }> {
  const spans: Array<Span & { address: string }> = [];
  let offset = 0;
  for (const shotPlan of plan.shots) {
    const duration = shotPlan.duration;
    const standIn = shotPlan.showStandIn
      ? plan.standInPlan?.shots.find((s) => s.shotId === shotPlan.shotId)
      : undefined;
    if (standIn?.shotFn) {
      const { element } = runInDiscoveryMode(
        standIn.stage,
        standIn.shotId,
        standIn.shotFn,
        plan.format,
      );
      for (const cue of harvestAudioStructure(element, {
        shotId: standIn.shotId,
        width: plan.size.width,
        height: plan.size.height,
        duration: standIn.duration,
        nested: false,
        typography: plan.typography,
        ...(standIn.panels ? { panels: standIn.panels } : {}),
        ...(standIn.cutinPanels ? { cutinPanels: standIn.cutinPanels } : {}),
      })) {
        if (!isVoiceKind(standIn.cueKinds?.[cue.src])) continue;
        const start = cue.start ?? 0;
        const take = voiceTake(cue);
        const length = cue.duration ?? take?.length ?? Math.max(0, standIn.duration - start);
        if (length <= 0) continue;
        const span = voiceTriggerSpan({
          start: offset + start,
          end: offset + start + length,
          mediaStart: cue.mediaStart ?? 0,
          leadInSec: take?.leadInSec,
        });
        if (span) spans.push({ ...span, address: cue.src });
      }
    }
    offset += duration;
  }
  return spans;
}

export function declaredVoiceSpans(
  video: StageDefinition,
  // The take resolved for a cue. Given, an OPEN-ENDED cue spans what it will actually sound for,
  // and every cue ducks from where its sound starts. Omitted (the hash paths) the span falls back
  // to the whole placement, keeping those render- and take-free.
  voiceTake?: (cue: StemAudioEntry) => VoiceTake | null,
): Array<Span & { address: string; shotId: string }> {
  const spans: Array<Span & { address: string; shotId: string }> = [];
  let offset = 0;
  for (const shot of video.shots) {
    for (const cue of harvestShotAudioStructure(video, shot.id) ?? []) {
      if (!isVoiceKind(shot.cueKinds?.[cue.src])) continue;
      const start = cue.start ?? 0;
      const take = voiceTake?.(cue) ?? null;
      const length = cue.duration ?? take?.length ?? Math.max(0, shot.duration - start);
      if (length <= 0) continue;
      const span = voiceTriggerSpan({
        start: offset + start,
        end: offset + start + length,
        mediaStart: cue.mediaStart ?? 0,
        leadInSec: take?.leadInSec,
      });
      if (span) spans.push({ ...span, address: cue.src, shotId: shot.id });
    }
    offset += shot.duration;
  }
  return spans;
}

// The shot's own cues, via its discovery render. Returns null when the shot has no render function;
// [] when it renders no audio.
export function harvestShotAudioStructure(
  video: StageDefinition,
  shotId: string,
): StemAudioEntry[] | null {
  const inputs = shotDiscoveryRender(video, shotId);
  if (!inputs) return null;
  return harvestAudioStructure(inputs.element, inputs.context);
}

// One `<Video>` of a shot's composition: the take it plays and the window it plays of it, shot-local.
// Read by `join-unshown`, which asks whether a take pinned to a seam shows that frame.
export interface PictureCue {
  src: string;
  start: number | null;
  duration: number | null;
  mediaStart: number | null;
}

// The shot's own `<Video>` cues, via its discovery render. Null when the shot has no render function.
export function harvestShotPictureCues(
  video: StageDefinition,
  shotId: string,
): PictureCue[] | null {
  const inputs = shotDiscoveryRender(video, shotId);
  if (!inputs) return null;
  const cues: PictureCue[] = [];
  renderToHtml(inputs.element, inputs.context, (tag, props) => {
    if (tag !== "video" || typeof props.src !== "string") return;
    cues.push({
      src: parsePlaceholder(props.src) ?? props.src,
      start: toNum(props["data-start"]),
      duration: toNum(props["data-duration"]),
      mediaStart: toNum(props["data-media-start"]),
    });
  });
  return cues;
}

type RenderShotInput = { id: string; fn: () => React.ReactElement };

// The shot's composition closure. A timelineFn re-run gives a fresh closure, so it wins over the
// plan's captured one. Null means the shot is not renderable (a pending shot, or a fallback shot).
function pickShotRenderFn(
  shotPlan: ShotRenderPlan,
  renderShotInputs: RenderShotInput[] | null,
): ShotFunction | null {
  const entry = renderShotInputs ? shotById(renderShotInputs, shotPlan.shotId) : undefined;
  return entry?.fn ?? shotPlan.shotFn;
}

// The composition a shot's slot draws: the board's, where the board stands in for it.
function shownCompositionAddress(plan: RenderPlan, shotPlan: ShotRenderPlan): string {
  const stage = shotPlan.showStandIn && plan.standInPlan ? plan.standInPlan.stage : plan.stage;
  return formatCompositionAddress(stage, shotPlan.shotId);
}

function renderShotHtml(
  plan: RenderPlan,
  shotPlan: ShotRenderPlan,
  resolvedFiles: Record<string, string>,
  resolvedVariants: Record<string, string>,
  assetBaseUrl: string,
  renderShotInputs: RenderShotInput[] | null,
  nested: boolean,
  visitor?: HostVisitor,
): string | null {
  // The stand-in wins over the shot's own build, which would otherwise draw a black tile with
  // broken placeholders. It renders out of the ANIMATIC's plan — its shot, its assets, its panels —
  // so what plays here is the board, on the same clock as the rest of the reel.
  if (shotPlan.showStandIn && plan.standInPlan) {
    const standInShot = plan.standInPlan.shots.find((s) => s.shotId === shotPlan.shotId);
    if (standInShot?.shotFn) {
      return renderShotHtml(
        plan.standInPlan,
        standInShot,
        standInShot.resolvedFiles,
        standInShot.resolvedVariants,
        assetBaseUrl,
        null,
        nested,
        visitor,
      );
    }
  }

  const renderFn = pickShotRenderFn(shotPlan, renderShotInputs);
  if (!renderFn) {
    return renderFallbackShotHtml(
      plan,
      shotPlan,
      resolvedFiles,
      resolvedVariants,
      assetBaseUrl,
      nested,
      visitor,
    );
  }

  const httpFiles = buildHttpResolvedFiles(
    plan.stage,
    shotPlan.shotId,
    resolvedFiles,
    resolvedVariants,
    assetBaseUrl,
    false,
  );

  const timelineHttpFiles = buildHttpResolvedFiles(
    plan.stage,
    shotPlan.shotId,
    plan.timelineResolvedFiles,
    plan.timelineResolvedVariants,
    assetBaseUrl,
    true,
  );
  const mergedHttpFiles = { ...timelineHttpFiles, ...httpFiles };
  const cueSrcs = {
    stage: plan.stage,
    shotId: shotPlan.shotId,
    resolvedFiles: httpFiles,
    timelineFiles: timelineHttpFiles,
  };

  const jsx = runInRenderMode(plan.stage, shotPlan.shotId, renderFn, mergedHttpFiles);

  return renderToHtml(
    jsx,
    {
      shotId: shotPlan.shotId,
      width: plan.size.width,
      height: plan.size.height,
      duration: shotPlan.duration,
      // The same levelling the mux applies, re-keyed to these HTTP srcs: what the reviewer hears
      // has to be what the export writes.
      levelGains: cueBySrc({ ...cueSrcs, byAddress: shotPlan.cueLevels?.gains }),
      leadIns: cueBySrc({ ...cueSrcs, byAddress: shotPlan.cueLevels?.leadIns }),
      nested,
      typography: plan.typography,
      ...(shotPlan.panels ? { panels: shotPlan.panels } : {}),
      ...(shotPlan.cutinPanels ? { cutinPanels: shotPlan.cutinPanels } : {}),
    },
    visitor,
  );
}

// A shot without a shotFn has no composition; render its single resolved asset full-frame, matching
// what the ffmpeg renderer commits to the final video — or, for an aside the stage does not board,
// konte's own labelled slug, so preview and the reel show the same span the MP4 renderer commits.
// Returns null only when nothing resolved (genuinely nothing to show).
function renderFallbackShotHtml(
  plan: RenderPlan,
  shotPlan: ShotRenderPlan,
  resolvedFiles: Record<string, string>,
  resolvedVariants: Record<string, string>,
  assetBaseUrl: string,
  nested: boolean,
  visitor?: HostVisitor,
): string | null {
  if (shotPlan.aside && !shotPlan.fallbackFile) {
    return asideSlugHtml({
      shotId: shotPlan.shotId,
      label: shotPlan.action,
      duration: shotPlan.duration,
      size: plan.size,
      typography: plan.typography,
      nested,
    });
  }
  if (!shotPlan.fallbackFile) return null;

  const entry = Object.entries(resolvedVariants)[0];
  if (!entry) return null;
  const [assetName, variantId] = entry;

  const file = resolvedFiles[assetName] ?? shotPlan.fallbackFile;
  const address = formatAddress(plan.stage, shotPlan.shotId, assetName);
  const url = buildAssetUrl(assetBaseUrl, address, variantId, file);

  const element = buildFallbackComposition(
    url,
    shotPlan.fallbackType ?? "video",
    shotPlan.duration,
  );

  return renderToHtml(
    element,
    {
      shotId: shotPlan.shotId,
      width: plan.size.width,
      height: plan.size.height,
      duration: shotPlan.duration,
      nested,
      typography: plan.typography,
    },
    visitor,
  );
}

// Levelled and trimmed against the takes actually shown. A ref outside the shot resolves exactly as
// `resolveAssetPlaceholdersInHtml` substitutes it.
function previewCueLevels(
  plan: RenderPlan,
  shotPlan: ShotRenderPlan,
  resolvedVariants: Record<string, string>,
  manager: StateManager,
  includeStale: boolean,
  overrideByAddress?: ReadonlyMap<string, string>,
): ShotCueLevels {
  return shotCueLevels({
    stage: shotPlan.stage,
    shotId: shotPlan.shotId,
    cueKinds: shotPlan.cueKinds,
    pictureRefs: shotPlan.pictureRefs,
    state: manager.getState(),
    resolvedVariants,
    timelineResolvedVariants: plan.timelineResolvedVariants,
    resolve: (address) =>
      resolveCompositionRef(manager, address, { includeStale, overrideByAddress })?.variantId,
  });
}

export async function buildShotCompositionHtml(
  options: BuildShotCompositionOptions,
): Promise<CompositionBuildResult> {
  const { video, manager, shotId, assetBaseUrl, variantOverride, allowNotReady } = options;

  let plan: RenderPlan;
  try {
    plan = buildRenderPlan(video, manager, {
      shotId,
      outputDir: "",
      allowUnaccepted: true,
      allowNotReady,
    });
  } catch (err) {
    if (err instanceof KonteError) {
      throw new KonteError(
        "COMPOSITION_BUILD_FAILED",
        `Failed to build composition for shot "${shotId}": ${err.message}`,
      );
    }
    throw err;
  }

  const shotPlan = plan.shots[0];
  if (!shotPlan) {
    throw new KonteError("COMPOSITION_BUILD_FAILED", `Shot "${shotId}" not found in render plan`);
  }

  let { resolvedFiles, resolvedVariants } = shotPlan;
  if (variantOverride) {
    ({ resolvedFiles, resolvedVariants } = applyVariantOverride(
      plan.stage,
      shotPlan,
      manager,
      variantOverride,
    ));
  }

  const renderShotInputs = plan.timelineFn
    ? runTimelineInRenderMode(
        plan.stage,
        () => plan.timelineFn!({ format: plan.format }),
        buildHttpResolvedFiles(
          plan.stage,
          "",
          plan.timelineResolvedFiles,
          plan.timelineResolvedVariants,
          assetBaseUrl,
          true,
        ),
      ).shots
    : null;

  // Levelled against the take actually shown: a candidate previewed here is a different recording
  // at a different level.
  const levelled: ShotRenderPlan = {
    ...shotPlan,
    cueLevels: previewCueLevels(plan, shotPlan, resolvedVariants, manager, allowNotReady ?? false),
  };

  const html = renderShotHtml(
    plan,
    levelled,
    resolvedFiles,
    resolvedVariants,
    assetBaseUrl,
    renderShotInputs,
    false,
  );

  if (!html) {
    throw new KonteError(
      "COMPOSITION_BUILD_FAILED",
      `Shot "${shotId}" has no composition function`,
    );
  }
  await assertTailwindClasses([{ label: shownCompositionAddress(plan, shotPlan), html }]);

  return {
    html: boundOpenAudio(
      resolveAssetPlaceholdersInHtml(
        injectRuntime(
          injectBaseTimeline(injectEmbeddedAudio(html), shotPlan.shotId, shotPlan.duration),
        ),
        manager,
        assetBaseUrl,
        allowNotReady ?? false,
      ),
      manager,
      assetBaseUrl,
    ),
    fps: plan.fps,
    shots: [
      {
        shotId: shotPlan.shotId,
        startTime: 0,
        duration: shotPlan.duration,
        resolvedVariants,
        unacceptedAssets: shotPlan.unacceptedAssets,
      },
    ],
    totalDuration: shotPlan.duration,
    size: plan.size,
  };
}

export async function buildFullCompositionHtml(
  options: BuildFullCompositionOptions,
): Promise<CompositionBuildResult> {
  const { video, manager, assetBaseUrl, variantOverrides, allowNotReady } = options;

  // Overrides are addressed; classify each by kind at its resolution point below. Parse once
  // and keep the full map for the placeholder pass (cross-shot refs), which needs every kind.
  const overrideByAddress = new Map<string, string>();
  const parsedOverrides: Array<{ parsed: ParsedAddress; variantId: string }> = [];
  for (const ov of variantOverrides ?? []) {
    let parsed: ParsedAddress;
    try {
      parsed = parseAddress(ov.address);
    } catch {
      continue;
    }
    overrideByAddress.set(ov.address, ov.variantId);
    parsedOverrides.push({ parsed, variantId: ov.variantId });
  }

  let plan: RenderPlan;
  try {
    plan = buildRenderPlan(video, manager, {
      outputDir: "",
      allowUnaccepted: true,
      allowNotReady,
      ...(options.standIn ? { standIn: options.standIn } : {}),
      ...(options.pinnedStandInShotIds
        ? { pinnedStandInShotIds: options.pinnedStandInShotIds }
        : {}),
    });
  } catch (err) {
    if (err instanceof KonteError) {
      throw new KonteError(
        "COMPOSITION_BUILD_FAILED",
        `Failed to build full composition: ${err.message}`,
      );
    }
    throw err;
  }

  // Timeline-own assets are baked into the soundtrack/`asset()` src at render time, so a
  // timeline override must land before runTimelineInRenderMode reads the resolved maps. The
  // slot address is this composition's own (`video:timeline.<name>`), so an override naming a
  // different stage is bound out by the lookup.
  for (const { parsed, variantId } of parsedOverrides) {
    if (parsed.kind !== "timeline") continue;
    overrideResolvedVariant(
      plan.timelineResolvedFiles,
      plan.timelineResolvedVariants,
      manager,
      parsed.assetName,
      formatTimelineAddress(plan.stage, parsed.assetName),
      variantId,
    );
  }

  // The overrides above can have moved which take a bed resolves to, and a bed is levelled by —
  // and ducks off — the take it plays.
  const bedLevels = computeBedLevels(
    video,
    manager,
    plan.timelineResolvedVariants,
    overrideByAddress,
  );

  const timelineRun = plan.timelineFn
    ? runTimelineInRenderMode(
        plan.stage,
        () => plan.timelineFn!({ format: plan.format }),
        buildHttpResolvedFiles(
          plan.stage,
          "",
          plan.timelineResolvedFiles,
          plan.timelineResolvedVariants,
          assetBaseUrl,
          true,
        ),
      )
    : null;
  const renderShotInputs = timelineRun?.shots ?? null;
  const timelineSoundtracks = timelineRun?.soundtracks ?? [];

  const shotInfos: ShotCompositionInfo[] = [];
  const stageFragments: string[] = [];
  const shotTemplates: string[] = [];
  const embeddedAudio: string[] = [];
  const classSubjects: ClassSubject[] = [];
  let cumulativeTime = 0;

  for (const shotPlan of plan.shots) {
    let resolvedFiles = shotPlan.resolvedFiles;
    let resolvedVariants = shotPlan.resolvedVariants;
    for (const { parsed, variantId } of parsedOverrides) {
      if (parsed.kind !== "shot" || parsed.shotId !== shotPlan.shotId) continue;
      ({ resolvedFiles, resolvedVariants } = applyVariantOverride(
        plan.stage,
        { ...shotPlan, resolvedFiles, resolvedVariants },
        manager,
        { assetName: parsed.assetName, variantId },
      ));
    }

    // Likewise for the shot's cues: a candidate take shown in review is levelled as itself.
    const levelled: ShotRenderPlan = {
      ...shotPlan,
      cueLevels: previewCueLevels(
        plan,
        shotPlan,
        resolvedVariants,
        manager,
        allowNotReady ?? false,
        overrideByAddress,
      ),
    };

    const templateBody = renderShotHtml(
      plan,
      levelled,
      resolvedFiles,
      resolvedVariants,
      assetBaseUrl,
      renderShotInputs,
      true,
    );

    if (templateBody) {
      classSubjects.push({ label: shownCompositionAddress(plan, shotPlan), html: templateBody });
      // Embed the shot as a nested composition: its content lives in a <template> that the
      // runtime hydrates into the empty [data-composition-id] host below. The mount scopes
      // selectors and getElementById per composition (duplicate ids across shots stay isolated)
      // and offsets each shot's gsap timeline to the host's data-start — replacing the
      // hand-rolled selector scoping and master-timeline merge.
      //
      // The runtime does NOT, however, re-base raw clip windows: a <Video>/<Audio>'s
      // data-start/data-duration is evaluated against the master clock, not the composition's.
      // So a clip authored shot-local (data-start 0) would light up at global 0 in every shot,
      // stacking all shots at the start. Offset each clip's data-start by the shot's absolute
      // start so its window lands in the shot's slot. (This is attribute-only; gsap timeline
      // positions are not data-start attributes and the runtime already offsets them.)
      const offset = offsetClipStarts(templateBody, cumulativeTime);
      embeddedAudio.push(...buildEmbeddedAudioTags(offset));
      const body = injectBaseTimeline(offset, shotPlan.shotId, shotPlan.duration);
      shotTemplates.push(`<template id="shot-${shotPlan.shotId}-template">${body}</template>`);
      stageFragments.push(
        `<div data-composition-id="shot-${shotPlan.shotId}" data-start="${cumulativeTime}" data-duration="${shotPlan.duration}" data-width="${plan.size.width}" data-height="${plan.size.height}" style="position:absolute;top:0;left:0;width:100%;height:100%;"></div>`,
      );
    }

    shotInfos.push({
      shotId: shotPlan.shotId,
      startTime: cumulativeTime,
      duration: shotPlan.duration,
      resolvedVariants,
      unacceptedAssets: shotPlan.unacceptedAssets,
    });

    cumulativeTime += shotPlan.duration;
  }

  await assertTailwindClasses(classSubjects);

  const { width, height } = plan.size;
  const totalDuration = cumulativeTime;

  // Inject timeline-level soundtracks (beds/music) as <audio> elements that span the whole
  // composition, so HyperFrames mixes them live — matching the final mux. Same element shape as a
  // per-shot <Audio>, placed at absolute time, inside one full-span group (so playback isn't gated
  // to a single shot's window). Spans resolve from from/until anchors against the declared shot
  // durations (the preview uses declared, not ffprobed, durations).
  if (timelineSoundtracks.length > 0) {
    const offsets = new Map(shotInfos.map((s) => [s.shotId, s.startTime]));
    const durations = new Map(plan.shots.map((s) => [s.shotId, s.duration]));
    const els: string[] = [];
    // The spans the MUX will duck under, read off each take's measured media — no probe.
    const voiceTake = (cue: StemAudioEntry): VoiceTake | null => {
      const resolved = resolveCompositionRef(manager, cue.src, {
        includeStale: allowNotReady ?? false,
        overrideByAddress,
      });
      if (!resolved) return null;
      const media =
        manager.getState().assets[resolved.address]?.variants?.[resolved.variantId]?.media ?? null;
      const recorded = mediaDurationSec(media);
      return {
        length: recorded == null ? null : Math.max(0, recorded - (cue.mediaStart ?? 0)),
        leadInSec: loudnessOf(media ?? undefined)?.leadInSec,
      };
    };
    // The video shot a stand-in replaces contributes no lines of its own.
    const standInIds = new Set(plan.shots.filter((s) => s.showStandIn).map((s) => s.shotId));
    const voiceSpans = [
      ...declaredVoiceSpans(video, voiceTake).filter((v) => !standInIds.has(v.shotId)),
      ...standInVoiceSpans(plan, voiceTake),
    ];
    for (const st of timelineSoundtracks) {
      const { start, end } = resolveSoundtrackSpan(st.options, offsets, durations, totalDuration);
      const span = end - start;
      if (span <= 0) continue;
      const mediaStart = st.options.mediaStart ?? 0;
      // The same computation the mux uses, so the bed is at one level in both.
      const level = bedLevels[st.id];
      const volume = clampEffectiveGain((st.options.volume ?? 1) * (level?.gain ?? 1));
      const settings = duckSettings(st.options.duck, { volume, loudness: level?.loudness });
      const steps = settings
        ? buildDuckEnvelope({ bed: { start, end }, triggers: voiceSpans, settings })
        : [];
      // The lane carries the duck and the declared fades (see bedVolumeLane).
      const automation = bedVolumeLane({
        span,
        volume,
        steps,
        depth: settings?.depth ?? 1,
        fadeIn: st.options.fadeIn,
        fadeOut: st.options.fadeOut,
      });

      const attrs = [
        `data-konte-track="soundtrack"`,
        `src="${escapeAttr(st.src.src)}"`,
        `data-start="${start}"`,
        // data-duration bounds both the clip's contribution to the composition duration and the
        // preview transport's playback of it; without it the clip counts as infinite and stretches
        // the timeline. Span = end - start.
        `data-duration="${span}"`,
        `data-media-start="${mediaStart}"`,
        `data-volume="${volume}"`,
        automation ? `data-automation="${escapeAttr(JSON.stringify(automation))}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      els.push(`<audio ${attrs}></audio>`);
    }
    if (els.length > 0) {
      stageFragments.push(
        `<div id="timeline-audio" class="shot-group" data-start="0" data-duration="${totalDuration}" style="position:absolute;top:0;left:0;width:100%;height:100%;visibility:hidden;">${els.join("")}</div>`,
      );
    }
  }

  // Mirrored clip audio sits outside the shot templates, in one full-span group, for the same
  // reason the beds do.
  if (embeddedAudio.length > 0) {
    stageFragments.push(
      `<div id="embedded-audio" class="shot-group" data-start="0" data-duration="${totalDuration}" style="position:absolute;top:0;left:0;width:100%;height:100%;visibility:hidden;">${embeddedAudio.join("")}</div>`,
    );
  }

  // The same <head> `Composition` emits for a single shot, hand-written because this document hosts
  // every shot as a nested composition instead of being one. Both must stay in step.
  const fontsHref = googleFontsHref(plan.typography.fonts);
  const fontStack = fontFamilyStack(plan.typography.fonts);

  const mergedHtml = `<!doctype html>
<html lang="${escapeAttr(plan.typography.lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<meta data-composition-id="full-video" data-width="${width}" data-height="${height}" data-duration="${totalDuration}" />
<title>Video Preview</title>
${fontsHref ? `<link rel="stylesheet" href="${escapeAttr(fontsHref)}" />\n` : ""}<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="${TAILWIND_BROWSER_SRC}"></script>
<style>
@layer theme, base, components, utilities;
@layer base { * { margin: 0; padding: 0; box-sizing: border-box; } }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000;${fontStack ? ` font-family: ${fontStack};` : ""} }
#stage { position: absolute; top: 0px; left: 0px; width: ${width}px; height: ${height}px; overflow: hidden; }
@layer components { .konte-clip { position: absolute; top: 0; left: 0; width: 100%; height: 100%; visibility: hidden; object-fit: cover; } }
</style>
</head>
<body>
<div id="stage">
${stageFragments.join("\n")}
</div>
${shotTemplates.join("\n")}
<script>${HYPERFRAME_RUNTIME}</script>
</body>
</html>`;

  return {
    html: boundOpenAudio(
      resolveAssetPlaceholdersInHtml(
        mergedHtml,
        manager,
        assetBaseUrl,
        allowNotReady ?? false,
        overrideByAddress,
      ),
      manager,
      assetBaseUrl,
    ),
    fps: plan.fps,
    shots: shotInfos,
    totalDuration,
    size: plan.size,
  };
}

// One composited media element on a shot's timeline (a <Video> or <Audio>), with
// its shot-local time range and audio routing. Powers the review UI's per-shot
// track view: "what plays where". `address`/`assetName` are the
// resolved variant's owning asset (null when the src is unmappable, e.g. an
// external URL), so the UI can open that asset's variant gallery from the clip.
export interface CompositionClip {
  assetName: string | null;
  address: string | null;
  mediaType: "video" | "image" | "audio";
  start: number;
  end: number;
  mediaStart: number | null;
  volume: number | null;
  hasAudio: boolean;
  // Stable cue id from <Audio id=...> (data-konte-cue); null for video/unidentified clips.
  // A display label for the placement (review timeline, `konte probe`); accept and focus
  // route through the cue's shot, not through this.
  cueId: string | null;
}

// Resolve the shared result and per-shot render inputs once, mirroring the setup
// buildFullCompositionHtml does before rendering each shot.
function prepareShotInputs(
  plan: RenderPlan,
  assetBaseUrl: string,
): Array<{ id: string; fn: () => React.ReactElement }> | null {
  return plan.timelineFn
    ? runTimelineInRenderMode(
        plan.stage,
        () => plan.timelineFn!({ format: plan.format }),
        buildHttpResolvedFiles(
          plan.stage,
          "",
          plan.timelineResolvedFiles,
          plan.timelineResolvedVariants,
          assetBaseUrl,
          true,
        ),
      ).shots
    : null;
}

function toNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value !== "") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Recover the owning address from a clip's `src`. A shot asset resolves to an HTTP URL of the
// form `${assetBaseUrl}/<stage>/<suffix>/...` whose first two path segments (the address split at
// `:`) decode back to the address. A reference/timeline asset pulled into the composition via
// closure is still a raw `__konte:…__` placeholder at harvest time (the HTML-string reference
// resolver runs later), so decode that form too — a dep path IS its address.
function clipAddressFromSrc(
  src: unknown,
  assetBaseUrl: string,
): { address: string | null; assetName: string | null } {
  const empty = { address: null, assetName: null };
  if (typeof src !== "string") return empty;
  const depPath = parsePlaceholder(src);
  if (depPath) {
    try {
      return { address: depPath, assetName: assetNameOf(parseAddress(depPath)) };
    } catch {
      return empty;
    }
  }
  const served = parseServedAssetUrl(src, assetBaseUrl);
  if (!served) return empty;
  try {
    return { address: served.address, assetName: assetNameOf(parseAddress(served.address)) };
  } catch {
    return empty;
  }
}

// Build a clip from a host <video>/<audio> element's resolved props (data-* defaults
// already applied). end is derived from data-duration, falling back to the shot duration
// — matching how the runtime bounds an open-ended clip.
function clipFromProps(
  mediaType: "video" | "image" | "audio",
  props: Record<string, unknown>,
  shotDuration: number,
  assetBaseUrl: string,
): CompositionClip {
  const start = toNum(props["data-start"]) ?? 0;
  const dataDuration = toNum(props["data-duration"]);
  const end = dataDuration !== null ? start + dataDuration : shotDuration;
  const hasAudioAttr = props["data-has-audio"];
  return {
    ...clipAddressFromSrc(props.src, assetBaseUrl),
    mediaType,
    start,
    end,
    mediaStart: toNum(props["data-media-start"]),
    volume: toNum(props["data-volume"]),
    hasAudio: mediaType === "audio" ? true : hasAudioAttr === "true" || hasAudioAttr === true,
    cueId: typeof props["data-konte-cue"] === "string" ? (props["data-konte-cue"] as string) : null,
  };
}

// Per-shot composited clips for the review UI's track view. Reuses the already-built
// render plan (no re-resolution) and renders each shot shot-local — harvesting clips
// from the render pass via a host-element visitor, so time ranges are relative to the
// shot and read straight off native props (no HTML re-parsing). A shot that fails to
// render contributes an empty list rather than blanking the whole map.
export function buildShotClips(
  plan: RenderPlan,
  assetBaseUrl: string,
): Map<string, CompositionClip[]> {
  const renderShotInputs = prepareShotInputs(plan, assetBaseUrl);
  const byShot = new Map<string, CompositionClip[]>();
  for (const shotPlan of plan.shots) {
    const clips: CompositionClip[] = [];
    try {
      renderShotHtml(
        plan,
        shotPlan,
        shotPlan.resolvedFiles,
        shotPlan.resolvedVariants,
        assetBaseUrl,
        renderShotInputs,
        false,
        (tag, props) => {
          const mediaType =
            tag === "video" ? "video" : tag === "img" ? "image" : tag === "audio" ? "audio" : null;
          if (mediaType) {
            clips.push(clipFromProps(mediaType, props, shotPlan.duration, assetBaseUrl));
          }
        },
      );
    } catch {
      // Isolate per shot — a render failure leaves this shot clip-less, not the timeline.
    }
    byShot.set(shotPlan.shotId, clips);
  }
  return byShot;
}
