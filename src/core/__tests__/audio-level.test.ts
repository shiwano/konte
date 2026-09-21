import { describe, expect, it } from "vitest";
import {
  audioLevelling,
  clampEffectiveGain,
  type CueKind,
  cueKindsBySrc,
  cueLeadIn,
  levellingGain,
  playedLufs,
  shotCueLevels,
} from "../audio-level.js";
import type { KonteState } from "../types/index.js";
import { parseEbur128Summary, parseLeadIn } from "../audio-loudness.js";

const SUMMARY = `[Parsed_ebur128_0 @ 0x55f] Summary:

  Integrated loudness:
    I:         -24.0 LUFS
    Threshold: -34.6 LUFS

  Loudness range:
    LRA:         5.0 LU

  True peak:
    Peak:       -3.2 dBFS
`;

describe("parseEbur128Summary", () => {
  it("reads the integrated loudness and true peak out of the summary block", () => {
    expect(parseEbur128Summary(SUMMARY)).toEqual({ integratedLufs: -24, truePeakDb: -3.2 });
  });

  it("reports no integrated loudness for content too quiet to hold one, keeping the peak", () => {
    const quiet = SUMMARY.replace("-24.0 LUFS", "-inf LUFS");
    expect(parseEbur128Summary(quiet)).toEqual({ integratedLufs: null, truePeakDb: -3.2 });
  });

  it("is null without a summary block, and for a silent file's peak", () => {
    expect(parseEbur128Summary("ffmpeg version 7.1\n")).toBeNull();
    expect(parseEbur128Summary(SUMMARY.replace("-3.2 dBFS", "-inf dBFS"))).toBeNull();
  });
});

const windows = (levels: string[]) =>
  levels
    .map(
      (level, i) =>
        `frame:${i} pts:${i * 480} pts_time:${i / 100}\nlavfi.astats.Overall.RMS_level=${level}`,
    )
    .join("\n");

describe("parseLeadIn", () => {
  it("finds where the sound rises within 30 dB of its loudest window", () => {
    expect(parseLeadIn(windows(["-inf", "-80", "-60", "-18", "-12", "-30"]))).toBe(0.03);
  });

  it("reads a sound already playing on its first window as no lead-in", () => {
    expect(parseLeadIn(windows(["-22", "-20", "-21"]))).toBe(0);
  });

  it("is 0 for digital silence and for output it cannot read", () => {
    expect(parseLeadIn(windows(["-inf", "-inf"]))).toBe(0);
    expect(parseLeadIn("")).toBe(0);
  });
});

describe("cueLeadIn", () => {
  const take = (leadInSec?: number) => ({
    kind: "audio" as const,
    durationSec: 1,
    channels: 2,
    sampleRate: 48000,
    loudness: {
      integratedLufs: null,
      truePeakDb: -3,
      ...(leadInSec !== undefined ? { leadInSec } : {}),
    },
  });

  it("skips an sfx take's measured lead-in", () => {
    expect(cueLeadIn("sfx", take(0.105))).toBe(0.105);
  });

  it("leaves a line where its author put it", () => {
    expect(cueLeadIn("voice", take(0.3))).toBe(0);
    expect(cueLeadIn("mob", take(0.3))).toBe(0);
  });

  it("skips nothing on a take measured before lead-in was, or a clip's track", () => {
    expect(cueLeadIn("sfx", take())).toBe(0);
    expect(cueLeadIn("sfx", undefined)).toBe(0);
    expect(
      cueLeadIn("sfx", {
        kind: "video",
        width: 2,
        height: 2,
        fps: 24,
        durationSec: 1,
        audio: null,
      }),
    ).toBe(0);
  });
});

describe("levellingGain", () => {
  it("levels a voice to its target: 6 dB under it asks for 6 dB of gain", () => {
    const gain = levellingGain("voice", { integratedLufs: -24, truePeakDb: -6 });
    expect(20 * Math.log10(gain)).toBeCloseTo(6, 6);
  });

  it("puts a mob under a voice from the same measurement", () => {
    const measured = { integratedLufs: -24, truePeakDb: -6 };
    expect(levellingGain("mob", measured)).toBeLessThan(levellingGain("voice", measured));
  });

  it("levels sfx by true peak, ignoring an integrated loudness a transient cannot hold", () => {
    const gain = levellingGain("sfx", { integratedLufs: null, truePeakDb: -20 });
    expect(20 * Math.log10(gain)).toBeCloseTo(12, 6);
  });

  it("leaves an unmeasured source at unity so `volume` keeps its current meaning", () => {
    expect(levellingGain("voice", undefined)).toBe(1);
    expect(levellingGain("voice", { integratedLufs: null, truePeakDb: -6 })).toBe(1);
  });

  it("clamps a wild measurement rather than shoving the cue across the mix", () => {
    const gain = levellingGain("voice", { integratedLufs: -90, truePeakDb: -90 });
    expect(20 * Math.log10(gain)).toBeCloseTo(12, 6);
  });
});

describe("audioLevelling diagnostics", () => {
  it.each([
    ["voice", -24, -6, 6, false],
    ["narration", -18, -6, 0, false],
    ["mob", -24, -6, -2, false],
    ["bed", -18, -6, -6, false],
    ["voice", -49, -30, 12, true],
    ["voice", -2, -1, -12, true],
    ["sfx", null, -20, 12, true],
  ] as const)(
    "explains %s gain for LUFS %s and peak %s",
    (kind, integratedLufs, truePeakDb, db, limited) => {
      const adjustment = audioLevelling(kind, { integratedLufs, truePeakDb });
      expect(20 * Math.log10(adjustment.gain)).toBeCloseTo(db, 6);
      expect(adjustment).toMatchObject({ limited });
      expect(adjustment.reason).toBeUndefined();
      expect(levellingGain(kind, { integratedLufs, truePeakDb })).toBe(adjustment.gain);
    },
  );

  it("distinguishes absent measurements from unavailable integrated LUFS", () => {
    expect(audioLevelling("voice", undefined)).toEqual({ gain: 1, reason: "unmeasured" });
    expect(audioLevelling("voice", { integratedLufs: null, truePeakDb: -6 })).toEqual({
      gain: 1,
      reason: "no-lufs",
    });
  });
});

describe("clampEffectiveGain", () => {
  // The preview's player clamps a gain at +12 dB and ffmpeg does not, so an uncapped product of a
  // declared +12 dB and a levelling +12 dB would have the two mixing differently.
  it("caps the product at the ceiling the declared value is checked against", () => {
    const ceiling = 10 ** (12 / 20);
    expect(clampEffectiveGain(ceiling * ceiling)).toBeCloseTo(ceiling, 10);
    expect(clampEffectiveGain(2)).toBe(2);
  });

  it("reads a broken number as silence rather than passing it to the mixer", () => {
    expect(clampEffectiveGain(Number.NaN)).toBe(0);
    expect(clampEffectiveGain(-1)).toBe(0);
  });
});

describe("cueKindsBySrc", () => {
  const cueKinds = {
    "video:shot.01.vo": "voice",
    "animatic:shot.01#stem": "voice",
  } as const;

  it("keys a shot's own cue by the file the render resolved it to", () => {
    expect(
      cueKindsBySrc({
        stage: "video",
        shotId: "01",
        cueKinds,
        resolvedFiles: { vo: "/abs/vo.wav" },
      }),
    ).toMatchObject({ "/abs/vo.wav": "voice" });
  });

  // The render only substitutes a shot's own assets, so a cue reaching outside it arrives at the
  // harvest as the placeholder.
  it("keys a cue reaching outside the shot by the placeholder the render leaves behind", () => {
    expect(cueKindsBySrc({ stage: "video", shotId: "01", cueKinds, resolvedFiles: {} })).toEqual({
      "__konte:video:shot.01.vo__": "voice",
      "__konte:animatic:shot.01#stem__": "voice",
    });
  });

  // A timeline-own cue captured by a shot's closure is substituted for its file by the render, so
  // the placeholder alone would miss it.
  it("keys a timeline-own cue by the file the timeline render resolved it to", () => {
    expect(
      cueKindsBySrc({
        stage: "video",
        shotId: "01",
        cueKinds: { "video:timeline.vo": "voice" },
        resolvedFiles: {},
        timelineFiles: { vo: "/abs/vo.wav" },
      }),
    ).toMatchObject({ "/abs/vo.wav": "voice", "__konte:video:timeline.vo__": "voice" });
  });

  it("reports nothing for a shot with no cues", () => {
    expect(
      cueKindsBySrc({ stage: "video", shotId: "01", cueKinds: undefined, resolvedFiles: {} }),
    ).toBeUndefined();
  });
});

describe("shotCueLevels", () => {
  const sfxTake = (leadInSec: number) => ({
    variants: {
      "v-1": {
        media: {
          kind: "audio",
          durationSec: 1,
          channels: 2,
          sampleRate: 48000,
          loudness: { integratedLufs: null, truePeakDb: -20, leadInSec },
        },
      },
    },
  });
  const state = {
    assets: {
      "animatic:shot.01.slam": sfxTake(0.1),
      "animatic:timeline.knock": sfxTake(0.2),
      "reference:thump": sfxTake(0.3),
      "animatic:shot.02#stem": sfxTake(0.4),
    },
  } as unknown as KonteState;
  const levels = shotCueLevels({
    stage: "animatic",
    shotId: "01",
    cueKinds: {
      "animatic:shot.01.slam": "sfx",
      "animatic:timeline.knock": "sfx",
      "reference:thump": "sfx",
      "animatic:shot.02#stem": "sfx",
    },
    state,
    resolvedVariants: { slam: "v-1" },
    timelineResolvedVariants: { knock: "v-1" },
    resolve: () => "v-1",
  });

  it("levels and trims a cue whether it is the shot's, the timeline's, or a reference", () => {
    expect(levels.leadIns).toEqual({
      "animatic:shot.01.slam": 0.1,
      "animatic:timeline.knock": 0.2,
      "reference:thump": 0.3,
    });
    expect(Object.keys(levels.gains)).toEqual(Object.keys(levels.leadIns));
  });

  it("leaves a stem alone, which is already a mix", () => {
    expect(levels.adjustments["animatic:shot.02#stem"]).toEqual({ gain: 1, reason: "stem" });
    expect(levels.gains["animatic:shot.02#stem"]).toBeUndefined();
    expect(levels.leadIns["animatic:shot.02#stem"]).toBeUndefined();
  });
});

describe("shotCueLevels — a clip's own track", () => {
  const clip = (integratedLufs: number) => ({
    variants: {
      "v-1": {
        media: {
          kind: "video",
          width: 1024,
          height: 576,
          fps: 24,
          durationSec: 3,
          audio: { loudness: { integratedLufs, truePeakDb: -30 } },
        },
      },
    },
  });
  const levelsFor = (kind: CueKind) =>
    shotCueLevels({
      stage: "video",
      shotId: "01",
      cueKinds: { "video:shot.01.motion": kind },
      pictureRefs: ["video:shot.01.motion"],
      state: { assets: { "video:shot.01.motion": clip(-30) } } as unknown as KonteState,
      resolvedVariants: { motion: "v-1" },
      resolve: () => "v-1",
    });

  it("brings the mix of a shot that speaks to the voice target", () => {
    // -30 LUFS to the voice target's -18 is +12 dB.
    const levels = levelsFor("voice");
    expect(levels.gains["video:shot.01.motion"]).toBeCloseTo(3.98, 2);
    expect(levels.adjustments["video:shot.01.motion"]).toEqual({
      gain: levels.gains["video:shot.01.motion"],
      limited: true,
    });
  });

  // The true-peak rule sfx is levelled by is meant for a door slam, not a whole soundscape: it
  // would haul a quiet shot up to the level of a loud one.
  it("leaves the mix of a shot that does not speak alone", () => {
    const levels = levelsFor("sfx");
    expect(levels.gains["video:shot.01.motion"]).toBeUndefined();
    expect(levels.adjustments["video:shot.01.motion"]).toEqual({ gain: 1, reason: "no-lines" });
  });

  it("levels a standalone sfx cue as before — the refusal is the clip's track only", () => {
    expect(
      shotCueLevels({
        stage: "video",
        shotId: "01",
        cueKinds: { "video:shot.01.motion": "sfx" },
        pictureRefs: [],
        state: { assets: { "video:shot.01.motion": clip(-30) } } as unknown as KonteState,
        resolvedVariants: { motion: "v-1" },
        resolve: () => "v-1",
      }).gains["video:shot.01.motion"],
    ).toBeDefined();
  });
});

describe("playedLufs", () => {
  it("reports where a source lands once its gain is on it", () => {
    expect(playedLufs({ integratedLufs: -14, truePeakDb: -1 }, 0.5)).toBeCloseTo(-20.02, 2);
    expect(playedLufs({ integratedLufs: -14, truePeakDb: -1 }, 1)).toBe(-14);
  });

  it("has nothing to report for an unmeasured source or a silent gain", () => {
    expect(playedLufs(undefined, 1)).toBeNull();
    expect(playedLufs({ integratedLufs: null, truePeakDb: -1 }, 1)).toBeNull();
    expect(playedLufs({ integratedLufs: -14, truePeakDb: -1 }, 0)).toBeNull();
  });
});
