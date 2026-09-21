import { existsSync } from "node:fs";
import * as path from "node:path";

// How many shot compositions render at once. Each render is a full browser capture, so the
// pool stays small — but a serial pass over a long timeline pays every capture end to end.
const SHOT_RENDER_CONCURRENCY = 2;
import {
  deliveryAddressOf,
  formatAddress,
  formatCompositionAddress,
  formatTimelineAddress,
  parseAssetPath,
} from "./address.js";
import { asideSlugHtml } from "./aside-slug.js";
import { injectBaseTimeline } from "./composition-builder.js";
import { resolveCompositionRef, substituteAssetPlaceholders } from "./composition-refs.js";
import { planShotById } from "./shot-index.js";
import { assertTailwindClasses } from "./tailwind-classes.js";
import { compositionCacheKey } from "./composition-resource.js";
import {
  computeDeliveryTarget,
  deliveryCoverSize,
  type DeliveryTarget,
  findFreshDeliveryVariant,
  getDeliverySize,
  getDeliveryUpscaleFn,
} from "./delivery.js";
import {
  parsePlaceholder,
  runInRenderMode,
  runTimelineInRenderMode,
  type ShotFunction,
} from "./dsl/shot-context.js";
import { KonteError, errorMessage } from "./errors.js";
import { STAGE_ENTRY_FILE } from "./roots.js";
import { syncFileAssets } from "./file-sync.js";
import { buildDependencyGraph } from "./graph.js";
import {
  concatenateShots,
  ensureFfmpeg,
  imageToVideo,
  muxTimelineAudio,
  tagDeliverable,
  videoToVideo,
} from "./ffmpeg.js";
import { loadReferenceDefinition, loadAnimaticDefinition } from "./loader.js";
import { compositeWithHyperFrames, ensureHyperFrames } from "./hyperframes.js";
import { renderToHtml } from "./jsx-html.js";
import type { Typography } from "./types/definition.js";
import { inferMediaType } from "./media-type.js";
import { buildRenderPlan, type RenderPlan, type ShotRenderPlan } from "./render-plan.js";
import { Semaphore } from "./semaphore.js";
import { clampEffectiveGain, cueKindsBySrc } from "./audio-level.js";
import { StateManager } from "./state/index.js";
import {
  buildTimelineTracks,
  collectShotAudioCues,
  type RawShotAudio,
  type ResolvedSoundtrack,
} from "./timeline-audio.js";
import type { SoundtrackEntry } from "./dsl/builders.js";
import {
  EXPORT_MANIFEST_FILE,
  type ExportManifest,
  type ManifestVariant,
  type ReferenceDefinition,
  type AnimaticDefinition,
  type VariantMedia,
  type VideoDefinition,
} from "./types/index.js";
import { shortId } from "./short-id.js";
import pkg from "../../package.json" with { type: "json" };
import { ensureVariantMedia, mediaByFile, mediaVisualSize } from "./variant-media.js";
import { probeMediaDuration, probeVideoDimensions } from "./video-probe.js";
import { probeVideo } from "./thumbnail.js";
import { applyResolutionDefinitions } from "./definition-hashes.js";

type DeliveryLayer = {
  shotId: string;
  assetName: string;
  sourceAddress: string;
  deliveryAddress: string;
  sourceAssetPath: string;
  sourceFileRel: string | null;
  sourceOutputHash: string | null;
  target: DeliveryTarget;
};

// Load the upstream animatic/reference entries so a render's file-asset sync covers every stage the
// video depends on. A missing or broken entry yields null — a render must never be blocked by an
// irrelevant upstream parse error.
async function loadUpstreamStages(videoRoot: string): Promise<{
  animatic: AnimaticDefinition | null;
  reference: ReferenceDefinition | null;
}> {
  const load = async <T>(file: string, loader: (p: string) => Promise<T>): Promise<T | null> => {
    const filePath = path.resolve(videoRoot, file);
    return existsSync(filePath) ? loader(filePath).catch(() => null) : null;
  };
  const [animatic, reference] = await Promise.all([
    load(STAGE_ENTRY_FILE.animatic, loadAnimaticDefinition),
    load(STAGE_ENTRY_FILE.reference, loadReferenceDefinition),
  ]);
  return { animatic, reference };
}

// The video-typed layers of a shot plan — composition layers (resolvedFiles) plus a
// single video fallback. Only video layers are upscaled for delivery.
function shotVideoLayers(shot: ShotRenderPlan): Array<{ assetName: string; absFile: string }> {
  const layers: Array<{ assetName: string; absFile: string }> = [];
  for (const [assetName, absFile] of Object.entries(shot.resolvedFiles)) {
    if (inferMediaType(absFile) === "video") layers.push({ assetName, absFile });
  }
  if (shot.fallbackFile && inferMediaType(shot.fallbackFile) === "video") {
    const assetName = Object.keys(shot.resolvedVariants)[0];
    if (assetName && !(assetName in shot.resolvedFiles)) {
      layers.push({ assetName, absFile: shot.fallbackFile });
    }
  }
  return layers;
}

// For each video layer across the shots, the source + delivery addressing, the recorded
// source fingerprint, and the upscale target. ffprobes each source so the per-layer target
// is its real size × scale (AR-preserving). The target is snapshotted onto the submitted
// upscale variant, so its definition hash is later re-derived from these exact dims — not re-probed.
export async function collectDeliveryLayers(
  video: VideoDefinition,
  shots: ShotRenderPlan[],
  manager: StateManager,
): Promise<DeliveryLayer[]> {
  const state = manager.getState();
  const layers: DeliveryLayer[] = [];
  for (const shot of shots) {
    for (const { assetName, absFile } of shotVideoLayers(shot)) {
      const sourceAddress = formatAddress("video", shot.shotId, assetName);
      const deliveryAddress = deliveryAddressOf(sourceAddress);
      const sourceVariantId = shot.resolvedVariants[assetName];
      const sourceVariant = sourceVariantId
        ? state.assets[sourceAddress]?.variants?.[sourceVariantId]
        : undefined;
      // The fallback file is the one layer with no variant behind it, so only that one still probes.
      const dims =
        mediaVisualSize(await ensureVariantMedia(sourceVariant, manager.videoRoot)) ??
        (await probeVideoDimensions(absFile)) ??
        video.format.size;
      const target = computeDeliveryTarget(video, "video", dims);
      layers.push({
        shotId: shot.shotId,
        assetName,
        sourceAddress,
        deliveryAddress,
        // Address ≡ asset path.
        sourceAssetPath: sourceAddress,
        sourceFileRel: sourceVariant?.file ?? null,
        sourceOutputHash: sourceVariant?.outputHash ?? null,
        target,
      });
    }
  }
  return layers;
}

export type DeliverySubstitution = { absFile: string; address: string; variantId: string };

// Resolve each video layer to its upscaled #delivery variant (at render time). Returns
// shotId → assetName → that variant and its absolute file. Throws DEPENDENCY_NOT_RESOLVED if any
// required delivery variant is missing or stale — an export job runs only once its delivery deps
// are ready, so this is a hard error.
async function resolveDeliverySubstitutions(opts: {
  video: VideoDefinition;
  shots: ShotRenderPlan[];
  manager: StateManager;
  videoRoot: string;
}): Promise<Map<string, Record<string, DeliverySubstitution>>> {
  const { video, shots, manager, videoRoot } = opts;
  const state = manager.getState();
  const layers = await collectDeliveryLayers(video, shots, manager);
  const substitutions = new Map<string, Record<string, DeliverySubstitution>>();

  for (const layer of layers) {
    const fresh =
      layer.sourceOutputHash != null
        ? findFreshDeliveryVariant(
            state,
            video,
            layer.deliveryAddress,
            layer.sourceAddress,
            layer.sourceOutputHash,
          )
        : null;
    if (!fresh) {
      throw new KonteError(
        "DEPENDENCY_NOT_RESOLVED",
        `Delivery upscale ${layer.deliveryAddress} is not ready — re-run "konte export" to (re)build it.`,
      );
    }
    const entry = substitutions.get(layer.shotId) ?? {};
    entry[layer.assetName] = {
      absFile: path.resolve(videoRoot, fresh.file),
      address: layer.deliveryAddress,
      variantId: fresh.variantId,
    };
    substitutions.set(layer.shotId, entry);
  }

  return substitutions;
}

function sanitizeShotId(shotId: string): string {
  return shotId.replace(/[/\\]/g, "_");
}

type RenderResult = { outputFile: string; warnings: string[] };

// Render the video to a delivered MP4. This is the work an `export` job performs:
// it resolves variants, re-composites at delivery resolution (substituting upscaled
// #delivery layers when the video has delivery config), stitches the shots, and writes
// metadata. Loads its own fresh state (the job may run long after registration). It does
// NOT submit any jobs or print — the caller (export command / job runner) owns those.
export async function renderVideoToFile(opts: {
  onLog?: (line: string) => void;
  videoRoot: string;
  video: VideoDefinition;
  animatic: AnimaticDefinition;
  allowUnaccepted: boolean;
  outputDir: string;
  // Stamped into the manifest as written; the caller owns the rule that a --no-delivery check
  // render carries none (see run-export-job.ts).
  exportSignature: string | null;
  // A working-size check render: the delivery upscales were never submitted, so the whole delivery
  // path is skipped — no substitutions, no cover scale, no crop. Without this the renderer would
  // look for `#delivery` variants that do not exist.
  noDelivery: boolean;
}): Promise<RenderResult> {
  const { videoRoot, video, animatic, allowUnaccepted, outputDir, exportSignature, noDelivery } =
    opts;

  // The reference stage is a separate entry; load it (if any) so the file-asset sync covers
  // reference files and a reference address resolves.
  const { reference } = await loadUpstreamStages(videoRoot);

  // All three stages, or a reference address resolves on the input axis alone.
  await applyResolutionDefinitions({ videoRoot, definitions: { reference, animatic, video } });

  // Sync file assets under the state lock so the seconds-long media hashing cannot
  // clobber a concurrent watcher write; reuse the returned post-sync snapshot below.
  const manager = await StateManager.withLock(videoRoot, async (m) => {
    await syncFileAssets({ reference, animatic, video }, m, { measure: true });
    return m;
  });

  // The mux reaches its sources by path, so hand it the measurements state already holds.
  const recordedMedia = mediaByFile(manager.getState(), videoRoot);
  const mediaOf = (absFile: string) => recordedMedia.get(absFile);

  // Every declared address across the three stages, resolved the way the render resolves a ref.
  const resolvedForManifest = new Map<string, ResolvedForManifest>();
  for (const address of buildDependencyGraph(
    video,
    animatic,
    reference ?? undefined,
  ).dependencies.keys()) {
    const ref = resolveCompositionRef(manager, address);
    if (ref) {
      resolvedForManifest.set(address, { variantId: ref.variantId, accepted: ref.isAccepted });
    }
  }

  const derivedFromOf = (address: string, variantId: string): string | null =>
    manager.getState().assets[address]?.variants?.[variantId]?.derivedFrom ?? null;

  const plan = buildRenderPlan(video, manager, { outputDir, allowUnaccepted: true });

  if (plan.shots.length === 0) {
    throw new KonteError("NO_RENDERABLE_ASSET", "No shots found in the video definition");
  }

  // Re-enforce the export gate at render time. `konte export` refuses to register when a shot is
  // still an undeveloped pendingShot, but the worker reloads the definition here (it may have
  // drifted since registration) — without this, the frame-delivery path silently skips a pending
  // shot and ships a deliverable missing that shot. Fail instead, matching the registration gate.
  const pendingShots = plan.shots.filter((s) => s.pending).map((s) => s.shotId);
  if (pendingShots.length > 0) {
    throw new KonteError(
      "PENDING_SHOTS",
      `Cannot render: the following shots are still undeveloped (pendingShot): ${pendingShots.join(
        ", ",
      )}. Develop them (swap the injected pendingShot for shot in video.tsx) before exporting.`,
    );
  }

  // An audio source may still be a placeholder at the mux — a `<Soundtrack src={reference.bgm}/>`
  // bed, a `<Sound src={reference.sfx}/>` cue pulled in by closure, or a `<Video src={shot(…).x}
  // hasAudio>` stem. Only a shot's own assets are resolved by the render pass; resolve the rest
  // from state here. A src that is not a placeholder (a real file path) is returned untouched.
  const resolveAssetSrc = (src: string): string => {
    const assetPath = parsePlaceholder(src);
    if (assetPath === null) return src;
    const resolved = resolveCompositionRef(manager, assetPath);
    return resolved?.file ?? src;
  };

  // Snapshot each shot's resolved files BEFORE any per-layer delivery substitution so timeline
  // audio (esp. <Video hasAudio> and a fallback clip's own audio) is read from the original
  // sources — audio never needs upscaling.
  const originalShotFiles = new Map(
    plan.shots.map(
      (s) =>
        [
          s.shotId,
          { resolvedFiles: { ...s.resolvedFiles }, fallbackFile: s.fallbackFile },
        ] as const,
    ),
  );

  // An out-of-shot ref with no ready variant would composite as a raw placeholder — a black layer.
  // `konte export` refuses to register on this, but the worker reloads state (it may have drifted
  // since registration), so re-enforce it. No flag overrides: there is nothing to render.
  const unresolvedRefs = [...new Set(plan.shots.flatMap((s) => s.unresolvedRefs))];
  if (unresolvedRefs.length > 0) {
    throw new KonteError(
      "DEPENDENCY_NOT_RESOLVED",
      `Cannot export: the composition references assets with no ready variant:\n${unresolvedRefs
        .map((ref) => `  ${ref}`)
        .join("\n")}\nGenerate them first.`,
    );
  }

  const allUnacceptedParts = [
    ...new Set([
      ...plan.unacceptedTimelineAssets,
      ...plan.shots.flatMap((s) => s.unacceptedAssets),
      ...plan.shots.flatMap((s) => s.unacceptedRefs),
    ]),
  ];

  // Refuse to export a half-baked video by default — re-run with --allow-unaccepted
  // to render the ready variants anyway.
  if (allUnacceptedParts.length > 0 && !allowUnaccepted) {
    throw new KonteError(
      "UNACCEPTED_ASSETS",
      `Cannot export: the following assets are not accepted:\n${allUnacceptedParts
        .map((addr) => `  ${addr}`)
        .join("\n")}\nAccept them, or pass --allow-unaccepted to render the ready variants.`,
    );
  }

  // Frame delivery: the delivery config upscales the whole composited shot (not per-layer). Each
  // shot's composite was already rendered (working res) and upscaled to a
  // `shot.<id>#composition#delivery` variant by the export command — here we just gather and
  // stitch those upscaled composites. No re-composite (text is upscaled with the frame).
  const frameFn = noDelivery ? undefined : getDeliveryUpscaleFn(video, "frame");
  const frameDeliverySize = noDelivery ? undefined : getDeliverySize(video);
  // Each composite was upscaled to the cover frame (see computeDeliveryTarget); the delivered frame
  // is cut from its centre when the two differ.
  const frameCover = frameDeliverySize ? deliveryCoverSize(video) : null;
  const frameDeliveryCrop =
    frameDeliverySize &&
    frameCover &&
    (frameCover.width !== frameDeliverySize.width || frameCover.height !== frameDeliverySize.height)
      ? frameDeliverySize
      : null;
  if (frameFn && frameDeliverySize) {
    const state = manager.getState();
    const frameWarnings: string[] = [];
    const shotFiles: string[] = [];
    const frameShotFileById = new Map<string, string>();
    const frameDeliveryVariants = new Map<string, { address: string; variantId: string }>();
    for (const shotPlan of plan.shots) {
      if (!shotPlan.shotFn && !shotPlan.fallbackFile) {
        frameWarnings.push(
          `shot ${shotPlan.shotId}: no renderable asset — skipped from frame delivery`,
        );
        continue;
      }
      const compAddr = formatCompositionAddress(shotPlan.stage, shotPlan.shotId);
      const deliveryAddr = deliveryAddressOf(compAddr);
      const cacheKey = compositionCacheKey(manager, video, shotPlan.shotId);
      const fresh = cacheKey
        ? findFreshDeliveryVariant(state, video, deliveryAddr, compAddr, cacheKey)
        : null;
      if (!fresh) {
        throw new KonteError(
          "DEPENDENCY_NOT_RESOLVED",
          `Frame delivery upscale ${deliveryAddr} is not ready — re-run "konte export" to (re)build it.`,
        );
      }
      const resolved = path.resolve(videoRoot, fresh.file);
      shotFiles.push(resolved);
      frameShotFileById.set(shotPlan.shotId, resolved);
      frameDeliveryVariants.set(shotPlan.shotId, {
        address: deliveryAddr,
        variantId: fresh.variantId,
      });
    }
    if (shotFiles.length === 0) {
      throw new KonteError("NO_RENDERABLE_ASSET", "No renderable shots for frame delivery");
    }
    await ensureFfmpeg();
    const finalOutput = path.join(outputDir, "video.mp4");
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(finalOutput), { recursive: true });
    if (shotFiles.length > 1) {
      // Composites come from arbitrary upscalers — re-encode to a uniform codec when stitching,
      // and conform to format.fps (upscalers may change the source rate).
      await concatenateShots({
        inputFiles: shotFiles,
        outputFile: finalOutput,
        reencode: true,
        fps: plan.fps,
        ...(frameDeliveryCrop ? { crop: frameDeliveryCrop } : {}),
      });
    } else {
      // A lone composite still inherits its upscaler's fps; conform to format.fps if it drifted,
      // otherwise copy as-is to avoid a needless re-encode. A crop is a re-encode either way.
      const probed = await probeVideo(shotFiles[0]!);
      if (Math.round(probed.fps) !== plan.fps || frameDeliveryCrop) {
        await concatenateShots({
          inputFiles: shotFiles,
          outputFile: finalOutput,
          reencode: true,
          fps: plan.fps,
          ...(frameDeliveryCrop ? { crop: frameDeliveryCrop } : {}),
        });
      } else {
        await fs.copyFile(shotFiles[0]!, finalOutput);
      }
    }

    // Frame composites carry no audio (upscalers are video-only); reconstruct it by muxing the
    // composition's timeline audio over the stitched picture. Re-run the timeline here to get the
    // shot inputs (the frame path otherwise skips rendering entirely).
    const frameTimelineRun = plan.timelineFn
      ? runTimelineInRenderMode(
          "video",
          () => plan.timelineFn!({ format: { size: plan.size, fps: plan.fps } }),
          plan.timelineResolvedFiles,
          plan.timelineResolvedFiles,
        )
      : null;
    await applyTimelineAudio({
      plan,
      size: plan.size,
      renderShotInputs: frameTimelineRun?.shots ?? null,
      soundtracks: frameTimelineRun?.soundtracks ?? null,
      originalShotFiles,
      shotFileById: frameShotFileById,
      finalOutput,
      resolveAssetSrc,
      mediaOf,
    });

    if (allUnacceptedParts.length > 0) {
      frameWarnings.push(`non-accepted: ${allUnacceptedParts.join(", ")}`);
    }

    // Record the delivery resolution (the stitched composites' size) in the manifest.
    plan.size = frameDeliverySize;
    await commitManifest(
      buildManifest(plan, {
        allWarnings: frameWarnings,
        allowUnaccepted,
        exportSignature,
        deliveryUpscale: "frame",
        resolved: resolvedForManifest,
        derivedFromOf,
        deliverySubstitutions: new Map(),
        frameDeliveryVariants,
      }),
      outputDir,
      finalOutput,
      frameWarnings,
    );

    return { outputFile: finalOutput, warnings: frameWarnings };
  }

  // Per-layer delivery upscale: when the video declares `export.delivery.upscale.video`, each
  // video layer was upscaled to the delivery resolution by separate upscale jobs (this export
  // job depends on them). Re-composite at that resolution so overlays/telops stay native and
  // sharp, substituting the upscaled #delivery file for each video layer.
  let deliverySubstitutions = new Map<string, Record<string, DeliverySubstitution>>();
  let deliveryUpscale: "video" | "frame" | null = null;
  // The delivery frame, captured from the centre of the cover-scaled composition (`plan.size`).
  let deliveryCrop: { width: number; height: number } | undefined;
  if (video.export?.delivery && !noDelivery) {
    const size = getDeliverySize(video);
    const fn = getDeliveryUpscaleFn(video, "video");
    if (size) {
      plan.size = deliveryCoverSize(video);
      deliveryCrop = size;
    }
    if (size && fn) {
      deliverySubstitutions = await resolveDeliverySubstitutions({
        video,
        shots: plan.shots,
        manager,
        videoRoot,
      });
      applyDeliverySubstitutions(plan.shots, deliverySubstitutions);
      deliveryUpscale = "video";
    }
  }

  await ensureHyperFrames();
  await ensureFfmpeg();

  const timelineRun = plan.timelineFn
    ? runTimelineInRenderMode(
        "video",
        () => plan.timelineFn!({ format: { size: plan.size, fps: plan.fps } }),
        plan.timelineResolvedFiles,
        plan.timelineResolvedFiles,
      )
    : null;
  const renderShotInputs = timelineRun?.shots ?? null;

  // Shot renders are independent — each writes its own shots/<id>.mp4 from a fresh render
  // workspace — so a small pool keeps a few Chromium captures in flight instead of paying
  // full serial wall-clock across every shot. Results keep plan order.
  const renderGate = new Semaphore(SHOT_RENDER_CONCURRENCY);
  const renderResults = await Promise.all(
    plan.shots.map((shotPlan) =>
      renderGate.run(async () => {
        const shotOutputFile = path.join(
          outputDir,
          "shots",
          `shot-${sanitizeShotId(shotPlan.shotId)}.mp4`,
        );

        const renderWarnings = await renderShotPlan(shotPlan, {
          onLog: opts.onLog,
          outputFile: shotOutputFile,
          fps: plan.fps,
          size: plan.size,
          crop: deliveryCrop,
          typography: plan.typography,
          videoRoot,
          renderShotInputs,
          manager,
          shots: plan.shots,
        });

        return { shotOutputFile, warnings: [...shotPlan.warnings, ...renderWarnings] };
      }),
    ),
  );
  const shotOutputFiles = renderResults.map((r) => r.shotOutputFile);
  const allWarnings = renderResults.flatMap((r) => r.warnings);

  const finalOutput = path.join(outputDir, "video.mp4");

  if (shotOutputFiles.length > 1) {
    await concatenateShots({ inputFiles: shotOutputFiles, outputFile: finalOutput });
  } else if (shotOutputFiles.length === 1) {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(finalOutput), { recursive: true });
    await fs.copyFile(shotOutputFiles[0]!, finalOutput);
  }

  await applyTimelineAudio({
    plan,
    size: plan.size,
    renderShotInputs,
    soundtracks: timelineRun?.soundtracks ?? null,
    originalShotFiles,
    shotFileById: new Map(plan.shots.map((s, i) => [s.shotId, shotOutputFiles[i]!] as const)),
    finalOutput,
    resolveAssetSrc,
    mediaOf,
  });

  if (allUnacceptedParts.length > 0) {
    allWarnings.push(`non-accepted: ${allUnacceptedParts.join(", ")}`);
  }

  // Record the delivered resolution (the captured frame), not the larger one it was cut from.
  if (deliveryCrop) plan.size = deliveryCrop;
  await commitManifest(
    buildManifest(plan, {
      allWarnings,
      allowUnaccepted,
      exportSignature,
      deliveryUpscale,
      resolved: resolvedForManifest,
      derivedFromOf,
      deliverySubstitutions,
      frameDeliveryVariants: new Map(),
    }),
    outputDir,
    finalOutput,
    allWarnings,
  );

  const fs = await import("node:fs/promises");
  // Per-shot files are intermediates only used to build video.mp4; drop them after concatenation.
  await fs.rm(path.join(outputDir, "shots"), { recursive: true, force: true });

  return { outputFile: finalOutput, warnings: allWarnings };
}

// Lay the composition's standalone audio (`<Soundtrack>`/`<Sound>`/`<Video hasAudio>`) over the
// concatenated picture in a single mux pass, replacing `finalOutput` in place. Audio is never
// baked per shot, so this is what gives the final video its sound — seam-free and upscale-safe.
// No-op when the composition has no audio.
async function applyTimelineAudio(opts: {
  plan: RenderPlan;
  size: { width: number; height: number };
  renderShotInputs: Array<{ id: string; fn: () => React.ReactElement }> | null;
  soundtracks: ReadonlyArray<SoundtrackEntry> | null;
  originalShotFiles: Map<
    string,
    { resolvedFiles: Record<string, string>; fallbackFile: string | null }
  >;
  shotFileById: Map<string, string>;
  finalOutput: string;
  resolveAssetSrc: (src: string) => string;
  mediaOf: (absFile: string) => VariantMedia | undefined;
}): Promise<void> {
  const {
    plan,
    size,
    renderShotInputs,
    soundtracks,
    originalShotFiles,
    shotFileById,
    finalOutput,
    resolveAssetSrc,
    mediaOf,
  } = opts;

  // Timeline soundtracks (beds/music) carry their clip in `src.src`. When the bed pulls a reference
  // asset (`reference.bgm`) it is still a `__konte:reference:…__` placeholder here, so resolve it to
  // its on-disk file before the mux; from/until anchors resolve to absolute time in
  // buildTimelineTracks against the ffprobed shot durations.
  const resolvedSoundtracks: ResolvedSoundtrack[] = (soundtracks ?? []).map((st) => ({
    id: st.id,
    file: resolveAssetSrc(st.src.src),
    from: st.options.from,
    until: st.options.until,
    mediaStart: st.options.mediaStart ?? 0,
    volume: clampEffectiveGain((st.options.volume ?? 1) * (plan.bedLevels[st.id]?.gain ?? 1)),
    ...(plan.bedLevels[st.id]?.loudness ? { loudness: plan.bedLevels[st.id]!.loudness } : {}),
    fadeIn: st.options.fadeIn,
    fadeOut: st.options.fadeOut,
    loop: st.options.loop,
    duck: st.options.duck,
  }));

  const audioByShot = new Map<string, RawShotAudio[]>();
  for (const shotPlan of plan.shots) {
    const original = originalShotFiles.get(shotPlan.shotId);
    if (shotPlan.shotFn) {
      const renderFn =
        renderShotInputs?.find((s) => s.id === shotPlan.shotId)?.fn ?? shotPlan.shotFn;
      const absoluteFiles = original?.resolvedFiles ?? shotPlan.resolvedFiles;
      // `onRenderError: "throw"`: a render failure here means the export would silently lose this
      // shot's audio. Audio is load-bearing, so fail the export loudly rather than ship a muted video.
      const shotAudio = collectShotAudioCues({
        stage: shotPlan.stage,
        shotId: shotPlan.shotId,
        duration: shotPlan.duration,
        renderFn,
        size,
        resolvedFiles: absoluteFiles,
        timelineFiles: plan.timelineResolvedFiles,
        cueLevels: shotPlan.cueLevels,
        cueKinds: cueKindsBySrc({
          stage: shotPlan.stage,
          shotId: shotPlan.shotId,
          cueKinds: shotPlan.cueKinds,
          resolvedFiles: absoluteFiles,
          timelineFiles: plan.timelineResolvedFiles,
        }),
        onRenderError: "throw",
      }).map((a) => ({ ...a, file: resolveAssetSrc(a.file) }));
      audioByShot.set(shotPlan.shotId, shotAudio);
    } else {
      // Fallback shot: no composition, but its full-frame video may carry audio that the old
      // per-shot bake preserved. Harvest it as an embedded track so the mux keeps it (probeHasAudio
      // in buildTimelineTracks drops it when the clip is silent).
      const fallback = original?.fallbackFile ?? shotPlan.fallbackFile;
      if (fallback && inferMediaType(fallback) === "video") {
        audioByShot.set(shotPlan.shotId, [
          {
            role: "embedded",
            // No composition, so no cue to classify: this track is in the mix but ducks nothing.
            kind: undefined,
            file: fallback,
            localStart: 0,
            localEnd: null,
            mediaStart: 0,
            volume: 1,
            cueId: null,
          },
        ]);
      }
    }
  }

  const hasShotAudio = [...audioByShot.values()].some((a) => a.length > 0);
  if (!hasShotAudio && resolvedSoundtracks.length === 0) return;

  const shotOrder = plan.shots.map((s) => s.shotId);
  const actualDurations = new Map<string, number>();
  // One ffprobe per shot; bounded-parallel instead of one full process round-trip at a time.
  const probeGate = new Semaphore(8);
  await Promise.all(
    plan.shots.map((shotPlan) =>
      probeGate.run(async () => {
        const file = shotFileById.get(shotPlan.shotId);
        const probed = file ? await probeMediaDuration(file) : null;
        actualDurations.set(shotPlan.shotId, probed ?? shotPlan.duration);
      }),
    ),
  );

  const tracks = await buildTimelineTracks({
    shotOrder,
    actualDurations,
    audioByShot,
    soundtracks: resolvedSoundtracks,
    mediaOf,
  });
  if (tracks.length === 0) return;

  // Clamp the mux to the stitched picture's real length so a long track can't stretch the file
  // past the video (which freezes the last frame in players).
  const videoDuration = (await probeMediaDuration(finalOutput)) ?? undefined;

  const fs = await import("node:fs/promises");
  const tmpOutput = `${finalOutput}.mux.mp4`;
  await muxTimelineAudio({ videoFile: finalOutput, outputFile: tmpOutput, tracks, videoDuration });
  await fs.rm(finalOutput, { force: true });
  await fs.rename(tmpOutput, finalOutput);
}

// Render a single shot's composition to an MP4 at the WORKING size — the source a
// frame delivery upscale consumes. Reuses the full export's render path, scoped to one shot,
// with no delivery substitution.
export async function renderShotCompositeToFile(opts: {
  videoRoot: string;
  video: VideoDefinition;
  shotId: string;
  allowUnaccepted: boolean;
  outputFile: string;
}): Promise<void> {
  const { videoRoot, video, shotId, allowUnaccepted, outputFile } = opts;
  const { animatic, reference } = await loadUpstreamStages(videoRoot);
  // Sync file assets under the state lock so the seconds-long media hashing cannot
  // clobber a concurrent watcher write; reuse the returned post-sync snapshot below.
  const manager = await StateManager.withLock(videoRoot, async (m) => {
    await syncFileAssets({ reference, animatic, video }, m, { measure: true });
    return m;
  });

  const plan = buildRenderPlan(video, manager, {
    shotId,
    outputDir: path.dirname(outputFile),
    allowUnaccepted: true,
  });
  const shotPlan = planShotById(plan.shots, shotId);
  if (!shotPlan) {
    throw new KonteError("NO_RENDERABLE_ASSET", `Shot "${shotId}" not found for frame delivery`);
  }
  if (!allowUnaccepted && shotPlan.unacceptedAssets.length > 0) {
    throw new KonteError(
      "UNACCEPTED_ASSETS",
      `Cannot upscale shot "${shotId}": not accepted: ${shotPlan.unacceptedAssets.join(", ")}`,
    );
  }

  await ensureHyperFrames();
  await ensureFfmpeg();

  const renderShotInputs = plan.timelineFn
    ? runTimelineInRenderMode(
        "video",
        () => plan.timelineFn!({ format: { size: plan.size, fps: plan.fps } }),
        plan.timelineResolvedFiles,
        plan.timelineResolvedFiles,
      ).shots
    : null;

  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await renderShotPlan(shotPlan, {
    outputFile,
    fps: plan.fps,
    size: plan.size, // working size — no delivery applied
    typography: plan.typography,
    videoRoot,
    renderShotInputs,
    manager,
    shots: plan.shots,
  });
}

// Swap each shot's video layers for their upscaled #delivery files before rendering.
// A composition layer is replaced in resolvedFiles; a single fallback video has its
// fallbackFile replaced.
function applyDeliverySubstitutions(
  shots: ShotRenderPlan[],
  substitutions: Map<string, Record<string, DeliverySubstitution>>,
): void {
  for (const shot of shots) {
    const sub = substitutions.get(shot.shotId);
    if (!sub) continue;
    for (const [assetName, { absFile }] of Object.entries(sub)) {
      if (assetName in shot.resolvedFiles) {
        shot.resolvedFiles[assetName] = absFile;
      } else if (shot.fallbackFile) {
        shot.fallbackFile = absFile;
      }
    }
  }
}

// The export is the final deliverable, so its shot composites render at the highest quality.
const EXPORT_QUALITY = "high" as const;

function buildAssetFiles(resolvedFiles: Record<string, string>): Record<string, string> {
  const assetFiles: Record<string, string> = {};
  for (const [assetName, filePath] of Object.entries(resolvedFiles)) {
    const ext = path.extname(filePath);
    assetFiles[`${assetName}${ext}`] = filePath;
  }
  return assetFiles;
}

// HyperFrames serves `assetFiles` by key, so an out-of-shot ref needs a workspace filename of its
// own. Only `:` is rewritten: the name goes into a `src` attribute, where a leading `video:` would
// read as a URL scheme. `.`, `-` and `_` are all legal in a filename and are kept, which keeps the
// mapping injective — a shot id and an asset name may each contain `-`/`_`, so collapsing those too
// would map `shot.a-b.c`, `shot.a.b-c` and `shot.a_b.c` onto one file. It also cannot collide with a
// shot's own `<assetName><ext>` key: the name carries a `<stage>.` prefix and an asset name may not
// contain `.`.
function refFileName(assetPath: string, filePath: string): string {
  return `${assetPath.replace(/:/g, ".")}${path.extname(filePath)}`;
}

interface ShotRenderInputs {
  compositionHtml: string;
  /** HyperFrames workspace filename → absolute source file. */
  assetFiles: Record<string, string>;
}

// The file a SIBLING shot's own render reads for `assetPath`, or null when the ref does not name one
// of this video's shot assets. Consulted before state so a cross-shot ref (`shot(…).video(…)`)
// composites from the very file its owning shot composites from — including the upscaled #delivery
// layer `applyDeliverySubstitutions` swapped into that shot's `resolvedFiles`. Resolving it from
// state instead would hand back the working-size source and leave that one layer soft at delivery
// resolution. The #delivery variant always exists here: the asset is a video layer of its own shot,
// so the export job already depended on its upscale.
function siblingShotFile(shots: readonly ShotRenderPlan[], assetPath: string): string | null {
  let parsed: ReturnType<typeof parseAssetPath>;
  try {
    parsed = parseAssetPath(assetPath);
  } catch {
    return null;
  }
  if (parsed.stage !== "video" || parsed.kind !== "shot") return null;
  const owner = shots.find((s) => s.shotId === parsed.shotId);
  return owner?.resolvedFiles[parsed.assetName] ?? null;
}

// A composition shot's render inputs: its HTML with every `src` pointing at a workspace filename,
// paired with the files to stage under those names. `asset()` resolves the shot's OWN assets during
// runInRenderMode; a ref reaching outside the shot (an animatic panel, a reference asset, a
// sibling shot's asset) survives as a `__konte:…__` placeholder and is substituted here.
export function buildShotRenderInputs(
  shotPlan: ShotRenderPlan & { shotFn: ShotFunction },
  options: {
    size: { width: number; height: number };
    // The delivery frame cut from the centre of `size`, when the two differ. See RenderContext.crop.
    crop?: { width: number; height: number };
    typography: Typography;
    manager: StateManager;
    renderShotInputs: Array<{ id: string; fn: () => React.ReactElement }> | null;
    // Every shot of the render plan, delivery substitutions already applied. See siblingShotFile.
    shots: readonly ShotRenderPlan[];
  },
): ShotRenderInputs {
  const { size, crop, typography, manager, renderShotInputs, shots } = options;

  const assetFiles = buildAssetFiles(shotPlan.resolvedFiles);
  const renderFiles: Record<string, string> = {};
  for (const [assetName, filePath] of Object.entries(shotPlan.resolvedFiles)) {
    renderFiles[assetName] = `${assetName}${path.extname(filePath)}`;
  }
  const renderFn = renderShotInputs?.find((s) => s.id === shotPlan.shotId)?.fn ?? shotPlan.shotFn;
  const jsx = runInRenderMode(
    shotPlan.stage,
    shotPlan.shotId,
    renderFn,
    renderFiles,
    shotPlan.resolvedFiles,
  );

  let compositionHtml = renderToHtml(jsx, {
    shotId: shotPlan.shotId,
    width: size.width,
    height: size.height,
    duration: shotPlan.duration,
    typography,
    ...(crop ? { crop } : {}),
  });
  compositionHtml = substituteAssetPlaceholders(compositionHtml, (assetPath) => {
    const file =
      siblingShotFile(shots, assetPath) ?? resolveCompositionRef(manager, assetPath)?.file;
    if (!file) return null;
    const name = refFileName(assetPath, file);
    assetFiles[name] = file;
    return name;
  });
  // Register a base gsap timeline so the capture engine's sub-composition
  // handshake resolves immediately for compositions without an <Animate>.
  compositionHtml = injectBaseTimeline(compositionHtml, shotPlan.shotId, shotPlan.duration);

  return { compositionHtml, assetFiles };
}

async function renderShotPlan(
  shotPlan: ShotRenderPlan,
  options: {
    onLog?: (line: string) => void;
    outputFile: string;
    fps: number;
    size: { width: number; height: number };
    crop?: { width: number; height: number };
    typography: Typography;
    videoRoot: string;
    renderShotInputs: Array<{ id: string; fn: () => React.ReactElement }> | null;
    manager: StateManager;
    shots: readonly ShotRenderPlan[];
  },
): Promise<string[]> {
  const { outputFile, fps, size, crop, typography, videoRoot, manager, renderShotInputs, shots } =
    options;

  if (shotPlan.shotFn) {
    const { compositionHtml, assetFiles } = buildShotRenderInputs(
      shotPlan as ShotRenderPlan & { shotFn: ShotFunction },
      { size, crop, typography, manager, renderShotInputs, shots },
    );
    await assertTailwindClasses([
      { label: formatCompositionAddress(shotPlan.stage, shotPlan.shotId), html: compositionHtml },
    ]);

    return await compositeWithHyperFrames({
      onLog: options.onLog,
      compositionHtml,
      assetFiles,
      outputFile,
      videoRoot,
      fps,
      size,
      duration: shotPlan.duration,
      quality: EXPORT_QUALITY,
    });
  } else if (shotPlan.fallbackFile) {
    const mediaType = inferMediaType(shotPlan.fallbackFile);
    if (mediaType === "image") {
      await imageToVideo({
        imageFile: shotPlan.fallbackFile,
        outputFile,
        fps,
        duration: shotPlan.duration,
        size,
      });
    } else {
      await videoToVideo({
        videoFile: shotPlan.fallbackFile,
        outputFile,
        fps,
        duration: shotPlan.duration,
        size,
      });
    }
  } else if (shotPlan.aside) {
    // An aside on the stage that does not board it. The span is real and has to be filled, so konte
    // renders its own labelled slug through the same capture path a shot takes.
    return await compositeWithHyperFrames({
      onLog: options.onLog,
      compositionHtml: injectBaseTimeline(
        asideSlugHtml({
          shotId: shotPlan.shotId,
          label: shotPlan.action,
          duration: shotPlan.duration,
          size,
          typography,
        }),
        shotPlan.shotId,
        shotPlan.duration,
      ),
      assetFiles: {},
      outputFile,
      videoRoot,
      fps,
      size,
      duration: shotPlan.duration,
      quality: EXPORT_QUALITY,
    });
  } else {
    throw new KonteError(
      "NO_RENDERABLE_ASSET",
      `Shot "${shotPlan.shotId}" has no renderable asset`,
    );
  }
  // The ffmpeg fallback paths are konte's own and warn through their own errors.
  return [];
}

// Write the manifest and burn its identity into the deliverable beside it. A failed tag pass costs
// the burned-in link, never the MP4, so it is a warning rather than a throw.
async function commitManifest(
  manifest: ExportManifest,
  outputDir: string,
  finalOutput: string,
  warnings: string[],
): Promise<void> {
  try {
    await tagDeliverable({
      file: finalOutput,
      tags: {
        konte_version: manifest.konteVersion,
        konte_manifest: manifest.id,
        ...(manifest.exportSignature ? { konte_export_signature: manifest.exportSignature } : {}),
      },
    });
  } catch (err) {
    warnings.push(`could not tag the deliverable with its manifest id: ${errorMessage(err)}`);
  }
  const fs = await import("node:fs/promises");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, EXPORT_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export type ResolvedForManifest = { variantId: string; accepted: boolean };

export function buildManifest(
  plan: RenderPlan,
  options: {
    allWarnings: string[];
    allowUnaccepted: boolean;
    exportSignature: string | null;
    deliveryUpscale: "video" | "frame" | null;
    // Every address the definitions declare, resolved the way the render resolved it.
    resolved: ReadonlyMap<string, ResolvedForManifest>;
    // A variant's patch lineage, read off state.
    derivedFromOf: (address: string, variantId: string) => string | null;
    deliverySubstitutions: Map<string, Record<string, DeliverySubstitution>>;
    frameDeliveryVariants: Map<string, { address: string; variantId: string }>;
  },
): ExportManifest {
  const {
    allWarnings,
    allowUnaccepted,
    exportSignature,
    deliveryUpscale,
    resolved,
    derivedFromOf,
    deliverySubstitutions,
    frameDeliveryVariants,
  } = options;

  const variants = new Map<string, ManifestVariant>();
  const record = (address: string, variantId: string, accepted: boolean) => {
    const entry: ManifestVariant = { variantId, accepted };
    const derivedFrom = derivedFromOf(address, variantId);
    if (derivedFrom) entry.derivedFrom = derivedFrom;
    variants.set(address, entry);
  };

  for (const [address, entry] of resolved) {
    record(address, entry.variantId, entry.accepted);
  }

  // The plan's own resolutions, in case a shot resolved something the declared graph does not list
  // (a fallback clip picks its own layer), and the `#delivery` derivatives, which are runtime
  // outputs with no place in the definition graph.
  for (const shotPlan of plan.shots) {
    const substituted = deliverySubstitutions.get(shotPlan.shotId) ?? {};
    for (const [assetName, variantId] of Object.entries(shotPlan.resolvedVariants)) {
      const address = formatAddress("video", shotPlan.shotId, assetName);
      if (variants.has(address)) continue;
      record(address, variantId, !shotPlan.unacceptedAssets.includes(address));
    }
    for (const delivered of Object.values(substituted)) {
      record(delivered.address, delivered.variantId, true);
    }
    const frame = frameDeliveryVariants.get(shotPlan.shotId);
    if (frame) record(frame.address, frame.variantId, true);
  }

  for (const [assetName, variantId] of Object.entries(plan.timelineResolvedVariants)) {
    const address = formatTimelineAddress("video", assetName);
    if (variants.has(address)) continue;
    record(address, variantId, !plan.unacceptedTimelineAssets.includes(address));
  }

  return {
    id: `mf-${shortId()}`,
    konteVersion: pkg.version,
    renderedAt: new Date().toISOString(),
    exportSignature,
    allowUnaccepted,
    fps: plan.fps,
    size: plan.size,
    deliveryUpscale,
    variants: Object.fromEntries([...variants].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    shots: plan.shots.map((shotPlan) => ({
      shotId: shotPlan.shotId,
      duration: shotPlan.duration,
      warnings: shotPlan.warnings,
    })),
    warnings: allWarnings,
  };
}
