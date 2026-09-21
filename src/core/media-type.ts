import type { StateManager } from "./state/index.js";
import * as path from "node:path";

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a"]);

export function inferMediaType(filePath: string): "video" | "image" | "audio" | null {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

/**
 * The media a take on disk is, defaulting to "video" for anything unreadable — an unknown extension,
 * a missing variant, an address with no state. Callers use it to split a shot's picture takes from
 * its audio ones, where guessing "video" keeps a take on the picture path it was already on.
 */
export function variantMediaKind(
  manager: StateManager,
  address: string,
  variantId: string | null,
): "video" | "image" | "audio" {
  if (!variantId) return "video";
  const file = manager.tryGetAssetState(address)?.variants?.[variantId]?.file;
  return (file && inferMediaType(file)) || "video";
}
