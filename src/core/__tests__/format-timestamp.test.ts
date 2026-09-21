import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../format-timestamp.js";

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  const ago = (seconds: number): string =>
    formatRelativeTime(new Date(now.getTime() - seconds * 1000).toISOString(), now);

  it("picks the largest fitting unit", () => {
    expect(ago(1)).toBe("1s ago");
    expect(ago(59)).toBe("59s ago");
    expect(ago(60)).toBe("1m ago");
    expect(ago(3599)).toBe("59m ago");
    expect(ago(3600)).toBe("1h ago");
    expect(ago(86_399)).toBe("23h ago");
    expect(ago(86_400)).toBe("1d ago");
    expect(ago(2_591_999)).toBe("29d ago");
    expect(ago(2_592_000)).toBe("1mo ago");
    expect(ago(31_535_999)).toBe("12mo ago");
    expect(ago(31_536_000)).toBe("1y ago");
  });

  it("reads a sub-second or clock-skewed future timestamp as just now", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(-3600)).toBe("just now");
  });

  it("returns an unparseable input verbatim", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
