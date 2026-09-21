import type { ReferenceDefinition } from "../types/reference.js";
import type { MediaAsset, MediaKind } from "./builders.js";
import { endPinCollection } from "./pin-collect.js";
import { beginPromptCollection, endPromptCollection } from "./prompt-collect.js";
import { endRespellCollection } from "./respell.js";
import { scriptTexts } from "./shot-script.js";
import { runInReferenceDiscoveryMode, type BuildFormat } from "./shot-context.js";
import { getDirectionIndex, type DirectionEntry } from "./direction.js";
import { deriveReferenceSize } from "../canvas.js";

type ReferenceAssetMap = Record<string, MediaAsset<MediaKind>>;

/**
 * The ref surface: `reference.character` / `reference.bgm`, each a MediaAsset placeholder
 * typed to the media kind its asset() produced.
 */
export type ReferenceRef<TAssets extends ReferenceAssetMap> = {
  readonly [K in keyof TAssets]: TAssets[K];
};

// Keys the merged result reserves for the ReferenceDefinition itself — an asset may not take one.
const RESERVED_NAMES = new Set([
  "shots",
  "topLevelAssets",
  "exposedAssetNames",
  "prompts",
  "pins",
  "waivers",
]);

export interface DefineReferenceOptions {
  // Prompt findings this stage accepts, keyed the way `konte status` prints them
  // (`prompt-negation:<hash>`) over the reason each is right; never a fixable one.
  waivers?: Record<string, string>;
}

/**
 * Declares the reference stage: the direction, then a flat callback that returns a named map of
 * asset()s. The returned object IS both the ReferenceDefinition (loaded by konte) and the ref used by
 * animatic/video to fabricate `reference:<name>` placeholders.
 *
 * The direction is taken for its typesetting (`policy.lang` + `policy.fonts`) and for the canvas
 * each sheet is sized off: its long edge, at the shape the asset's roster asks for
 * (`deriveReferenceSize`). An adapter's `width`/`height` are therefore filled in like a stage's;
 * passing them overrides.
 */
export function defineReference<TAssets extends ReferenceAssetMap>(
  direction: DirectionEntry<unknown>,
  fn: () => TAssets,
  opts: DefineReferenceOptions = {},
): ReferenceDefinition & ReferenceRef<TAssets> {
  const index = getDirectionIndex(direction);
  const base = index.format.size.base;
  const format = (assetName = ""): BuildFormat => ({
    size: deriveReferenceSize(base, index.referenceShapeById.get(assetName) ?? "square"),
    typography: index.typography,
  });
  // Nothing here stores or validates a respelling: a collection a failed stage build left open is
  // closed rather than inherited.
  endRespellCollection();
  beginPromptCollection(scriptTexts(index.scriptById));
  const discovery = runInReferenceDiscoveryMode(fn, format);
  const prompts = endPromptCollection();
  const pins = endPinCollection();
  const assets = discovery.assets;
  const returned = discovery.result as TAssets;

  // Every declared asset() is generatable (it lands in `topLevelAssets`); returning it is what
  // additionally exposes it as a `reference.<name>` placeholder to the other stages. An asset
  // used only as an input to another reference asset (e.g. a blank `latent` feeding a `key`) can
  // therefore be declared without being returned. A declared asset that is neither exposed nor
  // consumed is unused — `generate`/`doctor` report it (skip + warn), like an unused video/
  // animatic asset, rather than failing the load. A returned name must still be a real asset()
  // (no aliasing/extras) and may not collide with a reserved key.
  for (const name of Object.keys(returned)) {
    if (!(name in assets)) {
      throw new Error(`defineReference: "${name}" was returned but not declared via asset()`);
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(
        `defineReference: "${name}" is a reserved name and cannot be a reference asset`,
      );
    }
  }

  const definition: ReferenceDefinition = {
    shots: [],
    topLevelAssets: assets,
    exposedAssetNames: Object.keys(returned),
    ...(prompts.length > 0 ? { prompts } : {}),
    ...(pins.length > 0 ? { pins } : {}),
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
  };

  // `returned` already maps each name to its makeReferencePlaceholder() MediaAsset.
  return Object.assign(definition, returned) as ReferenceDefinition & ReferenceRef<TAssets>;
}
