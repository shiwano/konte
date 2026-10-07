import { describe, expect, it } from "vitest";
import { HandoffSchema } from "../types/handoff.js";

describe("HandoffSchema", () => {
  it("defaults notes to an empty array", () => {
    expect(HandoffSchema.parse({ id: "h", stage: "video" })).toEqual({
      id: "h",
      stage: "video",
      notes: [],
    });
  });

  it("parses stage, summary, and notes", () => {
    const parsed = HandoffSchema.parse({
      id: "h",
      stage: "video",
      summary: "warmer grade",
      notes: [{ address: "video:shot.01", text: "dusk background" }],
    });
    expect(parsed.stage).toBe("video");
    expect(parsed.summary).toBe("warmer grade");
    expect(parsed.notes).toEqual([{ address: "video:shot.01", text: "dusk background" }]);
  });

  it("drops a note left blank", () => {
    const parsed = HandoffSchema.parse({
      id: "h",
      stage: "animatic",
      notes: [
        { address: "animatic:shot.52.first", text: "" },
        { address: "animatic:shot.52#composition", text: "  " },
        { address: "animatic:shot.26.first", text: "closer on the face" },
      ],
    });
    expect(parsed.notes).toEqual([
      { address: "animatic:shot.26.first", text: "closer on the face" },
    ]);
  });

  it("rejects a file missing its stage", () => {
    expect(() => HandoffSchema.parse({ id: "h", notes: [] })).toThrow();
  });

  it("rejects a note missing its address", () => {
    expect(() =>
      HandoffSchema.parse({ id: "h", stage: "video", notes: [{ text: "no address" }] }),
    ).toThrow();
  });

  it("accepts the reference stage with a bare reference address", () => {
    const parsed = HandoffSchema.parse({
      id: "h",
      stage: "reference",
      notes: [{ address: "reference:character", text: "redrew the bow" }],
    });
    expect(parsed.stage).toBe("reference");
    expect(parsed.notes).toEqual([{ address: "reference:character", text: "redrew the bow" }]);
  });
});
