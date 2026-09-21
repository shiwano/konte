import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ReviewRecord, saveReviewRecord } from "../../../../core/review-record.js";
import { initWorkspace, run } from "../../../__tests__/harness.js";

let tmpDir: string;
let originalCwd: string;
let projectDir: string;

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    mode: "video-preview",
    createdAt: "2026-05-16T12:00:00.000Z",
    context: {
      shots: [{ shotId: "01", duration: 5, variants: { motion: "v-0001" } }],
    },
    decisions: { "01": "accepted" },
    ...overrides,
  };
}

async function seedReviews(records: ReviewRecord[]): Promise<void> {
  for (const r of records) {
    // force: a record with no feedback is still a session worth listing.
    await saveReviewRecord(projectDir, r, { force: true });
  }
}

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-review-list-"));
  process.chdir(tmpDir);
  projectDir = (await initWorkspace(path.join(tmpDir, "testproject"))).video;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("review record list", () => {
  it("says so plainly when a project has no reviews", async () => {
    const { stdout } = await run(["review", "record", "list"], projectDir);
    expect(stdout).toContain("No reviews found.");
  });

  it("lists a review with its stage, profile, and counts", async () => {
    await seedReviews([
      record({
        createdAt: "2026-05-16T12:00:00.000Z",
        // A video review's feedback rides on its timed notes.
        notes: [{ time: 1.5, shotId: "01", text: "too dark" }],
        handoffSummary: "first pass",
      }),
    ]);

    const { stdout } = await run(["review", "record", "list"], projectDir);

    const [header, row] = stdout.trim().split("\n");
    expect(header!.split(/\s+/)).toEqual([
      "FILE",
      "STAGE",
      "SHOTS",
      "ASSETS",
      "FB",
      "HANDOFF",
      "CREATED",
    ]);
    expect(row!.split(/\s+/).slice(0, 6)).toEqual([
      "video/20260516T120000000",
      "video",
      "1",
      "1",
      "1",
      "yes",
    ]);
  });

  it("sorts newest first and caps rows at --limit, with --all lifting the cap", async () => {
    await seedReviews([
      record({ createdAt: "2026-05-16T10:00:00.000Z" }),
      record({ createdAt: "2026-05-16T11:00:00.000Z" }),
      record({ createdAt: "2026-05-16T12:00:00.000Z" }),
    ]);

    const { stdout: text } = await run(["review", "record", "list", "--limit", "2"], projectDir);
    expect(text).toContain("video/20260516T120000000");
    expect(text).toContain("video/20260516T110000000");
    expect(text).not.toContain("video/20260516T100000000");
    expect(text).toContain("... and 1 more (use --all)");

    const { stdout: all } = await run(["review", "record", "list", "--all"], projectDir);
    expect(all).toContain("video/20260516T100000000");
  });

  it("lists reviews from every stage stream", async () => {
    await seedReviews([
      record({ createdAt: "2026-05-16T12:00:00.000Z" }),
      record({
        mode: "animatic-preview",
        createdAt: "2026-05-16T13:00:00.000Z",
        decisions: [],
      }),
    ]);

    const { stdout } = await run(["review", "record", "list"], projectDir);

    const stages = stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((row) => row.split(/\s+/)[1]);
    expect(stages).toEqual(["animatic", "video"]);
  });

  it("fails loudly on a non-numeric --limit", async () => {
    await expect(
      run(["review", "record", "list", "--limit", "0"], projectDir),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_OPTION"),
    });
  });
});
