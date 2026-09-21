import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { saveReviewRecord } from "../../../../core/review-record.js";
import { run } from "../../../__tests__/harness.js";
import {
  useReviewShowProject,
  seedManyNotes,
  projectDir,
  dropShotTakes,
  useSubtitleFreeProject,
  writeFrame,
  record,
} from "./record-show-fixtures.js";

useReviewShowProject();

describe("review record show --contact-sheet", () => {
  it("pages a review with more notes than one sheet holds", async () => {
    const notes = await seedManyNotes(13);
    const cell = (i: number): string => `${notes[i]!.id} shot.01 +${notes[i]!.time!.toFixed(1)}s`;

    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    expect(stdout).toContain("Contact sheet (13 frames, 2 sheets):");
    // Every frame lands on exactly one sheet, and the run reads front to back across them.
    const sheets = [...stdout.matchAll(/^\s+(\S+\.jpg)\s+(.+) \.\. (.+)$/gm)];
    expect(sheets.map((m) => [m[2], m[3]])).toEqual([
      [cell(0), cell(11)],
      [cell(12), cell(12)],
    ]);
    for (const [, sheetPath] of sheets) {
      expect((await fs.stat(sheetPath!)).size).toBeGreaterThan(0);
    }
  });

  it("names each sheet's span so a paginated run says where to look", async () => {
    await seedManyNotes(13);

    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    expect(stdout).toContain("Contact sheet (13 frames, 2 sheets):");
    expect(stdout).toMatch(/p01\.jpg\s+fb-00 shot\.01 \+1\.0s \.\. fb-11 shot\.01 \+12\.0s/);
    expect(stdout).toMatch(/p02\.jpg\s+fb-12 shot\.01 \+13\.0s \.\. fb-12 shot\.01 \+13\.0s/);
  });

  it("collapses the same review onto one sheet when --max-cells allows it", async () => {
    await seedManyNotes(13);

    const { stdout } = await run(
      ["review", "record", "show", "--contact-sheet", "--max-cells", "16"],
      projectDir,
    );

    expect(stdout).toContain("Contact sheet (13 frames):");
  });

  async function sheetFiles(): Promise<string[]> {
    const dir = path.join(projectDir, ".konte", "cache", "contact-sheets");
    return (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jpg")).sort();
  }

  it("re-renders its own sheets in place when a note stops having a frame", async () => {
    await useSubtitleFreeProject();
    await saveReviewRecord(
      projectDir,
      record([
        { id: "fb-a", time: 1, shotId: "01", text: "one" },
        { id: "fb-b", time: 2, shotId: "02", text: "two" },
        { id: "fb-c", time: 3, shotId: "01", text: "three" },
      ]),
      { force: true },
    );
    await writeFrame("fb-a", 1);
    await writeFrame("fb-b", 2, "02");
    await writeFrame("fb-c", 3);
    await run(["review", "record", "show", "--contact-sheet"], projectDir);
    const first = await sheetFiles();
    expect(first).toHaveLength(1);

    await dropShotTakes("02");

    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    // Same key, so the sheet showing the dropped frame is overwritten, never left beside a new one.
    expect(await sheetFiles()).toEqual(first);
    expect(stdout).toContain("Contact sheet (2 frames):");
  });

  it("clears its sheets once no note has a frame left", async () => {
    await useSubtitleFreeProject();
    await seedManyNotes(2);
    await run(["review", "record", "show", "--contact-sheet"], projectDir);
    expect(await sheetFiles()).toHaveLength(1);

    await dropShotTakes("01");
    const { stdout } = await run(["review", "record", "show", "--contact-sheet"], projectDir);

    expect(await sheetFiles()).toEqual([]);
    expect(stdout).toContain("none of the 2 note frame(s) could be rendered");
  });

  it("renders no sheet without the flag", async () => {
    await saveReviewRecord(
      projectDir,
      record([{ id: "fb-a", time: 1, shotId: "01", text: "note" }]),
      { force: true },
    );
    await writeFrame("fb-a", 1);

    const { stdout } = await run(["review", "record", "show"], projectDir);

    expect(stdout).not.toContain("Contact sheet");
    expect(stdout).toContain("[fb-a] 1.0s (shot.01 +1.0s) note");
  });
});
