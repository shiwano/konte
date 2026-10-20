import {
  formatShotAddress,
  listAddresses,
  listCompositionAddresses,
  listOverlayAddresses,
  listFrameDeliverySources,
  listReferenceAddresses,
  listStemAddresses,
  patchSourceVariantIdOf,
} from "./address.js";
import { listRemovedShotStemAddresses } from "./composition-resource.js";
import { deliveryAddressIsValid } from "./delivery.js";
import { listVariantDirsOnDisk, variantDir } from "./variant-dir.js";
import { acceptedConsumers, type VariantRef } from "./variant-lineage.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  KonteState,
  VideoDefinition,
} from "./types/index.js";

type OrphanContext = {
  validCompositionAddresses: Set<string>;
  isOrphan: (address: string) => boolean;
  // The accepted takes, at declared addresses, made from a take at this undeclared address — what
  // keeps it from being an orphan.
  acceptedMadeFrom: (address: string) => VariantRef[];
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
  // Keeps a stem still accepted after its shot stopped sounding anything, and an address an accepted
  // take was made from.
  state?: KonteState,
  // The direction's part addresses (`directionPartHashes`), each a feedback-only target.
  directionParts?: Iterable<string>,
): OrphanContext {
  const validAddresses = new Set<string>();
  for (const addr of listAddresses(video, "video")) validAddresses.add(addr);
  // Bare shot-level targets hold whole-shot feedback (no asset name, no variants); listAddresses
  // never emits them, so add them explicitly or existing shots' feedback reads as orphaned.
  for (const s of video.shots) validAddresses.add(formatShotAddress("video", s.id));
  // A bare stage holds a review's overall comment.
  for (const stage of ["animatic", "video", "reference", "direction"]) validAddresses.add(stage);
  for (const part of directionParts ?? []) validAddresses.add(part);
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
    for (const addr of listOverlayAddresses(def)) validCompositionAddresses.add(addr);
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

  const isUndeclared = (address: string): boolean => {
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

  // A patch step lives on its script, but is no take of its own to keep: what counts is whether
  // the take it corrects stands at a declared address.
  const addressOfVariant = new Map<string, string>();
  for (const [address, asset] of Object.entries(state?.assets ?? {})) {
    for (const variantId of Object.keys(asset.variants ?? {})) {
      addressOfVariant.set(variantId, address);
    }
  }
  const isLiveConsumer = (address: string): boolean => {
    const patchSource = patchSourceVariantIdOf(address);
    if (patchSource === null) return !isUndeclared(address);
    const sourceAddress = addressOfVariant.get(patchSource);
    return sourceAddress !== undefined && !isUndeclared(sourceAddress);
  };

  const madeFrom = new Map<string, VariantRef[]>();
  for (const [key, roots] of state ? acceptedConsumers(state) : []) {
    const address = key.slice(0, key.lastIndexOf(" "));
    if (!isUndeclared(address)) continue;
    for (const root of roots) {
      if (!isLiveConsumer(root.address)) continue;
      const refs = madeFrom.get(address) ?? [];
      if (!refs.some((r) => r.address === root.address && r.variantId === root.variantId)) {
        madeFrom.set(address, [...refs, root]);
      }
    }
  }
  const acceptedMadeFrom = (address: string): VariantRef[] => madeFrom.get(address) ?? [];
  const isOrphan = (address: string): boolean => isUndeclared(address) && !madeFrom.has(address);

  return { validCompositionAddresses, isOrphan, acceptedMadeFrom };
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
