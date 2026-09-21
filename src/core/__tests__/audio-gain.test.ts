import { describe, expect, it } from "vitest";
import { MAX_AUDIO_GAIN, MAX_AUDIO_GAIN_DB } from "@hyperframes/core/audio-gain";
import { KonteError } from "../errors.js";
import * as konte from "../audio-gain.js";

describe("MAX_AUDIO_GAIN", () => {
  it("matches the ceiling HyperFrames' preview and mixer share", () => {
    expect(konte.MAX_AUDIO_GAIN_DB).toBe(MAX_AUDIO_GAIN_DB);
    expect(konte.MAX_AUDIO_GAIN).toBe(MAX_AUDIO_GAIN);
  });
});

describe("assertAudioGain", () => {
  it("accepts an absent value and the whole 0–MAX_AUDIO_GAIN range", () => {
    for (const v of [undefined, null, 0, 0.5, 1, 2.8, "2.8", konte.MAX_AUDIO_GAIN]) {
      expect(() => konte.assertAudioGain(v, "x")).not.toThrow();
    }
  });

  it("refuses a negative, above-ceiling or non-numeric value with AUDIO_GAIN_INVALID", () => {
    for (const v of [-0.1, konte.MAX_AUDIO_GAIN + 0.01, 4, Number.NaN, "loud"]) {
      let err: unknown;
      try {
        konte.assertAudioGain(v, `cue ${String(v)}`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(KonteError);
      expect((err as KonteError).code).toBe("AUDIO_GAIN_INVALID");
      expect((err as KonteError).message).toContain(`cue ${String(v)}`);
    }
  });
});
