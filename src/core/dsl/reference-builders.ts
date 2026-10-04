import type { ReferenceDefinition } from "../types/reference.js";
import type { MediaAsset, MediaKind } from "./builders.js";
import { endPinCollection } from "./pin-collect.js";
import { beginPromptCollection, endPromptCollection } from "./prompt-collect.js";
import { beginRespellCollection, endRespellCollection } from "./respell.js";
import { KonteError } from "../errors.js";
import type { AssetDefinition, Respelling, VideoFormat } from "../types/definition.js";
import type { PromptOccurrence } from "../prompt-check.js";
import type { DirectionIndex } from "./direction.js";
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
 * passing them overrides. `format` is the working canvas the other stages render at.
 */
export function defineReference<TAssets extends ReferenceAssetMap>(
  direction: DirectionEntry<unknown>,
  fn: (args: { format: VideoFormat }) => TAssets,
  opts: DefineReferenceOptions = {},
): ReferenceDefinition & ReferenceRef<TAssets> {
  const index = getDirectionIndex(direction);
  const base = index.format.size.base;
  const format = (assetName = ""): BuildFormat => ({
    size: deriveReferenceSize(base, index.referenceShapeById.get(assetName) ?? "square"),
    typography: index.typography,
  });
  // A respelling here stands for a lyric line the song's model is given in another spelling.
  beginRespellCollection();
  beginPromptCollection(scriptTexts(index.scriptById));
  const canvas: VideoFormat = { size: base, fps: index.format.fps };
  const discovery = runInReferenceDiscoveryMode(() => fn({ format: canvas }), format);
  const prompts = endPromptCollection();
  const respellings = endRespellCollection() ?? [];
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

  assertLyricsSung(index, assets, prompts, respellings);

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

// Every lyric line is one the song is generated singing: the words `reference:<clock.song>` hands
// its model carry each line as the direction spells it, or as a `respell()` of it does. A song not
// declared here is `song-unreferenced`'s, and one handed no words (a file, a model given none) has
// nothing to hold the lines against.
function assertLyricsSung(
  index: DirectionIndex,
  assets: Record<string, AssetDefinition>,
  prompts: readonly PromptOccurrence[],
  respellings: readonly Respelling[],
): void {
  const song = index.timeline.clock?.song;
  if (!song || !index.lyrics || !(song in assets)) return;
  const lines = index.lyrics.map((l) => l.text);
  for (const { line } of respellings) {
    if (!lines.includes(line)) {
      throw new KonteError(
        "INVALID_RESPELL",
        `respell() was given “${line}”, which is not a lyric line direction.ts declares. Pass the ` +
          `line itself so the respelling follows an edit to it.`,
      );
    }
  }
  const address = `reference:${song}`;
  const words = prompts
    .filter((p) => p.address === address)
    .flatMap((p) => (p.spoken ? [p.value] : (p.spokenWithin ?? [])));
  if (words.length === 0) return;
  const missing = [...new Set(lines)].filter((line) => {
    const spellings = [line, ...respellings.filter((r) => r.line === line).map((r) => r.as)];
    return !spellings.some((spelling) => words.some((w) => w.includes(spelling)));
  });
  if (missing.length === 0) return;
  throw new KonteError(
    "LYRICS_NOT_SUNG",
    `${address} is not given ${missing.length} lyric line(s) direction.ts declares — build its ` +
      "words input from direction.lyrics, or spell a line the model needs differently with " +
      'respell(line, "…")',
    missing.map((line) => `  “${line}”`),
  );
}
