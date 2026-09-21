import * as fs from "node:fs/promises";
import { type AssetStage, type DefinitionLike, getAssetEntry, listAssetPaths } from "./address.js";
import { hashFile } from "./content-hash.js";
import { KonteError } from "./errors.js";
import { resolveWithinRoot } from "./path-containment.js";
import type { StateManager } from "./state/index.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  VariantState,
  VideoDefinition,
} from "./types/index.js";
import { probeMediaInfo } from "./video-probe.js";

interface SyncFileAssetsOptions {
  validate?: boolean;
  /**
   * Measure the media konte just hashed (`VariantMediaSchema`) — the only thing that ever measures an
   * authored file, such as a `file` narration's length. Opt-in: this sync also runs under `konte
   * status`, and the first ffprobe on a machine PROVISIONS the managed ffmpeg. Pass it from the
   * commands that already need ffmpeg (generate, preview, export), never from a read-only one.
   */
  measure?: boolean;
}

interface FileAssetSyncTargets {
  reference?: ReferenceDefinition | null;
  animatic?: AnimaticDefinition | null;
  video?: VideoDefinition | null;
}

async function syncFileAssetsForDefinition(
  definition: DefinitionLike,
  stage: AssetStage,
  manager: StateManager,
  validate: boolean,
  measureMedia: boolean,
): Promise<string[]> {
  const assetPaths = listAssetPaths(definition, stage);
  const changed: string[] = [];

  for (const assetPath of assetPaths) {
    const entry = getAssetEntry(definition, assetPath);
    if (entry.kind !== "file") continue;

    // An address is the asset path, so the file asset is addressed by its path directly.
    const address = assetPath;
    const filePath = entry.path;

    // A file asset's path is authored, and konte does two things with it that make an escape
    // dangerous: it hashes the file into state, and it uploads it to whichever cloud backend
    // consumes the asset. `path: "../../konte.credentials.json"` (or a symlink to it under
    // assets/files/) would therefore exfiltrate the workspace's credentials past the deny rules. Always an error,
    // regardless of `validate` — a path that leaves the video is wrong, not merely absent.
    const absPath = await resolveWithinRoot(manager.videoRoot, filePath);
    if (absPath === null) {
      throw new KonteError(
        "INVALID_REFERENCE",
        `File asset "${address}" references "${filePath}", which resolves outside the video directory. A file asset must live inside its video (usually under "assets/files/").`,
      );
    }

    const onDisk = await fs
      .access(absPath)
      .then(() => true)
      .catch(() => false);

    if (!onDisk && validate) {
      throw new KonteError(
        "LOAD_FAILED",
        `File asset "${address}" references "${filePath}" but the file does not exist`,
      );
    }

    const existingEntry = Object.entries(manager.tryGetAssetState(address)?.variants ?? {}).find(
      ([, v]) => v.file === filePath,
    );

    // A file asset's variant mirrors the file on disk rather than a generated take, so an absent
    // file must leave no variant behind. Otherwise the accepted variant a previous sync recorded
    // outlives its file, and every downstream reader — status' accept counts, the dependency
    // resolver — reads the asset as complete while its path resolves to nothing.
    if (!onDisk) {
      if (existingEntry) {
        manager.removeVariant(address, existingEntry[0]);
        // A file asset's target exists only to hold that mirror variant, so an emptied one is
        // dropped whole — a bare `variants: {}` would read as a never-generated asset and draw a
        // `generate` suggestion no `file` asset can act on.
        const remaining = manager.tryGetAssetState(address)?.variants ?? {};
        if (Object.keys(remaining).length === 0) manager.removeAsset(address);
        changed.push(address);
      }
      continue;
    }

    const contentHash = await hashFile(absPath);
    const measure = async (variant: VariantState): Promise<void> => {
      const media = measureMedia ? await probeMediaInfo(absPath) : null;
      if (media) variant.media = media;
      else delete variant.media;
    };

    if (existingEntry) {
      const [, variant] = existingEntry;
      if (variant.outputHash !== contentHash) {
        variant.outputHash = contentHash;
        // New bytes are a new picture: whatever was decided was decided about the old one.
        variant.status = "none";
        variant.decidedAt = null;
        // Whatever was recorded described the bytes that just got swapped out.
        await measure(variant);
        changed.push(address);
      } else if (measureMedia && !variant.media) {
        // Same bytes, never measured — synced by a read-only command. Fill it in now.
        await measure(variant);
      }
      continue;
    }

    const target = manager.ensureAssetState(address);
    if (!target.variants) {
      target.variants = {};
    }
    const variantId = manager.reserveVariantId(address);
    const variant = target.variants[variantId]!;
    variant.file = filePath;
    variant.readyAt = new Date().toISOString();
    variant.outputHash = contentHash;
    await measure(variant);
    changed.push(address);
  }

  return changed;
}

// Sync the on-disk `file` assets of every provided stage into state as variants, so a downstream
// stage's dependency on them resolves without separately generating that stage. A stage
// with no file assets is a no-op, so passing every loaded stage is always safe.
export async function syncFileAssets(
  targets: FileAssetSyncTargets,
  manager: StateManager,
  options?: SyncFileAssetsOptions,
): Promise<string[]> {
  const validate = options?.validate ?? false;
  const measureMedia = options?.measure ?? false;
  const changed: string[] = [];

  const stages: Array<[AssetStage, DefinitionLike | null | undefined]> = [
    ["reference", targets.reference],
    ["animatic", targets.animatic],
    ["video", targets.video],
  ];
  for (const [stage, definition] of stages) {
    if (!definition) continue;
    changed.push(
      ...(await syncFileAssetsForDefinition(definition, stage, manager, validate, measureMedia)),
    );
  }

  return changed;
}
