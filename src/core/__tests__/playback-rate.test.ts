import { describe, expect, it } from "vitest";
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from "@hyperframes/parsers/media-duration";
import * as konte from "../playback-rate.js";

describe("playback rate bounds", () => {
  it("match the bounds HyperFrames clamps to", () => {
    expect(konte.MIN_PLAYBACK_RATE).toBe(MIN_PLAYBACK_RATE);
    expect(konte.MAX_PLAYBACK_RATE).toBe(MAX_PLAYBACK_RATE);
  });
});

describe("assertPlaybackRate", () => {
  it("accepts an absent value and the whole bounded range", () => {
    for (const v of [
      undefined,
      null,
      konte.MIN_PLAYBACK_RATE,
      1,
      1.625,
      "2",
      konte.MAX_PLAYBACK_RATE,
    ]) {
      expect(() => konte.assertPlaybackRate(v, false, "x")).not.toThrow();
    }
  });

  it("refuses an out-of-bounds or non-numeric rate with PLAYBACK_RATE_INVALID", () => {
    for (const v of [0, -1, 0.05, 11, Number.NaN, "fast"]) {
      expect(() => konte.assertPlaybackRate(v, false, `clip ${String(v)}`)).toThrow(
        expect.objectContaining({ code: "PLAYBACK_RATE_INVALID" }),
      );
    }
  });

  it("refuses a rate other than 1 on a clip that plays its own audio", () => {
    expect(() => konte.assertPlaybackRate(1, true, "x")).not.toThrow();
    expect(() => konte.assertPlaybackRate(1.5, true, "x")).toThrow(
      expect.objectContaining({ code: "PLAYBACK_RATE_INVALID" }),
    );
  });
});
