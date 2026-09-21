import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { parseSrt } from "../srt.js";

describe("parseSrt", () => {
  it("parses valid SRT content", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,200
Second line`;

    const entries = parseSrt(srt);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      index: 1,
      startSeconds: 1,
      endSeconds: 4,
      text: "Hello world",
    });
    expect(entries[1]).toEqual({
      index: 2,
      startSeconds: 5.5,
      endSeconds: 8.2,
      text: "Second line",
    });
  });

  it("handles multi-line subtitle text", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two`;

    const entries = parseSrt(srt);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Line one\nLine two");
  });

  it("handles CRLF line endings", () => {
    const srt =
      "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,000 --> 00:00:08,000\r\nWorld";

    const entries = parseSrt(srt);
    expect(entries).toHaveLength(2);
  });

  it("handles dot separator in timecodes", () => {
    const srt = `1
00:00:01.000 --> 00:00:04.500
Hello`;

    const entries = parseSrt(srt);
    expect(entries[0]!.startSeconds).toBe(1);
    expect(entries[0]!.endSeconds).toBe(4.5);
  });

  it("throws SRT_PARSE_ERROR for invalid index", () => {
    const srt = `abc
00:00:01,000 --> 00:00:04,000
Hello`;

    expect(() => parseSrt(srt)).toThrow(KonteError);
    expect(() => parseSrt(srt)).toThrow("Invalid SRT index");
  });

  it("throws SRT_PARSE_ERROR for invalid timecode", () => {
    const srt = `1
invalid timecode
Hello`;

    expect(() => parseSrt(srt)).toThrow(KonteError);
    expect(() => parseSrt(srt)).toThrow("Invalid SRT timecode");
  });

  it("calculates hours and minutes correctly", () => {
    const srt = `1
01:02:03,456 --> 02:30:00,000
Test`;

    const entries = parseSrt(srt);
    expect(entries[0]!.startSeconds).toBe(3723.456);
    expect(entries[0]!.endSeconds).toBe(9000);
  });
});
