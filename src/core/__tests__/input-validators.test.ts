import { describe, expect, it } from "vitest";
import { inertInputs, requireOneOf } from "../dsl/validators/input-validators.js";

function messageOf(fn: () => string | undefined): string {
  const rejection = fn();
  if (rejection === undefined) throw new Error("expected a rejection");
  return rejection;
}

describe("inertInputs", () => {
  // Qwen Image Edit's negative prompt under the Lightning LoRA: the sampler runs at CFG 1, so the
  // negative branch is not there to read it.
  const negativeUnderLightning = inertInputs({
    inputs: { negativePrompt: [" ", ""] },
    when: { useLightning: true },
    reason: "the Lightning LoRA samples at CFG 1, which has no negative branch",
    fix: "Set `useLightning: false` for this take, or drop the negative prompt.",
  });

  it("rejects the input when the condition holds", () => {
    const message = messageOf(() =>
      negativeUnderLightning({ useLightning: true, negativePrompt: "extra hands" }),
    );
    expect(message).toContain('"negativePrompt" is set');
    expect(message).toContain("CFG 1");
    expect(message).toContain("useLightning: false");
  });

  it("passes when the condition does not hold", () => {
    expect(
      negativeUnderLightning({ useLightning: false, negativePrompt: "extra hands" }),
    ).toBeUndefined();
  });

  it("treats every declared unset value as not set", () => {
    expect(negativeUnderLightning({ useLightning: true, negativePrompt: " " })).toBeUndefined();
    expect(negativeUnderLightning({ useLightning: true, negativePrompt: "" })).toBeUndefined();
    expect(negativeUnderLightning({ useLightning: true })).toBeUndefined();
  });

  it("matches on whenUnset for a companion input that is not passed", () => {
    // H3's soundtrack slots: one is read only beside the clip whose track it is.
    const soundtrack = inertInputs({
      inputs: { video1Audio: "" },
      whenUnset: { video1: "" },
      reason: "a soundtrack rides on the clip it belongs to, and `video1` is not passed",
      fix: "Pass the clip as `video1`, or drop `video1Audio`.",
    });

    const message = messageOf(() => soundtrack({ video1Audio: "clip.mp4" }));
    expect(message).toContain('"video1Audio" is set');
    expect(message).toContain("video1");
    expect(soundtrack({ video1Audio: "clip.mp4", video1: "clip.mp4" })).toBeUndefined();
    expect(soundtrack({})).toBeUndefined();
  });

  it("matches on whenNot for a condition stated as an absence", () => {
    // The TTS preset menus: they build a voice only while `instruct` is empty.
    const presets = inertInputs({
      inputs: { character: "Auto", style: "Auto" },
      whenNot: { instruct: "" },
      reason: "the preset menus build a voice only while `instruct` is empty",
      fix: "Fold it into the `instruct` sentence.",
    });
    expect(presets({ instruct: "", character: "Cheerful", style: "Auto" })).toBeUndefined();
    expect(
      messageOf(() => presets({ instruct: "A gravelly older man.", character: "Cheerful" })),
    ).toContain('"character" is set');
  });

  it("negates a multi-entry whenNot as a whole, not entry by entry", () => {
    const validator = inertInputs({
      inputs: { knob: "" },
      whenNot: { mode: "A", quality: "low" },
      reason: "r",
      fix: "f",
    });
    // The match holds only when both entries do, so it is not-held as soon as one differs — and the
    // validator applies there.
    expect(validator({ mode: "A", quality: "low", knob: "x" })).toBeUndefined();
    expect(messageOf(() => validator({ mode: "A", quality: "high", knob: "x" }))).toContain(
      '"knob" is set',
    );
    expect(messageOf(() => validator({ mode: "B", quality: "low", knob: "x" }))).toContain(
      '"knob" is set',
    );
  });

  it("reports every inert input at once", () => {
    const presets = inertInputs({
      inputs: { character: "Auto", style: "Auto" },
      whenNot: { instruct: "" },
      reason: "r",
      fix: "f",
    });
    expect(
      messageOf(() => presets({ instruct: "A voice.", character: "Cheerful", style: "Narration" })),
    ).toContain('"character", "style" are set');
  });
});

describe("requireOneOf", () => {
  const aVoice = requireOneOf({
    inputs: { instruct: "", character: "Auto", style: "Auto" },
    reason: "voice design has no voice to build.",
  });

  it("rejects the combination in which every input sits at its unset value", () => {
    const message = messageOf(() => aVoice({ instruct: "", character: "Auto", style: "Auto" }));
    expect(message).toContain('None of "instruct", "character", "style" is set');
    expect(message).toContain("no voice to build");
  });

  it("passes as soon as one is set", () => {
    expect(aVoice({ instruct: "A gravelly older man." })).toBeUndefined();
    expect(aVoice({ instruct: "", character: "Cheerful", style: "Auto" })).toBeUndefined();
  });
});
