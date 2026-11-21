import { jobLogPath } from "./job-manager.js";
import { patchFilePath } from "./patch.js";
import { variantDir } from "./variant-dir.js";
import {
  audioVariantCacheDir,
  cropVariantDir,
  motionVariantCacheDir,
  prerollVariantDir,
  songPartsVariantDir,
  thumbnailVariantCacheDir,
} from "./video-cache.js";

// What one variant leaves outside its asset dir: its log, caches and patch script.
export function variantLeftoverPaths(videoRoot: string, variantId: string): string[] {
  return [
    jobLogPath(videoRoot, variantId),
    audioVariantCacheDir(videoRoot, variantId),
    motionVariantCacheDir(videoRoot, variantId),
    prerollVariantDir(videoRoot, variantId),
    songPartsVariantDir(videoRoot, variantId),
    cropVariantDir(videoRoot, variantId),
    patchFilePath(videoRoot, variantId),
  ];
}

export function variantAssetPaths(videoRoot: string, address: string, variantId: string): string[] {
  try {
    return [
      variantDir(videoRoot, address, variantId),
      thumbnailVariantCacheDir(videoRoot, address, variantId),
    ];
  } catch {
    // unparseable address: no asset or thumbnail dir to name
    return [];
  }
}

export function variantOwnedPaths(videoRoot: string, address: string, variantId: string): string[] {
  return [
    ...variantAssetPaths(videoRoot, address, variantId),
    ...variantLeftoverPaths(videoRoot, variantId),
  ];
}
