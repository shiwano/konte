import * as path from "node:path";
import {
  type DefinitionLike,
  getAssetEntry,
  isCompositionAddress,
  isHeardStemAddress,
  isOverlayAddress,
  isSongStemAddress,
  isStemAddress,
  listShotStems,
  parseAddress,
} from "./address.js";
import {
  compositionStructureHtml,
  harvestShotAudioStructure,
  type StemAudioEntry,
} from "./composition-builder.js";
import { resolveCompositionRef } from "./composition-refs.js";
import { renderOverlayBody } from "./overlay-render.js";
import { shotStarts } from "./render-plan.js";
import { computeDefinitionHash } from "./definition-hash.js";
import type { CueKind } from "./audio-level.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { shotById } from "./shot-index.js";
import { shortHash, stableHash } from "./content-hash.js";
import type { StateManager } from "./state/index.js";
import {
  isPendingShot,
  type AssetDefinition,
  type AssetState,
  type ShotDefinition,
  type StageDefinition,
  type VariantMedia,
} from "./types/index.js";

// A composition variant is rendered locally (not by a backend), so its asset URLs
// must not embed the dev server's base URL — that would make the output hash and
// stored file churn across machines/ports. A fixed canonical base keeps both stable.
export const CANONICAL_ASSET_BASE = "konte://asset";

// The refs feeding a shot's picture composition: the audio-excluded partition when present
// (defineVideo populates it), else the full compositionRefs (raw literals).
export function pictureRefsOf(shot: ShotDefinition): readonly string[] {
  return shot.pictureRefs ?? shot.compositionRefs ?? [];
}

// The picture refs a shot draws from that resolve to nothing — the layers a read surface leaves
// blank. Stale counts as resolved: a read surface falls back to the newest stale take.
export function unresolvedPictureRefs(
  manager: StateManager,
  shot: ShotDefinition,
): readonly string[] {
  return pictureRefsOf(shot).filter(
    (ref) => !resolveCompositionRef(manager, ref, { includeStale: true }),
  );
}

// The refs a shot's composition FINGERPRINTS, which is the same set its definition hash covers. The
// video's picture composition strips audio from both (an audio-only edit must not churn the
// composite); the animatic's keeps it — its whole point is a decision on the sound and the timing.
export function compositionFingerprintRefs(
  def: StageDefinition,
  shot: ShotDefinition,
): readonly string[] {
  return def.stage === "animatic" ? (shot.compositionRefs ?? []) : pictureRefsOf(shot);
}

// Per-definition memo of what the discovery-rendered definition hashes (composition / animatic /
// stem / overlay) hash. Each computation renders the shot's structure from the definition, so an
// all-shots sweep (status, review submit, handoff) would otherwise pay one render per shot per pass
// and re-pay them on the next. Keyed weakly on the definition object — a reload builds a new one,
// invalidating naturally — and the inputs are deterministic per loaded definition. `null` is no
// input, hashed as "".
const definitionInputMemo = new WeakMap<StageDefinition, Map<string, unknown>>();

export function memoizedInput(
  video: StageDefinition,
  key: string,
  compute: () => unknown,
): unknown {
  let cache = definitionInputMemo.get(video);
  if (!cache) {
    cache = new Map();
    definitionInputMemo.set(video, cache);
  }
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key);
}

/** Rewrites what a definition hash hashes, before it is hashed. */
export type HashInputRewrite = (input: unknown) => unknown;

function hashInput(input: unknown, rewrite?: HashInputRewrite): string {
  if (input === null) return "";
  return shortHash(rewrite ? rewrite(input) : input);
}

function compositionHashInput(video: StageDefinition, shotId: string): unknown {
  return memoizedInput(video, `composition:${shotId}`, () => {
    const structureHtml = compositionStructureHtml(video, shotId);
    if (structureHtml === null) return null;
    const shot = shotById(video.shots, shotId);
    const size = video.format.size;
    return {
      structureHtml,
      typography: video.typography,
      duration: shot?.duration,
      width: size?.width,
      height: size?.height,
    };
  });
}

/**
 * Definition hash of a composition: its structural picture HTML (the body rendered from the
 * definition, audio stripped) plus the typography, render dimensions and duration. Rendered in discovery mode, so it
 * captures code-level picture edits — and a timelineFn override's effect on the picture — without
 * depending on which upstream variant resolves (that is tracked separately via inputFingerprints).
 * Unlike the old source-text hash it ignores audio-only edits structurally. Returns "" when the
 * shot has no render function.
 */
export function compositionDefinitionHash(
  video: StageDefinition,
  shotId: string,
  rewrite?: HashInputRewrite,
): string {
  return hashInput(compositionHashInput(video, shotId), rewrite);
}

/**
 * Definition hash for the composition at a given address, resolving the shot from the
 * video definition. Returns null when the address has no composition (unknown shot or
 * no shotFn).
 */
export function compositionDefinitionHashForAddress(
  video: StageDefinition,
  address: string,
  rewrite?: HashInputRewrite,
): string | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return null;
  const shot = shotById(video.shots, parsed.shotId);
  if (!shot?.shotFn) return null;
  return compositionDefinitionHash(video, parsed.shotId, rewrite);
}

/**
 * Live definition hash for any address: the composition hash for a composition
 * address, else the asset's definition hash (null for `file` assets, which have no
 * definition, and for addresses absent from the definition). Mirrors what `inspect`
 * and `status` compute so definition-staleness reads consistently everywhere.
 */
export function definitionHashForAddress(
  def: DefinitionLike,
  address: string,
  rewrite?: HashInputRewrite,
): string | null {
  if (isOverlayAddress(address)) {
    return (def as unknown as StageDefinition).overlay
      ? overlayDefinitionHash(def as unknown as StageDefinition, rewrite)
      : null;
  }
  if (isCompositionAddress(address)) {
    return compositionDefinitionHashForAddress(def as unknown as StageDefinition, address, rewrite);
  }
  if (isStemAddress(address)) {
    return stemDefinitionHashForAddress(def as unknown as StageDefinition, address, rewrite);
  }
  try {
    const entry = getAssetEntry(def, address);
    if (entry.kind === "file") return null;
    return computeDefinitionHash(rewrite ? (rewrite(entry) as AssetDefinition) : entry);
  } catch {
    return null;
  }
}

// Whether every ref a shot's composition consumes resolves to a ready variant
// (accepted, else newest non-stale with a file) — the bar for auto-materializing the
// composition, identical to what generation jobs use for their dependencies.
//
// Stale is excluded here for the reason it is excluded there (`assetResolves`): materializing
// bakes a leaf out of what it reads, and a stale input is material the next `generate` replaces.
export function compositionRefsResolvable(
  manager: StateManager,
  compositionRefs: readonly string[],
): boolean {
  // A dependency path IS its upstream address.
  for (const depPath of compositionRefs) {
    if (!manager.resolveReference(depPath, { includeStale: false })) return false;
  }
  return true;
}

/**
 * Input fingerprints for a composition: each referenced address mapped to its
 * resolved variant's outputHash (accepted, else newest non-stale ready variant —
 * the same bar the composite render and the auto-materialize gate use). A composition
 * is materialized from ready upstreams, so the fingerprint tracks the resolved output;
 * `StalenessView.staleness` compares it against that same resolved output, so the composition
 * flips input-stale once an upstream resolves elsewhere — a different accept, or a patch/reroll
 * where nothing is accepted. Unresolvable refs (no ready variant) are skipped.
 */
export function compositionInputFingerprints(
  manager: StateManager,
  compositionRefs: readonly string[],
): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  // A dependency path IS its upstream address.
  for (const depPath of compositionRefs) {
    const resolved = manager.resolveReference(depPath);
    if (resolved?.outputHash) fingerprints[depPath] = resolved.outputHash;
  }
  return fingerprints;
}

// A content key for a shot's frame-delivery source: everything that determines the rendered
// composite, folded into one hash. Deterministic and computable WITHOUT rendering — so a frame
// delivery upscale can be cached against it (re-upscale only when the source actually changed).
//
// The composition definition hash plus the upstream input fingerprints. The definition hash already
// renders the shot's picture with any timelineFn override applied, so a timelineFn change is
// reflected there when (and only when) it changes the picture. Returns null when the shot has no
// composition.
export function compositionCacheKey(
  manager: StateManager,
  video: StageDefinition,
  shotId: string,
): string | null {
  const shot = shotById(video.shots, shotId);
  if (!shot?.shotFn) return null;
  const definitionHash = compositionDefinitionHash(video, shotId);
  const inputFingerprints = compositionInputFingerprints(manager, pictureRefsOf(shot));
  // The overlay laid over the shot is part of the frames a delivery upscales.
  const overlay = video.overlay
    ? {
        shotStart: shotStarts(video.shots, video.format.fps).get(shotId) ?? 0,
        definitionHash: overlayDefinitionHash(video),
        inputs: compositionInputFingerprints(manager, overlayFingerprintRefs(video)),
      }
    : null;
  return stableHash({
    kind: "composition",
    definitionHash,
    inputFingerprints,
    ...(overlay ? { overlay } : {}),
  });
}

function fingerprintsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

export function findMatchingCompositionVariant(
  target: AssetState,
  definitionHash: string,
  inputFingerprints: Record<string, string>,
): string | null {
  for (const [variantId, v] of Object.entries(target.variants ?? {})) {
    if (
      v.definitionHash === definitionHash &&
      fingerprintsEqual(v.inputFingerprints ?? {}, inputFingerprints)
    ) {
      return variantId;
    }
  }
  return null;
}

// ── Audio stems ──────────────────────────────────────────────────────────────

export function hashStructure(structure: unknown): string {
  return shortHash(structure);
}

// A shot stem's identity. The board's carries the clamp too: the shot's `duration` is konte's own
// input to the mix, so a retimed shot re-mixes the stem.
// `kinds` rides along because the mix is levelled by them: without it, a line the direction moves
// from a character to the mob reuses the stem mixed at the old level.
export type ShotStemStructure =
  | { kind: "delivered"; cues: StemAudioEntry[]; kinds?: Readonly<Record<string, CueKind>> }
  | {
      kind: "board";
      cues: StemAudioEntry[];
      clamp: number;
      kinds?: Readonly<Record<string, CueKind>>;
    };

// The shot a stem address belongs to and the cues that stem is mixed from. Null when the shot does
// not carry that stem.
export function shotStemOf(
  video: StageDefinition,
  address: string,
): { shot: ShotDefinition; refs: readonly string[] } | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return null;
  const shot = shotById(video.shots, parsed.shotId);
  const stem = shot && listShotStems(video.stage, shot).find((s) => s.address === address);
  return shot && stem ? { shot, refs: stem.refs } : null;
}

export function shotStemStructure(
  video: StageDefinition,
  address: string,
): ShotStemStructure | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return null;
  const shot = shotById(video.shots, parsed.shotId);
  if (isSongStemAddress(address)) {
    if (!shot?.shotFn || !shot.songCue || !shot.songStem) return null;
    const cues = songPartEntries(shot.songCue, shot.songStem);
    return { kind: "board", cues, clamp: shot.duration };
  }
  const harvested = harvestShotAudioStructure(video, parsed.shotId);
  if (harvested === null) return null;
  const refs = shotStemOf(video, address)?.refs ?? [];
  const apart = new Set([...(shot?.narrationStemRefs ?? []), ...(shot?.offFrameStemRefs ?? [])]);
  const heard = isHeardStemAddress(address);
  const cues = harvested.filter((cue) => (heard ? refs.includes(cue.src) : !apart.has(cue.src)));
  if (shot?.songCue && !heard) cues.push(songStemEntry(shot.songCue));
  if (cues.length === 0) return null;
  const kinds = shot?.cueKinds
    ? Object.fromEntries(Object.entries(shot.cueKinds).filter(([ref]) => refs.includes(ref)))
    : undefined;
  if (video.stage !== "animatic") return { kind: "delivered", cues, kinds };
  if (!shot) return null;
  return { kind: "board", cues, clamp: shot.duration, kinds };
}

function songStemEntry(cue: NonNullable<ShotDefinition["songCue"]>): StemAudioEntry {
  return {
    src: cue.src,
    track: "song",
    start: 0,
    duration: cue.duration,
    mediaStart: cue.mediaStart,
    rate: 1,
    volume: null,
    fadeIn: null,
    fadeOut: null,
  };
}

function songPartEntries(
  cue: NonNullable<ShotDefinition["songCue"]>,
  stem: NonNullable<ShotDefinition["songStem"]>,
): StemAudioEntry[] {
  const windows = stem.part === "vocals" ? stem.windows : [{ start: 0, duration: cue.duration }];
  return windows.map((w) => ({
    ...songStemEntry(cue),
    track: stem.part,
    start: w.start,
    duration: w.duration,
    mediaStart: cue.mediaStart + w.start,
  }));
}

function shotStemHashInput(structure: ShotStemStructure): unknown {
  const kinds = structure.kinds ?? {};
  return structure.kind === "board"
    ? { cues: structure.cues, clamp: structure.clamp, kinds }
    : { cues: structure.cues, kinds };
}

export function hashShotStemStructure(structure: ShotStemStructure): string {
  return hashStructure(shotStemHashInput(structure));
}

export function timelineStemStructure(
  video: StageDefinition,
): Array<{ id: string; src: string; options: unknown }> | null {
  const soundtracks = video.timelineSoundtracks ?? [];
  if (soundtracks.length === 0) return null;
  return soundtracks.map((st) => ({
    id: st.id,
    src: parsePlaceholder(st.src.src) ?? st.src.src,
    options: st.options,
  }));
}

/**
 * The takes the timeline stem is made of: its beds. A ducking bed's envelope is signed off on each
 * line's shot stem.
 */
export function timelineStemRefs(video: StageDefinition): string[] {
  return (video.timelineSoundtracks ?? [])
    .map((st) => parsePlaceholder(st.src.src))
    .filter((p): p is string => p !== null);
}

// The stem's definition hash: a hash of its audio structure (shot cues or timeline beds), rendered
// from the definition alone. "" when there is no stem (no render fn / no audio / no soundtracks).
export function stemDefinitionHash(
  video: StageDefinition,
  address: string,
  rewrite?: HashInputRewrite,
): string {
  const input = memoizedInput(video, `stem:${address}`, () => {
    if (parseAddress(address).kind === "timeline") return timelineStemStructure(video);
    const structure = shotStemStructure(video, address);
    return structure === null ? null : shotStemHashInput(structure);
  });
  return hashInput(input, rewrite);
}

function stemDefinitionHashForAddress(
  video: StageDefinition,
  address: string,
  rewrite?: HashInputRewrite,
): string | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot" && parsed.kind !== "timeline") return null;
  const hash = stemDefinitionHash(video, address, rewrite);
  if (hash !== "") return hash;
  // A developed shot that sounds nothing stems silence, so a stem accepted before its last cue was
  // removed reads definition-stale.
  const shot = parsed.kind === "shot" ? shotById(video.shots, parsed.shotId) : undefined;
  return shot && !isPendingShot(shot) ? hashStructure({ cues: [] }) : null;
}

export interface LeafIdentity {
  definitionHash: string;
  inputFingerprints: Record<string, string>;
}

export function recordLeafVariant(
  manager: StateManager,
  address: string,
  variantId: string,
  filePath: string,
  outputHash: string,
  identity: LeafIdentity,
  media: VariantMedia | null = null,
): string {
  const variant = manager.getAssetState(address).variants![variantId]!;
  variant.file = path.relative(manager.videoRoot, filePath);
  variant.readyAt = new Date().toISOString();
  variant.outputHash = outputHash;
  variant.definitionHash = identity.definitionHash;
  variant.inputFingerprints = identity.inputFingerprints;
  if (media) variant.media = media;
  return variantId;
}

// ── Overlay ──────────────────────────────────────────────────────────────────

export function overlayDefinitionHash(video: StageDefinition, rewrite?: HashInputRewrite): string {
  const input = memoizedInput(video, "overlay", () => {
    const overlay = video.overlay;
    if (!overlay) return null;
    const structureHtml = renderOverlayBody({
      stage: video.stage,
      overlay,
      fn: overlay.fn,
      size: video.format.size,
      typography: video.typography,
      resolvedFiles: {},
    });
    // Where the overlay subtitles lines: where each shot opens, and how each stem places its cues.
    const stems = overlayLineStems(video);
    return {
      structureHtml,
      ...(stems.length > 0
        ? {
            shotStarts: [...shotStarts(video.shots, video.format.fps)],
            stems: stems.map((stem) => [stem, stemDefinitionHashForAddress(video, stem)]),
          }
        : {}),
      typography: video.typography,
      duration: overlay.duration,
      width: video.format.size.width,
      height: video.format.size.height,
    };
  });
  return hashInput(input, rewrite);
}

// The shots whose lines the overlay's script-line `<Subtitle>` entries time, read off its render
// from the definition alone.
function overlaySubtitledShots(video: StageDefinition): readonly string[] {
  const overlay = video.overlay;
  if (!overlay) return [];
  return memoizedInput(video, "overlay-subtitled-shots", () => {
    const html = renderOverlayBody({
      stage: video.stage,
      overlay,
      fn: overlay.fn,
      size: video.format.size,
      typography: video.typography,
      resolvedFiles: {},
    });
    return [...new Set([...html.matchAll(/\sdata-konte-line="([^"]+):\d+"/g)].map((m) => m[1]!))];
  }) as string[];
}

// Where the overlay subtitles any line, every stem of every shot on the stage — wherever a line
// plays, its cues' placement and takes time the subtitle.
function overlayLineStems(video: StageDefinition): readonly string[] {
  if (overlaySubtitledShots(video).length === 0) return [];
  return video.shots.flatMap((shot) =>
    listShotStems(video.stage, shot).map((stem) => stem.address),
  );
}

// What the overlay's inputs are fingerprinted on: the refs it draws and the takes its subtitled
// lines are heard in.
export function overlayFingerprintRefs(video: StageDefinition): readonly string[] {
  if (!video.overlay) return [];
  const cues = overlayLineStems(video).flatMap((stem) => shotStemOf(video, stem)?.refs ?? []);
  return [...new Set([...video.overlay.compositionRefs, ...cues])];
}
