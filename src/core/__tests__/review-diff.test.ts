import { describe, expect, it } from "vitest";
import { computeChangeInfo } from "../review-diff.js";
import type { ReviewRecord } from "../review-record.js";

function makeRecord(
  shots: Array<{ shotId: string; variants: Record<string, string> }>,
  notes?: ReviewRecord["notes"],
): ReviewRecord {
  return {
    mode: "video-preview",
    createdAt: "2026-01-01T00:00:00.000Z",
    context: { shots: shots.map((s) => ({ shotId: s.shotId, duration: 1, variants: s.variants })) },
    decisions: null,
    notes,
  };
}

describe("computeChangeInfo", () => {
  it("returns null when there is no previous review", () => {
    expect(computeChangeInfo(new Map([["01", { motion: "v-1" }]]), null)).toBeNull();
  });

  it("returns null when nothing changed", () => {
    const last = makeRecord([{ shotId: "01", variants: { motion: "v-1" } }]);
    expect(computeChangeInfo(new Map([["01", { motion: "v-1" }]]), last)).toBeNull();
  });

  it("detects a changed variant", () => {
    const last = makeRecord([{ shotId: "01", variants: { motion: "v-1" } }]);
    const result = computeChangeInfo(new Map([["01", { motion: "v-2" }]]), last);
    expect(result?.previousReview).toBe("2026-01-01T00:00:00.000Z");
    expect(result?.changedShots).toEqual([
      {
        shotId: "01",
        changedAssets: { motion: { previous: "v-1", current: "v-2" } },
        previousNotes: [],
      },
    ]);
  });

  it("ignores assets absent from the previous review", () => {
    const last = makeRecord([{ shotId: "01", variants: { motion: "v-1" } }]);
    const result = computeChangeInfo(new Map([["01", { motion: "v-1", extra: "v-9" }]]), last);
    expect(result).toBeNull();
  });

  it("carries the changed shot's previous notes", () => {
    const last = makeRecord(
      [{ shotId: "01", variants: { motion: "v-1" } }],
      [
        { time: 1, shotId: "01", text: "too fast" },
        { time: 2, shotId: "02", text: "other shot" },
      ],
    );
    const result = computeChangeInfo(new Map([["01", { motion: "v-2" }]]), last);
    expect(result?.changedShots[0]!.previousNotes).toEqual([
      { time: 1, shotId: "01", text: "too fast" },
    ]);
  });
});
