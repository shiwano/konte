import { describe, expect, it } from "vitest";
import { KonteError } from "../../core/errors.js";
import { parseNumberOption, parsePositiveInt } from "../parse-option.js";

describe("parsePositiveInt", () => {
  it("parses a positive integer string", () => {
    expect(parsePositiveInt("3", "--count")).toBe(3);
    expect(parsePositiveInt("1", "--count")).toBe(1);
  });

  it("rejects non-numeric input", () => {
    expect(() => parsePositiveInt("abc", "--count")).toThrow(KonteError);
    expect(() => parsePositiveInt("5m", "--timeout")).toThrow(KonteError);
  });

  it("rejects zero, negatives, and fractions", () => {
    expect(() => parsePositiveInt("0", "--count")).toThrow(KonteError);
    expect(() => parsePositiveInt("-1", "--count")).toThrow(KonteError);
    expect(() => parsePositiveInt("1.5", "--count")).toThrow(KonteError);
    expect(() => parsePositiveInt("", "--timeout")).toThrow(KonteError);
  });

  it("names the offending option in the message", () => {
    expect(() => parsePositiveInt("abc", "--timeout")).toThrow(/--timeout/);
  });

  it("fails with the unified INVALID_OPTION code", () => {
    expect(() => parsePositiveInt("abc", "--limit")).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
  });
});

describe("parseNumberOption", () => {
  it("returns undefined for an absent value", () => {
    expect(parseNumberOption("--threshold", undefined, {})).toBeUndefined();
  });

  it("parses floats and integers", () => {
    expect(parseNumberOption("--threshold", "0.3", { min: 0, max: 1 })).toBe(0.3);
    expect(parseNumberOption("--max-frames", "8", { integer: true, min: 1 })).toBe(8);
  });

  it.each(["10abc", "0.5x", "", "  ", "abc"])(
    "rejects trailing garbage / empty %j instead of truncating to NaN",
    (value) => {
      expect(() => parseNumberOption("--threshold", value, {})).toThrowError(
        expect.objectContaining({ code: "INVALID_OPTION" }),
      );
    },
  );

  it("rejects a non-integer for an integer option", () => {
    expect(() => parseNumberOption("--max-frames", "10.5", { integer: true })).toThrow(KonteError);
  });

  it("enforces min and max bounds", () => {
    expect(() => parseNumberOption("--threshold", "-0.1", { min: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
    expect(() => parseNumberOption("--threshold", "1.5", { max: 1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTION" }),
    );
  });
});
