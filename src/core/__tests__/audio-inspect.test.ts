import { describe, expect, it } from "vitest";
import {
  buriedBedWarning,
  detectAudibleSpans,
  detectAudioOnset,
  detectWindowCuts,
  playedRms,
  summarizeAudioSilence,
} from "../audio-inspect.js";

const RATE = 100;

// Build an RMS envelope of `total` seconds where only [start, end) carries signal at `level`.
function envelope(total: number, start: number, end: number, level = 0.3): number[] {
  const buckets = Math.round(total * RATE);
  return Array.from({ length: buckets }, (_, i) => {
    const t = i / RATE;
    return t >= start && t < end ? level : 0;
  });
}

describe("summarizeAudioSilence", () => {
  it("returns no warnings for a source that fills its duration", () => {
    expect(summarizeAudioSilence(envelope(10, 0, 10), RATE, 10)).toEqual([]);
  });

  it("flags a trailing silence (early-ended music)", () => {
    const warnings = summarizeAudioSilence(envelope(20, 0, 16), RATE, 20);
    const trailing = warnings.find((w) => w.type === "trailing_silence");
    expect(trailing).toBeDefined();
    expect(trailing?.message).toBe("trailing silence: 4.0s (audio ends at 16.0s / 20.0s)");
    expect(warnings.some((w) => w.type === "leading_silence")).toBe(false);
  });

  it("flags a leading silence (delayed start)", () => {
    const warnings = summarizeAudioSilence(envelope(10, 2, 10), RATE, 10);
    const leading = warnings.find((w) => w.type === "leading_silence");
    expect(leading?.message).toBe("leading silence: 2.0s (audio starts at 2.0s / 10.0s)");
  });

  it("flags a wholly silent file just once", () => {
    const warnings = summarizeAudioSilence(new Array(500).fill(0), RATE, 5);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe("silent");
  });

  it("ignores sub-threshold head/tail decay", () => {
    expect(summarizeAudioSilence(envelope(10, 0.2, 9.7), RATE, 10)).toEqual([]);
  });

  it("gates a low-level noise tail under a loud peak via the peak-relative floor", () => {
    // Loud music for 8s, then a 2s noise tail at 0.003 — above the absolute floor but under the
    // peak-relative one (peak 1.0 → threshold 0.0056), so it still reads as trailing silence.
    const buckets = Array.from({ length: 1000 }, (_, i) => (i < 800 ? 1.0 : 0.003));
    const trailing = summarizeAudioSilence(buckets, RATE, 10).find(
      (w) => w.type === "trailing_silence",
    );
    expect(trailing?.message).toBe("trailing silence: 2.0s (audio ends at 8.0s / 10.0s)");
  });

  it("keeps a faint but audible ambience out of the silent verdict", () => {
    // A fryer's sizzle: steady broadband at -44 dBFS. Quiet, but nothing a listener calls silence.
    expect(summarizeAudioSilence(new Array(300).fill(0.006), RATE, 3)).toEqual([]);
  });

  it("follows a decaying transient to where it really stops, not to its attack", () => {
    // A bell: a 0.8 peak ringing down to -54 dBFS by 1.5s. A floor set near the attack cut the ring
    // off in the first frames and called it "trailing silence: 2.1s (ends at 0.9s)". The decay is
    // content, so the audible span runs to 1.3s — only the dead tail after it is flagged.
    const bell = Array.from({ length: 300 }, (_, i) => 0.8 * Math.exp(-(i / RATE) / 0.25));
    const trailing = summarizeAudioSilence(bell, RATE, 3).find(
      (w) => w.type === "trailing_silence",
    );
    expect(trailing?.message).toBe("trailing silence: 1.7s (audio ends at 1.3s / 3.0s)");
  });

  it("returns nothing for an empty envelope", () => {
    expect(summarizeAudioSilence([], RATE, null)).toEqual([]);
  });
});

// Build an envelope of `total` seconds carrying signal over each [start, end) span.
function spans(total: number, ranges: [number, number][], level = 0.3): number[] {
  const buckets = Math.round(total * RATE);
  return Array.from({ length: buckets }, (_, i) => {
    const t = i / RATE;
    return ranges.some(([a, b]) => t >= a && t < b) ? level : 0;
  });
}

describe("detectAudibleSpans", () => {
  it("reports one span for a continuous source", () => {
    expect(detectAudibleSpans(envelope(5, 0.5, 4.5), RATE)).toEqual([{ start: 0.5, end: 4.5 }]);
  });

  it("separates stretches a real gap divides — a take padded past its content", () => {
    expect(
      detectAudibleSpans(
        spans(5.2, [
          [0.5, 2.35],
          [3.0, 3.5],
          [3.9, 4.65],
        ]),
        RATE,
      ),
    ).toEqual([
      { start: 0.5, end: 2.35 },
      { start: 3.0, end: 3.5 },
      { start: 3.9, end: 4.65 },
    ]);
  });

  it("joins a pause too short to divide two utterances", () => {
    expect(
      detectAudibleSpans(
        spans(3, [
          [0.2, 1.0],
          [1.15, 2.4],
        ]),
        RATE,
      ),
    ).toEqual([{ start: 0.2, end: 2.4 }]);
  });

  it("holds the same audible floor summarizeAudioSilence judges by", () => {
    const quiet = spans(3, [[0.5, 2.5]], 0.001);
    expect(detectAudibleSpans(quiet, RATE)).toEqual([]);
    expect(summarizeAudioSilence(quiet, RATE, 3)[0]?.type).toBe("silent");
  });

  it("returns nothing for a silent or empty envelope", () => {
    expect(detectAudibleSpans([], RATE)).toEqual([]);
    expect(detectAudibleSpans(new Array(100).fill(0), RATE)).toEqual([]);
  });
});

describe("detectAudioOnset", () => {
  it("reports the lead-in a cue has to be offset by", () => {
    // A shutter click 0.12s into its file: `<Sound start>` = target time − 0.12.
    expect(detectAudioOnset(envelope(0.9, 0.12, 0.3), RATE)).toEqual({
      startSec: 0.12,
      peakSec: 0.12,
    });
  });

  it("separates the attack from the first audible sample", () => {
    // A swell: audible from 0.2s, loudest at 1.0s — a hit aligned on its peak needs the latter.
    const rms = envelope(2, 0.2, 2, 0.1).map((v, i) => (i / RATE >= 1 && i / RATE < 1.1 ? 0.9 : v));
    expect(detectAudioOnset(rms, RATE)).toEqual({ startSec: 0.2, peakSec: 1 });
  });

  it("holds the same audible floor summarizeAudioSilence judges by", () => {
    // A noise tail under a loud peak is below the peak-relative floor, so it is not the onset.
    const rms = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.003 : 1.0));
    expect(detectAudioOnset(rms, RATE)?.startSec).toBe(1);
  });

  it("returns nothing for a silent or empty envelope", () => {
    expect(detectAudioOnset(new Array(300).fill(0), RATE)).toBeNull();
    expect(detectAudioOnset([], RATE)).toBeNull();
  });
});

describe("playedRms", () => {
  const profile = (total: number, start: number, end: number) => ({
    durationSec: total,
    rate: RATE,
    rms: envelope(total, start, end),
  });
  const silence = (rms: number[]) => summarizeAudioSilence(rms, RATE, null).map((w) => w.message);

  it("cuts the played region so a mediaStart trim doesn't read as leading silence", () => {
    // A 10s source silent for its first 3s, played from 3s — the trim removes the silence.
    const played = playedRms(profile(10, 3, 10), 3, 7, false);
    expect(played).toHaveLength(700);
    expect(silence(played)).toEqual([]);
  });

  it("still flags a trailing silence inside the played region", () => {
    const played = playedRms(profile(20, 0, 16), 0, 20, false);
    expect(silence(played)).toEqual(["trailing silence: 4.0s (audio ends at 16.0s / 20.0s)"]);
  });

  it("pads the span a source runs out of, so an underrun reads as the silence it is", () => {
    // A 5s source held for 30s (`<Audio duration={30}>`, or a non-looping bed): 25s of nothing.
    const played = playedRms(profile(5, 0, 5), 0, 30, false);
    expect(played).toHaveLength(3000);
    expect(silence(played)).toEqual(["trailing silence: 25.0s (audio ends at 5.0s / 30.0s)"]);
  });

  it("reads a mediaStart past the source end as wholly silent", () => {
    const played = playedRms(profile(10, 0, 10), 12, 3, false);
    expect(played).toEqual(new Array(300).fill(0));
    expect(silence(played)).toEqual([
      "No audible signal above the noise floor — the whole 3.0s file is silent.",
    ]);
  });

  it("measures a looped bed over the source it repeats, not the span it fills", () => {
    // A 10s bed whose music stops at 7s, looped across a 60s timeline: the gap recurs each lap.
    const played = playedRms(profile(10, 0, 7), 0, 60, true);
    expect(played).toHaveLength(1000);
    expect(silence(played)).toEqual(["trailing silence: 3.0s (audio ends at 7.0s / 10.0s)"]);
  });

  it("ignores mediaStart on a looped bed — the wrap plays the head back anyway", () => {
    // Matches sliceEnvelope, which wraps over the whole source: the first 3s return on lap two.
    expect(playedRms(profile(10, 0, 7), 3, 60, true)).toEqual(
      playedRms(profile(10, 0, 7), 0, 60, true),
    );
  });

  it("returns nothing when the played span is empty or unknown", () => {
    expect(playedRms(profile(10, 0, 10), 0, 0, false)).toEqual([]);
    expect(playedRms(profile(10, 0, 10), 0, null, false)).toEqual([]);
  });
});

describe("detectWindowCuts", () => {
  // A 6s take speaking from 0.5s to 5.5s at full level.
  const line = envelope(6, 0.5, 5.5, 1.0);

  it("passes a window that ends in silence", () => {
    expect(detectWindowCuts(line, RATE, 0.2, 5.6)).toEqual([]);
  });

  it("flags a window whose end lands inside the line", () => {
    const w = detectWindowCuts(line, RATE, 0, 4.8);
    expect(w.map((x) => x.type)).toEqual(["window_cuts_mid_sound"]);
    expect(w[0]?.message).toContain("0.70s more follows");
  });

  it("flags a window that opens inside the line", () => {
    const w = detectWindowCuts(line, RATE, 2, 3.5);
    expect(w.map((x) => x.type)).toEqual(["window_opens_mid_sound"]);
  });

  it("flags both edges at once", () => {
    expect(detectWindowCuts(line, RATE, 1, 2).map((x) => x.type)).toEqual([
      "window_opens_mid_sound",
      "window_cuts_mid_sound",
    ]);
  });

  it("reports faded source boundaries as information without directing timing changes", () => {
    const cuts = detectWindowCuts(line, RATE, 1, 2, { fadeIn: 0.1, fadeOut: 0.25 });
    expect(cuts).toHaveLength(2);
    expect(cuts.every((cut) => cut.informational)).toBe(true);
    expect(cuts[0]?.message).toContain("fadeIn 0.1s applied");
    expect(cuts[1]?.message).toContain("fadeOut 0.25s reaches silence");
    expect(cuts.every((cut) => !cut.message.includes("raise `duration`"))).toBe(true);
  });

  it("keeps unfaded edges and incomplete fade-outs as warnings", () => {
    for (const fades of [{}, { fadeIn: 0, fadeOut: 0 }, { fadeOut: 3 }]) {
      expect(detectWindowCuts(line, RATE, 1, 2, fades).every((cut) => !cut.informational)).toBe(
        true,
      );
    }
    const cuts = detectWindowCuts(line, RATE, 1, 2, { fadeOut: 0.25 });
    expect(cuts.map((cut) => cut.informational)).toEqual([false, true]);
  });

  it("passes a window opening exactly on the line's onset", () => {
    expect(detectWindowCuts(line, RATE, 0.5, 5.1)).toEqual([]);
  });

  // The floor is stricter than summarizeAudioSilence's: a decay crossing the edge far under the
  // take's own peak is inaudible, a vowel a few dB down is a click.
  it("passes a quiet tail crossing the edge and flags a loud one", () => {
    const quiet = line.map((v, i) => (i / RATE >= 5.5 && i / RATE < 6 ? 0.004 : v));
    expect(detectWindowCuts(quiet, RATE, 0, 5.7)).toEqual([]);
    const loud = line.map((v, i) => (i / RATE >= 5.5 && i / RATE < 6 ? 0.3 : v));
    expect(detectWindowCuts(loud, RATE, 0, 5.7).map((x) => x.type)).toEqual([
      "window_cuts_mid_sound",
    ]);
  });

  it("ignores a single loud bucket at the edge", () => {
    const blip = envelope(3, 0, 0, 0).map((v, i) => (i === 200 ? 1.0 : v));
    expect(detectWindowCuts(blip, RATE, 0, 2.0)).toEqual([]);
  });

  it("reports nothing without a window to judge", () => {
    expect(detectWindowCuts(line, RATE, 0, null)).toEqual([]);
    expect(detectWindowCuts([], RATE, 0, 2)).toEqual([]);
    expect(detectWindowCuts(new Array(300).fill(0), RATE, 0, 2)).toEqual([]);
  });
});

describe("buriedBedWarning", () => {
  it("says nothing about a bed sitting a normal distance under the lines", () => {
    expect(buriedBedWarning([-20, -20.6], -33)).toBeNull();
  });

  it("flags a bed the lines have buried, naming the gap and the level", () => {
    expect(buriedBedWarning([-20], -39)).toBe(
      "19 dB under the lines at -39.0 LUFS — inaudible; raise its `volume`",
    );
  });

  it("judges against the loudest line, not the quietest", () => {
    expect(buriedBedWarning([-30, -18], -37)).not.toBeNull();
    expect(buriedBedWarning([-30], -37)).toBeNull();
  });

  it("has no verdict without lines to be under, or without a measured bed", () => {
    expect(buriedBedWarning([], -60)).toBeNull();
    expect(buriedBedWarning([-20], null)).toBeNull();
  });
});
