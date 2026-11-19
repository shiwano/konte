import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deliveryAddressOf, formatCompositionAddress } from "../../core/address.js";
import { deploymentNameOf } from "../../comfy-api/routing.js";
import { loadKonteConfig } from "../../core/config.js";
import { compositionCacheKey } from "../../core/composition-resource.js";
import {
  computeDeliveryTarget,
  findFreshDeliveryVariant,
  getDeliverySize,
  getDeliveryUpscaleFn,
  deliveryPromptSubject,
  synthesizeDeliveryAssetDefinition,
  type DeliveryTarget,
} from "../../core/delivery.js";
import { pinFindings } from "../../core/pin-check.js";
import { promptFindings } from "../../core/prompt-check.js";
import { assertNoSpendFindings } from "../finding-gates.js";
import { JobIndex } from "../../core/job-index.js";
import type { JobManager } from "../../core/job-manager.js";
import { collectDeliveryLayers, renderShotCompositeToFile } from "../../core/render-video.js";
import type { ShotRenderPlan } from "../../core/render-plan.js";
import { StateManager } from "../../core/state/index.js";
import { computeDefinitionHash } from "../../core/definition-hash.js";
import { variantDir } from "../../core/variant-dir.js";
import type { AssetDefinition, VideoDefinition } from "../../core/types/index.js";
import {
  prepareSpend,
  printSpendNotices,
  registerJobs,
  reserveVariantsBatch,
} from "../generate-orchestrator.js";
import type { VideoRoots } from "../../core/roots.js";

// Result of planning the video's delivery upscales (export command side).
type DeliveryPlan = {
  // Every delivery address the export render will consume (the export job depends on these).
  deliveryAddresses: string[];
  // Upscale generation jobs registered this invocation.
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

  const jobIndex = new JobIndex(await jobManager.listJobs());
  const { deliveryAddresses, items, inProgress } = frameFn
    ? collectFrameItems(video, shots, manager, jobIndex)
    : await collectLayerItems(video, shots, manager, jobIndex);
  if (items.length === 0) return { deliveryAddresses, submittedJobIds: [], inProgress };

  // Every upscale is gated before any composite is rendered or job registered.
  const fixIn = { stage: "video" as const };
  assertNoSpendFindings(
    items.flatMap(({ address, target }) => {
      const subject = deliveryPromptSubject(video, address, target);
      return [...promptFindings(subject, fixIn), ...pinFindings(subject, fixIn)];
    }),
    { command: "export", stage: "video", addresses: [], targeted: false },
  );
  const spend = await prepareSpend(
    roots,
    items.map((item) => ({ label: item.address, def: item.assetDef })),
    await loadKonteConfig(roots.workspace),
  );
  printSpendNotices(spend);
  const deployments = new Set(
    items.flatMap((item) => {
      const target = spend.targetOf(item.assetDef);
      const name = target ? deploymentNameOf(target) : null;
      return name === null ? [] : [name];
    }),
  );
  for (const deployment of deployments) {
    console.log(
      `Bringing up Comfy API deployment ${deployment} for the delivery upscale — the first ` +
        `submit waits for it (minutes when a release has to build)`,
    );
  }

  // Each frame source is rendered before its variant is reserved, so a reservation never sits
  // without a job while a composite renders.
  const rendered = new Map<string, string>();
  const prereqJobs = new Map<string, string[]>();
  try {
    for (const item of items) {
      if (typeof item.source === "string") continue;
      const scratch = path.join(videoRoot, ".konte", "frame-src", `${randomUUID()}.mp4`);
      rendered.set(item.address, scratch);
      await item.source(scratch);
    }
    // The provisioning jobs are registered once every source is ready, so none completes and is
    // cleaned before the upscale that depends on it exists.
    for (const item of items) {
      prereqJobs.set(item.address, await spend.prereqJobs(item.assetDef, jobManager));
    }
  } catch (err) {
    await removeFiles(rendered.values());
    throw err;
  }

  // Reserved under the state lock, which re-checks for an upscale a concurrent export already
  // reserved: that one is in progress here.
  const reserved = await reserveVariantsBatch(
    videoRoot,
    items.map((item) => ({
      address: item.address,
      variantCount: 1,
      definitionHash: computeDefinitionHash(item.assetDef),
      assetDef: item.assetDef,
      deliveryTarget: item.target,
    })),
  );
  const claimed = items.flatMap((item) => {
    const variantId = reserved.get(item.address)?.[0];
    return variantId ? [{ item, variantId }] : [];
  });
  await removeFiles(
    items.filter((i) => !reserved.has(i.address)).map((i) => rendered.get(i.address)),
  );

  const unregistered = new Map(claimed.map((c) => [c.variantId, c.item.address]));
  const submittedJobIds: string[] = [];
  try {
    for (const { item, variantId } of claimed) {
      let source = item.source;
      if (typeof source !== "string") {
        const file = path.join(variantDir(videoRoot, item.address, variantId), FRAME_SOURCE_FILE);
        await fs.rename(rendered.get(item.address)!, file);
        source = path.relative(videoRoot, file);
      }
      // registerJobs drops its own reservation when it fails to create the job.
      unregistered.delete(variantId);
      const result = await registerJobs({
        address: item.address,
        assetDef: item.assetDef,
        variantCount: 1,
        videoRoot,
        jobManager,
        reservedVariantIds: [variantId],
        dependsOnJobs: prereqJobs.get(item.address),
        resolvedDeps: { [item.sourceAddress]: source },
        compositionCacheKeys: item.compositionCacheKeys,
        // Snapshot the resolved target so the variant's definition hash is re-derived from these
        // exact dims at export time, never from a fresh probe — and the worker rebuilds the
        // definition from it.
        deliveryTarget: item.target,
        comfyTarget: spend.targetOf(item.assetDef),
      });
      for (const j of result.jobs) submittedJobIds.push(j.variantId);
    }
  } catch (err) {
    // A reservation with no job reads as in flight and would hold its address forever.
    if (unregistered.size > 0) {
      await StateManager.withLock(videoRoot, async (m) => {
        for (const [variantId, address] of unregistered) m.removeVariant(address, variantId);
      });
    }
    await removeFiles([...unregistered.values()].map((address) => rendered.get(address)));
    throw err;
  }
  return {
    deliveryAddresses,
    submittedJobIds,
    inProgress: inProgress + items.length - claimed.length,
  };
}

type DeliveryItem = {
  address: string;
  assetDef: AssetDefinition;
  target: DeliveryTarget;
  sourceAddress: string;
  // The source file, video-root relative, or how to render it to a given path.
  source: string | ((outputFile: string) => Promise<void>);
  compositionCacheKeys?: Record<string, string>;
};

const FRAME_SOURCE_FILE = "frame-source.mp4";

async function removeFiles(files: Iterable<string | undefined>): Promise<void> {
  for (const file of files) if (file) await fs.rm(file, { force: true });
}

type DeliveryItems = {
  deliveryAddresses: string[];
  items: DeliveryItem[];
  inProgress: number;
};

// Frame mode: upscale each shot's whole composite. Cache on the composition's identity
// (compositionCacheKey) so a cache hit needs no re-render; on a miss, render the working
// composite to MP4 and submit the upscale with it as the source.
function collectFrameItems(
  video: VideoDefinition,
  shots: ShotRenderPlan[],
  manager: StateManager,
  jobIndex: JobIndex,
): DeliveryItems {
  const state = manager.getState();
  const target = computeDeliveryTarget(video, "frame", video.format.size);
  const out: DeliveryItems = { deliveryAddresses: [], items: [], inProgress: 0 };
  for (const shot of shots) {
    const compAddr = formatCompositionAddress("video", shot.shotId);
    const deliveryAddr = deliveryAddressOf(compAddr);
    out.deliveryAddresses.push(deliveryAddr);

    const cacheKey = compositionCacheKey(manager, video, shot.shotId);
    if (cacheKey && findFreshDeliveryVariant(state, video, deliveryAddr, compAddr, cacheKey)) {
      continue;
    }
    if (jobIndex.hasActiveJobFor(deliveryAddr)) {
      out.inProgress++;
      continue;
    }

    out.items.push({
      address: deliveryAddr,
      assetDef: synthesizeDeliveryAssetDefinition(video, deliveryAddr, target),
      target,
      sourceAddress: compAddr,
      source: (outputFile) =>
        renderShotCompositeToFile({
          videoRoot: manager.videoRoot,
          video,
          shotId: shot.shotId,
          allowUnaccepted: true,
          outputFile,
        }),
      // Snapshot the source composition's cache key so the produced upscale is fingerprinted
      // against the composition actually rendered here — not whatever live state shows when the
      // (possibly long) upscale finishes. Absent when uncomputable, in which case the upscale is
      // simply left without a composition fingerprint (never cache-hit) rather than mis-keyed.
      compositionCacheKeys: cacheKey ? { [compAddr]: cacheKey } : undefined,
    });
  }
  return out;
}

// Per-layer mode: upscale each video layer; ffprobe gives each its real target size.
async function collectLayerItems(
  video: VideoDefinition,
  shots: ShotRenderPlan[],
  manager: StateManager,
  jobIndex: JobIndex,
): Promise<DeliveryItems> {
  const state = manager.getState();
  const layers = await collectDeliveryLayers(video, shots, manager);
  const out: DeliveryItems = {
    deliveryAddresses: layers.map((l) => l.deliveryAddress),
    items: [],
    inProgress: 0,
  };
  for (const layer of layers) {
    if (
      layer.sourceOutputHash != null &&
      findFreshDeliveryVariant(
        state,
        video,
        layer.deliveryAddress,
        layer.sourceAddress,
        layer.sourceOutputHash,
      )
    ) {
      continue;
    }
    if (jobIndex.hasActiveJobFor(layer.deliveryAddress)) {
      out.inProgress++;
      continue;
    }
    if (!layer.sourceFileRel) continue;

    out.items.push({
      address: layer.deliveryAddress,
      assetDef: synthesizeDeliveryAssetDefinition(video, layer.deliveryAddress, layer.target),
      target: layer.target,
      sourceAddress: layer.sourceAddress,
      source: layer.sourceFileRel,
    });
  }
  return out;
}
