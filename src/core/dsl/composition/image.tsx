import type { MediaAsset } from "../builders.js";
import { getRenderContext } from "../../jsx-html.js";

type ImgElementProps = React.ComponentPropsWithoutRef<"img">;

export type ImageProps = Omit<ImgElementProps, "src" | "children"> & {
  src: MediaAsset<"image">;
  /** Timeline start in seconds, local to the shot it is placed in (data-start). Defaults to 0. */
  start?: number;
  /** How long the image shows in seconds (data-duration). Defaults to the shot duration. */
  duration?: number;
  /** A full-stage, cover-fit layer (`konte-clip`); Tailwind utilities in `className` override it. */
  fill?: boolean;
};

/**
 * A still image placed in a shot's composition (a reference logo/character/product, a background
 * plate, an overlay). Render a generated or `file` image asset by its `src`. Defaults to the whole
 * shot; `start`/`duration` window it. `fill` makes it a full-frame layer — without it, position it
 * with Tailwind/inline styles like any `<img>`.
 */
// Defaults to `alt=""` — a composition image renders into a video frame, not a screen-reader DOM,
// so it is decorative unless the author passes an explicit `alt`.
export function Image({
  src,
  start,
  duration,
  fill,
  className,
  alt = "",
  ...rest
}: ImageProps): React.ReactElement {
  // Default the clip to span the whole shot, mirroring <Video>: an image with no explicit
  // data-duration would otherwise have an open-ended window. An explicit prop still wins.
  const { duration: shotDuration } = getRenderContext();

  // Raw data-* attributes are not part of the props type but are still accepted as JSX
  // attributes; honor them as fallbacks so the typed props stay opt-in. data-end is not a
  // HyperFrames attribute (a clip is bounded by data-duration only), so it is dropped.
  const raw = rest as Record<string, unknown>;

  return (
    <img
      src={src.src}
      alt={alt}
      {...rest}
      className={fill ? (className ? `konte-clip ${className}` : "konte-clip") : className}
      data-start={start ?? raw["data-start"] ?? 0}
      data-duration={duration ?? raw["data-duration"] ?? shotDuration}
      data-end={undefined}
    />
  );
}
