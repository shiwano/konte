import type { VideoPreviewState } from "../types.js";
import { reelTakes, servedTakes } from "./reel-takes.js";
import { effectiveVariantsOf } from "./use-effective-variants.js";
import type { ReelMarks } from "./use-reel-decisions.js";

type ReelState = Pick<
  VideoPreviewState,
  "shots" | "audioAssets" | "timelineStem" | "overlay" | "thumbnail" | "compositionRefVariants"
>;

type ReelViews = {
  shots: Map<string, string>;
  stem: string | undefined;
  overlay: string | undefined;
  thumbnail: string | undefined;
};

// What each accept unit puts on screen under the same gallery picks: the takes and definitions its
// accept signs off. A materialized leaf's own variant is left out — the page renders it live.
function reelViews(state: ReelState, selectedVariants: Record<string, string>): ReelViews {
  const assets = [
    ...state.shots.flatMap((s) => s.assets),
    ...state.audioAssets,
    ...(state.thumbnail ? [state.thumbnail.cover, ...state.thumbnail.assets] : []),
  ];
  const { shown } = reelTakes(servedTakes(state), effectiveVariantsOf(assets, selectedVariants));
  const view = (...parts: unknown[]) => JSON.stringify(parts);

  return {
    shots: new Map(
      state.shots.map((s) => [
        s.shotId,
        view(
          s.verdictAddresses.map((a) => [a, shown(a)]),
          s.compositionDefinitionHash,
          s.stems.map((stem) => [stem.address, stem.definitionHash]),
          s.waivers.map((w) => [w.code, w.subject, w.reason]),
          s.showingStandIn,
        ),
      ]),
    ),
    stem: state.timelineStem
      ? view(
          state.timelineStem.definitionHash,
          state.timelineStem.verdictAddresses.map((a) => [a, shown(a)]),
        )
      : undefined,
    overlay: state.overlay
      ? view(
          state.overlay.definitionHash,
          state.overlay.offered,
          state.overlay.verdictAddresses.map((a) => [a, shown(a)]),
        )
      : undefined,
    thumbnail: state.thumbnail
      ? view(
          [state.thumbnail.cover, ...state.thumbnail.assets].map((a) => [
            a.address,
            shown(a.address),
          ]),
        )
      : undefined,
  };
}

/**
 * The marks that still describe what the page shows after `before` was replaced by `after` (a
 * reload): a unit whose takes or definition moved drops its mark, since the reviewer never saw what
 * the mark would now sign off. `movedShots` names the shots whose marks went.
 */
export function marksStillShown(
  marks: ReelMarks,
  before: ReelState,
  after: ReelState,
  selectedVariants: Record<string, string>,
): { marks: ReelMarks; movedShots: string[] } {
  const was = reelViews(before, selectedVariants);
  const now = reelViews(after, selectedVariants);
  const movedShots = Object.keys(marks.shots).filter(
    (id) => was.shots.get(id) === undefined || was.shots.get(id) !== now.shots.get(id),
  );
  const keep = <T>(mark: T | undefined, a: string | undefined, b: string | undefined) =>
    mark !== undefined && a !== undefined && a === b ? mark : undefined;
  const next: ReelMarks = {
    shots: Object.fromEntries(
      Object.entries(marks.shots).filter(([id]) => !movedShots.includes(id)),
    ),
    stem: keep(marks.stem, was.stem, now.stem),
    overlay: keep(marks.overlay, was.overlay, now.overlay),
    thumbnail: keep(marks.thumbnail, was.thumbnail, now.thumbnail),
  };
  const unchanged =
    movedShots.length === 0 &&
    next.stem === marks.stem &&
    next.overlay === marks.overlay &&
    next.thumbnail === marks.thumbnail;
  return { marks: unchanged ? marks : next, movedShots };
}
