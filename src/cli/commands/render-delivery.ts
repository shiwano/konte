import * as path from "node:path";
import { deliveryAddressOf, formatCompositionAddress } from "../../core/address.js";
import type { GenerationBackend } from "../../core/backend.js";
import { assertSpendAllowed } from "../../core/backend-policy.js";
import { loadKonteConfig } from "../../core/config.js";
import { compositionCacheKey } from "../../core/composition-resource.js";
import {
  computeDeliveryTarget,
  findFreshDeliveryVariant,
  getDeliverySize,
  getDeliveryUpscaleFn,
  deliveryPromptSubject,
  synthesizeDeliveryAssetDefinition,
} from "../../core/delivery.js";
import { assertPinGate } from "../../core/pin-check.js";
import { assertPromptGate } from "../../core/prompt-check.js";
import { JobIndex } from "../../core/job-index.js";
import type { JobManager } from "../../core/job-manager.js";
import { collectDeliveryLayers, renderShotCompositeToFile } from "../../core/render-video.js";
import type { ShotRenderPlan } from "../../core/render-plan.js";
import type { StateManager } from "../../core/state/index.js";
import type { AssetDefinition, BackendKind, VideoDefinition } from "../../core/types/index.js";
import { submitAssetJobs } from "../generate-orchestrator.js";
import type { VideoRoots } from "../../core/roots.js";

// Result of planning the video's delivery upscales (export command side).
type DeliveryPlan = {
  // Every delivery address the export render will consume (the export job depends on these).
  deliveryAddresses: string[];
  // Upscale generation jobs submitted this invocation.
  submittedJobIds: string[];
  // Delivery upscales still running from a previous invocation.
  inProgress: number;
};

// Plan the video's delivery upscales: reuse fresh upscaled variants, skip ones whose upscale
// job is still in flight, and submit new upscale jobs for stale/missing ones. Returns the full
// set of delivery addresses the export render depends on, plus the jobs submitted now. Returns
// null when the video has no delivery upscale configured. `frame` mode takes precedence over
// `video` when both are set.
export async function planDelivery(opts: {
  video: VideoDefinition;
  shots: ShotRenderPlan[];
  manager: StateManager;
  roots: VideoRoots;
  jobManager: JobManager;
}): Promise<DeliveryPlan | null> {
  const { video, shots, manager, roots, jobManager } = opts;
  const videoRoot = roots.video;
  const size = getDeliverySize(video);
  if (!size) return null;

  const frameFn = getDeliveryUpscaleFn(video, "frame");
  const videoFn = getDeliveryUpscaleFn(video, "video");
  if (!frameFn && !videoFn) return null;

  const state = manager.getState();
  const jobIndex = new JobIndex(await jobManager.listJobs());
  const hasActiveJob = (address: string): boolean => jobIndex.hasActiveJobFor(address);

  // A delivery upscale runs on comfy or fal, so export is a spend entry point. Gated on the first
  // item that would be submitted — one upscale function serves a whole mode — and before its
  // composite is rendered.
  const config = await loadKonteConfig(roots.workspace);
  let gated = false;
  const gateSpend = (assetDef: AssetDefinition, label: string): void => {
    if (gated) return;
    assertSpendAllowed([{ label, kind: assetDef.kind }], config);
    gated = true;
  };

  const backendCache = new Map<BackendKind, GenerationBackend>();
  const deliveryAddresses: string[] = [];
  const submittedJobIds: string[] = [];
  let inProgress = 0;

  if (frameFn) {
    // Frame mode: upscale each shot's whole composite. Cache on the composition's identity
    // (compositionCacheKey) so a cache hit needs no re-render; on a miss, render the working
    // composite to MP4 and submit the upscale with it as the source.
    const target = computeDeliveryTarget(video, "frame", video.format.size);
    for (const shot of shots) {
      if (!shot.shotFn && !shot.fallbackFile) continue; // nothing renderable to upscale
      const compAddr = formatCompositionAddress("video", shot.shotId);
      const deliveryAddr = deliveryAddressOf(compAddr);
      deliveryAddresses.push(deliveryAddr);

      const cacheKey = compositionCacheKey(manager, video, shot.shotId);
      const fresh = cacheKey
        ? findFreshDeliveryVariant(state, video, deliveryAddr, compAddr, cacheKey)
        : null;
      if (fresh) continue;
      if (hasActiveJob(deliveryAddr)) {
        inProgress++;
        continue;
      }

      const assetDef = synthesizeDeliveryAssetDefinition(video, deliveryAddr, target);
      gateSpend(assetDef, deliveryAddr);
      const subject = deliveryPromptSubject(video, deliveryAddr, target);
      assertPromptGate(subject, "video.tsx");
      assertPinGate(subject, "video.tsx");

      const compositeAbs = path.resolve(
        videoRoot,
        ".konte",
        "frame-src",
        `shot.${shot.shotId}.mp4`,
      );
      await renderShotCompositeToFile({
        videoRoot,
        video,
        shotId: shot.shotId,
        allowUnaccepted: true,
        outputFile: compositeAbs,
      });
      const result = await submitAssetJobs(
        deliveryAddr,
        assetDef,
        1,
        roots,
        jobManager,
        backendCache,
        { [compAddr]: path.relative(videoRoot, compositeAbs) },
        // Snapshot the source composition's cache key so the produced upscale is fingerprinted
        // against the composition actually rendered here — not whatever live state shows when the
        // (possibly long) upscale finishes. Absent when uncomputable, in which case the upscale is
        // simply left without a composition fingerprint (never cache-hit) rather than mis-keyed.
        cacheKey ? { [compAddr]: cacheKey } : undefined,
        // Snapshot the resolved target so the variant's definition hash is re-derived from these exact
        // dims at export time, never from a fresh probe.
        target,
      );
      for (const j of result.jobs) submittedJobIds.push(j.variantId);
    }
    return { deliveryAddresses, submittedJobIds, inProgress };
  }

  // Per-layer mode: upscale each video layer; ffprobe gives each its real target size.
  const layers = await collectDeliveryLayers(video, shots, manager);
  deliveryAddresses.push(...layers.map((l) => l.deliveryAddress));

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
    if (fresh) continue;

    if (hasActiveJob(layer.deliveryAddress)) {
      inProgress++;
      continue;
    }

    if (!layer.sourceFileRel) continue;

    const assetDef = synthesizeDeliveryAssetDefinition(video, layer.deliveryAddress, layer.target);
    gateSpend(assetDef, layer.deliveryAddress);
    const subject = deliveryPromptSubject(video, layer.deliveryAddress, layer.target);
    assertPromptGate(subject, "video.tsx");
    assertPinGate(subject, "video.tsx");
    const result = await submitAssetJobs(
      layer.deliveryAddress,
      assetDef,
      1,
      roots,
      jobManager,
      backendCache,
      { [layer.sourceAssetPath]: layer.sourceFileRel },
      undefined,
      // Snapshot the resolved target so the variant's definition hash is re-derived from these exact
      // dims at export time, never from a fresh probe (whose drift would falsely mark it stale).
      layer.target,
    );
    for (const j of result.jobs) submittedJobIds.push(j.variantId);
  }

  return { deliveryAddresses, submittedJobIds, inProgress };
}
