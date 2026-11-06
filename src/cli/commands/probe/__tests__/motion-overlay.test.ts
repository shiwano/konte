import { describe, expect, it } from "vitest";
import type { StageDefinition } from "../../../../core/types/index.js";
import { overlayShotAt } from "../motion.js";

function stage(overlay: boolean): StageDefinition {
  return {
    stage: "video",
    format: { fps: 24 },
    shots: [
      { id: "01", duration: 2 },
      { id: "02", duration: 3 },
    ],
    ...(overlay ? { overlay: {} } : {}),
  } as unknown as StageDefinition;
}

describe("overlayShotAt", () => {
  it("names the shot under a timeline moment and the moment on its clock", () => {
    expect(overlayShotAt(stage(true), 0)).toEqual({ address: "video:shot.01#composition", at: 0 });
    expect(overlayShotAt(stage(true), 2)).toEqual({ address: "video:shot.02#composition", at: 0 });
    expect(overlayShotAt(stage(true), 3.5)).toEqual({
      address: "video:shot.02#composition",
      at: 1.5,
    });
  });

  it("keeps the timeline's last moment on the last shot", () => {
    expect(overlayShotAt(stage(true), 5)).toEqual({ address: "video:shot.02#composition", at: 3 });
  });

  it("refuses a moment past the timeline", () => {
    expect(() => overlayShotAt(stage(true), 5.5)).toThrow(/past the end of the video timeline/);
  });

  it("refuses a stage with no overlay", () => {
    expect(() => overlayShotAt(stage(false), 1)).toThrow(
      /has no overlay \(video:timeline#overlay\)/,
    );
  });
});
