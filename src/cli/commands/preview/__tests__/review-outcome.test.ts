import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { saveReviewRecord } from "../../../../core/review-record.js";
import {
  mergeReviewOutcome,
  printReviewOutcome,
  recoverOutcome,
  type ReviewOutcome,
} from "../review-outcome.js";

// The reported gap: a backgrounded `konte preview` signalled only "the process ended", so submit
// and close were indistinguishable without re-reading the output for a save notice that may never
// have been printed.

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

const submitted: ReviewOutcome = {
  stage: "video",
  filePath: "review/video/records/20260809T101500123.json",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printReviewOutcome — text", () => {
  it("names the generate a Regenerate answer leaves, stage by stage", () => {
    const out = capture(() =>
      printReviewOutcome(
        "animatic-preview",
        {
          stage: "animatic",
          filePath: "review/animatic/records/20260809T101500123.json",
          regenerate: ["animatic:shot.14.first", "video:shot.14.motion"],
        },
        false,
      ),
    );

    expect(out).toBe(
      "Animatic Review: submitted\n" +
        "  konte review record show review/animatic/records/20260809T101500123.json\n" +
        "  konte generate animatic\n" +
        "  konte generate video",
    );
  });

  it("says a session closed without submitting", () => {
    const out = capture(() => printReviewOutcome("video-preview", null, false));

    expect(out).toBe("Video Review: not submitted (closed without submitting)");
  });

  it("leads with submitted, then the command that reads the record", () => {
    const out = capture(() => printReviewOutcome("video-preview", submitted, false));

    expect(out).toBe(
      "Video Review: submitted\n" +
        "  konte review record show review/video/records/20260809T101500123.json",
    );
  });

  it("says so when the record was recovered rather than reported", () => {
    const out = capture(() =>
      printReviewOutcome("video-preview", { ...submitted, recovered: true }, false),
    );

    expect(out).toBe(
      "Video Review: submitted (recovered — the submit did not report before exit)\n" +
        "  konte review record show review/video/records/20260809T101500123.json",
    );
  });

  it("distinguishes a submit that settled nothing from a close", () => {
    const out = capture(() =>
      printReviewOutcome("animatic-preview", { stage: "animatic", filePath: null }, false),
    );

    expect(out).toBe("Animatic Review: submitted, but nothing to record (no changes)");
  });
});

describe("printReviewOutcome — recovered", () => {
  it("flags a recovered record, so a reader can tell it apart from a reported submit", () => {
    const out = capture(() =>
      printReviewOutcome("video-preview", { ...submitted, recovered: true }),
    );

    expect(out).toContain(
      "Video Review: submitted (recovered — the submit did not report before exit)",
    );
  });

  it("names the generate a Regenerate answer leaves as the next step", () => {
    const out = capture(() =>
      printReviewOutcome("video-preview", { ...submitted, regenerate: ["video:shot.14.motion"] }),
    );

    expect(out).toContain("konte generate video");
  });
});

describe("mergeReviewOutcome", () => {
  it("keeps the record when an empty submit lands after it", () => {
    expect(mergeReviewOutcome(submitted, { stage: "video", filePath: null })).toBe(submitted);
  });

  it("takes a record over an earlier empty submit", () => {
    expect(mergeReviewOutcome({ stage: "video", filePath: null }, submitted)).toBe(submitted);
  });

  it("takes the newer record when both saved one", () => {
    const later: ReviewOutcome = { stage: "video", filePath: "review/video/records/later.json" };

    expect(mergeReviewOutcome(submitted, later)).toBe(later);
  });

  it("reports an empty submit when nothing was ever saved", () => {
    const empty: ReviewOutcome = { stage: "video", filePath: null };

    expect(mergeReviewOutcome(null, empty)).toBe(empty);
  });
});

describe("printReviewOutcome — cut short", () => {
  it("leads with the unfinished submit and still names what was recorded", () => {
    const out = capture(() => printReviewOutcome("video-preview", submitted, true));

    expect(out).toBe(
      "Video Review: a submit was still running when the session ended\n" +
        "  konte review record list\n" +
        "Video Review: submitted\n" +
        "  konte review record show review/video/records/20260809T101500123.json",
    );
  });

  it("does not claim a close when a submit was cut short", () => {
    const out = capture(() => printReviewOutcome("video-preview", null, true));

    expect(out).toBe(
      "Video Review: a submit was still running when the session ended\n" +
        "  konte review record list",
    );
  });
});

describe("recoverOutcome", () => {
  it("carries the record's Regenerate answers", async () => {
    const videoRoot = await fs.mkdtemp(path.join(tmpdir(), "konte-recover-"));
    const sessionStart = new Date(Date.now() - 1000).toISOString();
    await saveReviewRecord(videoRoot, {
      mode: "animatic-preview",
      stage: "animatic",
      createdAt: new Date().toISOString(),
      context: { shots: [] },
      decisions: {},
      regenerate: ["animatic:shot.14.first"],
    });

    expect(await recoverOutcome(videoRoot, "animatic-preview", sessionStart)).toMatchObject({
      recovered: true,
      regenerate: ["animatic:shot.14.first"],
    });
  });
});
