import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acceptedVariantId } from "./accepted-variant.js";
import {
  formatAddress,
  formatTimelineOverlayAddress,
  formatTimelineStemAddress,
} from "./address.js";
import { listShotStems, shotStemAssetNames } from "./definition-addresses.js";
import type { StemAudioEntry } from "./composition-builder.js";
import {
  clampEffectiveGain,
  cueLeadIn,
  levellingGain,
  loudnessOf,
  type CueKind,
} from "./audio-level.js";
import { songParts } from "./song-parts.js";
import { KonteError } from "./errors.js";
import { mixAudioTracks, type MuxAudioTrack } from "./ffmpeg.js";
import { shotById } from "./shot-index.js";
import { sha256Hex } from "./content-hash.js";
import {
  compositionInputFingerprints,
  compositionRefsResolvable,
  findMatchingCompositionVariant,
  hashShotStemStructure,
  hashStructure,
  type LeafIdentity,
  overlayDefinitionHash,
  overlayFingerprintRefs,
  recordLeafVariant,
  shotStemOf,
  shotStemStructure,
  type ShotStemStructure,
  timelineStemRefs,
  timelineStemStructure,
} from "./leaf-hash.js";
import { stableStringify } from "./stable-stringify.js";
import type { StateManager } from "./state/index.js";
import {
  isPendingShot,
  type KonteState,
  type ShotDefinition,
  type StageDefinition,
  type VariantMedia,
} from "./types/index.js";
import { variantDir } from "./variant-dir.js";
import { probeMediaInfo } from "./video-probe.js";
import { videoCacheDir } from "./video-cache.js";

const STEM_MANIFEST_FILE = "stem.json";
const STEM_MIX_FILE = "stem.wav";

// A stem is a no-job leaf like a composition, but for audio: a shot's <Audio>/<Video hasAudio>
// cues (`shot.<id>#stem`, and a board shot's narration and off-frame lines apart in
// `shot.<id>#narrationStem` / `#offFrameStem`) or the
// timeline soundtrack beds (`timeline#stem`). Its identity is the
// resolution-independent audio structure; its input fingerprints track the resolved audio sources.
// Materialized on accept. What is written differs by stage: a delivered stem is a manifest (the
// mux happens at export), the board's per-shot stem the real mix, clamped to the shot — an
// audio-driven motion model consumes that file, and reads the clip length off it.

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
    .map((name) => formatAddress(video.stage, shotId, name))
    .filter((address) => !live.has(address) && acceptedVariantId(state, address) !== null);
}

export function listRemovedShotStemAddresses(state: KonteState, video: StageDefinition): string[] {
  return video.shots.flatMap((shot) => removedShotStemAddresses(state, video, shot.id));
}

// The delivered stem's artifact: a manifest of what the export will mux.
async function writeStemManifest(
  manager: StateManager,
  address: string,
  identity: LeafIdentity,
  structure: unknown,
): Promise<string> {
  const manifest = stableStringify({ structure, inputFingerprints: identity.inputFingerprints });
  const variantId = manager.reserveVariantId(address);
  const filePath = path.join(variantDir(manager.videoRoot, address, variantId), STEM_MANIFEST_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, manifest, "utf-8");
  return recordLeafVariant(manager, address, variantId, filePath, sha256Hex(manifest), identity);
}

function identitiesEqual(a: LeafIdentity, b: LeafIdentity): boolean {
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
  const tracks: MuxAudioTrack[] = [];
  for (const cue of cues) {
    const resolved = manager.resolveReference(cue.src);
    if (!resolved) {
      throw new KonteError(
        "DEPENDENCY_NOT_RESOLVED",
        `Cannot mix ${address}: "${cue.src}" has no ready take`,
      );
    }
    const part = cue.track === "vocals" || cue.track === "instrumental" ? cue.track : null;
    const kind = cue.track === "song" || part ? "song" : (cueKinds?.[cue.src] ?? "voice");
    const media = manager.getState().assets[cue.src]?.variants?.[resolved.variantId]?.media;
    tracks.push({
      file: part ? (await songParts(manager.videoRoot, resolved))[part] : resolved.file,
      start: cue.start ?? 0,
      // Levelled and lead-in trimmed exactly as the render does: this file is what an audio-driven
      // model consumes and what the reviewer signed off in the preview.
      mediaStart: cue.mediaStart ?? (kind === "song" ? 0 : cueLeadIn(kind, media)),
      rate: cue.rate,
      duration: cue.duration != null ? Math.max(0, cue.duration) : null,
      volume: clampEffectiveGain((cue.volume ?? 1) * levellingGain(kind, loudnessOf(media))),
      loop: false,
      fadeIn: cue.fadeIn ?? undefined,
      fadeOut: cue.fadeOut ?? undefined,
    });
  }
  const cacheDir = videoCacheDir(manager.videoRoot);
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
  | { kind: "existing"; identity: LeafIdentity; variantId: string }
  | { kind: "manifest"; identity: LeafIdentity; structure: unknown }
  | {
      kind: "mix";
      identity: LeafIdentity;
      stagingDir: string;
      file: string;
      outputHash: string;
      media: VariantMedia | null;
    };

function shotStemIdentity(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): { shot: ShotDefinition; structure: ShotStemStructure; identity: LeafIdentity } | null {
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

/** The identity a shot stem materialized now would carry; null when it cannot be made yet. */
export function shotStemIdentityFor(
  manager: StateManager,
  video: StageDefinition,
  address: string,
): LeafIdentity | null {
  return shotStemIdentity(manager, video, address)?.identity ?? null;
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
  const identity: LeafIdentity = {
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

// Dead stem and overlay variants — the counterpart of collectDeadCompositionVariants for the other
// leaves: unaccepted, unlocked variants that no longer match the current definition/inputs.
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

  if (video.overlay) {
    const live = compositionRefsResolvable(manager, video.overlay.compositionRefs)
      ? {
          definitionHash: overlayDefinitionHash(video),
          inputFingerprints: compositionInputFingerprints(manager, overlayFingerprintRefs(video)),
        }
      : null;
    collect(formatTimelineOverlayAddress(video.stage), live);
  }
  return dead;
}
