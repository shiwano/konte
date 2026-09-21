import { describe, expect, it } from "vitest";
import { formatPlayerTime } from "../../format-time.js";

describe("formatPlayerTime", () => {
  it("carries rounded tenths into the next minute", () => {
    expect(formatPlayerTime(59.96)).toBe("1:00.0");
    expect(formatPlayerTime(119.96)).toBe("2:00.0");
    expect(formatPlayerTime(59.94)).toBe("0:59.9");
  });

  it("formats ordinary and unavailable playhead positions", () => {
    expect(formatPlayerTime(64.32)).toBe("1:04.3");
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatPlayerTime(value)).toBe("0:00.0");
    }
  });
});
