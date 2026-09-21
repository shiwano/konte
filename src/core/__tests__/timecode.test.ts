import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { parseTimecode } from "../timecode.js";

describe("parseTimecode", () => {
  it("parses seconds format (90s)", () => {
    expect(parseTimecode("90s")).toBe(90);
  });

  it("parses fractional seconds format (1.5s)", () => {
    expect(parseTimecode("1.5s")).toBe(1.5);
  });

  it("parses mm:ss format", () => {
    expect(parseTimecode("1:30")).toBe(90);
  });

  it("parses mm:ss.f format", () => {
    expect(parseTimecode("1:30.5")).toBe(90.5);
  });

  it("parses hh:mm:ss format", () => {
    expect(parseTimecode("00:01:30")).toBe(90);
  });

  it("parses hh:mm:ss.f format", () => {
    expect(parseTimecode("01:00:00.5")).toBe(3600.5);
  });

  it("parses raw number", () => {
    expect(parseTimecode("45")).toBe(45);
  });

  it("parses raw decimal", () => {
    expect(parseTimecode("45.5")).toBe(45.5);
  });

  it("parses zero", () => {
    expect(parseTimecode("0")).toBe(0);
    expect(parseTimecode("0s")).toBe(0);
    expect(parseTimecode("0:00")).toBe(0);
    expect(parseTimecode("00:00:00")).toBe(0);
  });

  it("throws INVALID_TIMECODE for invalid format", () => {
    expect(() => parseTimecode("abc")).toThrow(KonteError);
    expect(() => parseTimecode("abc")).toThrow("Invalid timecode format");
  });

  it("throws INVALID_TIMECODE for empty string", () => {
    expect(() => parseTimecode("")).toThrow(KonteError);
  });
});
