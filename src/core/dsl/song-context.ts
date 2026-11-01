import type { SongVariant } from "../song-variant.js";

// The takes of the video's song the loader read off state before evaluating its definitions — the
// one input a definition has that is not a file: where the accepted song is sung. Set for the length
// of one definition import (which the loader serializes), read by `defineDirection`. Absent outside
// a load (a test calling `defineDirection` directly), which reads as no take.
let current: ((address: string) => SongVariant | null) | null = null;

export function withSongVariants<T>(
  lookup: ((address: string) => SongVariant | null) | null,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = current;
  current = lookup;
  return fn().finally(() => {
    current = previous;
  });
}

export function songVariantAt(address: string): SongVariant | null {
  return current?.(address) ?? null;
}
