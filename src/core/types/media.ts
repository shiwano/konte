export type MediaKind = "image" | "video" | "audio";

export interface MediaAsset<T extends MediaKind = MediaKind> {
  readonly src: string;
  readonly __kind?: T;
}

// `__kind` is a phantom field — never present at runtime — so a caller that knows the media kind
// mints it directly rather than casting at every site.
export function makeMediaAsset<T extends MediaKind = MediaKind>(src: string): MediaAsset<T> {
  return { src };
}
