import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTimestamp,
  findReviewRecordSince,
  hasFeedback,
  loadAllReviewRecords,
  loadLatestReviewRecord,
  loadReviewRecordFile,
  reviewShowedHandoff,
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
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted", "02": "none" },
    };
    expect(hasFeedback(record)).toBe(false);
  });

  it("returns true for video-preview with notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
      notes: [{ time: 5, address: "video", text: "Fix this" }],
    };
    expect(hasFeedback(record)).toBe(true);
  });

  it("returns false for video-preview with only accepted decisions and no notes", () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
    };
    expect(hasFeedback(record)).toBe(false);
  });

  it("returns true for reference-preview with decisions array", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
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
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    expect(hasFeedback(record)).toBe(false);
  });

  it("returns false for reference-preview with null decisions", () => {
    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
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
      stage: "direction",
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
      stage: "direction",
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
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    expect(hasFeedback(record)).toBe(false);
  });
});

describe("reviewShowedHandoff", () => {
  const save = (createdAt: string, handoffId?: string) =>
    saveReviewRecord(tmpDir, {
      mode: "video-preview",
      stage: "video",
      createdAt,
      context: { shots: [] },
      decisions: {},
      overallComment: "ok",
      ...(handoffId ? { handoffId } : {}),
    });

  it("finds the record submitted after the handoff that showed it", async () => {
    await save("2026-05-16T12:00:00.000Z", "20260516T110000000");
    await save("2026-05-16T13:00:00.000Z");
    expect(await reviewShowedHandoff(tmpDir, "video", "20260516T110000000")).toBe(true);
  });

  it("finds none when no later record showed it", async () => {
    await save("2026-05-16T12:00:00.000Z", "20260516T110000000");
    expect(await reviewShowedHandoff(tmpDir, "video", "20260516T113000000")).toBe(false);
    expect(await reviewShowedHandoff(tmpDir, "animatic", "20260516T110000000")).toBe(false);
  });

  it("reads no record written before the handoff", async () => {
    await save("2026-05-16T12:00:00.000Z", "20260516T130000000");
    expect(await reviewShowedHandoff(tmpDir, "video", "20260516T130000000")).toBe(false);
  });
});

describe("saveReviewRecord", () => {
  it("saves a record with feedback to review/<stage>/records/", async () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [{ shotId: "01", start: 0, duration: 5, variants: { motion: "v-xxx" } }] },
      decisions: { "01": "none" },
      notes: [{ time: 5, address: "video", text: "Fix this" }],
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
      stage: "animatic",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
      notes: [{ time: 0, shotId: "01", address: "video:shot.01", text: "hold on the last frame" }],
    };

    const filePath = await saveReviewRecord(tmpDir, record);
    expect(filePath).toBe(
      path.join(tmpDir, "review", "animatic", "records", "20260516T120000000.json"),
    );
  });

  it("returns null when record has no feedback", async () => {
    const record: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
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
      stage: "video",
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
      stage: "direction",
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
            stage: "video",
            createdAt,
            context: { shots: [] },
            decisions: { "01": "accepted" },
          }
        : {
            mode: "reference-preview",
            stage: "reference",
            createdAt,
            context: { shots: [] },
            decisions: [],
          };
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

describe("loadLatestReviewRecord", () => {
  it("loads the latest record matching the stage", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const older: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    const newer: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: { "02": "none" },
    };
    const other: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-17T15:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };

    await fs.writeFile(path.join(dir, "20260515T100000000.json"), JSON.stringify(older));
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(newer));
    await fs.writeFile(path.join(dir, "20260517T150000000.json"), JSON.stringify(other));

    const result = await loadLatestReviewRecord(tmpDir, "video");
    expect(result).not.toBeNull();
    expect(result!.createdAt).toBe("2026-05-16T12:00:00.000Z");
    expect(result!.decisions).toEqual({ "02": "none" });
  });

  it("returns null when no reviews directory exists", async () => {
    const result = await loadLatestReviewRecord(tmpDir, "video");
    expect(result).toBeNull();
  });

  it("returns null when no matching stage found", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const record: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
    };
    await fs.writeFile(path.join(dir, "20260516T120000000.json"), JSON.stringify(record));

    const result = await loadLatestReviewRecord(tmpDir, "video");
    expect(result).toBeNull();
  });

  it("returns the most recent record regardless of stage when stage omitted", async () => {
    const dir = path.join(tmpDir, "review", "records");
    await fs.mkdir(dir, { recursive: true });

    const older: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    const newer: ReviewRecord = {
      mode: "reference-preview",
      stage: "reference",
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
      stage: "video",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
    };
    const newer: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
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
      stage: "video",
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
      stage: "animatic",
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
        stage: "animatic",
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

  // SUNSET(0.6.0): brief sign-offs
  it("reads a record an earlier konte wrote with a brief decision, dropping that decision", async () => {
    const filePath = (await saveReviewRecord(tmpDir, {
      mode: "direction-preview",
      stage: "direction",
      createdAt: "2026-05-16T12:00:00.000Z",
      context: { shots: [] },
      decisions: [],
      directionDecisions: { policy: "accepted" },
    }))!;
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    raw.directionDecisions.brief = "accepted";
    await fs.writeFile(filePath, JSON.stringify(raw));

    const [loaded] = await loadAllReviewRecords(tmpDir);
    expect(loaded?.record.directionDecisions).toEqual({ policy: "accepted" });
  });

  it("ids nested records by their stream-qualified path and round-trips through loadReviewRecordFile", async () => {
    const animatic: ReviewRecord = {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: "2026-05-15T10:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "accepted" },
      notes: [{ time: 0, shotId: "01", address: "video:shot.01", text: "hold the last frame" }],
    };
    const video: ReviewRecord = {
      mode: "video-preview",
      stage: "video",
      createdAt: "2026-05-17T15:00:00.000Z",
      context: { shots: [] },
      decisions: { "01": "none" },
      notes: [{ time: 1, address: "video", text: "x" }],
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

    // The videoRoot-relative path the review event carries.
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
      stage: "direction",
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
        stage: "video",
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
        stage: "video",
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
