import type { MediaAsset, MediaKind } from "../types/media.js";

// `__kind` is a phantom field, never present at runtime.
export function makeMediaAsset<T extends MediaKind = MediaKind>(src: string): MediaAsset<T> {
  return { src };
}
