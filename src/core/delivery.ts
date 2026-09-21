import {
  COMPOSITION_ASSET_NAME,
  isDeliveryAddress,
  parseAddress,
  sourceAddressOfDelivery,
} from "./address.js";
import { computeDefinitionHash } from "./definition-hash.js";
import { makeMediaAsset, type MediaAsset } from "./dsl/builders.js";
import { endPinCollection } from "./dsl/pin-collect.js";
import { beginPromptCollection, endPromptCollection } from "./dsl/prompt-collect.js";
import { endRespellCollection } from "./dsl/respell.js";
import { makePlaceholder, makeTimelinePlaceholder } from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import type { PinCheckSubject, PinOccurrence } from "./pin-check.js";
import type { PromptCheckSubject, PromptOccurrence } from "./prompt-check.js";
import type {
  AssetDefinition,
  DeliveryUpscaleFn,
  DeliveryUpscaleInput,
  KonteState,
  VideoDefinition,
} from "./types/index.js";

// Two delivery upscale modes, distinguished by the #delivery source:
//   - "video": source is one video layer  (shot.<id>.<layer>#delivery)        → upscale.video
//   - "frame": source is the composited shot (shot.<id>#composition#delivery) → upscale.frame
type DeliveryMode = "video" | "frame";

// The inputs konte injects into a delivery upscale function. width/height are absolute and
// AR-preserving: per-layer = source size × scale, frame = the delivery size.
export type DeliveryTarget = { scale: number; width: number; height: number };

export function deliveryMode(deliveryAddress: string): DeliveryMode {
  const source = sourceAddressOfDelivery(deliveryAddress);
  const parsed = parseAddress(source);
  return parsed.kind === "shot" && parsed.assetName === COMPOSITION_ASSET_NAME ? "frame" : "video";
}

// The delivery upscale function for a mode, or undefined when not configured.
export function getDeliveryUpscaleFn(
  video: VideoDefinition,
  mode: DeliveryMode,
): DeliveryUpscaleFn | undefined {
  const upscale = video.export?.delivery?.upscale;
  return mode === "frame" ? upscale?.frame : upscale?.video;
}

// The delivery resolution, or undefined when the video has no delivery config.
export function getDeliverySize(
  video: VideoDefinition,
): { width: number; height: number } | undefined {
  return video.export?.delivery?.size;
}

// The uniform delivery/working scale factor (the whole composition scales by this). It COVERS the
// delivery rather than matching one axis: the working canvas lands a grid step or two off the
// delivery's exact aspect, so scaling by width alone leaves a gap on the other axis. The overshoot
// is cropped off at the end (`deliveryCoverSize`).
function deliveryScale(video: VideoDefinition): number {
  const size = getDeliverySize(video);
  const base = video.format.size;
  if (!size || base.width <= 0 || base.height <= 0) return 1;
  return Math.max(size.width / base.width, size.height / base.height);
}

// Even, because the cover frame is encoded before it is cropped and yuv420p has no odd dimension.
function toEven(value: number): number {
  const up = Math.ceil(value);
  return up % 2 === 0 ? up : up + 1;
}

// The scale past which the delivery is a real resolution increase rather than the rounding gap the
// derived canvas always leaves. Above it, letting ffmpeg stretch the picture ships a soft frame.
const UPSCALER_REQUIRED_ABOVE = 1.2;

export function deliveryNeedsUpscaler(video: VideoDefinition): boolean {
  return getDeliverySize(video) ? deliveryScale(video) > UPSCALER_REQUIRED_ABOVE : false;
}

export function deliveryUpscalerMissing(video: VideoDefinition): boolean {
  const upscale = video.export?.delivery?.upscale;
  return deliveryNeedsUpscaler(video) && !(upscale?.video || upscale?.frame);
}

// The composition's frame BEFORE the delivery crop: the working canvas scaled to cover the delivery
// on both axes. The picture is laid out here and the delivery frame cut from its centre. Laying out
// at the delivery size directly instead reflows the composition — a telop pinned at `left: 8%` lands
// somewhere else once the aspect moves.
export function deliveryCoverSize(video: VideoDefinition): { width: number; height: number } {
  const size = getDeliverySize(video);
  const base = video.format.size;
  if (!size) return { width: base.width, height: base.height };
  const scale = deliveryScale(video);
  return {
    width: Math.max(size.width, toEven(base.width * scale)),
    height: Math.max(size.height, toEven(base.height * scale)),
  };
}

// Compute the injected target for a delivery address given the source's real dimensions.
// per-layer: width/height = source × scale (AR-preserving absolute target). frame: the
// composite is the canvas, so the target is exactly the delivery size.
export function computeDeliveryTarget(
  video: VideoDefinition,
  mode: DeliveryMode,
  sourceSize: { width: number; height: number },
): DeliveryTarget {
  const size = getDeliverySize(video);
  const scale = deliveryScale(video);
  if (!size) return { scale, width: sourceSize.width, height: sourceSize.height };
  // Frame mode hands the whole composite to the upscaler, so its target is the cover frame, not the
  // delivery frame — the crop to delivery happens after, when the composites are stitched.
  if (mode === "frame") return { scale, ...deliveryCoverSize(video) };
  // Rounded the way `deliveryCoverSize` rounds, so a base-sized layer lands exactly on the frame it
  // fills. Rounding independently leaves it a pixel short — `object-fit: cover` then rescales it,
  // and the odd dimension it can land on is not encodable as yuv420p.
  return {
    scale,
    width: toEven(sourceSize.width * scale),
    height: toEven(sourceSize.height * scale),
  };
}

// Synthesize the AssetDefinition for a `#delivery` address. It is not authored by the user —
// it is derived by calling the profile's upscale function with konte's injected inputs: the
// source `video` (a placeholder, so the dependency graph and ref-resolver wire it up) and the
// `target` (scale + absolute width/height, which the caller computes from the resolved
// source's real size). Marked `deterministic`: konte accepts it on completion.
export function synthesizeDeliveryAssetDefinition(
  video: VideoDefinition,
  deliveryAddress: string,
  target: DeliveryTarget,
): AssetDefinition {
  if (!isDeliveryAddress(deliveryAddress)) {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Not a delivery address: "${deliveryAddress}" (expected a "#delivery" suffix)`,
    );
  }
  const sourceAddress = sourceAddressOfDelivery(deliveryAddress);
  const parsed = parseAddress(sourceAddress);
  if (parsed.stage !== "video") {
    throw new KonteError(
      "INVALID_ADDRESS",
      `Delivery is only defined for the video stage, got "${deliveryAddress}"`,
    );
  }

  const mode = deliveryMode(deliveryAddress);
  const fn = getDeliveryUpscaleFn(video, mode);
  if (!fn) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `No export.delivery.upscale.${mode} is configured, so "${deliveryAddress}" cannot be built`,
    );
  }

  const placeholder =
    parsed.kind === "shot"
      ? makePlaceholder("video", parsed.shotId, parsed.assetName)
      : makeTimelinePlaceholder("video", parsed.assetName);

  const input: DeliveryUpscaleInput = {
    video: makeMediaAsset(placeholder) as MediaAsset<"video">,
    scale: target.scale,
    width: target.width,
    height: target.height,
  };

  const def = fn(input);
  return { ...def, deterministic: true } as AssetDefinition;
}

// What the two stage-file gates read before an export submits a delivery upscale: the `"prompt"`
// values and `pin` wiring the author's upscale function built, stamped with the `#delivery` address
// they will be spent at, over the video stage's own waivers (the function is written in
// `video.tsx`). The function is pure by contract, so it is run a second time here under a
// collection.
export function deliveryPromptSubject(
  video: VideoDefinition,
  deliveryAddress: string,
  target: DeliveryTarget,
): PromptCheckSubject & PinCheckSubject {
  let prompts: readonly PromptOccurrence[] = [];
  let pins: readonly PinOccurrence[] = [];
  // Nothing here stores or validates a respelling: a collection a failed stage build left open is
  // closed rather than inherited.
  endRespellCollection();
  beginPromptCollection();
  try {
    synthesizeDeliveryAssetDefinition(video, deliveryAddress, target);
  } finally {
    prompts = endPromptCollection();
    pins = endPinCollection();
  }
  return {
    prompts: prompts.map((p) => ({ ...p, address: deliveryAddress })),
    pins: pins.map((p) => ({ ...p, address: deliveryAddress })),
    waivers: video.waivers,
  };
}

// The definition hash konte would store for a freshly built delivery variant.
function deliveryDefinitionHash(
  video: VideoDefinition,
  deliveryAddress: string,
  target: DeliveryTarget,
): string {
  return computeDefinitionHash(synthesizeDeliveryAssetDefinition(video, deliveryAddress, target));
}

// Whether a `#delivery` state key is still backed by the definition: its source must be a
// real video-stage source (a layer, or a shot's composition) and its profile must declare the
// matching upscale function. Used by `prune` to keep live delivery targets from being orphaned.
export function deliveryAddressIsValid(
  video: VideoDefinition,
  deliveryAddress: string,
  validSourceAddresses: ReadonlySet<string>,
): boolean {
  if (!isDeliveryAddress(deliveryAddress)) return false;
  const sourceAddress = sourceAddressOfDelivery(deliveryAddress);
  if (!validSourceAddresses.has(sourceAddress)) return false;
  let parsed;
  try {
    parsed = parseAddress(sourceAddress);
  } catch {
    return false;
  }
  if (parsed.stage !== "video") return false;
  return getDeliveryUpscaleFn(video, deliveryMode(deliveryAddress)) !== undefined;
}

// A ready delivery variant whose definition and source fingerprint both still
// match — i.e. re-exporting would not need to re-run the upscale (staleness cache hit).
// Robust to an unaccepted source (matches the resolved source's outputHash directly,
// not only an accepted upstream), since delivery sources may be ready-but-unaccepted.
//
// The definition check re-derives each variant's hash from its OWN snapshotted `deliveryTarget`
// (captured at submit), never from a fresh ffprobe of the source. A per-layer target's dims are
// the source's real size × scale, so re-probing at export time can drift (probe fallback, a
// re-encoded source) and falsely flag a just-built upscale as definition-stale. Re-deriving from
// the snapshot keeps the check deterministic while still catching a genuine definition edit (the
// hash recomputed from the same target against the current definition differs). A variant with
// no snapshotted target (pre-feature) can't be verified, so it is rebuilt.
export function findFreshDeliveryVariant(
  state: KonteState,
  video: VideoDefinition,
  deliveryAddress: string,
  sourceAddress: string,
  sourceOutputHash: string,
): { variantId: string; file: string } | null {
  const target = state.assets[deliveryAddress];
  if (!target?.variants) return null;
  // An address is its own asset-path form — inputFingerprints are keyed by it directly.
  const sourceAssetPath = sourceAddress;
  const ids = Object.keys(target.variants);
  for (let i = ids.length - 1; i >= 0; i--) {
    const variantId = ids[i]!;
    const v = target.variants[variantId];
    if (!v?.file || !v.deliveryTarget) continue;
    const expectedDefinitionHash = deliveryDefinitionHash(video, deliveryAddress, v.deliveryTarget);
    if (v.definitionHash !== expectedDefinitionHash) continue;
    if (v.inputFingerprints?.[sourceAssetPath] !== sourceOutputHash) continue;
    return { variantId, file: v.file };
  }
  return null;
}
