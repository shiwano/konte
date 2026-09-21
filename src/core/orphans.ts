import {
  formatShotAddress,
  listAddresses,
  listCompositionAddresses,
  listFrameDeliverySources,
  listReferenceAddresses,
  listStemAddresses,
  patchSourceVariantIdOf,
} from "./address.js";
import { listRemovedShotStemAddresses } from "./composition-resource.js";
import { deliveryAddressIsValid } from "./delivery.js";
import { listVariantDirsOnDisk, variantDir } from "./variant-dir.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  KonteState,
  VideoDefinition,
} from "./types/index.js";

type OrphanContext = {
  validCompositionAddresses: Set<string>;
  isOrphan: (address: string) => boolean;
};

// Single source of truth for "is this state address an orphan" — shared by `prune`
// (which deletes orphans) and `doctor` (which warns about them) so the two can never
// drift. An orphan is a state address that maps to no in-definition target: not a
// regular asset, not a live composition baseline, and not a live `#delivery` derivative.
export function buildOrphanContext(
  video: VideoDefinition,
  animatic: AnimaticDefinition | null,
  reference?: ReferenceDefinition | null,
  // Variant ids that still have a `patches/<id>.ts`. A patch step's declaration lives in that file,
  // so its script existing is what makes the step live — the same rule every other address follows.
  // Judged by filename, never by loading the module: a syntactically broken patch must not read as
  // "declaration gone" and take its steps' real variants with it. Undefined means "not looked up",
  // so every patch step is protected rather than guessed at.
  patchScriptIds?: ReadonlySet<string>,
  // Keeps a stem still accepted after its shot stopped sounding anything.
  state?: KonteState,
): OrphanContext {
  const validAddresses = new Set<string>();
  for (const addr of listAddresses(video, "video")) validAddresses.add(addr);
  // Bare shot-level targets hold whole-shot feedback (no asset name, no variants); listAddresses
  // never emits them, so add them explicitly or existing shots' feedback reads as orphaned.
  for (const s of video.shots) validAddresses.add(formatShotAddress("video", s.id));
  if (animatic) {
    for (const addr of listAddresses(animatic, "animatic")) validAddresses.add(addr);
    for (const s of animatic.shots) validAddresses.add(formatShotAddress("animatic", s.id));
  }
  // Reference assets are real `reference:*` targets — never orphans to be pruned.
  if (reference) {
    for (const addr of listReferenceAddresses(reference)) validAddresses.add(addr);
  }

  // Composition and stem LEAVES are NOT part of listAddresses (they have no asset entry), but
  // preview submit / `konte accept` materialize and record them into state — so they are live, never
  // orphans. Both composition stages have them: a leaf left out here is pruned away, taking its
  // accept and its HTML with it.
  const validCompositionAddresses = new Set<string>();
  for (const def of [video, animatic]) {
    if (!def) continue;
    for (const addr of listCompositionAddresses(def)) validCompositionAddresses.add(addr);
    for (const addr of listStemAddresses(def)) validCompositionAddresses.add(addr);
    if (state) {
      for (const addr of listRemovedShotStemAddresses(state, def)) {
        validCompositionAddresses.add(addr);
      }
    }
  }

  // A live #delivery target is derived from an in-definition source (a layer asset for `video`
  // mode, or a shot's frame source for `frame` mode) that still declares upscale.
  const frameDeliverySources = new Set<string>();
  for (const addr of listFrameDeliverySources(video)) frameDeliverySources.add(addr);
  const validDeliverySources = new Set([...validAddresses, ...frameDeliverySources]);

  const isOrphan = (address: string): boolean => {
    const patchSource = patchSourceVariantIdOf(address);
    if (patchSource !== null) {
      return patchScriptIds !== undefined && !patchScriptIds.has(patchSource);
    }
    return (
      !validAddresses.has(address) &&
      !validCompositionAddresses.has(address) &&
      !deliveryAddressIsValid(video, address, validDeliverySources)
    );
  };

  return { validCompositionAddresses, isOrphan };
}

/**
 * Variant directories on disk whose variant no state row records — left by a registration that
 * died before its save, or by a variant another checkout deleted. Pass the recorded state
 * (`StateManager.getRecordedState`): an absent variant's directory is not stray. Shared by `prune`
 * (which deletes them) and `doctor` (which warns about them).
 */
export async function listStrayVariantDirs(
  videoRoot: string,
  state: KonteState,
): Promise<string[]> {
  const recorded = new Set<string>();
  for (const [address, asset] of Object.entries(state.assets)) {
    for (const variantId of Object.keys(asset.variants ?? {})) {
      try {
        recorded.add(variantDir("", address, variantId));
      } catch {
        // unparseable address: owns no directory
      }
    }
  }
  return (await listVariantDirsOnDisk(videoRoot)).filter((dir) => !recorded.has(dir));
}
