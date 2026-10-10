/**
 * One shot of a draft take: where the direction's clock puts its head, and the detected cut read
 * as that head — null on the take's first shot, and where no detection falls near it.
 */
export type DraftCutReading = { shotId: string; expected: number; detected: number | null };

// A take cuts up to half a second either side of the time its prompt states.
const CUT_TOLERANCE_SEC = 0.75;

/**
 * A draft take's scene detections laid beside the direction's cut times. Each cut takes the nearest
 * detection within tolerance that no earlier cut took; `unmatched` are the detections left over,
 * which a large move inside a shot produces.
 */
export function readDraftCuts(
  shots: readonly { id: string; duration: number }[],
  detections: readonly number[],
): { cuts: DraftCutReading[]; unmatched: number[] } {
  const taken = new Set<number>();
  const cuts: DraftCutReading[] = [];
  let expected = 0;
  shots.forEach((shot, i) => {
    let detected: number | null = null;
    if (i > 0) {
      let best = -1;
      detections.forEach((at, d) => {
        if (taken.has(d) || Math.abs(at - expected) > CUT_TOLERANCE_SEC) return;
        if (best < 0 || Math.abs(at - expected) < Math.abs(detections[best]! - expected)) best = d;
      });
      if (best >= 0) {
        taken.add(best);
        detected = detections[best]!;
      }
    }
    cuts.push({ shotId: shot.id, expected, detected });
    expected += shot.duration;
  });
  return { cuts, unmatched: detections.filter((_, d) => !taken.has(d)) };
}
