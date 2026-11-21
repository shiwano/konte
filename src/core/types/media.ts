export type MediaKind = "image" | "video" | "audio";

export interface MediaAsset<T extends MediaKind = MediaKind> {
  readonly src: string;
  readonly __kind?: T;
}
