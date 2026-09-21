import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type AssetStage,
  DELIVERY_SUFFIX,
  formatAssetPathSuffix,
  parseAddress,
} from "./address.js";

const PATCH_DIR = "patch";

export const ASSET_STAGES: readonly AssetStage[] = ["reference", "animatic", "video"];

export function assetDir(videoRoot: string, address: string): string {
  const parsed = parseAddress(address);
  // A patch step nests under its chain, so `<stage>:patch.<vid>` — an address-scope already — is a
  // directory too: one `patch/<vid>/` holding every step of one correction, beside the stage's own
  // assets rather than scattered among them. `patch` heads the axis and is a reserved asset name
  // (see validateAssetName), so the bucket can collide with nothing an author declares.
  if (parsed.kind === "patch") {
    return path.join(
      patchChainDir(videoRoot, parsed.stage, parsed.sourceVariantId),
      parsed.assetName,
    );
  }
  const base = formatAssetPathSuffix(parsed);
  const rest = parsed.delivery ? `${base}${DELIVERY_SUFFIX}` : base;
  return path.join(videoRoot, "assets", parsed.stage, rest);
}

// The directory holding every step of one patch's chain — what `patch remove` deletes, and what
// `prune` collapses once its last step is gone.
export function patchChainDir(
  videoRoot: string,
  stage: AssetStage,
  sourceVariantId: string,
): string {
  return path.join(videoRoot, "assets", stage, PATCH_DIR, sourceVariantId);
}

// The stage's patch bucket — the parent of every chain dir.
export function patchBucketDir(videoRoot: string, stage: AssetStage): string {
  return path.join(videoRoot, "assets", stage, PATCH_DIR);
}

export function variantDir(videoRoot: string, address: string, variantId: string): string {
  return path.join(assetDir(videoRoot, address), variantId);
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Every directory on disk shaped like a variant directory — `<stage>/<suffix>/v-…` and
 * `<stage>/patch/v-…/<name>/v-…` under `assets/` — relative to the video root, whether or not
 * state records its variant.
 */
export async function listVariantDirsOnDisk(videoRoot: string): Promise<string[]> {
  const out: string[] = [];
  const isVariantName = (name: string) => name.startsWith("v-");
  for (const stage of ASSET_STAGES) {
    const stageDir = path.join("assets", stage);
    for (const suffix of await subdirectories(path.join(videoRoot, stageDir))) {
      const suffixDir = path.join(stageDir, suffix);
      if (suffix !== PATCH_DIR) {
        for (const name of await subdirectories(path.join(videoRoot, suffixDir))) {
          if (isVariantName(name)) out.push(path.join(suffixDir, name));
        }
        continue;
      }
      for (const chain of await subdirectories(path.join(videoRoot, suffixDir))) {
        if (!isVariantName(chain)) continue;
        const chainDir = path.join(suffixDir, chain);
        for (const step of await subdirectories(path.join(videoRoot, chainDir))) {
          const stepDir = path.join(chainDir, step);
          for (const name of await subdirectories(path.join(videoRoot, stepDir))) {
            if (isVariantName(name)) out.push(path.join(stepDir, name));
          }
        }
      }
    }
  }
  return out;
}

/**
 * The variant whose directory holds `file` — the one that generated it, as opposed to any variant
 * merely pointing at it. Null when the file lives outside every variant directory (a `file` asset's
 * mirror, an authored asset).
 */
export function variantOwningFile(
  state: { assets: Record<string, { variants?: Record<string, { file?: string | null }> }> },
  file: string,
): { address: string; variantId: string } | null {
  const target = path.join(file);
  for (const [address, asset] of Object.entries(state.assets)) {
    for (const [variantId, variant] of Object.entries(asset.variants ?? {})) {
      if (!variant.file || path.join(variant.file) !== target) continue;
      if (target.startsWith(`${variantDir("", address, variantId)}${path.sep}`)) {
        return { address, variantId };
      }
    }
  }
  return null;
}

/**
 * The variants whose file this one's directory holds — anything that would lose its bytes if this
 * variant were deleted. Empty for all but a patch chain's returned step, whose take IS the patched
 * variant's file (see `materializePatchOutput`, which points rather than copies).
 *
 * Judged by path, so it needs no field recording the relationship: a variant's file is inside
 * exactly one variant directory, and that variant owns it. A file elsewhere in the video (a `file`
 * asset's mirror, an authored asset) is inside none of them.
 */
export function variantsHostedBy(
  state: { assets: Record<string, { variants?: Record<string, { file?: string | null }> }> },
  address: string,
  variantId: string,
): Array<{ address: string; variantId: string }> {
  const dir = `${variantDir("", address, variantId)}${path.sep}`;
  const out: Array<{ address: string; variantId: string }> = [];
  for (const [otherAddress, target] of Object.entries(state.assets)) {
    for (const [otherId, variant] of Object.entries(target.variants ?? {})) {
      if (otherAddress === address && otherId === variantId) continue;
      if (!variant.file) continue;
      if (path.join(variant.file).startsWith(dir))
        out.push({ address: otherAddress, variantId: otherId });
    }
  }
  return out;
}
