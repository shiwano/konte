import { describe, expect, it } from "vitest";
import { ERROR_GLIMPSE_WIDTH, singleLine, truncateSingleLine } from "../truncate.js";

describe("truncateSingleLine", () => {
  it("returns short text unchanged", () => {
    expect(truncateSingleLine("boom", 60)).toBe("boom");
  });

  it("collapses internal whitespace and newlines to single spaces", () => {
    expect(truncateSingleLine("  a\n\tb   c  ", 60)).toBe("a b c");
  });

  it("caps to the given width with a trailing ellipsis", () => {
    expect(truncateSingleLine("x".repeat(20), 5)).toBe("xxxx…");
  });

  it("caps at ERROR_GLIMPSE_WIDTH when used for error peeks", () => {
    const out = truncateSingleLine("x".repeat(200), ERROR_GLIMPSE_WIDTH);
    expect(out).toHaveLength(ERROR_GLIMPSE_WIDTH);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("singleLine", () => {
  it("collapses internal whitespace and newlines without capping length", () => {
    expect(singleLine("  a\n\tb   c  ")).toBe("a b c");
    expect(singleLine("x".repeat(200))).toHaveLength(200);
  });
});
