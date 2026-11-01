import { shotAcceptable, type ShotAcceptabilityInput } from "../../../core/shot-acceptable.js";

/**
 * A unit one reel review signs off: a shot, the timeline stem the soundtrack beds mix into, or the
 * overlay once it is offered on its own.
 */
export type ReelUnit = { kind: "shot"; shotId: string } | { kind: "stem" } | { kind: "overlay" };

/**
 * Everything a reel review can sign off. A board whose shots are every one of them undeveloped
 * still offers its soundtrack.
 */
export function reelAcceptUnits(
  shots: ReadonlyArray<ShotAcceptabilityInput & { shotId: string }>,
  hasTimelineStem: boolean,
  overlayOffered = false,
): ReelUnit[] {
  return [
    ...shots.filter(shotAcceptable).map((s): ReelUnit => ({ kind: "shot", shotId: s.shotId })),
    ...(hasTimelineStem ? [{ kind: "stem" } as ReelUnit] : []),
    ...(overlayOffered ? [{ kind: "overlay" } as ReelUnit] : []),
  ];
}
