import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addressToCacheSegments, formatCompositionAddress } from "./address.js";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError, errorMessage } from "./errors.js";
import {
  detectSceneChanges,
  extractFrameAt,
  generateUniformTimestamps,
  lastSeekableTime,
  subsampleTimestamps,
  type ThumbnailInfo,
} from "./frame-extract.js";
import { inferMediaType } from "./media-type.js";
import { shotById } from "./shot-index.js";
import { probeVideo } from "./video-probe.js";

// Every writer of a shot's thumbnail dir renders at these settings. They are part of the cache key,
// so a caller that picked its own would land in a second hash dir — and `pruneSuperseded` would have
// the two deleting each other's frames on every miss.
export const COMPOSITION_FRAME_FORMAT = "jpeg" as const;
export const COMPOSITION_FRAME_QUALITY = 80;

export interface CaptureCompositionOptions {
  timestamps?: number[];
  maxFrames?: number;
  sceneThreshold?: number;
  format?: "jpeg" | "png";
  quality?: number;
  force?: boolean;
  // Remove sibling cache dirs (older composition hashes) for this shot when rendering.
  pruneSuperseded?: boolean;
}

// --at frames are named deterministically from their timecode so the file's
// existence alone is a valid cache hit (same composition hash + same timecode).
export function atFrameName(ts: number, ext: string): string {
  return `at-${String(Math.round(ts * 1000)).padStart(8, "0")}ms.${ext}`;
}

// The frame injector reaches each <video> by `document.getElementById(id)`, and `<Video>` only
// carries an id when the author gave it one (for `hasAudio`). Mint the missing ones before both
// the harvest below and the write, so the two sides agree on every id.
export function withVideoElementIds(html: string): string {
  let n = 0;
  return html.replace(/<video\b[^>]*>/g, (tag) =>
    /\sid="/.test(tag) ? tag : tag.replace("<video", `<video id="konte-video-${n++}"`),
  );
}

interface CompositionVideo {
  id: string;
  src: string;
  start: number;
  end: number;
  mediaStart: number;
  rate: number;
  loop: boolean;
}

// Every <video> on the composition's timeline, with the window the runtime bounds it by.
// Operates on the well-formed HTML our own renderer emits (same basis as stripAudioFromHtml).
export function harvestCompositionVideos(html: string): CompositionVideo[] {
  const videos: CompositionVideo[] = [];
  for (const [tag] of html.matchAll(/<video\b[^>]*>/g)) {
    const attr = (name: string): string | undefined =>
      tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const id = attr("id");
    const src = attr("src");
    if (!id || !src) continue;
    const start = Number(attr("data-start") ?? 0);
    const duration = Number(attr("data-duration"));
    videos.push({
      id,
      src,
      start,
      // No data-duration means an unbounded clip — the runtime plays it to the composition's end.
      end: Number.isFinite(duration) ? start + duration : Infinity,
      mediaStart: Number(attr("data-media-start") ?? 0),
      rate: Number(attr("data-playback-rate") ?? 1),
      loop: /\sloop\b/.test(tag),
    });
  }
  return videos;
}

// The `src` of a composition <video>, resolved to the file it will serve. Mirrors the capture file
// server's own lookup: the URL is percent-encoded per segment and the link tree below `workspace`
// is laid out under the decoded names.
function workspaceFileForSrc(src: string, workspace: string): string {
  const segments = src.split("/").filter(Boolean).map(decodeURIComponent);
  return path.join(workspace, ...segments);
}

// Headless Chromium does not decode a <video> reliably under a deterministic seek: the element
// yields whatever it happens to hold at screenshot time, which for most frames is nothing — a
// black rectangle. HyperFrames' answer is a before-capture hook that swaps each <video> for an
// <img> of the ffmpeg-extracted frame at that time; `executeRenderJob` wires one up internally,
// which is why exports are correct and only this hand-rolled capture path was not.
//
// The hook is built from a frame lookup, which upstream fills by extracting *every* frame of
// *every* clip. We know the handful of timestamps up front, so extract just those, through konte's
// own managed ffmpeg (`extractFrameAt`) rather than the engine's PATH-resolved one. The injector
// asks the lookup for `getActiveFramePayloads(time)` and for `frameDirs()`, the shared extraction
// cache dirs whose lease it renews; these frames live in the capture's own workspace, so there are
// none.
//
// `suppliedVideoIds` are the clips the hook covers at every captured moment. Their <video> is never
// on screen, so its own load state is left out of the capture's media check, as the render does.
async function buildVideoFrameInjector(
  videos: CompositionVideo[],
  timestamps: number[],
  workspace: string,
  fps: number,
): Promise<{
  injector: import("@hyperframes/producer").BeforeCaptureHook | null;
  suppliedVideoIds: string[];
}> {
  const { loadHyperFramesProducer } = await import("./hyperframes.js");
  const { createVideoFrameInjector, quantizeTimeToFrame } = await loadHyperFramesProducer();
  const framesDir = path.join(workspace, ".frames");
  await fs.mkdir(framesDir, { recursive: true });

  // Keyed by the capture's own frame number: `captureFrame` quantizes each timestamp onto the fps
  // grid before calling the hook, so the hook's `time` is that grid's value, not the raw request.
  const byCaptureFrame = new Map<number, Map<string, { framePath: string; frameIndex: number }>>();
  const unsupplied = new Set<string>();

  // Two different lengths, because the runtime uses two. A looping clip wraps on its *container*
  // length — that is what a media element's currentTime runs to and what HyperFrames' own lookup
  // wraps by, so anything else would make these frames disagree with the render they preview. Past
  // the last picture frame that lookup then holds the final frame rather than going blank, so the
  // picture's own length is what an extract has to be pulled back into. A clip whose audio outruns
  // its video needs both: wrap at 12s, but read no frame after 3s.
  const loopWindows = new Map<string, number>();
  const pictureEnds = new Map<string, number>();
  for (const video of videos) {
    try {
      const probe = await probeVideo(workspaceFileForSrc(video.src, workspace));
      if (video.loop) loopWindows.set(video.id, probe.duration);
      if (probe.videoDuration > 0) {
        pictureEnds.set(video.id, lastSeekableTime(probe.videoDuration, probe.fps));
      }
    } catch {
      // unreadable source — handled per frame below
    }
  }

  for (const ts of timestamps) {
    const time = quantizeTimeToFrame(ts, fps);
    const payloads = new Map<string, { framePath: string; frameIndex: number }>();
    for (const video of videos) {
      if (time < video.start || time >= video.end) continue;
      let mediaTime = (time - video.start) * video.rate + video.mediaStart;
      // Past the source's end a `loop` clip restarts at mediaStart, matching how the runtime
      // wraps a looping element's currentTime. Without this the extract lands beyond the file,
      // finds no frame, and the shot falls back to the black <video> this hook exists to avoid.
      const sourceDuration = loopWindows.get(video.id);
      if (sourceDuration !== undefined && mediaTime >= sourceDuration) {
        const window = sourceDuration - video.mediaStart;
        if (window > 0) mediaTime = video.mediaStart + ((mediaTime - video.mediaStart) % window);
      }
      // Hold the last picture frame past the end of the video stream, as the render's own lookup
      // does. Without it an audio-padded clip's tail extracts nothing and falls back to the black
      // <video> this hook exists to avoid.
      const pictureEnd = pictureEnds.get(video.id);
      if (pictureEnd !== undefined && mediaTime > pictureEnd) mediaTime = pictureEnd;
      // Two capture timestamps can land on one source frame — extract it once, and let the
      // injector skip re-injecting it by reporting the same frameIndex.
      const frameIndex = Math.floor(mediaTime * fps);
      // PNG, not JPEG: the injector reads the mime off this extension, and a source with alpha
      // (a transparent overlay) must reach the page unflattened. It also spares the frame a
      // JPEG generation it would only lose detail to before the screenshot re-encodes it.
      const framePath = path.join(framesDir, `${video.id}-${frameIndex}.png`);
      if (!existsSync(framePath)) {
        try {
          await extractFrameAt(workspaceFileForSrc(video.src, workspace), mediaTime, framePath);
        } catch {
          // An unreadable source is the resolver's problem, not the capture's: leave this clip to
          // the browser rather than failing every frame of the shot over one bad file.
          unsupplied.add(video.id);
          continue;
        }
      }
      payloads.set(video.id, { framePath, frameIndex });
    }
    byCaptureFrame.set(Math.round(time * fps), payloads);
  }

  const lookup = {
    getActiveFramePayloads: (time: number) =>
      byCaptureFrame.get(Math.round(time * fps)) ?? new Map(),
    frameDirs: () => [],
  };
  return {
    injector: createVideoFrameInjector(
      lookup as unknown as NonNullable<Parameters<typeof createVideoFrameInjector>[0]>,
    ),
    suppliedVideoIds: videos.map((v) => v.id).filter((id) => !unsupplied.has(id)),
  };
}

/**
 * Where this shot's frames cache, for the composition as it stands now.
 *
 * The composition HTML embeds the timeline and every resolved variant reference — but a reference
 * names an address, a variant id and a filename, NOT the bytes behind them, and a `file` asset is
 * re-synced in place under the same variant (`file-sync`). So the HTML alone would keep its hash
 * across a picture change; the resolved inputs' content fingerprints go in beside it, and only both
 * together make any input/definition change a new dir — a cache miss, never a stale frame served as
 * current. Older hash dirs (superseded compositions) are swept on render when `pruneSuperseded` is
 * set, since `clean` is variant-scoped and would not otherwise reclaim them.
 *
 * A read surface, so it builds tolerantly: a ref with no ready take falls back to the newest stale
 * one, and a layer with none at all leaves a hole. It throws only when there is no frame to show at
 * all: no such shot, no composition, or a page that draws nothing.
 */
export async function resolveCompositionCacheDir(options: {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  shotId: string;
  outputDir: string;
  format: "jpeg" | "png";
  quality: number;
}): Promise<{
  compositionResult: Awaited<
    ReturnType<typeof import("./composition-builder.js").buildShotCompositionHtml>
  >;
  cacheDir: string;
}> {
  const { video, manager, shotId, outputDir, format, quality } = options;
  const { buildShotCompositionHtml, compositionDrawsSomething } =
    await import("./composition-builder.js");
  const { compositionInputFingerprints, pictureRefsOf, unresolvedPictureRefs } =
    await import("./composition-resource.js");
  const target = shotById(video.shots, shotId);
  const compositionResult = await buildShotCompositionHtml({
    video,
    manager,
    shotId,
    // A read surface, so it falls back to the newest stale take and draws what is there — the same
    // tolerance the review page builds with. Refusing would hold a whole board of pictures on one
    // unready asset the sheet does not even show.
    allowNotReady: true,
    // Root-absolute so URLs resolve to "/<enc-address>/<variant>/<file>" against
    // the capture file server. `buildAssetUrl` adds the leading slash; a value of
    // "./" here would produce ".//…" → the browser resolves it to "//…" (404).
    assetBaseUrl: "",
    withOverlay: true,
  });
  // What "this shot cannot be captured" means: the built page would draw nothing. Asked of the
  // render, not the refs, so a shot with text or a background over its missing layers still frames.
  if (!compositionDrawsSomething(compositionResult.html)) {
    const gone = target ? unresolvedPictureRefs(manager, target) : [];
    throw new KonteError(
      "COMPOSITION_BUILD_FAILED",
      `Shot "${shotId}" has nothing to capture: it draws only ${gone.join(", ") || "layers"}, which resolve to nothing`,
    );
  }
  const fingerprints = target
    ? compositionInputFingerprints(manager, [
        ...pictureRefsOf(target),
        ...(video.overlay?.compositionRefs ?? []),
      ])
    : {};
  const compHash = createHash("sha256")
    .update(compositionResult.html)
    .update(
      `|${compositionResult.size.width}x${compositionResult.size.height}|${compositionResult.fps}|${format}|${quality}`,
    )
    .update(`|${JSON.stringify(Object.entries(fingerprints).sort())}`)
    .digest("hex")
    .slice(0, 12);
  return { compositionResult, cacheDir: path.join(outputDir, compHash) };
}

type CaptureCompositionFramesOptions = {
  video: import("./types/index.js").StageDefinition;
  manager: import("./state/index.js").StateManager;
  shotId: string;
  videoRoot: string;
  outputDir: string;
  captureOptions?: CaptureCompositionOptions;
};

export async function captureCompositionFrames(
  options: CaptureCompositionFramesOptions,
): Promise<ThumbnailInfo[]> {
  try {
    return await captureCompositionFramesUnwrapped(options);
  } catch (err) {
    // Wrapped, because a bundled stack names no shot.
    if (err instanceof KonteError) throw err;
    // The renderer can reject with a message-less Error, which reads as no failure at all.
    const message = errorMessage(err).trim() || (err instanceof Error ? err.name : String(err));
    throw new KonteError(
      "FRAME_CAPTURE_FAILED",
      `${formatCompositionAddress(options.video.stage, options.shotId)}: ${message} — re-run with KONTE_DEBUG=1 for the renderer's own diagnostics`,
    );
  }
}

async function captureCompositionFramesUnwrapped(
  options: CaptureCompositionFramesOptions,
): Promise<ThumbnailInfo[]> {
  const { video, manager, shotId, videoRoot, outputDir, captureOptions } = options;
  const maxFrames = captureOptions?.maxFrames ?? 8;
  const sceneThreshold = captureOptions?.sceneThreshold ?? 0.3;
  const format = captureOptions?.format ?? "jpeg";
  const quality = captureOptions?.quality ?? 80;
  const force = captureOptions?.force ?? false;
  const ext = format === "png" ? "png" : "jpg";
  const requested = captureOptions?.timestamps;

  const { compositionResult, cacheDir } = await resolveCompositionCacheDir({
    video,
    manager,
    shotId,
    outputDir,
    format,
    quality,
  });
  const manifestPath = path.join(cacheDir, "manifest.json");

  // Fast paths: a full cache hit skips the expensive capture session (and, for the
  // scene-detected set, the scene detection) entirely.
  if (!force) {
    if (requested) {
      const hits = requested.map((ts) => ({
        file: path.join(cacheDir, atFrameName(ts, ext)),
        timestamp: ts,
      }));
      if (hits.every((h) => existsSync(h.file))) {
        return hits.map((h) => ({
          file: path.relative(videoRoot, h.file),
          timestamp: h.timestamp,
        }));
      }
    } else if (existsSync(manifestPath)) {
      // Scene-detected timestamps vary per run, so a manifest records the set.
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as ThumbnailInfo[];
        if (
          manifest.length > 0 &&
          manifest.every((m) => existsSync(path.resolve(videoRoot, m.file)))
        ) {
          return manifest;
        }
      } catch {
        // corrupt manifest: fall through and re-render
      }
    }
  }

  // Cache miss — resolve which timestamps to render.
  const {
    assertCaptureMediaLoaded,
    embedFontFaces,
    ensureHyperFrames,
    linkIntoWorkspace,
    loadHyperFramesProducer,
    makeCaptureWorkspace,
    silenceHyperFramesLogs,
  } = await import("./hyperframes.js");
  const { buildAssetUrl, parseServedAssetUrl } = await import("./composition-builder.js");
  await ensureHyperFrames();

  let timestamps: number[];
  const sceneMode = !requested;
  if (requested) {
    timestamps = requested; // honor every --at timecode exactly (no subsampling)
  } else {
    const detected = await detectCompositionKeyframes(
      video,
      manager,
      shotId,
      videoRoot,
      sceneThreshold,
      maxFrames,
    );
    if (detected.length === 0) return [];
    timestamps = subsampleTimestamps(detected, maxFrames); // cap only the auto-detected set
  }

  await fs.mkdir(cacheDir, { recursive: true });

  if (captureOptions?.pruneSuperseded) {
    try {
      for (const entry of await fs.readdir(outputDir)) {
        if (entry !== path.basename(cacheDir)) {
          await fs.rm(path.join(outputDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // best-effort GC of stale composition caches
    }
  }

  // Per-frame plan with deterministic output names; reuse on-disk frames for --at.
  const plan = timestamps.map((ts, i) => {
    const name = sceneMode
      ? `keyframe-${String(i + 1).padStart(3, "0")}.${ext}`
      : atFrameName(ts, ext);
    const finalPath = path.join(cacheDir, name);
    return { ts, finalPath, cached: !sceneMode && !force && existsSync(finalPath) };
  });

  const results: ThumbnailInfo[] = new Array(plan.length);

  if (plan.some((p) => !p.cached)) {
    const {
      createFileServer,
      createCaptureSession,
      initializeSession,
      captureFrame,
      closeCaptureSession,
    } = await loadHyperFramesProducer();

    const restoreLogs = silenceHyperFramesLogs();
    let workspace: string | undefined;
    let captureDir: string | undefined;
    try {
      workspace = await makeCaptureWorkspace(videoRoot, "capture-");
      // The producer names a frame by its index in the session, so two runs capturing straight into
      // the shared cacheDir rename each other's `frame_NNNNNN` away. Each run captures into its own
      // dir inside cacheDir — one filesystem, so moving a finished frame into place is atomic.
      captureDir = await fs.mkdtemp(path.join(cacheDir, ".capture-"));
      const captureHtml = withVideoElementIds(compositionResult.html);
      await fs.writeFile(
        path.join(workspace, "index.html"),
        await embedFontFaces(captureHtml),
        "utf-8",
      );

      const state = manager.getState();
      for (const [address, assetState] of Object.entries(state.assets)) {
        if (!assetState.variants) continue;
        for (const [variantId, variant] of Object.entries(assetState.variants)) {
          // Only what the page references: a hard link or copy fails on a take whose file is gone.
          if (
            variant.file &&
            captureHtml.includes(buildAssetUrl("", address, variantId, variant.file))
          ) {
            const absPath = path.resolve(videoRoot, variant.file);
            // The composition URLs are percent-encoded per segment, but the capture file
            // server decodes each segment before the filesystem lookup. Lay the links out
            // under the decoded path — the address split at `@`/`:` (so no `:` dir is created)
            // plus the variant — so they match what the server resolves the URL to.
            const targetDir = path.join(workspace, ...addressToCacheSegments(address), variantId);
            await fs.mkdir(targetDir, { recursive: true });
            try {
              await linkIntoWorkspace(absPath, path.join(targetDir, path.basename(variant.file)));
            } catch (err) {
              throw new KonteError(
                "FRAME_CAPTURE_FAILED",
                `${address} (${variantId}): cannot stage ${variant.file} for capture: ${errorMessage(err)}`,
              );
            }
          }
        }
      }

      // The page-side runtime quantizes every seek onto its own fps grid and falls back to 30 when
      // the server does not name one — so an unstated fps rounds a 24fps panel's start back over
      // the cut before it, and the frame captured for a keyframe is the OUTGOING one.
      const server = await createFileServer({
        projectDir: workspace,
        fps: { num: compositionResult.fps, den: 1 },
      });

      const { injector, suppliedVideoIds } = await buildVideoFrameInjector(
        harvestCompositionVideos(captureHtml),
        plan.filter((p) => !p.cached).map((p) => p.ts),
        workspace,
        compositionResult.fps,
      );

      const session = await createCaptureSession(
        server.url,
        captureDir,
        {
          width: compositionResult.size.width,
          height: compositionResult.size.height,
          // The composition's own fps: capture quantizes each timestamp onto this grid, so any
          // other value samples moments the delivered video never shows.
          fps: { num: compositionResult.fps, den: 1 },
          format,
          quality,
          skipReadinessVideoIds: suppliedVideoIds,
        },
        injector,
      );

      try {
        await initializeSession(session);
        assertCaptureMediaLoaded(session, (urlPath) => {
          const served = parseServedAssetUrl(urlPath, "");
          if (!served?.variantId) return null;
          const file = state.assets[served.address]?.variants?.[served.variantId]?.file;
          return `${served.address} (${served.variantId}${file ? `: ${file}` : ""})`;
        });
        let renderIdx = 0;
        for (let i = 0; i < plan.length; i++) {
          const entry = plan[i]!;
          if (entry.cached) {
            results[i] = {
              file: path.relative(videoRoot, entry.finalPath),
              timestamp: entry.ts,
            };
            continue;
          }
          const captureResult = await captureFrame(session, renderIdx++, entry.ts);
          await fs.rename(captureResult.path, entry.finalPath);
          results[i] = {
            file: path.relative(videoRoot, entry.finalPath),
            timestamp: entry.ts,
          };
        }
      } finally {
        await closeCaptureSession(session);
        server.close();
      }
    } finally {
      for (const dir of [workspace, captureDir]) {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
      }
      restoreLogs();
    }
  } else {
    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i]!;
      results[i] = { file: path.relative(videoRoot, entry.finalPath), timestamp: entry.ts };
    }
  }

  if (sceneMode) {
    try {
      await writeFileAtomic(manifestPath, JSON.stringify(results));
    } catch {
      // manifest is best-effort; its absence just means a cache miss next time
    }
  }

  return results;
}

async function detectCompositionKeyframes(
  video: import("./types/index.js").StageDefinition,
  manager: import("./state/index.js").StateManager,
  shotId: string,
  videoRoot: string,
  threshold: number,
  maxFrames: number,
): Promise<number[]> {
  const { buildRenderPlan } = await import("./render-plan.js");

  let plan;
  try {
    plan = buildRenderPlan(video, manager, {
      shotId,
      outputDir: "",
      allowUnaccepted: true,
      allowNotReady: true,
    });
  } catch {
    return [];
  }

  const shotPlan = plan.shots[0];
  if (!shotPlan) return [];

  const duration = shotPlan.duration;
  const allTimestamps: number[] = [];

  for (const [, filePath] of Object.entries(shotPlan.resolvedFiles)) {
    const absPath = path.resolve(videoRoot, filePath);
    const mediaType = inferMediaType(filePath);
    if (mediaType !== "video") continue;

    try {
      const ts = await detectSceneChanges(absPath, threshold, 0.5);
      allTimestamps.push(...ts.filter((t) => t <= duration));
    } catch {
      // skip unreadable files
    }
  }

  if (allTimestamps.length === 0 && duration > 0) {
    return generateUniformTimestamps(duration, maxFrames, []);
  }

  const unique = [...new Set(allTimestamps)].sort((a, b) => a - b);
  const filtered: number[] = [];
  for (const ts of unique) {
    if (filtered.length === 0 || ts - filtered[filtered.length - 1]! >= 0.5) {
      filtered.push(ts);
    }
  }

  // Low-motion shots yield only 1-2 scene changes, leaving too few frames to judge motion. Top up
  // with uniform timestamps to the full requested density so --max-frames actually controls how
  // finely a subtle-motion clip is sampled (a peak-collapsed pair of stills reads as "no motion").
  if (filtered.length < 3 && duration > 0) {
    const needed = maxFrames - filtered.length;
    if (needed > 0) {
      const uniform = generateUniformTimestamps(duration, needed, filtered);
      return [...filtered, ...uniform].sort((a, b) => a - b);
    }
  }

  return filtered;
}
