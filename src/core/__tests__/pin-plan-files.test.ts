import { describe, expect, it } from "vitest";
import type { RenderPlan } from "../render-plan.js";
import { pinPlanFiles } from "../render-video.js";

describe("pinPlanFiles", () => {
  it("draws a job's pinned takes in the slots the plan resolved live", () => {
    const plan = {
      stage: "video",
      timelineResolvedFiles: { bed: "/live/bed.mp3" },
      shots: [
        { shotId: "01", resolvedFiles: { motion: "/live/01.mp4" } },
        { shotId: "02", resolvedFiles: { motion: "/live/02.mp4" } },
      ],
    } as unknown as RenderPlan;
    pinPlanFiles(
      plan,
      new Map([
        ["video:shot.01.motion", "/pinned/01.mp4"],
        ["video:timeline.bed", "/pinned/bed.mp3"],
        ["video:shot.02.other", "/pinned/other.png"],
        ["animatic:shot.02.first", "/pinned/first.png"],
      ]),
    );
    expect(plan.shots.map((s) => s.resolvedFiles)).toEqual([
      { motion: "/pinned/01.mp4" },
      { motion: "/live/02.mp4" },
    ]);
    expect(plan.timelineResolvedFiles).toEqual({ bed: "/pinned/bed.mp3" });
  });
});
