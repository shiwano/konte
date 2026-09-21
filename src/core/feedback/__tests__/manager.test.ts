import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackAnnotationSchema, type FeedbackEntry } from "../../types/index.js";
import { FeedbackManager, findFeedback, listAllFeedback } from "../index.js";

const FIRST = "animatic:shot.01.first";

function entry(id: string, extra: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id,
    displayedVariants: {},
    annotation: null,
    text: "note",
    createdAt: "2024-01-01T00:00:00Z",
    createdBy: "local",
    ...extra,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-feedback-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("FeedbackManager CRUD", () => {
  it("addFeedback adds an entry, getFeedback reads it back", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    mgr.addFeedback(FIRST, entry("fb-test0001", { annotation: { kind: "pin", x: 0.5, y: 0.3 } }));
    const feedback = mgr.getFeedback(FIRST);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.id).toBe("fb-test0001");
    expect(feedback[0]!.annotation).toEqual({ kind: "pin", x: 0.5, y: 0.3 });
  });

  it("removeFeedback removes an entry by ID, false for a missing one", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    mgr.addFeedback(FIRST, entry("fb-aaa00001"));
    mgr.addFeedback(FIRST, entry("fb-bbb00001"));
    expect(mgr.getFeedback(FIRST)).toHaveLength(2);

    expect(mgr.removeFeedback(FIRST, "fb-aaa00001")).toBe(true);
    const remaining = mgr.getFeedback(FIRST);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("fb-bbb00001");
    expect(mgr.removeFeedback(FIRST, "fb-nonexist")).toBe(false);
  });

  it("updateFeedbackText updates the text, false for a missing one", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    mgr.addFeedback(FIRST, entry("fb-test0001", { text: "original text" }));
    expect(mgr.updateFeedbackText(FIRST, "fb-test0001", "updated text")).toBe(true);
    expect(mgr.getFeedback(FIRST)[0]!.text).toBe("updated text");
    expect(mgr.updateFeedbackText(FIRST, "fb-nonexist", "x")).toBe(false);
  });

  it("getFeedback returns an empty array for an address with no feedback", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    expect(mgr.getFeedback("animatic:shot.99.missing")).toEqual([]);
  });

  it("addFeedback rejects an address from a different stream", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    expect(() => mgr.addFeedback("video:shot.01.motion", entry("fb-y"))).toThrow(/does not belong/);
    // A bare-shot address (whole-shot feedback) in the right stream is accepted.
    mgr.addFeedback("animatic:shot.01", entry("fb-ok"));
    expect(mgr.getFeedback("animatic:shot.01")).toHaveLength(1);
  });

  it("removeAddress drops every entry on an address", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    mgr.addFeedback(FIRST, entry("fb-aaa00001"));
    mgr.addFeedback(FIRST, entry("fb-bbb00001"));
    mgr.removeAddress(FIRST);
    expect(mgr.getFeedback(FIRST)).toEqual([]);
  });
});

describe("FeedbackManager persistence", () => {
  it("persists a stream across save and load", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "animatic");
    mgr.addFeedback(
      FIRST,
      entry("fb-persist1", {
        displayedVariants: { [FIRST]: "v-abc00001" },
        annotation: { kind: "pin", x: 0.1, y: 0.9 },
      }),
    );
    await mgr.save();

    const loaded = await FeedbackManager.load(tmpDir, "animatic");
    const feedback = loaded.getFeedback(FIRST);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.id).toBe("fb-persist1");
    expect(feedback[0]!.annotation).toEqual({ kind: "pin", x: 0.1, y: 0.9 });
  });

  it("writes to review/<stage>/feedback.json", async () => {
    await FeedbackManager.withLock(tmpDir, "animatic", async (mgr) => {
      mgr.addFeedback(FIRST, entry("fb-loc00001"));
    });
    const filePath = path.join(tmpDir, "review", "animatic", "feedback.json");
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(raw.feedback[FIRST][0].id).toBe("fb-loc00001");
  });

  it("load returns an empty stream when the file is absent", async () => {
    const mgr = await FeedbackManager.load(tmpDir, "reference");
    expect(mgr.list()).toEqual([]);
  });

  it("load surfaces a non-ENOENT read error instead of silently returning empty", async () => {
    // A directory where the feedback file should be triggers EISDIR, not ENOENT — a read
    // failure that must not be swallowed as "no feedback" (a later save would erase it).
    await fs.mkdir(path.join(tmpDir, "review", "animatic", "feedback.json"), {
      recursive: true,
    });
    await expect(FeedbackManager.load(tmpDir, "animatic")).rejects.toThrow();
  });
});

describe("cross-stream helpers", () => {
  async function seed(): Promise<void> {
    await FeedbackManager.withLock(tmpDir, "animatic", async (mgr) => {
      mgr.addFeedback(FIRST, entry("fb-sb000001"));
    });
    await FeedbackManager.withLock(tmpDir, "video", async (mgr) => {
      mgr.addFeedback("video:shot.01", entry("fb-vid00001"));
    });
  }

  it("listAllFeedback returns every entry across streams", async () => {
    await seed();
    const all = await listAllFeedback(tmpDir);
    expect(all.map((f) => f.entry.id).sort()).toEqual(["fb-sb000001", "fb-vid00001"]);
    const byStage = Object.fromEntries(all.map((f) => [f.entry.id, f.stage]));
    expect(byStage["fb-sb000001"]).toBe("animatic");
    expect(byStage["fb-vid00001"]).toBe("video");
  });

  it("findFeedback resolves a feedback id to its stream and address", async () => {
    await seed();
    const found = await findFeedback(tmpDir, "fb-vid00001");
    expect(found).toMatchObject({
      stage: "video",
      address: "video:shot.01",
    });
    expect(await findFeedback(tmpDir, "fb-nonexist")).toBeNull();
  });
});

describe("FeedbackAnnotationSchema coordinates", () => {
  it("clamps an out-of-frame pin instead of failing the stream it lives in", () => {
    // A pin dragged a hair past the frame edge still means "at this edge". Rejecting it would fail
    // the whole feedback file's load (FeedbackStreamSchema), losing every comment in the stream.
    const parsed = FeedbackAnnotationSchema.parse({ kind: "pin", x: 1.02, y: -0.01 });
    expect(parsed).toEqual({ kind: "pin", x: 1, y: 0 });
  });

  it("clamps both ends of an arrow", () => {
    const parsed = FeedbackAnnotationSchema.parse({
      kind: "arrow",
      from: { x: -3, y: 0.5 },
      to: { x: 0.5, y: 9 },
    });
    expect(parsed).toEqual({ kind: "arrow", from: { x: 0, y: 0.5 }, to: { x: 0.5, y: 1 } });
  });

  it("still rejects a non-numeric coordinate", () => {
    expect(FeedbackAnnotationSchema.safeParse({ kind: "pin", x: "left", y: 0.5 }).success).toBe(
      false,
    );
  });
});
