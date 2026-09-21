import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type DefinitionLike,
  formatAddress,
  formatCompositionAddress,
  formatTimelineStemAddress,
  getAssetEntryByAddress,
  isCompositionAddress,
  isNarrationStemAddress,
  isStemAddress,
  listShotStems,
  parseAddress,
  shotStemAssetNames,
  formatAssetPath,
} from "./address.js";
import {
  buildShotCompositionHtml,
  compositionStructureHtml,
  harvestShotAudioStructure,
  type StemAudioEntry,
} from "./composition-builder.js";
import { resolveCompositionRef } from "./composition-refs.js";
import { computeDefinitionHash } from "./definition-hash.js";
import {
  clampEffectiveGain,
  cueLeadIn,
  levellingGain,
  loudnessOf,
  type CueKind,
} from "./audio-level.js";
import { parsePlaceholder } from "./dsl/shot-context.js";
import { KonteError } from "./errors.js";
import { mixAudioTracks, type MuxAudioTrack } from "./ffmpeg.js";
import { shotById } from "./shot-index.js";
import { formatStaleCause } from "./staleness.js";
import { sha256Hex, shortHash, stableHash } from "./content-hash.js";
import { stableStringify } from "./stable-stringify.js";
import type { StateManager } from "./state/index.js";
import {
  isPendingShot,
  type AssetState,
  type KonteState,
  type ShotDefinition,
  type StageDefinition,
  type VariantMedia,
} from "./types/index.js";
import { variantDir } from "./variant-dir.js";
import { probeMediaInfo } from "./video-probe.js";

// A composition variant is rendered locally (not by a backend), so its asset URLs
// must not embed the dev server's base URL — that would make the output hash and
// stored file churn across machines/ports. A fixed canonical base keeps both stable.
const CANONICAL_ASSET_BASE = "konte://asset";

const COMPOSITION_HTML_FILE = "composition.html";
const STEM_MANIFEST_FILE = "stem.json";
const STEM_MIX_FILE = "stem.wav";

// The refs feeding a shot's picture composition: the audio-excluded partition when present
// (defineVideo populates it), else the full compositionRefs (raw literals / fallback shots).
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
function compositionFingerprintRefs(def: StageDefinition, shot: ShotDefinition): readonly string[] {
  return def.stage === "animatic" ? (shot.compositionRefs ?? []) : pictureRefsOf(shot);
}

// Per-definition memo of the discovery-rendered definition hashes (composition / animatic /
// stem). Each computation renders the shot's structure from the definition, so an all-shots
// sweep (status, review submit, handoff) would otherwise pay one render per shot per pass and
// re-pay them on the next. Keyed weakly on the definition object — a reload builds a new one,
// invalidating naturally — and the hashes are deterministic per loaded definition.
const definitionHashMemo = new WeakMap<StageDefinition, Map<string, string>>();

function memoizedHash(video: StageDefinition, key: string, compute: () => string): string {
  let cache = definitionHashMemo.get(video);
  if (!cache) {
    cache = new Map();
    definitionHashMemo.set(video, cache);
  }
  let value = cache.get(key);
  if (value === undefined) {
    value = compute();
    cache.set(key, value);
  }
  return value;
}

/**
 * Definition hash of a composition: its structural picture HTML (the body rendered from the
 * definition, audio stripped) plus the typography, render dimensions and duration. Rendered in discovery mode, so it
 * captures code-level picture edits — and a timelineFn override's effect on the picture — without
 * depending on which upstream variant resolves (that is tracked separately via inputFingerprints).
 * Unlike the old source-text hash it ignores audio-only edits structurally. Returns "" when the
 * shot has no render function.
 */
export function compositionDefinitionHash(video: StageDefinition, shotId: string): string {
  return memoizedHash(video, `composition:${shotId}`, () => {
    const structureHtml = compositionStructureHtml(video, shotId);
    if (structureHtml === null) return "";
    const shot = shotById(video.shots, shotId);
    const size = video.format.size;
    return shortHash({
      structureHtml,
      typography: video.typography,
      duration: shot?.duration,
      width: size?.width,
      height: size?.height,
    });
  });
}

/**
 * Definition hash for the composition at a given address, resolving the shot from the
 * video definition. Returns null when the address has no composition (unknown shot or
 * no shotFn).
 */
export function compositionDefinitionHashForAddress(
  video: StageDefinition,
  address: string,
): string | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return null;
  const shot = shotById(video.shots, parsed.shotId);
  if (!shot?.shotFn) return null;
  return compositionDefinitionHash(video, parsed.shotId);
}

/**
 * Live definition hash for any address: the composition hash for a composition
 * address, else the asset's definition hash (null for `file` assets, which have no
 * definition, and for addresses absent from the definition). Mirrors what `inspect`
 * and `status` compute so definition-staleness reads consistently everywhere.
 */
export function definitionHashForAddress(def: DefinitionLike, address: string): string | null {
  if (isCompositionAddress(address)) {
    return compositionDefinitionHashForAddress(def as unknown as StageDefinition, address);
  }
  if (isStemAddress(address)) {
    return stemDefinitionHashForAddress(def as unknown as StageDefinition, address);
  }
  try {
    const entry = getAssetEntryByAddress(def, address);
    return entry.kind === "file" ? null : computeDefinitionHash(entry);
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
function compositionRefsResolvable(
  manager: StateManager,
  compositionRefs: readonly string[],
): boolean {
  // A dependency path IS its upstream address (address ≡ asset path).
  for (const depPath of compositionRefs) {
    if (!manager.resolveReference(depPath, { includeStale: false })) return false;
  }
  return true;
}

/**
 * Input fingerprints for a composition: each referenced asset path mapped to its
 * resolved variant's outputHash (accepted, else newest non-stale ready variant —
 * the same bar the composite render and the auto-materialize gate use). A composition
 * is materialized from ready upstreams, so the fingerprint tracks the resolved output;
 * computeVariantStaleness compares it against that same resolved output, so the composition
 * flips input-stale once an upstream resolves elsewhere — a different accept, or a patch/reroll
 * where nothing is accepted. Unresolvable refs (no ready variant) are skipped.
 */
export function compositionInputFingerprints(
  manager: StateManager,
  compositionRefs: readonly string[],
): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  // A dependency path IS its upstream address (address ≡ asset path).
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
// For a composition shot (shotFn): the composition definition hash plus the upstream input
// fingerprints. The definition hash already renders the shot's picture with any timelineFn
// override applied, so a timelineFn change is reflected there when (and only when) it changes the
// picture. For a fallback shot (no shotFn): the resolved fallback source's fingerprint plus the
// render dimensions. Returns null when the shot is not renderable (no shotFn and no resolvable
// fallback source).
export function compositionCacheKey(
  manager: StateManager,
  video: StageDefinition,
  shotId: string,
): string | null {
  const shot = shotById(video.shots, shotId);
  if (!shot) return null;
  const size = video.format.size;

  if (shot.shotFn) {
    const definitionHash = compositionDefinitionHash(video, shotId);
    const inputFingerprints = compositionInputFingerprints(manager, pictureRefsOf(shot));
    return stableHash({ kind: "composition", definitionHash, inputFingerprints });
  }

  // Fallback shot: the composite is the resolved fallback source rendered to video at working
  // size (timelineFn never applies — renderShotPlan gates it on shotFn), so the key is the
  // source's fingerprint plus the render dimensions.
  const fallback = fallbackSourceFingerprint(manager, shot);
  if (!fallback) return null;
  return stableHash({
    kind: "fallback",
    fallback,
    duration: shot.duration,
    width: size.width,
    height: size.height,
  });
}

// The fingerprint of a fallback shot's source: the first comfy/file asset that resolves (mirrors
// buildRenderPlan's fallback selection), keyed by its output hash. Returns null when nothing
// resolves — the shot is not renderable.
function fallbackSourceFingerprint(manager: StateManager, shot: ShotDefinition): string | null {
  const state = manager.getState();
  for (const [assetName, entry] of Object.entries(shot.assets)) {
    if (entry.kind !== "comfy" && entry.kind !== "file") continue;
    const addr = formatAddress("video", shot.id, assetName);
    const resolved = manager.resolveReference(addr);
    if (!resolved) continue;
    const variant = state.assets[addr]?.variants?.[resolved.variantId];
    return `${assetName}:${variant?.outputHash ?? resolved.variantId}`;
  }
  return null;
}

function fingerprintsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

function findMatchingCompositionVariant(
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

interface MaterializeCompositionOptions {
  manager: StateManager;
  video: StageDefinition;
  shotId: string;
}

/**
 * Idempotently materialize a composition variant for a shot. Reuses an existing
 * variant when the definition hash AND input fingerprints are unchanged (no churn,
 * so feedback pinned to it stays valid); otherwise renders the canonical HTML,
 * writes it as the variant artifact, and records the hashes. Returns the variant
 * id, or null if the shot has no composition (shotFn). Mutates in-memory state —
 * the caller is responsible for persisting (e.g. via StateManager.withLock).
 */
export async function materializeCompositionVariant(
  opts: MaterializeCompositionOptions,
): Promise<string | null> {
  const { manager, video, shotId } = opts;
  const shot = shotById(video.shots, shotId);
  if (!shot?.shotFn) return null;

  const definitionHash = compositionDefinitionHash(video, shotId);
  const inputFingerprints = compositionInputFingerprints(
    manager,
    compositionFingerprintRefs(video, shot),
  );

  const compAddress = formatCompositionAddress(video.stage, shotId);
  const existing = manager.tryGetAssetState(compAddress);
  if (existing) {
    const match = findMatchingCompositionVariant(existing, definitionHash, inputFingerprints);
    if (match) return match;
  }

  const built = await buildShotCompositionHtml({
    video,
    manager,
    shotId,
    assetBaseUrl: CANONICAL_ASSET_BASE,
  });

  const variantId = manager.reserveVariantId(compAddress);
  const htmlPath = path.join(
    variantDir(manager.videoRoot, compAddress, variantId),
    COMPOSITION_HTML_FILE,
  );
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, built.html, "utf-8");

  const variant = manager.getAssetState(compAddress).variants![variantId]!;
  variant.file = path.relative(manager.videoRoot, htmlPath);
  variant.readyAt = new Date().toISOString();
  variant.outputHash = sha256Hex(built.html);
  variant.definitionHash = definitionHash;
  variant.inputFingerprints = inputFingerprints;

  return variantId;
}

/**
 * Composition variants that are dead leftovers — safe to drop. A composition is
 * auto-materialized, never rerolled, so it has no "alternative" variants: a variant is dead
 * when it is unaccepted, unlocked, and not the one the current definition + resolved inputs
 * would keep (the live variant). Two cases produce one: the composition's inputs no longer
 * resolve (nothing is materializable, so every unaccepted variant is a stale leftover — e.g.
 * an empty-inputFingerprints ghost from an earlier definition), or the variant simply predates
 * the current definition/inputs. Accepted (the signed-off baseline, kept for re-review) and
 * locked variants are always preserved. Pure — performs no deletion.
 */
export function collectDeadCompositionVariants(
  manager: StateManager,
  video: StageDefinition,
): { address: string; variantId: string }[] {
  const dead: { address: string; variantId: string }[] = [];

  const collect = (
    address: string,
    refs: readonly string[],
    definitionHash: () => string,
    // The refs the variant records, when they are narrower than the ones it renders — the live
    // variant is matched on what was recorded.
    fingerprintRefs: readonly string[] = refs,
  ): void => {
    const target = manager.tryGetAssetState(address);
    if (!target?.variants) return;

    // The variant the current definition would keep, if its inputs resolve; otherwise
    // nothing is materializable and there is no keeper (every unaccepted variant is dead).
    let liveId: string | null = null;
    if (compositionRefsResolvable(manager, refs)) {
      liveId = findMatchingCompositionVariant(
        target,
        definitionHash(),
        compositionInputFingerprints(manager, fingerprintRefs),
      );
    }

    for (const [variantId, v] of Object.entries(target.variants)) {
      if (v.status === "accepted" || variantId === liveId) continue;
      dead.push({ address, variantId });
    }
  };

  for (const shot of video.shots) {
    if (!shot.shotFn) continue;
    collect(
      formatCompositionAddress(video.stage, shot.id),
      shot.compositionRefs ?? [],
      () => compositionDefinitionHash(video, shot.id),
      compositionFingerprintRefs(video, shot),
    );
  }

  return dead;
}

// ── Audio stems ──────────────────────────────────────────────────────────────
// A stem is a no-job leaf like a composition, but for audio: a shot's <Audio>/<Video hasAudio>
// cues (`shot.<id>#stem`, and a board shot's narration apart in `shot.<id>#narrationStem`) or the
// timeline soundtrack beds (`timeline#stem`). Its identity is the
// resolution-independent audio structure; its input fingerprints track the resolved audio sources.
// Materialized on accept. What is written differs by stage: a delivered stem is a manifest (the
// mux happens at export), the board's per-shot stem the real mix, clamped to the shot — an
// audio-driven motion model consumes that file, and reads the clip length off it.

function hashStructure(structure: unknown): string {
  return shortHash(structure);
}

// A shot stem's identity. The board's carries the clamp too: the shot's `duration` is konte's own
// input to the mix, so a retimed shot re-mixes the stem.
// `kinds` rides along because the mix is levelled by them: without it, a line the direction moves
// from a character to the mob reuses the stem mixed at the old level.
type ShotStemStructure =
  | { kind: "delivered"; cues: StemAudioEntry[]; kinds?: Readonly<Record<string, CueKind>> }
  | {
      kind: "board";
      cues: StemAudioEntry[];
      clamp: number;
      kinds?: Readonly<Record<string, CueKind>>;
    };

// The shot a stem address belongs to and the cues that stem is mixed from. Null when the shot does
// not carry that stem.
function shotStemOf(
  video: StageDefinition,
  address: string,
): { shot: ShotDefinition; refs: readonly string[] } | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return null;
  const shot = shotById(video.shots, parsed.shotId);
  const stem = shot && listShotStems(video.stage, shot).find((s) => s.address === address);
  return shot && stem ? { shot, refs: stem.refs } : null;
}

function shotStemStructure(video: StageDefinition, address: string): ShotStemStructure | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot") return null;
  const harvested = harvestShotAudioStructure(video, parsed.shotId);
  if (harvested === null) return null;
  const shot = shotById(video.shots, parsed.shotId);
  const narration = new Set(shot?.narrationStemRefs ?? []);
  const cues = harvested.filter(
    (cue) => narration.has(cue.src) === isNarrationStemAddress(address),
  );
  if (cues.length === 0) return null;
  const refs = shotStemOf(video, address)?.refs ?? [];
  const kinds = shot?.cueKinds
    ? Object.fromEntries(Object.entries(shot.cueKinds).filter(([ref]) => refs.includes(ref)))
    : undefined;
  if (video.stage !== "animatic") return { kind: "delivered", cues, kinds };
  if (!shot) return null;
  return { kind: "board", cues, clamp: shot.duration, kinds };
}

function hashShotStemStructure(structure: ShotStemStructure): string {
  const kinds = structure.kinds ?? {};
  return structure.kind === "board"
    ? hashStructure({ cues: structure.cues, clamp: structure.clamp, kinds })
    : hashStructure({ cues: structure.cues, kinds });
}

function timelineStemStructure(
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
export function stemDefinitionHash(video: StageDefinition, address: string): string {
  return memoizedHash(video, `stem:${address}`, () => {
    if (parseAddress(address).kind === "timeline") {
      const structure = timelineStemStructure(video);
      return structure === null ? "" : hashStructure(structure);
    }
    const structure = shotStemStructure(video, address);
    return structure === null ? "" : hashShotStemStructure(structure);
  });
}

function stemDefinitionHashForAddress(video: StageDefinition, address: string): string | null {
  const parsed = parseAddress(address);
  if (parsed.kind !== "shot" && parsed.kind !== "timeline") return null;
  const hash = stemDefinitionHash(video, address);
  if (hash !== "") return hash;
  // A developed shot that sounds nothing stems silence, so a stem accepted before its last cue was
  // removed reads definition-stale.
  const shot = parsed.kind === "shot" ? shotById(video.shots, parsed.shotId) : undefined;
  return shot && !isPendingShot(shot) ? hashStructure({ cues: [] }) : null;
}

/** A developed shot's stems still accepted after the shot stopped mixing anything into them. */
export function removedShotStemAddresses(
  state: KonteState,
  video: StageDefinition,
  shotId: string,
): string[] {
  const shot = shotById(video.shots, shotId);
  if (!shot || isPendingShot(shot)) return [];
  const live = new Set(listShotStems(video.stage, shot).map((stem) => stem.address));
  return shotStemAssetNames(video.stage)
    .map((name) => formatAssetPath(video.stage, shotId, name))
    .filter(
      (address) =>
        !live.has(address) &&
        Object.values(state.assets[address]?.variants ?? {}).some((v) => v.status === "accepted"),
    );
}

export function listRemovedShotStemAddresses(state: KonteState, video: StageDefinition): string[] {
  return video.shots.flatMap((shot) => removedShotStemAddresses(state, video, shot.id));
}

interface StemIdentity {
  definitionHash: string;
  inputFingerprints: Record<string, string>;
}

function recordLeafVariant(
  manager: StateManager,
  address: string,
  variantId: string,
  filePath: string,
  outputHash: string,
  identity: StemIdentity,
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

// The delivered stem's artifact: a manifest of what the export will mux.
async function writeStemManifest(
  manager: StateManager,
  address: string,
  identity: StemIdentity,
  structure: unknown,
): Promise<string> {
  const manifest = stableStringify({ structure, inputFingerprints: identity.inputFingerprints });
  const variantId = manager.reserveVariantId(address);
  const filePath = path.join(variantDir(manager.videoRoot, address, variantId), STEM_MANIFEST_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, manifest, "utf-8");
  return recordLeafVariant(manager, address, variantId, filePath, sha256Hex(manifest), identity);
}

function identitiesEqual(a: StemIdentity, b: StemIdentity): boolean {
  return (
    a.definitionHash === b.definitionHash &&
    stableStringify(a.inputFingerprints) === stableStringify(b.inputFingerprints)
  );
}

// The board stem's artifact: the shot's cues mixed to one file and padded or cut to the shot. The
// same ffmpeg mix the export mux runs, from the same cue fields. Written to a staging dir under the
// video's cache, outside any state lock — `commitShotStem` moves it into the variant dir.
async function mixStemToStaging(
  manager: StateManager,
  address: string,
  cues: readonly StemAudioEntry[],
  clamp: number,
  cueKinds: Readonly<Record<string, CueKind>> | undefined,
): Promise<{ stagingDir: string; file: string; outputHash: string; media: VariantMedia | null }> {
  const tracks: MuxAudioTrack[] = cues.map((cue) => {
    const resolved = manager.resolveReference(cue.src);
    if (!resolved) {
      throw new KonteError(
        "DEPENDENCY_NOT_RESOLVED",
        `Cannot mix ${address}: "${cue.src}" has no ready take`,
      );
    }
    const kind = cueKinds?.[cue.src] ?? "voice";
    const media = manager.getState().assets[cue.src]?.variants?.[resolved.variantId]?.media;
    return {
      file: resolved.file,
      start: cue.start ?? 0,
      // Levelled and lead-in trimmed exactly as the render does: this file is what an audio-driven
      // model consumes and what the reviewer signed off in the preview.
      mediaStart: cue.mediaStart ?? cueLeadIn(kind, media),
      duration: cue.duration != null ? Math.max(0, cue.duration) : null,
      volume: clampEffectiveGain((cue.volume ?? 1) * levellingGain(kind, loudnessOf(media))),
      loop: false,
      fadeIn: cue.fadeIn ?? undefined,
      fadeOut: cue.fadeOut ?? undefined,
    };
  });
  const cacheDir = path.join(manager.videoRoot, ".konte", "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(cacheDir, "stem-"));
  const file = path.join(stagingDir, STEM_MIX_FILE);
  try {
    await mixAudioTracks({ outputFile: file, tracks, duration: clamp });
    const outputHash = sha256Hex(await fs.readFile(file));
    const media = await probeMediaInfo(file);
    return { stagingDir, file, outputHash, media };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * A shot stem readied outside the state lock: the inputs it was mixed from (`identity`) and, for
 * the board's, the mix on disk in a staging dir. `commitShotStem` writes the variant under the
 * lock, once the identity still holds. A `PreparedShotStem` that is never committed must be
 * dropped with `discardPreparedStem`.
 */
export type PreparedShotStem =
  | { kind: "existing"; identity: StemIdentity; variantId: string }
  | { kind: "manifest"; identity: StemIdentity; structure: unknown }
  | {
      kind: "mix";
      identity: StemIdentity;
      stagingDir: string;
      file: string;
      outputHash: string;
      media: VariantMedia | null;
    };

function shotStemIdentity(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): { shot: ShotDefinition; structure: ShotStemStructure; identity: StemIdentity } | null {
  const stem = shotStemOf(video, address);
  if (!stem) return null;
  if (!compositionRefsResolvable(manager, stem.refs)) return null;
  const structure = shotStemStructure(video, address);
  if (structure === null) return null;
  return {
    shot: stem.shot,
    structure,
    identity: {
      definitionHash: hashShotStemStructure(structure),
      inputFingerprints: compositionInputFingerprints(manager, stem.refs),
    },
  };
}

// Ready a shot stem (only when it has cues) without touching state: an existing variant whose
// definition hash and input fingerprints match is reused; the board's mix runs here, ffmpeg and
// all, so the state lock is held only for the commit. Null when the stem cannot be made yet.
export async function prepareShotStem(opts: {
  manager: StateManager;
  video: StageDefinition;
  address: string;
}): Promise<PreparedShotStem | null> {
  const { manager, video, address } = opts;
  const current = shotStemIdentity(manager, video, address);
  if (!current) return null;
  const { shot, structure, identity } = current;
  const existing = manager.tryGetAssetState(address);
  if (existing) {
    const match = findMatchingCompositionVariant(
      existing,
      identity.definitionHash,
      identity.inputFingerprints,
    );
    if (match) return { kind: "existing", identity, variantId: match };
  }
  if (structure.kind !== "board") return { kind: "manifest", identity, structure: structure.cues };
  const mixed = await mixStemToStaging(
    manager,
    address,
    structure.cues,
    structure.clamp,
    shot.cueKinds,
  );
  return { kind: "mix", identity, ...mixed };
}

export async function discardPreparedStem(prepared: PreparedShotStem | null): Promise<void> {
  if (prepared?.kind !== "mix") return;
  await fs.rm(prepared.stagingDir, { recursive: true, force: true }).catch(() => undefined);
}

// Write a prepared stem as a variant, under the state lock. The identity is taken again here,
// whatever was prepared: a source accepted elsewhere since means the stem names audio nobody signed
// off, so it is refused (and the staging dropped) rather than recorded. A variant matching the live
// identity is reused. Mutates in-memory state — the caller persists.
export async function commitShotStem(opts: {
  manager: StateManager;
  video: StageDefinition;
  address: string;
  prepared: PreparedShotStem;
}): Promise<string | null> {
  const { manager, video, address, prepared } = opts;
  try {
    const current = shotStemIdentity(manager, video, address);
    if (!current) return null;
    const { identity } = current;
    if (!identitiesEqual(identity, prepared.identity)) {
      throw new KonteError(
        "DEPENDENCY_NOT_RESOLVED",
        `Cannot record ${address}: an audio take it is mixed from changed since the review — review the shot again`,
      );
    }
    const existing = manager.tryGetAssetState(address);
    if (existing) {
      const match = findMatchingCompositionVariant(
        existing,
        identity.definitionHash,
        identity.inputFingerprints,
      );
      if (match) return match;
    }
    if (prepared.kind === "existing") {
      throw new KonteError(
        "VARIANT_NOT_FOUND",
        `Cannot record ${address}: ${prepared.variantId} was removed since the review — review the shot again`,
      );
    }
    if (prepared.kind === "manifest") {
      return writeStemManifest(manager, address, identity, prepared.structure);
    }
    // Reserved only once the mix is on disk; anything that fails between here and the record is
    // rolled back, so a failure never leaves a file-less variant for the caller's save to persist.
    const variantId = manager.reserveVariantId(address);
    const dir = variantDir(manager.videoRoot, address, variantId);
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, STEM_MIX_FILE);
      await fs.rename(prepared.file, filePath);
      return recordLeafVariant(
        manager,
        address,
        variantId,
        filePath,
        prepared.outputHash,
        identity,
        prepared.media,
      );
    } catch (err) {
      manager.removeVariant(address, variantId);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  } finally {
    await discardPreparedStem(prepared);
  }
}

// Idempotently materialize a shot stem (only when it has cues), prepare and commit in one go — for
// a caller already holding the lock over a single shot (`konte accept`).
export async function materializeShotStem(opts: {
  manager: StateManager;
  video: StageDefinition;
  address: string;
}): Promise<string | null> {
  const prepared = await prepareShotStem(opts);
  if (!prepared) return null;
  return commitShotStem({ ...opts, prepared });
}

// Idempotently materialize the timeline audio stem (the soundtrack beds), only when present.
export async function materializeTimelineStem(opts: {
  manager: StateManager;
  video: StageDefinition;
}): Promise<string | null> {
  const { manager, video } = opts;
  const structure = timelineStemStructure(video);
  if (structure === null) return null;
  const paths = timelineStemRefs(video);
  if (!compositionRefsResolvable(manager, paths)) return null;
  const address = formatTimelineStemAddress(video.stage);
  const identity: StemIdentity = {
    definitionHash: hashStructure(structure),
    inputFingerprints: compositionInputFingerprints(manager, paths),
  };
  const existing = manager.tryGetAssetState(address);
  if (existing) {
    const match = findMatchingCompositionVariant(
      existing,
      identity.definitionHash,
      identity.inputFingerprints,
    );
    if (match) return match;
  }
  return writeStemManifest(manager, address, identity, structure);
}

// ── Content-hash baseline (review snapshot) ─────────────────────────────────
// A materialized leaf's *content hash*: sha256 over its definition hash and resolved input
// fingerprints — the (definitionHash, inputFingerprints) pair variant identity is matched on
// (findMatchingCompositionVariant). No state write, and no *full-artifact* render: a stem's part is
// a pure structure hash, and a composition reuses the discovery-mode structure hash that
// definition-staleness already computes (lighter than the full rendered HTML). A review snapshots it
// per shown leaf so `review handoff new` can diff a leaf's current content against what was
// reviewed, catching a definition edit or an upstream take swap alike.
//
// Deliberately NOT a variant's `outputHash`, which hashes the produced *artifact* (a composition's
// full rendered HTML, a stem's manifest file) and tracks render details — a heavier, render-bound
// value; the content hash is the identity both leaves already match on.
function leafContentHash(
  definitionHash: string,
  inputFingerprints: Record<string, string>,
): string {
  return stableHash({ definitionHash, inputFingerprints });
}

// The upstream refs a materialized leaf consumes for its input fingerprints — the same refs its
// materializer fingerprints: a composition's picture refs, a shot stem's cues, the timeline beds.
// null when the address is not a renderable leaf (no shotFn / no audio cues / no soundtracks).
function leafInputRefs(video: StageDefinition, address: string): readonly string[] | null {
  const parsed = parseAddress(address);
  if (isCompositionAddress(address)) {
    if (parsed.kind !== "shot") return null;
    const shot = shotById(video.shots, parsed.shotId);
    return shot?.shotFn ? compositionFingerprintRefs(video, shot) : null;
  }
  if (isStemAddress(address)) {
    if (parsed.kind === "shot") return shotStemOf(video, address)?.refs ?? null;
    if (parsed.kind === "timeline") {
      return (video.timelineSoundtracks?.length ?? 0) > 0 ? timelineStemRefs(video) : null;
    }
  }
  return null;
}

// The content-hash baseline of one materialized leaf (composition / stem), or null when it is not a
// renderable leaf or its inputs do not resolve (nothing was shown to snapshot). Pure — no render, no
// state write. Shared by the review submit (records it) and `review handoff new` (diffs against it).
export function materializedLeafContentHash(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): string | null {
  const definitionHash = definitionHashForAddress(video, address);
  if (definitionHash == null) return null;
  const refs = leafInputRefs(video, address);
  if (refs === null) return null;
  if (!compositionRefsResolvable(manager, refs)) return null;
  const inputFingerprints = compositionInputFingerprints(manager, refs);
  return leafContentHash(definitionHash, inputFingerprints);
}

// The refs a leaf's readiness is judged on. null when the address is not a renderable leaf (no
// shotFn / no audio cues / no soundtracks), which is not the same as a leaf whose refs do not
// resolve — the callers below keep the two apart.
function leafReadinessRefs(video: StageDefinition, address: string): readonly string[] | null {
  const parsed = parseAddress(address);
  if (isCompositionAddress(address)) {
    if (parsed.kind !== "shot") return null;
    const shot = shotById(video.shots, parsed.shotId);
    if (!shot?.shotFn) return null;
    // The render plan gates a composition build on the shot's whole pool, not only the refs the
    // composition places. Read the same set here, so "ready for review" and "the builder will take
    // it" cannot disagree.
    const pool = Object.keys(shot.assets ?? {}).map((name) =>
      formatAddress(video.stage, shot.id, name),
    );
    return [...new Set([...(shot.compositionRefs ?? []), ...pool])];
  }
  if (isStemAddress(address)) {
    if (parsed.kind === "shot") return shotStemOf(video, address)?.refs ?? null;
    if (parsed.kind === "timeline") {
      return (video.timelineSoundtracks?.length ?? 0) > 0 ? timelineStemRefs(video) : null;
    }
  }
  return null;
}

// Whether a materialized leaf (composition / stem) is ready to be reviewed right now: it has a
// renderable structure and every ref it consumes resolves to a ready variant. The read-only twin
// of the materializers' own gates — status uses it to surface a never-accepted leaf for review
// without writing anything, now that leaves are materialized only on accept.
export function leafReadyForReview(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): boolean {
  const refs = leafReadinessRefs(video, address);
  return refs !== null && compositionRefsResolvable(manager, refs);
}

/** One ref a leaf consumes that resolves to nothing a spend may bake, and why. */
export interface UnresolvedLeafRef {
  address: string;
  // In the words `inspect` uses for the same state, so a reader is not made to translate between
  // this and `status`.
  cause: string;
}

/**
 * The refs behind a false `leafReadyForReview`, each with its cause — what a caller reports so the
 * reviewer is not sent to `status -v` to find out which input held the leaf back. Empty when the
 * leaf is ready, and when the address is no leaf at all (`leafReadyForReview` answers that half).
 */
export function unresolvedLeafRefs(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): UnresolvedLeafRef[] {
  const unresolved: UnresolvedLeafRef[] = [];
  for (const ref of leafReadinessRefs(video, address) ?? []) {
    const cause = unresolvedRefCause(manager, ref);
    if (cause !== null) unresolved.push({ address: ref, cause });
  }
  return unresolved;
}

// Why one ref resolves to nothing a spend may build on; null when it resolves. Every case here is
// the next `generate`'s work — a human accept resolves whatever its staleness, so a stale take that
// got this far is one `generate` re-bakes, as are a dismissed-only address and an unfinished job.
function unresolvedRefCause(manager: StateManager, address: string): string | null {
  if (manager.resolveReference(address, { includeStale: false })) return null;
  // Only strict resolution refused, so what a read surface still shows is a stale take.
  const stale = manager.selectVariant(address, { includeStale: true });
  if (stale) {
    const staleness = manager.variantStaleness(address, stale.variantId);
    return (staleness && formatStaleCause(staleness)) || "stale";
  }
  const variants = Object.values(manager.getState().assets[address]?.variants ?? {});
  if (variants.length === 0) return "no take yet";
  if (variants.every((v) => v.status === "dismissed")) return "every take was dismissed";
  return "no take has an output file yet";
}

/**
 * A leaf readied for its accept. Only a board shot's stem has work worth doing outside the lock
 * (its ffmpeg mix); every other leaf is materialized at commit.
 */
export type PreparedLeaf = { kind: "inline" } | { kind: "shot-stem"; prepared: PreparedShotStem };

// Ready the composition/stem leaf an address names for its accept, without touching state. Null
// when the address is not a leaf or the leaf has nothing to materialize (pending shot, no audio).
export async function prepareLeafForAddress(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): Promise<PreparedLeaf | null> {
  // Gate on the same readiness `status` uses, so accept-materialize is possible exactly when the
  // leaf shows under "Needs review". A composition renders its <Audio> too (only its hash is
  // audio-independent), so every ref — audio included — must resolve before we build it.
  if (!leafReadyForReview(manager, video, address)) return null;
  const parsed = parseAddress(address);
  if (parsed.kind === "shot" && isStemAddress(address)) {
    const prepared = await prepareShotStem({ manager, video, address });
    return prepared ? { kind: "shot-stem", prepared } : null;
  }
  if (parsed.kind === "shot" || parsed.kind === "timeline") return { kind: "inline" };
  return null;
}

export async function discardPreparedLeaf(prepared: PreparedLeaf | null): Promise<void> {
  if (prepared?.kind === "shot-stem") await discardPreparedStem(prepared.prepared);
}

// Write a prepared leaf under the state lock and return its variant id (idempotent — reuses a
// matching variant). Mutates in-memory state — the caller persists.
export async function commitLeafForAddress(
  manager: StateManager,
  video: StageDefinition,
  address: string,
  prepared: PreparedLeaf,
): Promise<string | null> {
  if (prepared.kind === "shot-stem") {
    return commitShotStem({ manager, video, address, prepared: prepared.prepared });
  }
  if (!leafReadyForReview(manager, video, address)) return null;
  const parsed = parseAddress(address);
  if (parsed.kind === "shot") {
    return isCompositionAddress(address)
      ? materializeCompositionVariant({ manager, video, shotId: parsed.shotId })
      : null;
  }
  if (parsed.kind === "timeline") {
    return materializeTimelineStem({ manager, video });
  }
  return null;
}

// Materialize the composition/stem leaf an address names, prepare and commit in one go, and return
// its variant id. The on-accept entry point for a caller holding the lock over one leaf.
export async function materializeLeafForAddress(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): Promise<string | null> {
  const prepared = await prepareLeafForAddress(manager, video, address);
  if (!prepared) return null;
  return commitLeafForAddress(manager, video, address, prepared);
}

// Dead stem variants — the stem counterpart of collectDeadCompositionVariants: unaccepted,
// unlocked variants that no longer match the current definition/inputs.
export function collectDeadStemVariants(
  manager: StateManager,
  video: StageDefinition,
): { address: string; variantId: string }[] {
  const dead: { address: string; variantId: string }[] = [];

  const collect = (
    address: string,
    live: { definitionHash: string; inputFingerprints: Record<string, string> } | null,
  ): void => {
    const target = manager.tryGetAssetState(address);
    if (!target?.variants) return;
    const liveId = live
      ? findMatchingCompositionVariant(target, live.definitionHash, live.inputFingerprints)
      : null;
    for (const [variantId, v] of Object.entries(target.variants)) {
      if (v.status === "accepted" || variantId === liveId) continue;
      dead.push({ address, variantId });
    }
  };

  for (const shot of video.shots) {
    for (const stem of listShotStems(video.stage, shot)) {
      const structure = shotStemStructure(video, stem.address);
      const live =
        structure !== null && compositionRefsResolvable(manager, stem.refs)
          ? {
              definitionHash: hashShotStemStructure(structure),
              inputFingerprints: compositionInputFingerprints(manager, stem.refs),
            }
          : null;
      collect(stem.address, live);
    }
  }

  const timelineStructure = timelineStemStructure(video);
  if (timelineStructure !== null) {
    const paths = timelineStemRefs(video);
    const live = compositionRefsResolvable(manager, paths)
      ? {
          definitionHash: hashStructure(timelineStructure),
          inputFingerprints: compositionInputFingerprints(manager, paths),
        }
      : null;
    collect(formatTimelineStemAddress(video.stage), live);
  }
  return dead;
}
