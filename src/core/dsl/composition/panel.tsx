import { KonteError } from "../../errors.js";
import { getRenderContext } from "../../jsx-html.js";
import type { MediaAsset } from "../builders.js";
import { isCollectingPanels, nextPanelIndex, recordPanel } from "../panel-collect.js";
import { parsePlaceholder } from "../shot-context.js";

type ImgElementProps = React.ComponentPropsWithoutRef<"img">;

export type PanelProps = Omit<ImgElementProps, "src" | "children" | "start"> & {
  src: MediaAsset<"image">;
  /**
   * When this keyframe takes over, in shot-local seconds. Omitted, the panel takes its share of
   * whatever the PINNED panels around it leave — with nothing pinned, the shot's panels divide its
   * duration equally in document order. Each panel holds until the next one's `start` (the last
   * until the shot's end) and then CUTS — konte never interpolates between two frames; write a
   * dissolve with `<Animate>`.
   */
  start?: number;
  /** The subject movement carrying this keyframe to the next one (or, on the only panel, to the shot's end). */
  blocking?: string;
  /** The camera's behaviour over that same transit. */
  camera?: string;
};

/**
 * A keyframe of an animatic shot: a part name (the leaf of its `src` address — what
 * `animatic.shot("01").image("first")` reaches from `video.tsx`), a slot on the shot's clock, the
 * movement leaving it, and a frame in the contact sheet. A plain `<Image>` in the same composition
 * is a layer, not a keyframe — use it for a background plate or a title card.
 */
export function Panel({
  src,
  start,
  blocking,
  camera,
  className,
  alt = "",
  ...rest
}: PanelProps): React.ReactElement {
  const { duration: shotDuration, panels, cutinPanels, lane = "main" } = getRenderContext();
  // The window runs to the NEXT panel's start, which only the resolved panel list knows, and pairs
  // by position because by the real render the `src` is a served URL rather than an address. Absent
  // (the collecting pass that produces that list, or a raw render) the panel spans the shot. A panel
  // inside a `<Cutin>` keys the cutin's frame, so it pairs against that lane's list.
  const window = (lane === "cutin" ? cutinPanels : panels)?.[nextPanelIndex(lane)];

  // The address the panel names, while it still is one: `asset()` swaps it for a served file in
  // render mode, and only the discovery pass — the one that describes the definition — sees it.
  const assetPath = parsePlaceholder(src.src);
  let assetName = window?.assetName;
  if (isCollectingPanels()) {
    // A panel's art is any generatable image: a shot-local one (`animatic:shot.<id>.<name>`), a
    // shared timeline one (`animatic:timeline.<name>`), or a `reference:<name>` used as-is. Anything
    // else would mint a bogus part name.
    if (
      assetPath === null ||
      !(assetPath.startsWith("animatic:") || assetPath.startsWith("reference:"))
    ) {
      throw new KonteError(
        "ANIMATIC_INVALID",
        `<Panel> takes an animatic asset (declared with asset() inside a shot's build, or a shared ` +
          `timeline asset()) or a reference asset, but received "${assetPath ?? src.src}".`,
      );
    }
    // The part name is the asset's leaf. Timeline/shot paths are dot-separated (`…timeline.bg`,
    // `…shot.01.bg`); a reference path is colon-separated (`reference:bg`) — take whichever is last.
    const sep = Math.max(assetPath.lastIndexOf("."), assetPath.lastIndexOf(":"));
    assetName = assetPath.slice(sep + 1);
    recordPanel({
      lane,
      assetName,
      assetPath,
      start: start ?? null,
      ...(blocking !== undefined ? { blocking } : {}),
      ...(camera !== undefined ? { camera } : {}),
    });
  }

  return (
    <img
      src={src.src}
      alt={alt}
      className={className ? `konte-clip ${className}` : "konte-clip"}
      {...rest}
      data-konte-panel={assetName}
      data-start={window?.start ?? 0}
      data-duration={window?.duration ?? shotDuration}
    />
  );
}
