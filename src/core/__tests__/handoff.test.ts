import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLatestHandoff } from "../handoff.js";
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

describe("findLatestHandoff", () => {
  let reviewDir: string;

  beforeEach(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "konte-review-"));
  });

  afterEach(() => {
    fs.rmSync(reviewDir, { recursive: true, force: true });
  });

  const writeNotes = (id: string, stage: string, summary: string) => {
    const dir = path.join(reviewDir, stage, "handoffs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      `${JSON.stringify({ stage, summary, notes: [] })}\n`,
    );
  };

  it("returns null when the dir is empty or missing", async () => {
    expect(await findLatestHandoff(reviewDir, "video")).toBeNull();
    expect(await findLatestHandoff(path.join(reviewDir, "missing"), "video")).toBeNull();
  });

  it("picks the latest file matching the active stage", async () => {
    writeNotes("20260101T000000000", "video", "old notes");
    writeNotes("20260102T000000000", "video", "new notes");
    const found = await findLatestHandoff(reviewDir, "video");
    expect(found?.handoff.summary).toBe("new notes");
  });

  it("finds none once a review showed the newest", async () => {
    writeNotes("20260101T000000000", "video", "older notes");
    writeNotes("20260102T000000000", "video", "shown notes");
    const shown = async (id: string) => id === "20260102T000000000";
    expect(await findLatestHandoff(reviewDir, "video", shown)).toBeNull();
    writeNotes("20260103T000000000", "video", "pending notes");
    const found = await findLatestHandoff(reviewDir, "video", shown);
    expect(found?.handoff).toMatchObject({ id: "20260103T000000000", summary: "pending notes" });
  });

  it("skips a newer file for a different stage", async () => {
    writeNotes("20260101T000000000", "video", "video notes");
    writeNotes("20260103T000000000", "animatic", "animatic notes");
    const found = await findLatestHandoff(reviewDir, "video");
    expect(found?.handoff.summary).toBe("video notes");
  });
});
