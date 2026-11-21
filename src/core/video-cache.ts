import * as path from "node:path";
import { addressToCacheSegments } from "./address.js";

export function videoCacheDir(videoRoot: string, ...segments: string[]): string {
  return path.join(videoRoot, ".konte", "cache", ...segments);
}

export function thumbnailCacheDir(videoRoot: string, address?: string): string {
  return videoCacheDir(
    videoRoot,
    "thumbnails",
    ...(address === undefined ? [] : addressToCacheSegments(address)),
  );
}

export function thumbnailVariantCacheDir(
  videoRoot: string,
  address: string,
  variantId: string,
): string {
  return path.join(thumbnailCacheDir(videoRoot, address), variantId);
}

export function audioVariantCacheDir(videoRoot: string, variantId: string): string {
  return videoCacheDir(videoRoot, "audio", variantId);
}

export function motionVariantCacheDir(videoRoot: string, variantId: string): string {
  return videoCacheDir(videoRoot, "motion", variantId);
}

export function cropVariantDir(videoRoot: string, variantId: string): string {
  return videoCacheDir(videoRoot, "crops", variantId);
}

export function songPartsVariantDir(videoRoot: string, variantId: string): string {
  return videoCacheDir(videoRoot, "song-parts", variantId);
}

export function prerollCacheDir(videoRoot: string): string {
  return videoCacheDir(videoRoot, "preroll");
}

export function prerollVariantDir(videoRoot: string, variantId: string): string {
  return path.join(prerollCacheDir(videoRoot), variantId);
}
