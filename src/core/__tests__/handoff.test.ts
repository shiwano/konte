import { describe, expect, it } from "vitest";
import { HandoffSchema } from "../types/handoff.js";

describe("HandoffSchema", () => {
  it("defaults notes to an empty array", () => {
    expect(HandoffSchema.parse({ stage: "video" })).toEqual({
      stage: "video",
      notes: [],
    });
  });

  it("parses stage, summary, and notes", () => {
    const parsed = HandoffSchema.parse({
      stage: "video",
      summary: "warmer grade",
      notes: [{ address: "video:shot.01.motion", text: "dusk background" }],
    });
    expect(parsed.stage).toBe("video");
    expect(parsed.summary).toBe("warmer grade");
    expect(parsed.notes).toEqual([{ address: "video:shot.01.motion", text: "dusk background" }]);
  });

  it("rejects a file missing its stage", () => {
    expect(() => HandoffSchema.parse({ notes: [] })).toThrow();
  });

  it("rejects a note missing its address", () => {
    expect(() =>
      HandoffSchema.parse({ stage: "video", notes: [{ text: "no address" }] }),
    ).toThrow();
  });

  it("accepts the reference stage with a bare reference address", () => {
    const parsed = HandoffSchema.parse({
      stage: "reference",
      notes: [{ address: "reference:character", text: "redrew the bow" }],
    });
    expect(parsed.stage).toBe("reference");
    expect(parsed.notes).toEqual([{ address: "reference:character", text: "redrew the bow" }]);
  });
});
