import type { ReferenceDefinition } from "../types/reference.js";
import type { MediaAsset, MediaKind } from "./builders.js";
import { endPinCollection } from "./pin-collect.js";
import { beginPromptCollection, endPromptCollection } from "./prompt-collect.js";
import { beginRespellCollection, endRespellCollection } from "./respell.js";
import { KonteError } from "../errors.js";
import type { AssetDefinition, Respelling, VideoFormat } from "../types/definition.js";
import type { PromptOccurrence } from "../prompt-check.js";
import type { PinOccurrence } from "../pin-check.js";
import type { DirectionIndex } from "./direction.js";
import { scriptTexts } from "./shot-script.js";
import {
  makeReferencePlaceholder,
  parsePlaceholder,
  runInReferenceDiscoveryMode,
  type BuildFormat,
} from "./shot-context.js";
import {
  getDirectionIndex,
  type DirectionEntry,
  type LocationIdOf,
  type ViewsAtOf,
} from "./direction.js";
import { IMAGED_VIEWS, isImagedView, viewAssetName } from "../view.js";
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

/**
 * The view images a `views` callback may return: per location, one image per way its setups face
 * other than `front`, which is the location's own `reference:<id>`.
 */
export type ReferenceViews<D> = {
  [L in LocationIdOf<D>]?: { [V in Exclude<ViewsAtOf<D, L>, "front">]?: MediaAsset<"image"> };
};

export interface DefineReferenceOptions<TAssets extends ReferenceAssetMap, D = unknown> {
  // The shared pool: a flat callback returning a named map of asset()s, each exposed as
  // `reference.<name>`. `format` is the working canvas the other stages render at.
  references: (args: { format: VideoFormat }) => TAssets;
  // Each location's view images, keyed by location id and view, each addressed
  // `reference:view.<locationId>.<view>` whatever its asset is named. Runs after `references`, which
  // it receives. Its own declaration site (`view`): an adapter whose `allowedIn` lacks it is refused.
  views?: (args: { format: VideoFormat; reference: ReferenceRef<TAssets> }) => ReferenceViews<D>;
  // Prompt findings this stage accepts, keyed the way `konte status` prints them
  // (`prompt-negation:<hash>`) over the reason each is right; never a fixable one.
  waivers?: Record<string, string>;
}

/**
 * Declares the reference stage: the direction, then `references` (a flat callback returning a named
 * map of asset()s) and `views`. The returned object IS both the ReferenceDefinition (loaded by konte)
 * and the ref used by animatic/video to fabricate `reference:<name>` placeholders.
 *
 * The direction is taken for its typesetting (`policy.lang` + `policy.fonts`) and for the canvas
 * each sheet is sized off: its long edge, at the shape the asset's roster asks for
 * (`deriveReferenceSize`); a view image takes its location's. An adapter's `width`/`height` are
 * therefore filled in like a stage's; passing them overrides.
 */
export function defineReference<const D, TAssets extends ReferenceAssetMap>(
  direction: DirectionEntry<D>,
  opts: DefineReferenceOptions<TAssets, D>,
): ReferenceDefinition & ReferenceRef<TAssets> {
  const index = getDirectionIndex(direction);
  const base = index.format.size.base;
  const format = (assetName = ""): BuildFormat => ({
    size: deriveReferenceSize(base, index.referenceShapeById.get(assetName) ?? "square"),
    typography: index.typography,
  });
  const viewFormat = (): BuildFormat => ({
    size: deriveReferenceSize(base, "master"),
    typography: index.typography,
  });
  // A respelling here stands for a lyric line the song's model is given in another spelling.
  beginRespellCollection();
  beginPromptCollection(scriptTexts(index.scriptById));
  const canvas: VideoFormat = { size: base, fps: index.format.fps };
  let discovery: ReturnType<typeof runInReferenceDiscoveryMode>;
  let views: ReturnType<typeof runInReferenceDiscoveryMode> | undefined;
  let prompts: PromptOccurrence[];
  let respellings: Respelling[];
  let pins: PinOccurrence[];
  try {
    discovery = runInReferenceDiscoveryMode(() => opts.references({ format: canvas }), format);
    const reference = discovery.result as ReferenceRef<TAssets>;
    views = opts.views
      ? runInReferenceDiscoveryMode(
          () => opts.views!({ format: canvas, reference }),
          viewFormat,
          "view",
        )
      : undefined;
  } finally {
    prompts = endPromptCollection();
    respellings = endRespellCollection() ?? [];
    pins = endPinCollection();
  }
  const returned = discovery.result as TAssets;
  assertReturnedReferences(returned, discovery.assets);

  let assets = discovery.assets;
  const viewNames: string[] = [];
  if (views) {
    const filed = fileViews(direction, views.result, views.assets, discovery.assets);
    const renamed = renameAssets(views.assets, filed);
    assets = { ...discovery.assets, ...renamed };
    viewNames.push(...filed.values());
    const rename = (address: string): string => {
      const name = address.startsWith("reference:") ? address.slice("reference:".length) : null;
      const to = name === null ? undefined : filed.get(name);
      return to === undefined ? address : `reference:${to}`;
    };
    prompts = prompts.map((p) => ({ ...p, address: rename(p.address) }));
    pins = pins.map((p) => ({
      ...p,
      address: rename(p.address),
      ...(p.source !== undefined ? { source: rename(p.source) } : {}),
    }));
  }

  assertLyricsSung(index, assets, prompts, respellings);

  const definition: ReferenceDefinition = {
    shots: [],
    topLevelAssets: assets,
    exposedAssetNames: [...Object.keys(returned), ...viewNames],
    ...(prompts.length > 0 ? { prompts } : {}),
    ...(pins.length > 0 ? { pins } : {}),
    ...(opts.waivers ? { waivers: opts.waivers } : {}),
  };

  // `returned` already maps each name to its makeReferencePlaceholder() MediaAsset.
  return Object.assign(definition, returned) as ReferenceDefinition & ReferenceRef<TAssets>;
}

// Every declared asset() is generatable (it lands in `topLevelAssets`); returning it is what
// additionally exposes it as a `reference.<name>` placeholder to the other stages. An asset
// used only as an input to another reference asset (e.g. a blank `latent` feeding a `key`) can
// therefore be declared without being returned. A declared asset that is neither exposed nor
// consumed is unused — `generate`/`doctor` report it (skip + warn), like an unused video/
// animatic asset, rather than failing the load. A returned name must still be a real asset()
// (no aliasing/extras) and may not collide with a reserved key.
function assertReturnedReferences(
  returned: ReferenceAssetMap,
  assets: Record<string, AssetDefinition>,
): void {
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
}

// The asset name each returned view image was declared under → the name it is filed under
// (`view.<locationId>.<view>`). What `views` declares and does not return is an intermediate, kept
// under its own name.
function fileViews(
  direction: DirectionEntry<unknown>,
  result: unknown,
  declared: Record<string, AssetDefinition>,
  references: Record<string, AssetDefinition>,
): Map<string, string> {
  for (const name of Object.keys(declared)) {
    if (name in references) {
      throw new KonteError(
        "INVALID_VIEW",
        `defineReference: asset("${name}", …) is declared in both \`references\` and \`views\` — ` +
          `give one another name`,
      );
    }
  }
  const locations = new Set(
    Object.keys((direction as { locations?: Record<string, unknown> }).locations ?? {}),
  );
  const filed = new Map<string, string>();
  for (const [locationId, byView] of Object.entries((result ?? {}) as Record<string, unknown>)) {
    if (!locations.has(locationId)) {
      throw new KonteError(
        "INVALID_VIEW",
        `defineReference: views."${locationId}" is not a location direction.ts declares. A view ` +
          `image is filed under its location id: ${[...locations].join(", ")}`,
      );
    }
    for (const [view, image] of Object.entries((byView ?? {}) as Record<string, unknown>)) {
      // The type lets a view be left `undefined`, which declares none.
      if (image === undefined) continue;
      const at = `views.${locationId}.${view}`;
      if (view === "front") {
        throw new KonteError(
          "INVALID_VIEW",
          `defineReference: ${at} — the front view is reference.${locationId} itself, so it is ` +
            `not returned here`,
        );
      }
      if (!isImagedView(view)) {
        throw new KonteError(
          "INVALID_VIEW",
          `defineReference: ${at} is not a view — return ${IMAGED_VIEWS.join(", ")}`,
        );
      }
      const src = (image as { src?: unknown } | null | undefined)?.src;
      const name =
        typeof src === "string" ? parsePlaceholder(src)?.match(/^reference:(.+)$/)?.[1] : undefined;
      if (name === undefined || !(name in declared)) {
        throw new KonteError(
          "INVALID_VIEW",
          `defineReference: ${at} must return the handle of an asset() declared in \`views\` — ` +
            `a view image is made there, from reference.${locationId}`,
        );
      }
      if (filed.has(name)) {
        throw new KonteError(
          "INVALID_VIEW",
          `defineReference: asset("${name}", …) is returned as two views — each view is its own ` +
            `image`,
        );
      }
      filed.set(name, viewAssetName(locationId, view));
    }
  }
  return filed;
}

// The `views` assets under the names they are filed at, every placeholder naming one rewritten to
// match, so a view built from another is wired to its filed address.
function renameAssets(
  assets: Record<string, AssetDefinition>,
  filed: ReadonlyMap<string, string>,
): Record<string, AssetDefinition> {
  const placeholders = new Map(
    [...filed].map(([from, to]) => [makeReferencePlaceholder(from), makeReferencePlaceholder(to)]),
  );
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [from, to] of placeholders) out = out.split(from).join(to);
      return out;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(assets).map(([name, def]) => [
      filed.get(name) ?? name,
      rewrite(def) as AssetDefinition,
    ]),
  );
}

// Every lyric line is one the song is generated singing: the words `reference:<policy.song>` hands
// its model carry each line as the direction spells it, or as a `respell()` of it does. A song not
// declared here is `song-unreferenced`'s, and one handed no words (a file, a model given none) has
// nothing to hold the lines against.
function assertLyricsSung(
  index: DirectionIndex,
  assets: Record<string, AssetDefinition>,
  prompts: readonly PromptOccurrence[],
  respellings: readonly Respelling[],
): void {
  const song = index.timeline.song;
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
