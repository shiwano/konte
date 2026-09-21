import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTimestamp,
  countReviewAssets,
  countReviewFeedback,
  findReviewRecordSince,
  formatReviewRecord,
  hasFeedback,
  loadAllReviewRecords,
  loadLatestReviewRecord,
  loadReviewRecordFile,
  reviewNoteFrameTargets,
  reviewStage,
  saveReviewRecord,
  toReviewFileId,
  type ReviewRecord,
} from "../review-record.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-review-record-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildTimestamp", () => {
  it("returns a string in YYYYMMDDTHHmmssSSS format", () => {
    const ts = buildTimestamp();
    expect(ts).toMatch(/^\d{8}T\d{9}$/);
  });
});

describe("hasFeedback", () => {
  it("returns false for video-preview with decisions but no notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted", "02": "none" },
    };
    expect(hasFeedback(record)).toBe(false);
  });

  it("returns true for video-preview with notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
      notes: [{ time: 5, text: "Fix this" }],
    };
    expect(hasFeedback(record)).toBe(true);
  });

  it("returns false for video-preview with only accepted decisions and no notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };
    expect(hasFeedback(record)).toBe(false);
  });

  it("returns true for reference-preview with decisions array", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        { address: "reference:bg", variantId: "v-Xk8mP2qR", status: "accepted", feedback: [] },
      ],
    };
    expect(hasFeedback(record)).toBe(true);
  });

  it("returns false for reference-preview with empty decisions array", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    expect(hasFeedback(record)).toBe(false);
  });

  it("returns false for reference-preview with null decisions", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: null,
    };
    expect(hasFeedback(record)).toBe(false);
  });

  // A direction accept is variant-less, so it never lands in `decisions` — a review that only
  // accepts must still count as one, or the record (and the watcher's notification) is dropped.
  it("returns true for direction-preview accepting a section with no feedback", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { shots: "accepted" },
    };
    expect(hasFeedback(record)).toBe(true);
  });

  it("returns true for direction-preview revoking a section's acceptance", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { shots: "none" },
    };
    expect(hasFeedback(record)).toBe(true);
  });

  it("returns false for direction-preview that touched neither the acceptance nor feedback", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    expect(hasFeedback(record)).toBe(false);
  });
});

describe("saveReviewRecord", () => {
  it("saves a record with feedback to review/<stage>/records/", async () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 5, variants: { motion: "v-xxx" } }] },
      decisions: { "01": "none" },
      notes: [{ time: 5, text: "Fix this" }],
    };

    const filePath = await saveReviewRecord(tmpDir, record);
    expect(filePath).not.toBeNull();
    expect(filePath).toContain(path.join("review", "video", "records"));
    expect(filePath).toContain("20260516T120000000.json");

    const content = await fs.readFile(filePath!, "utf-8");
    const saved = JSON.parse(content);
    expect(saved.mode).toBe("video-preview");
    expect(saved.decisions).toEqual({ "01": "none" });
  });

  it("nests records under <stage> and derives the stage from the mode", async () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
      notes: [{ time: 0, shotId: "01", text: "hold on the last frame" }],
    };

    const filePath = await saveReviewRecord(tmpDir, record);
    expect(filePath).toBe(
      path.join(tmpDir, "review", "animatic", "records", "20260516T120000000.json"),
    );
  });

  it("returns null when record has no feedback", async () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };

    const filePath = await saveReviewRecord(tmpDir, record);
    expect(filePath).toBeNull();
  });

  it("saves an accept-only record when force is set", async () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };

    const filePath = await saveReviewRecord(tmpDir, record, { force: true });
    expect(filePath).not.toBeNull();

    const saved = JSON.parse(await fs.readFile(filePath!, "utf-8"));
    expect(saved.decisions).toEqual({ "01": "accepted" });
  });

  it("saves a direction record that only accepts a section", async () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [], directionParts: { "direction:brief.logline": "h1" } },
      decisions: [],
      directionDecisions: { shots: "accepted" },
    };

    const filePath = await saveReviewRecord(tmpDir, record);
    expect(filePath).toBe(
      path.join(tmpDir, "review", "direction", "records", "20260516T120000000.json"),
    );

    const saved = JSON.parse(await fs.readFile(filePath!, "utf-8"));
    expect(saved.directionDecisions).toEqual({ shots: "accepted" });
  });
});

describe("findReviewRecordSince", () => {
  async function writeRecord(stage: "video" | "animatic", createdAt: string): Promise<string> {
    const record: ReviewRecord =
      stage === "video"
        ? {
            mode: "video-preview",
            createdAt,
            context: { shots: [] },
            decisions: { "01": "accepted" },
          }
        : { mode: "reference-preview", createdAt, context: { shots: [] }, decisions: [] };
    const filePath = await saveReviewRecord(tmpDir, record, { force: true });
    if (!filePath) throw new Error("record not saved");
    return filePath;
  }

  it("names a record written during the session", async () => {
    const filePath = await writeRecord("video", "2026-05-16T12:00:00.000Z");

    expect(await findReviewRecordSince(tmpDir, "video", "2026-05-16T11:59:00.000Z")).toBe(filePath);
  });

  it("ignores one that predates the session", async () => {
    await writeRecord("video", "2026-05-16T12:00:00.000Z");

    expect(await findReviewRecordSince(tmpDir, "video", "2026-05-16T12:00:01.000Z")).toBeNull();
  });

  it("reads one stage's stream only", async () => {
    await writeRecord("animatic", "2026-05-16T12:00:00.000Z");

    expect(await findReviewRecordSince(tmpDir, "video", "2026-05-16T11:59:00.000Z")).toBeNull();
  });

  it("returns null when the stream has no records", async () => {
    expect(await findReviewRecordSince(tmpDir, "video", "2026-05-16T11:59:00.000Z")).toBeNull();
  });

  it("takes the newest of several", async () => {
    await writeRecord("video", "2026-05-16T12:00:00.000Z");
    const newest = await writeRecord("video", "2026-05-16T12:30:00.000Z");

    expect(await findReviewRecordSince(tmpDir, "video", "2026-05-16T11:59:00.000Z")).toBe(newest);
  });
});

describe("formatReviewRecord", () => {
  it("reports each accepted direction section under Accepted", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { shots: "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted:");
    expect(out).toContain("  direction:shots");
    expect(out).not.toContain("Accepted: none submitted");
  });

  // A leaf's skip reason carries the inputs that held it back and the command that clears them, so
  // the block has to keep them under their address instead of running them into one line.
  it("indents a skip reason's own detail lines under its address", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      skippedDecisions: [
        {
          address: "video:shot.01#composition",
          reason: [
            "the composition could not be materialized; these inputs have no take a spend may use:",
            "animatic:shot.01.first (input-stale: reference:hero)",
            "konte generate animatic",
          ].join("\n"),
        },
      ],
    };

    expect(formatReviewRecord(record)).toContain(
      [
        "Not settled:",
        "  video:shot.01#composition — the composition could not be materialized; these inputs have no take a spend may use:",
        "    animatic:shot.01.first (input-stale: reference:hero)",
        "    konte generate animatic",
      ].join("\n"),
    );
  });

  it("reports a direction section by its code key, with no UI-label parenthetical", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { characters: "accepted", brief: "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("  direction:characters");
    expect(out).toContain("  direction:brief");
    expect(out).not.toContain("(Characters)");
    expect(out).not.toContain("direction:characters (");
  });

  it("reports an un-accepted direction section under Unaccepted", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { shots: "none" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: none submitted");
    expect(out).toContain("Unaccepted:");
    expect(out).toContain("  direction:shots");
  });

  it("reports how many parts the direction gate still blocked at submit", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { brief: "accepted" },
      directionGate: { open: false, blocking: 3, total: 12 },
    };

    expect(formatReviewRecord(record)).toContain(
      "Gate at submit: 3 of 12 parts still needed review",
    );
  });

  it("reports an open direction gate", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { brief: "accepted" },
      directionGate: { open: true, blocking: 0, total: 12 },
    };

    expect(formatReviewRecord(record)).toContain(
      "Gate at submit: open — the direction no longer blocks generation",
    );
  });

  it("omits the gate line for a stage that has none", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };

    expect(formatReviewRecord(record)).not.toContain("Gate at submit:");
  });
});

describe("loadLatestReviewRecord", () => {
  it("loads the latest record matching the mode", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const older: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    const newer: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "02": "none" },
    };
    const other: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-17T15:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };

    await fs.writeFile(path.join(dir, "20260515T100000000.json"), JSON.stringify(older));
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(newer));
    await fs.writeFile(path.join(dir, "20260517T150000000.json"), JSON.stringify(other));

    const result = await loadLatestReviewRecord(tmpDir, "video-preview");
    expect(result).not.toBeNull();
    expect(result!.createdAt).toBe("2026-05-16T12:00:00.000Z");
    expect(result!.decisions).toEqual({ "02": "none" });
  });

  it("returns null when no reviews directory exists", async () => {
    const result = await loadLatestReviewRecord(tmpDir, "video-preview");
    expect(result).toBeNull();
  });

  it("returns null when no matching mode found", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(record));

    const result = await loadLatestReviewRecord(tmpDir, "video-preview");
    expect(result).toBeNull();
  });

  it("returns the most recent record regardless of mode when mode omitted", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const older: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    const newer: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-17T15:00:00.000Z",
      context: { shots: [] },
      decisions: [
        { address: "reference:bg", variantId: "v-Xk8mP2qR", status: "accepted", feedback: [] },
      ],
    };

    await fs.writeFile(path.join(dir, "20260515T100000000.json"), JSON.stringify(older));
    await fs.writeFile(path.join(dir, "20260517T150000000.json"), JSON.stringify(newer));

    const result = await loadLatestReviewRecord(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.createdAt).toBe("2026-05-17T15:00:00.000Z");
    expect(result!.mode).toBe("reference-preview");
  });
});

describe("countReviewFeedback", () => {
  it("sums feedback across an entry-array stage's decisions", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "a",
          feedback: [
            { id: "f1", annotation: null, text: "x", stale: false },
            { id: "f2", annotation: null, text: "y", stale: false },
          ],
        },
        { address: "b", feedback: [{ id: "f3", annotation: null, text: "z", stale: false }] },
      ],
    };
    expect(countReviewFeedback(record)).toBe(3);
  });

  it("skips carried-over stale feedback so the count matches what `record show` prints", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "reference:cat",
          feedback: [
            { id: "f1", annotation: null, text: "carried over", stale: true },
            { id: "f2", annotation: null, text: "written now", stale: true, added: true },
            { id: "f3", annotation: null, text: "live", stale: false },
          ],
        },
      ],
    };
    expect(countReviewFeedback(record)).toBe(2);
  });

  it("counts notes for video-preview", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
      notes: [
        { time: 1, text: "a" },
        { time: 2, text: "b" },
      ],
    };
    expect(countReviewFeedback(record)).toBe(2);
  });

  it("returns 0 for video-preview without notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };
    expect(countReviewFeedback(record)).toBe(0);
  });

  it("returns 0 for animatic-preview with null decisions", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: null,
    };
    expect(countReviewFeedback(record)).toBe(0);
  });
});

describe("countReviewAssets", () => {
  it("sums variant counts across shots", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          { shotId: "01", duration: 3, variants: { key: "v-a", wide: "v-b" } },
          { shotId: "02", duration: 2, variants: { key: "v-c" } },
        ],
      },
      decisions: [],
    };
    expect(countReviewAssets(record)).toBe(3);
  });

  it("returns 0 when there are no shots", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: {},
    };
    expect(countReviewAssets(record)).toBe(0);
  });
});

describe("reviewStage", () => {
  it("returns the explicit stage when present", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: {},
    };
    expect(reviewStage(record)).toBe("video");
  });

  it("falls back to animatic for animatic-preview without a stage", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    expect(reviewStage(record)).toBe("animatic");
  });

  it("falls back to video for video-preview without a stage", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: {},
    };
    expect(reviewStage(record)).toBe("video");
  });
});

describe("toReviewFileId", () => {
  it("renders an ISO createdAt as a compact UTC file id", () => {
    expect(toReviewFileId("2026-05-16T12:05:00.123Z")).toBe("20260516T120500123");
  });

  it("is lexically sortable in chronological order", () => {
    const ids = ["2026-05-17T15:00:00.000Z", "2026-05-15T10:00:00.000Z"].map(toReviewFileId);
    expect([...ids].sort()).toEqual(["20260515T100000000", "20260517T150000000"]);
  });
});

describe("loadAllReviewRecords", () => {
  it("returns all records newest first with the file id", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const older: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    const newer: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-17T15:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };

    await fs.writeFile(path.join(dir, "20260515T100000000.json"), JSON.stringify(older));
    await fs.writeFile(path.join(dir, "20260517T150000000.json"), JSON.stringify(newer));

    const result = await loadAllReviewRecords(tmpDir);
    expect(result.map((r) => r.file)).toEqual(["20260517T150000000", "20260515T100000000"]);
    expect(result[0]!.record.mode).toBe("animatic-preview");
  });

  it("ignores non-json and unparseable files", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const valid: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(valid));
    await fs.writeFile(path.join(dir, "notes.txt"), "ignored");
    await fs.writeFile(path.join(dir, "20260516T130000000.json"), "{ broken");

    const result = await loadAllReviewRecords(tmpDir);
    expect(result.map((r) => r.file)).toEqual(["20260516T120000000"]);
  });

  it("skips schema-invalid records instead of crashing a consumer", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const valid: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [{ address: "animatic:shot.01.first", feedback: [] }],
    };
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(valid));
    // A decision entry missing its required `feedback` array — the kind of malformed
    // record that used to reach `d.feedback.length` as an untyped TypeError.
    await fs.writeFile(
      path.join(dir, "20260516T130000000.json"),
      JSON.stringify({
        mode: "animatic-preview",
        createdAt: "2026-05-16T13:00:00.000Z",
        context: { shots: [] },
        decisions: [{ address: "animatic:shot.01.first" }],
      }),
    );

    const result = await loadAllReviewRecords(tmpDir);
    expect(result.map((r) => r.file)).toEqual(["20260516T120000000"]);
  });

  it("returns an empty array when no reviews directory exists", async () => {
    expect(await loadAllReviewRecords(tmpDir)).toEqual([]);
  });

  it("ids nested records by their stream-qualified path and round-trips through loadReviewRecordFile", async () => {
    const animatic: ReviewRecord = {
      mode: "animatic-preview",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
      notes: [{ time: 0, shotId: "01", text: "hold the last frame" }],
    };
    const video: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-17T15:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
      notes: [{ time: 1, text: "x" }],
    };
    await saveReviewRecord(tmpDir, animatic);
    await saveReviewRecord(tmpDir, video);

    const all = await loadAllReviewRecords(tmpDir);
    expect(all.map((r) => r.file)).toEqual([
      "video/20260517T150000000",
      "animatic/20260515T100000000",
    ]);

    const byId = await loadReviewRecordFile(tmpDir, "video/20260517T150000000");
    expect(byId.createdAt).toBe("2026-05-17T15:00:00.000Z");

    // A bare timestamp still resolves under the nested layout.
    const byTimestamp = await loadReviewRecordFile(tmpDir, "20260515T100000000");
    expect(byTimestamp.createdAt).toBe("2026-05-15T10:00:00.000Z");

    // The videoRoot-relative path the MCP review event carries.
    const byRelPath = await loadReviewRecordFile(
      tmpDir,
      "review/video/records/20260517T150000000.json",
    );
    expect(byRelPath.createdAt).toBe("2026-05-17T15:00:00.000Z");
  });

  it("resolves a path rooted at the cwd or carrying leading segments", async () => {
    const videoRoot = path.join(tmpDir, "videos", "cat-crew");
    await fs.mkdir(videoRoot, { recursive: true });
    await saveReviewRecord(videoRoot, {
      mode: "direction-preview",
      createdAt: "2026-05-18T09:00:00.000Z",
      context: { shots: [] },
      decisions: [{ address: "direction:brief.logline", feedback: [] }],
    });

    const rel = "videos/cat-crew/review/direction/records/20260518T090000000.json";

    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      expect((await loadReviewRecordFile(videoRoot, rel)).createdAt).toBe(
        "2026-05-18T09:00:00.000Z",
      );
    } finally {
      process.chdir(cwd);
    }

    // Same path from a cwd it is not relative to: the basename still finds it.
    expect((await loadReviewRecordFile(videoRoot, rel)).createdAt).toBe("2026-05-18T09:00:00.000Z");
  });

  it("refuses a path that resolves outside the video", async () => {
    const outside = path.join(tmpDir, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({
        mode: "video-preview",
        createdAt: "2026-05-19T09:00:00.000Z",
        context: { shots: [] },
        decisions: {},
      }),
    );
    const videoRoot = path.join(tmpDir, "videos", "cat-crew");
    await fs.mkdir(videoRoot, { recursive: true });

    await expect(loadReviewRecordFile(videoRoot, outside)).rejects.toThrow(/not found/);
    await expect(loadReviewRecordFile(videoRoot, "../../outside.json")).rejects.toThrow(
      /not found/,
    );
  });

  it("refuses a record symlinked out of the video", async () => {
    const outside = path.join(tmpDir, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({
        mode: "video-preview",
        createdAt: "2026-05-20T09:00:00.000Z",
        context: { shots: [] },
        decisions: {},
      }),
    );
    const videoRoot = path.join(tmpDir, "videos", "cat-crew");
    const records = path.join(videoRoot, "review", "video", "records");
    await fs.mkdir(records, { recursive: true });
    await fs.symlink(outside, path.join(records, "20260520T090000000.json"));

    await expect(loadReviewRecordFile(videoRoot, "20260520T090000000")).rejects.toThrow(
      /not found/,
    );
  });
});

describe("formatReviewRecord", () => {
  // An animatic review is a reel review, so its decisions are per shot and expand into the
  // addresses each shot signed off — the same vocabulary the video's record uses.
  it("renders animatic-preview decisions per shot, under the animatic stage", () => {
    const record: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "03", duration: 4, variants: { first: "v-Q4nT8aLp" } }] },
      decisions: { "03": "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Review: animatic-preview (animatic) 2026-05-16T12:00:00.000Z");
    expect(out).toContain("Accepted:");
    expect(out).toContain("animatic:shot.03.first (v-Q4nT8aLp)");
  });

  it("omits carried-over stale feedback, keeping one that went stale within its own submit", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "reference:cat",
          variantId: "v-xm65f1Aa",
          status: "accepted",
          feedback: [
            { id: "fb-Qv1pNz65", annotation: null, text: "carried over", stale: true },
            { id: "fb-27aTaC02", annotation: null, text: "written now", stale: true, added: true },
          ],
        },
        {
          address: "reference:dog",
          feedback: [{ id: "fb-8kLmR3wq", annotation: null, text: "all stale here", stale: true }],
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).not.toContain("carried over");
    expect(out).toContain("[fb-27aTaC02] written now [added] [stale]");
    // The address whose only comment was carried over drops out of the section entirely.
    expect(out).not.toContain("reference:dog");
  });

  it("names the take each comment was written against", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "reference:cat",
          feedback: [
            {
              id: "fb-Qv1pNz65",
              annotation: null,
              text: "ears too long",
              displayedVariants: { "reference:cat": "v-xm65f1Aa" },
              stale: false,
            },
          ],
        },
      ],
    };

    // The comment stands on the address holding the take, so the take is named bare.
    expect(formatReviewRecord(record)).toContain("[fb-Qv1pNz65] ears too long [saw: v-xm65f1Aa]");
  });

  it("names every take under a note whose subject spans more than its own address", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "02", duration: 3, variants: { motion: "v-Q4nT8aLp" } }] },
      decisions: {},
      notes: [
        {
          id: "fb-8kLmR3wq",
          time: 1.5,
          shotId: "02",
          address: "video:shot.02#composition",
          text: "too dark",
          displayedVariants: {
            "video:shot.02.motion": "v-Q4nT8aLp",
            "animatic:shot.02.first": "v-UI5zkvU6",
          },
        },
      ],
    };

    expect(formatReviewRecord(record)).toContain(
      "too dark [saw: animatic:shot.02.first=v-UI5zkvU6, video:shot.02.motion=v-Q4nT8aLp]",
    );
  });

  it("renders a comment with no snapshotted take unchanged", () => {
    const record: ReviewRecord = {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [
        {
          address: "direction:brief.logline",
          feedback: [{ id: "fb-Qv1pNz65", annotation: null, text: "weak hook", stale: false }],
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("[fb-Qv1pNz65] weak hook");
    expect(out).not.toContain("saw:");
  });

  it("renders video-preview accepts with variant IDs and un-accepts under Unaccepted", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          { shotId: "01", duration: 3, variants: { motion: "v-UI5zkvU6" } },
          { shotId: "02", duration: 3, variants: { motion: "v-Q4nT8aLp" } },
        ],
      },
      decisions: { "01": "accepted", "02": "none" },
      notes: [
        {
          time: 5.2,
          shotId: "02",
          address: "video:shot.02#composition",
          x: 0.5,
          y: 0.5,
          text: "too dark",
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted:");
    expect(out).toContain("video:shot.01.motion (v-UI5zkvU6)");
    // An explicit un-accept ("none") is its own outcome, listed under Unaccepted by bare address.
    expect(out).toContain("Unaccepted:");
    expect(out).toContain("  video:shot.02.motion");
    // Feedback is grouped under the target address, not the old flat `Notes:` block.
    expect(out).toContain("Feedback:");
    expect(out).toContain("  video:shot.02#composition");
    expect(out).toContain("    5.2s (shot.02 +2.2s) (pin: 0.50, 0.50) too dark");
    expect(out).not.toContain("Notes:");
    expect(out).not.toContain("File:");
  });

  it("reports a feedback-only review with no decisions as none submitted", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "03", duration: 3, variants: { motion: "v-UI5zkvU6" } }],
      },
      decisions: {},
      notes: [
        {
          time: 8.2,
          shotId: "03",
          address: "video:shot.03#composition",
          text: "全体的に文字が小さい",
        },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted: none submitted");
    expect(out).not.toContain("Unaccepted:");
    expect(out).toContain("Feedback:");
    expect(out).toContain("  video:shot.03#composition");
    expect(out).toContain("    8.2s (shot.03 +8.2s) 全体的に文字が小さい");
  });

  it("derives a note's feedback address from its shotId when no address is stored", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 3, variants: { motion: "v-UI5zkvU6" } }] },
      decisions: {},
      notes: [{ time: 1.0, shotId: "01", text: "legacy note" }],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("  video:shot.01");
    expect(out).toContain("    1.0s (shot.01 +1.0s) legacy note");
  });

  it("renders timeline video assets, accepted only when every shot is accepted", () => {
    const base = {
      mode: "video-preview" as const,
      stage: "video" as const,
      createdAt: "2026-05-16T12:00:00.000Z",
    };
    const context = {
      shots: [{ shotId: "01", duration: 3, variants: { motion: "v-aaaaaaaa" } }],
      timeline: { bgm: "v-bbbbbbbb" },
    };

    const accepted = formatReviewRecord({ ...base, context, decisions: { "01": "accepted" } });
    expect(accepted).toContain("video:timeline.bgm (v-bbbbbbbb)");

    // A shot that isn't explicitly accepted means submit never accepts the timeline
    // asset, so it must not be listed as accepted (the shot itself surfaces under Unaccepted).
    const notOk = formatReviewRecord({ ...base, context, decisions: { "01": "none" } });
    expect(notOk).not.toContain("video:timeline.bgm");
    expect(notOk).toContain("Unaccepted:");

    // An undecided shot is likewise not "accepted", so timeline stays out of the accept list.
    const undecided = formatReviewRecord({ ...base, context, decisions: {} });
    expect(undecided).not.toContain("video:timeline.bgm");
  });

  it("folds cascade accepts into Accepted, showing via only across a stage boundary", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 3, variants: { motion: "v-aaaaaaaa" } }] },
      decisions: { "01": "accepted" },
      timelineStemDecision: "accepted",
      cascadeAccepted: [
        // Same stage (video → video): the address already says whose it is, so no `via`.
        { address: "video:timeline.bgm", via: "video:timeline#stem" },
        // Cross stage (reference locked by a video review): `via` names the driver.
        { address: "reference:bgm", via: "video:timeline#stem" },
        // Already an accept line — must not be repeated.
        { address: "video:shot.01.motion", via: "video:shot.01#stem" },
      ],
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Accepted:");
    expect(out).toContain("video:timeline#stem");
    expect(out).toContain("reference:bgm (via video:timeline#stem)");
    // Within-stage cascade drops the redundant provenance.
    expect(out).toContain("  video:timeline.bgm\n");
    expect(out).not.toContain("video:timeline.bgm (via");
    // The motion accept appears once (its own line), never duplicated by the cascade entry.
    expect(out.match(/video:shot\.01\.motion/g)).toHaveLength(1);
  });

  it("has no cascade lines when nothing was signed off in context", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 3, variants: { motion: "v-aaaaaaaa" } }] },
      decisions: { "01": "accepted" },
    };
    const out = formatReviewRecord(record);
    expect(out).toContain("video:shot.01.motion (v-aaaaaaaa)");
    expect(out).not.toContain("(via ");
  });

  it("counts timeline assets toward the review asset total", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [{ shotId: "01", duration: 3, variants: { motion: "v-aaaaaaaa" } }],
        timeline: { bgm: "v-bbbbbbbb" },
      },
      decisions: { "01": "accepted" },
    };
    expect(countReviewAssets(record)).toBe(2);
  });

  it("prints the File line when a filePath is passed", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 3, variants: { motion: "v-UI5zkvU6" } }] },
      decisions: { "01": "none" },
    };

    const out = formatReviewRecord(record, {
      filePath: "review/video/records/20260516T120000000.json",
    });
    expect(out).toContain("File: review/video/records/20260516T120000000.json");
    // The un-accept comes from the record itself, listed by bare address.
    expect(out).toContain("Unaccepted:");
    expect(out).toContain("  video:shot.01.motion");
  });

  it("names the composition and stem accepted as a side effect of the shot accept", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "05", duration: 3, variants: { motion: "v-aaaaaaaa" } }] },
      decisions: { "05": "accepted" },
      cascadeAccepted: [
        { address: "video:shot.05#composition", via: "video:shot.05" },
        { address: "video:shot.05#stem", via: "video:shot.05" },
        { address: "video:se-hit", via: "video:shot.05#stem" },
      ],
    };

    const out = formatReviewRecord(record);
    // The composition/stem aren't reviewable per-shot assets, but they surface under Accepted so the
    // recap names everything the shot accept signed off. All within `video`, so no `via` is shown.
    expect(out).toContain("Accepted:");
    expect(out).toContain("  video:shot.05.motion (v-aaaaaaaa)");
    expect(out).toContain("  video:shot.05#composition");
    expect(out).toContain("  video:shot.05#stem");
    expect(out).toContain("  video:se-hit");
    expect(out).not.toContain("(via ");
  });

  it("says why a shot that generates nothing of its own carries no variant id", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: {
        shots: [
          { shotId: "01", duration: 3, variants: {} },
          { shotId: "10", duration: 3, variants: { motion: "v-kVNK2f5s" } },
        ],
        contentHashes: { "video:shot.01#composition": "h-01" },
      },
      decisions: { "01": "accepted", "10": "accepted" },
    };

    // Beside a sibling that names its variant, a bare `video:shot.01` reads as a half-recorded
    // accept — the reason keeps it from being mistaken for one.
    const out = formatReviewRecord(record);
    expect(out).toContain("  video:shot.10.motion (v-kVNK2f5s)");
    expect(out).toContain("  video:shot.01 (composition only)");
  });

  it("reports an undeveloped shot, which has no composition either, as generating nothing", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "04", duration: 3, variants: {} }] },
      decisions: { "04": "none" },
    };

    expect(formatReviewRecord(record)).toContain("  video:shot.04 (no generated assets)");
  });

  it("gates the AI-authored handoff behind showHandoff", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 3, variants: { motion: "v-aaaaaaaa" } }] },
      decisions: { "01": "accepted" },
      handoffSummary: "remaining shots wrapped up",
      handoffNotes: [{ address: "video:shot.01.motion", text: "confirm the pacing" }],
    };

    // A bare recap is the human's decisions, not the agent's own note echoed back.
    const bare = formatReviewRecord(record);
    expect(bare).not.toContain("Handoff:");
    expect(bare).not.toContain("remaining shots wrapped up");

    const verbose = formatReviewRecord(record, { showHandoff: true });
    expect(verbose).toContain("Handoff:");
    expect(verbose).toContain("  summary: remaining shots wrapped up");
    expect(verbose).toContain("  video:shot.01.motion: confirm the pacing");
  });

  it("derives the stage for the header when the record omits it", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };

    const out = formatReviewRecord(record);
    expect(out).toContain("Review: video-preview (video) 2026-05-16T12:00:00.000Z");
  });

  it("names the frame the caller resolved for a note, and nothing for one it did not", () => {
    const image = ".konte/cache/thumbnails/video/shot.01/fb-1/abc123/at-00001000ms.jpg";
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: {},
      notes: [
        { id: "fb-1", time: 1, shotId: "01", text: "here" },
        { id: "fb-2", time: 2, shotId: "01", text: "no frame for this one" },
      ],
    };

    const out = formatReviewRecord(record, { noteFrames: new Map([["fb-1", image]]) });
    expect(out).toContain(`[image: ${image}]`);
    expect(out).toContain("[fb-2] 2.0s no frame for this one");
    expect(out.match(/\[image: /g)).toHaveLength(1);
  });
});

describe("formatReviewRecord note ids", () => {
  it("names the comment a note was stored as, so the listing pairs with a sheet cell", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", duration: 3, variants: {} }] },
      decisions: {},
      notes: [{ id: "fb-24G1HFL3", time: 1.5, shotId: "01", text: "face is wrong" }],
    };

    expect(formatReviewRecord(record)).toContain(
      "    [fb-24G1HFL3] 1.5s (shot.01 +1.5s) face is wrong",
    );
  });
});

describe("reviewNoteFrameTargets", () => {
  const record: ReviewRecord = {
    mode: "video-preview",
    stage: "video",
    createdAt: "2026-05-16T12:00:00.000Z",
    context: {
      shots: [
        { shotId: "01", duration: 10, variants: {} },
        { shotId: "02", duration: 10, variants: {} },
      ],
    },
    decisions: {},
    notes: [
      { id: "fb-late", time: 12.5, shotId: "02", text: "second" },
      { id: "fb-early", time: 3.5, shotId: "01", text: "first" },
    ],
  };

  it("returns one target per note, shot-local and in timeline order", () => {
    expect(reviewNoteFrameTargets(record)).toEqual([
      {
        id: "fb-early",
        address: "video:shot.01",
        shotId: "01",
        localTime: 3.5,
        annotation: null,
        label: "fb-early shot.01 +3.5s",
      },
      {
        id: "fb-late",
        address: "video:shot.02",
        shotId: "02",
        localTime: 2.5,
        annotation: null,
        label: "fb-late shot.02 +2.5s",
      },
    ]);
  });

  it("carries a pinned note's reticle, so the rendered frame is marked", () => {
    const pinned: ReviewRecord = {
      ...record,
      notes: [{ id: "fb-pin", time: 1, shotId: "01", x: 0.25, y: 0.75, text: "here" }],
    };
    expect(reviewNoteFrameTargets(pinned)[0]!.annotation).toEqual({
      kind: "pin",
      x: 0.25,
      y: 0.75,
    });
  });

  it("skips a note with no shot of its own, and one from before ids were stored", () => {
    const skipped: ReviewRecord = {
      ...record,
      notes: [
        { id: "fb-bed", time: 6.25, text: "bgm too loud" },
        { time: 2, shotId: "01", text: "no id" },
      ],
    };
    expect(reviewNoteFrameTargets(skipped)).toEqual([]);
  });

  it("returns nothing for a record with no notes", () => {
    expect(reviewNoteFrameTargets({ ...record, notes: undefined })).toEqual([]);
  });
});

describe("formatReviewRecord (keep or regenerate)", () => {
  const record: ReviewRecord = {
    mode: "animatic-preview",
    stage: "animatic",
    createdAt: "2026-05-16T12:00:00.000Z",
    context: { shots: [] },
    decisions: {},
    kept: ["animatic:shot.13.first"],
    regenerate: ["animatic:shot.14.first", "video:shot.14.motion"],
  };

  it("names what was kept and what is left to regenerate", () => {
    const out = formatReviewRecord(record);
    expect(out).toContain("Kept against newer upstream:\n  animatic:shot.13.first");
    expect(out).toContain("Regenerate:\n  animatic:shot.14.first\n  video:shot.14.motion");
  });

  it("is worth saving on those answers alone", () => {
    expect(hasFeedback({ ...record, kept: [] })).toBe(true);
  });
});
