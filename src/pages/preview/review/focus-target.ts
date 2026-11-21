import type { ReelPreviewState, ShotInfo } from "../../../core/types/review-state.js";

type OverlayInfo = NonNullable<ReelPreviewState["overlay"]>;
type ThumbnailInfo = NonNullable<ReelPreviewState["thumbnail"]>;

// What a reel's feedback panel and Accept key are pointed at. A sticky pick the state no longer
// offers — a reload that dropped the soundtracks, an overlay no longer offered — falls back to the
// shot at the playhead.
export type FocusTarget =
  | { kind: "shot"; shot: ShotInfo | undefined }
  | { kind: "soundtrack"; address: string; label: "Soundtrack" }
  | { kind: "overlay"; address: string; label: "Overlay"; overlay: OverlayInfo }
  | { kind: "thumbnail"; address: string; label: "Thumbnail"; thumbnail: ThumbnailInfo };

export type FocusPick = FocusTarget["kind"];

export function focusTargetOf(
  pick: FocusPick,
  state: Pick<ReelPreviewState, "timelineStem" | "overlay" | "thumbnail">,
  focusedShot: ShotInfo | undefined,
): FocusTarget {
  if (pick === "soundtrack" && state.timelineStem) {
    return { kind: "soundtrack", address: state.timelineStem.address, label: "Soundtrack" };
  }
  // The overlay is a target only while it is offered on its own: every shot accept stands and it
  // changed after them.
  if (pick === "overlay" && state.overlay?.offered) {
    return {
      kind: "overlay",
      address: state.overlay.address,
      label: "Overlay",
      overlay: state.overlay,
    };
  }
  if (pick === "thumbnail" && state.thumbnail) {
    return {
      kind: "thumbnail",
      address: state.thumbnail.target,
      label: "Thumbnail",
      thumbnail: state.thumbnail,
    };
  }
  return { kind: "shot", shot: focusedShot };
}
