import {
  type AssetStage,
  formatAddress,
  formatCompositionAddress,
  formatNarrationStemAddress,
  formatOffFrameStemAddress,
  formatPlateAddress,
  formatReferenceAddress,
  formatShotStemAddress,
  formatSongStemAddress,
  formatThumbnailAddress,
  formatTimelineAddress,
  formatTimelineOverlayAddress,
  formatTimelineStemAddress,
  isPlateAddress,
  NARRATION_STEM_ASSET_NAME,
  OFF_FRAME_STEM_ASSET_NAME,
  parseAddress,
  type ShotStage,
  SONG_STEM_ASSET_NAME,
  STEM_ASSET_NAME,
  THUMBNAIL_FRAME_ADDRESS,
  THUMBNAIL_STILL_ADDRESS,
  tryParseAddress,
} from "./address.js";
import { KonteError } from "./errors.js";
import { shotById } from "./shot-index.js";
import type {
  AnimaticDefinition,
  AssetDefinition,
  AssetStageDefinition,
  ThumbnailDefinition,
} from "./types/index.js";

// The addresses the thumbnail is made of: its frame, its still and its own assets.
export function thumbnailOwnAddresses(thumbnail: {
  frame: unknown;
  compose: unknown;
  assets: Record<string, unknown>;
}): string[] {
  return [
    ...(thumbnail.frame ? [THUMBNAIL_FRAME_ADDRESS] : []),
    ...(thumbnail.compose ? [THUMBNAIL_STILL_ADDRESS] : []),
    ...Object.keys(thumbnail.assets).map(formatThumbnailAddress),
  ];
}

// The take whose accept signs the thumbnail off: its still when it composes one, else its frame.
export function thumbnailCoverAddress(thumbnail: { compose: unknown }): string {
  return thumbnail.compose ? THUMBNAIL_STILL_ADDRESS : THUMBNAIL_FRAME_ADDRESS;
}

interface StemShotLike {
  id: string;
  stemRefs?: readonly string[];
  narrationStemRefs?: readonly string[];
  offFrameStemRefs?: readonly string[];
  songCue?: { src: string };
  songStem?: unknown;
}

interface StemVideoLike {
  stage: ShotStage;
  shots: readonly StemShotLike[];
  timelineSoundtracks?: readonly unknown[];
}

/**
 * One shot's stem leaves and the cues each is mixed from: `#stem`, then the board's
 * `#narrationStem`, `#offFrameStem` and `#songStem`.
 */
export function listShotStems(
  stage: ShotStage,
  shot: StemShotLike,
): Array<{ address: string; refs: readonly string[] }> {
  const stems: Array<{ address: string; refs: readonly string[] }> = [];
  const refs = [...(shot.stemRefs ?? []), ...(shot.songCue ? [shot.songCue.src] : [])];
  if (refs.length > 0) stems.push({ address: formatShotStemAddress(stage, shot.id), refs });
  if (stage === "animatic" && (shot.narrationStemRefs?.length ?? 0) > 0) {
    stems.push({ address: formatNarrationStemAddress(shot.id), refs: shot.narrationStemRefs! });
  }
  if (stage === "animatic" && (shot.offFrameStemRefs?.length ?? 0) > 0) {
    stems.push({ address: formatOffFrameStemAddress(shot.id), refs: shot.offFrameStemRefs! });
  }
  if (stage === "animatic" && shot.songCue && shot.songStem) {
    stems.push({ address: formatSongStemAddress(shot.id), refs: [shot.songCue.src] });
  }
  return stems;
}

/** The reserved stem names a shot of this stage can carry. */
export function shotStemAssetNames(stage: ShotStage): string[] {
  return stage === "animatic"
    ? [STEM_ASSET_NAME, NARRATION_STEM_ASSET_NAME, OFF_FRAME_STEM_ASSET_NAME, SONG_STEM_ASSET_NAME]
    : [STEM_ASSET_NAME];
}

/** Every audio cue a shot plays, across its stems. */
export function shotCueRefs(shot: StemShotLike): string[] {
  return [
    ...(shot.stemRefs ?? []),
    ...(shot.narrationStemRefs ?? []),
    ...(shot.offFrameStemRefs ?? []),
  ];
}

type ShownShotLike = StemShotLike & {
  assets: Record<string, unknown>;
  shotFn?: unknown;
  compositionRefs?: readonly string[];
};

const placedByShots = new WeakMap<object, { length: number; placed: Set<string> }>();

function placedRefs(shots: readonly ShownShotLike[]): Set<string> {
  let entry = placedByShots.get(shots);
  if (!entry || entry.length !== shots.length) {
    const placed = new Set<string>();
    for (const s of shots) {
      for (const ref of [...(s.compositionRefs ?? []), ...shotCueRefs(s)]) placed.add(ref);
    }
    entry = { length: shots.length, placed };
    placedByShots.set(shots, entry);
  }
  return entry.placed;
}

/**
 * The shot's own assets the stage's review shows: what any of its compositions places — a sibling
 * shot may draw one — or its stems mix. A shot with no composition, or one never discovered, shows
 * every one.
 */
export function shownShotAssetNames(
  stage: ShotStage,
  shots: readonly ShownShotLike[],
  shot: ShownShotLike,
): string[] {
  const names = Object.keys(shot.assets);
  if (!shot.shotFn || !shot.compositionRefs) return names;
  const placed = placedRefs(shots);
  return names.filter((name) => placed.has(formatAddress(stage, shot.id, name)));
}

// The stem leaves a stage declares: each shot's stems (`listShotStems`), plus the timeline stem
// when the stage has soundtrack beds.
export function listStemAddresses(video: StemVideoLike): string[] {
  const addresses: string[] = [];
  for (const s of video.shots) {
    for (const stem of listShotStems(video.stage, s)) addresses.push(stem.address);
  }
  if ((video.timelineSoundtracks?.length ?? 0) > 0) {
    addresses.push(formatTimelineStemAddress(video.stage));
  }
  return addresses;
}

interface CompositionShotLike {
  id: string;
  shotFn?: unknown;
  assets?: Record<string, { kind?: string }>;
}

// The overlay leaf a stage declares, if any.
export function listOverlayAddresses(def: { stage: ShotStage; overlay?: unknown }): string[] {
  return def.overlay ? [formatTimelineOverlayAddress(def.stage)] : [];
}

// Composition addresses for every developed shot of a stage.
export function listCompositionAddresses(video: {
  stage: ShotStage;
  shots: readonly CompositionShotLike[];
}): string[] {
  const addresses: string[] = [];
  for (const s of video.shots) {
    if (s.shotFn) addresses.push(formatCompositionAddress(video.stage, s.id));
  }
  return addresses;
}

// The existence half of `getAssetEntry`.
export function validateAddress(address: string, definition: AssetStageDefinition): void {
  void getAssetEntry(definition, address);
}

function animaticOf(
  definition: AssetStageDefinition | null | undefined,
): AnimaticDefinition | undefined {
  return definition && "stage" in definition && definition.stage === "animatic"
    ? definition
    : undefined;
}

export function platesOf(
  definition: AssetStageDefinition | null | undefined,
): Record<string, AssetDefinition> {
  return animaticOf(definition)?.plates ?? {};
}

// The plates filed under a setup. A definition that never went through `defineAnimatic` filed all.
export function exposedPlateIdsOf(definition: AssetStageDefinition | null | undefined): string[] {
  return animaticOf(definition)?.exposedPlateIds ?? Object.keys(platesOf(definition));
}

export function thumbnailOf(
  definition: AssetStageDefinition | null | undefined,
): ThumbnailDefinition | undefined {
  const video =
    definition && "stage" in definition && definition.stage === "video" ? definition : undefined;
  return video?.thumbnail ?? undefined;
}

export function listAddresses(definition: AssetStageDefinition, stage: AssetStage): string[] {
  const paths: string[] = [];
  // A reference asset lives in `topLevelAssets` with no shot axis, keyed by its bare name.
  if (stage === "reference") {
    for (const assetName of Object.keys(definition.topLevelAssets ?? {})) {
      paths.push(formatReferenceAddress(assetName));
    }
    return paths;
  }
  if (definition.topLevelAssets) {
    for (const assetName of Object.keys(definition.topLevelAssets)) {
      paths.push(formatTimelineAddress(stage, assetName));
    }
  }
  if (stage === "animatic") {
    for (const setupId of Object.keys(platesOf(definition))) {
      paths.push(formatPlateAddress(setupId));
    }
  }
  if (stage === "video") {
    const thumbnail = thumbnailOf(definition);
    for (const assetName of Object.keys(thumbnail?.assets ?? {})) {
      paths.push(formatThumbnailAddress(assetName));
    }
    if (thumbnail?.frame) paths.push(THUMBNAIL_FRAME_ADDRESS);
    if (thumbnail?.compose) paths.push(THUMBNAIL_STILL_ADDRESS);
  }
  for (const s of definition.shots) {
    for (const assetName of Object.keys(s.assets)) {
      paths.push(formatAddress(stage, s.id, assetName));
    }
  }
  return paths;
}

// A reference definition's assets, as addresses.
export function listReferenceAddresses(definition: AssetStageDefinition): string[] {
  return listAddresses(definition, "reference");
}

// The reference assets the stage published — the ones its callback returned (`exposedAssetNames`).
// A declared-but-unreturned asset is an intermediate another reference asset consumes: generated and
// tracked like any other, but never review work — it is read through the asset that consumes it, the
// way a patch chain's earlier step is, and no accept is ever owed on it. The review surfaces and the
// accept accounting list this; `doctor`/`generate` keep listing them all.
export function listExposedReferenceAddresses(definition: AssetStageDefinition): string[] {
  const exposed = "exposedAssetNames" in definition ? definition.exposedAssetNames : undefined;
  // Only a definition that never went through `defineReference` lacks the field; it published all.
  if (!exposed) return listReferenceAddresses(definition);
  const names = new Set(exposed.map(formatReferenceAddress));
  return listReferenceAddresses(definition).filter((p) => names.has(p));
}

// A plate the `plates` callback declared without returning it under a setup id: an intermediate the
// plates are built from, read through the plate that consumes it — an unexposed reference asset's
// terms.
export function isUnexposedPlateAddress(
  definition: AssetStageDefinition | null | undefined,
  address: string,
): boolean {
  const exposed =
    definition && "exposedPlateIds" in definition ? definition.exposedPlateIds : undefined;
  // Only a definition that never went through `defineAnimatic` lacks the field; it filed all.
  if (!exposed) return false;
  const parsed = tryParseAddress(address);
  return parsed?.kind === "plate" && !exposed.includes(parsed.assetName);
}

// The assets a review shows: every one but an intermediate read through what consumes it and a
// plate.
export function listReviewableAddresses(
  definition: AssetStageDefinition,
  stage: AssetStage,
): string[] {
  return stage === "reference"
    ? listExposedReferenceAddresses(definition)
    : listAddresses(definition, stage).filter((p) => !isPlateAddress(p));
}

export function getAssetEntry(definition: AssetStageDefinition, address: string): AssetDefinition {
  const parsed = parseAddress(address);

  if (parsed.kind === "plate") {
    const plates = platesOf(definition);
    const plate = Object.hasOwn(plates, parsed.assetName) ? plates[parsed.assetName] : undefined;
    if (!plate) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `Setup "${parsed.assetName}" has no plate in animatic.tsx — declare it in \`plates\``,
      );
    }
    return plate;
  }

  if (parsed.kind === "thumbnail") {
    const thumbnail = thumbnailOf(definition);
    const asset =
      address === THUMBNAIL_STILL_ADDRESS
        ? thumbnail?.compose?.still
        : address === THUMBNAIL_FRAME_ADDRESS
          ? thumbnail?.frame?.asset
          : thumbnail?.assets[parsed.assetName];
    if (!asset) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `Thumbnail asset "${parsed.assetName}" not found in video.tsx's thumbnail`,
      );
    }
    return asset;
  }

  if (parsed.kind === "timeline" || parsed.kind === "reference") {
    const topLevelAsset = definition.topLevelAssets?.[parsed.assetName];
    if (!topLevelAsset) {
      throw new KonteError(
        "ADDRESS_NOT_FOUND",
        `Timeline asset "${parsed.assetName}" not found in definition`,
      );
    }
    return topLevelAsset;
  }

  // A patch step is declared by `patches/<variantId>.ts`, never by a stage definition — its
  // definition comes from the patch catalog.
  if (parsed.kind === "patch") {
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `"${address}" is a patch step — its definition lives in patches/${parsed.sourceVariantId}.ts`,
    );
  }

  const foundShot = shotById(definition.shots, parsed.shotId);
  if (!foundShot) {
    throw new KonteError("ADDRESS_NOT_FOUND", `Shot "${parsed.shotId}" not found in definition`);
  }

  const shotAsset = foundShot.assets[parsed.assetName];
  if (!shotAsset) {
    throw new KonteError(
      "ADDRESS_NOT_FOUND",
      `Asset "${parsed.assetName}" not found in shot "${parsed.shotId}" of definition`,
    );
  }

  return shotAsset;
}
