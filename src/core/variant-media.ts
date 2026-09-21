import * as path from "node:path";
import type { KonteState, VariantMedia, VariantState } from "./types/index.js";
import { probeMediaInfo } from "./video-probe.js";

// Reading a variant's measurements (`VariantMediaSchema`) instead of spawning a probe for them. The
// record is written when the file lands (`waitForJob`); a miss here — a `file` asset whose sync
// deliberately does not probe — measures once for this run.

/**
 * The variant's recorded media, measuring the file once when the record is missing. The measurement
 * is written back into the passed variant, so it persists only if the caller's manager is one that
 * gets saved — a read-only pass takes it again next command. Null for a variant with no file, an
 * unreadable one, or one whose file carries no media (a composition's HTML manifest); none of those
 * is recorded, so a file that becomes readable later still gets measured.
 */
export async function ensureVariantMedia(
  variant: VariantState | undefined,
  videoRoot: string,
): Promise<VariantMedia | null> {
  if (!variant) return null;
  if (variant.media) return variant.media;
  if (!variant.file) return null;
  const media = await probeMediaInfo(path.resolve(videoRoot, variant.file));
  if (media) variant.media = media;
  return media;
}

/**
 * Absolute file → its recorded media, over every variant in state — how a caller holding a path and
 * no address (the mux) reaches the records. A file whose variant is unmeasured is absent from the
 * map, left to the caller's own fallback. Two variants sharing a file (a patch output and the step
 * it inherited) carry the same measurements, so either wins.
 */
export function mediaByFile(state: KonteState, videoRoot: string): Map<string, VariantMedia> {
  const byFile = new Map<string, VariantMedia>();
  for (const asset of Object.values(state.assets)) {
    for (const variant of Object.values(asset.variants ?? {})) {
      if (variant.file && variant.media) {
        byFile.set(path.resolve(videoRoot, variant.file), variant.media);
      }
    }
  }
  return byFile;
}

/** The file's pixel size — an image and a video both have one, audio does not. */
export function mediaVisualSize(
  media: VariantMedia | null,
): { width: number; height: number } | null {
  if (!media || media.kind === "audio") return null;
  return { width: media.width, height: media.height };
}

/** How long the file plays. Null for a still, which has no duration to speak of. */
export function mediaDurationSec(media: VariantMedia | null): number | null {
  if (!media || media.kind === "image") return null;
  return media.durationSec;
}

/** Whether the file carries an audio stream the mux can take. */
export function mediaHasAudio(media: VariantMedia): boolean {
  return media.kind === "audio" || (media.kind === "video" && media.audio !== null);
}
