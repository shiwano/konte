import { describe, expect, it } from "vitest";
import { formatDuration, jobElapsed } from "../format-duration.js";

describe("formatDuration", () => {
  it("formats sub-hour durations as M:SS", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(125_000)).toBe("2:05");
  });

  it("formats hour-plus durations as H:MM:SS", () => {
    expect(formatDuration(3_661_000)).toBe("1:01:01");
  });

  it("clamps negatives to zero", () => {
    expect(formatDuration(-1000)).toBe("0:00");
  });
});

describe("jobElapsed", () => {
  const now = new Date("2026-01-01T00:02:00.000Z").getTime();

  it("returns '-' when the job never started", () => {
    expect(jobElapsed({ startedAt: null, processingStartedAt: null, completedAt: null }, now)).toBe(
      "-",
    );
  });

  it("computes live elapsed from startedAt to now while running", () => {
    expect(
      jobElapsed(
        { startedAt: "2026-01-01T00:00:00.000Z", processingStartedAt: null, completedAt: null },
        now,
      ),
    ).toBe("2:00");
  });

  it("computes final elapsed from startedAt to completedAt once terminal", () => {
    expect(
      jobElapsed(
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          processingStartedAt: null,
          completedAt: "2026-01-01T00:00:30.000Z",
        },
        now,
      ),
    ).toBe("0:30");
  });

  it("prefers processingStartedAt over startedAt so queue wait is excluded", () => {
    expect(
      jobElapsed(
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          processingStartedAt: "2026-01-01T00:01:30.000Z",
          completedAt: null,
        },
        now,
      ),
    ).toBe("0:30");
  });
});
