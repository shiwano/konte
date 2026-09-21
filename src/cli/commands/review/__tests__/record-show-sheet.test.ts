import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { saveReviewRecord } from "../../../../core/review-record.js";
import { run } from "../../../__tests__/harness.js";
import { useReviewShowProject, projectDir, writeFrame, record } from "./record-show-fixtures.js";

useReviewShowProject();

describe("review record show --contact-sheet", () => {
  it("tiles every note's frame into one sheet, printed above the listing", async () => {
    await saveReviewRecord(
      projectDir,
      record([
        { id: "fb-second", time: 4, shotId: "01", text: "later" },
        { id: "fb-first", time: 1, shotId: "01", text: "earlier" },
      ]),
      { force: true },
    );
    await writeFrame("fb-second", 4);
    await writeFrame("fb-first", 1);

    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    expect(stdout).toContain("Contact sheet (2 frames):");
    const sheet = stdout.match(/^\s+(\S+contact-sheets\S+\.jpg)$/m)?.[1];
    expect(sheet).toBeDefined();
    expect((await fs.stat(sheet!)).size).toBeGreaterThan(0);
    // Above the listing, so a piped read keeps it.
    expect(stdout.indexOf("Contact sheet")).toBeLessThan(stdout.indexOf("Review: video-preview"));
    // The comment text stays in the listing — the sheet only says which comment each cell is.
    expect(stdout).toContain("[fb-first] 1.0s (shot.01 +1.0s) earlier");
  });

  it("skips a note whose frame cannot be rendered and says how many", async () => {
    await saveReviewRecord(
      projectDir,
      record([
        { id: "fb-kept", time: 1, shotId: "01", text: "kept" },
        // A shot the definition no longer has: nothing to compose, so nothing to render.
        { id: "fb-gone", time: 2, shotId: "99", text: "gone" },
      ]),
      { force: true },
    );
    await writeFrame("fb-kept", 1);

    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    expect(stdout).toContain("Contact sheet (1 frames):");
    expect(stdout).toContain("(1 frame(s) could not be rendered)");
    // The comment survives without one — the record is the evidence, the frame is the aid.
    expect(stdout).toContain("gone");
  });

  it("says so when no note can carry a frame, and still shows the record", async () => {
    await saveReviewRecord(
      projectDir,
      // A note on no shot of its own (a timeline-level one) is not a frame target at all.
      record([{ id: "fb-audio", time: 1, text: "voice is flat" }]),
      { force: true },
    );

    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    expect(stdout).toContain("Contact sheet: no note in this review can carry a frame.");
    expect(stdout).toContain("[fb-audio] 1.0s voice is flat");
  });

  it("labels the cells in timeline order, whatever order the notes were written in", async () => {
    await saveReviewRecord(
      projectDir,
      record([
        { id: "fb-second", time: 4, shotId: "01", text: "later" },
        { id: "fb-first", time: 1, shotId: "01", text: "earlier" },
      ]),
      { force: true },
    );
    await writeFrame("fb-second", 4);
    await writeFrame("fb-first", 1);

    // One cell per sheet, so each sheet's span names the single cell it holds.
    const { stdout } = await run(
      ["review", "record", "show", "--contact-sheet", "--max-cells", "1"],
      projectDir,
    );

    expect(stdout).toContain("Contact sheet (2 frames, 2 sheets):");
    const spans = stdout.match(/^\s+\S+\.jpg\s+(.+?) \.\. /gm)?.map((line) => line.trim());
    expect(spans).toEqual([
      expect.stringContaining("fb-first shot.01 +1.0s"),
      expect.stringContaining("fb-second shot.01 +4.0s"),
    ]);
  });
});
