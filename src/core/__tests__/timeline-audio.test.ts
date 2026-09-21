import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../video-probe.js", () => ({
  probeMediaDuration: vi.fn(async () => 12),
  probeHasAudio: vi.fn(async () => true),
}));

import {
  buildTimelineTracks,
  type RawShotAudio,
  resolveSoundtrackSpan,
  type ResolvedSoundtrack,
  shouldAutoLoop,
} from "../timeline-audio.js";
import type { VariantMedia } from "../types/index.js";
import { probeHasAudio, probeMediaDuration } from "../video-probe.js";

const order = ["01", "02", "03"];
const durations = new Map([
  ["01", 3],
  ["02", 4],
  ["03", 3],
]);

const cue = (over: Partial<RawShotAudio> & Pick<RawShotAudio, "role" | "file">): RawShotAudio => ({
  kind: undefined,
  localStart: 0,
  localEnd: null,
  mediaStart: 0,
  volume: 1,
  cueId: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(probeMediaDuration).mockResolvedValue(12);
});

describe("buildTimelineTracks", () => {
  it("keeps a Sound as an independent play-once track at its absolute position", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map([
        ["02", [cue({ role: "sound", file: "/sfx.mp3", localStart: 1, localEnd: 1.5 })]],
      ]),
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      file: "/sfx.mp3",
      start: 4, // offset(02)=3 + localStart 1
      duration: 0.5,
      loop: false,
    });
  });
});

describe("buildTimelineTracks — recorded media", () => {
  const recorded = new Map<string, VariantMedia>([
    ["/vo.wav", { kind: "audio", durationSec: 5, channels: 1, sampleRate: 24000 }],
    ["/silent.mp4", { kind: "video", width: 16, height: 9, fps: 24, durationSec: 4, audio: null }],
  ]);
  const mediaOf = (file: string) => recorded.get(file);

  beforeEach(() => {
    vi.mocked(probeHasAudio).mockClear();
    vi.mocked(probeMediaDuration).mockClear();
  });

  it("takes a source's length off the record instead of probing for it", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map([["01", [cue({ role: "sound", file: "/vo.wav", mediaStart: 1 })]]]),
      mediaOf,
    });
    // 5s source minus a 1s mediaStart, and no probe spawned to learn it.
    expect(tracks[0]).toMatchObject({ duration: 4 });
    expect(probeMediaDuration).not.toHaveBeenCalled();
  });

  it("drops an embedded clip the record says carries no audio, without probing", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map([["02", [cue({ role: "embedded", file: "/silent.mp4" })]]]),
      mediaOf,
    });
    expect(tracks).toEqual([]);
    expect(probeHasAudio).not.toHaveBeenCalled();
  });

  it("falls back to probing a source no record covers", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map([["01", [cue({ role: "sound", file: "/bed.mp3" })]]]),
      mediaOf,
    });
    expect(tracks[0]).toMatchObject({ duration: 12 });
    expect(probeMediaDuration).toHaveBeenCalledWith("/bed.mp3");
  });
});

describe("buildTimelineTracks — timeline soundtracks", () => {
  const bed = (over: Partial<ResolvedSoundtrack> = {}): ResolvedSoundtrack => ({
    id: "main",
    file: "/bgm.mp3",
    mediaStart: 0,
    volume: 0.3,
    duck: false,
    ...over,
  });

  it("resolves from/until shot anchors to an absolute span", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map(),
      soundtracks: [bed({ from: { shot: "02", at: 1 }, until: { shot: "03", at: 2 } })],
    });
    expect(tracks).toHaveLength(1);
    // from: offset(02)=3 + 1 = 4 ; until: offset(03)=7 + 2 = 9
    expect(tracks[0]).toMatchObject({ start: 4, duration: 5, volume: 0.3 });
  });

  it("defaults: no from→timeline start, no until→timeline end, until.at omitted→that shot's end", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map(),
      soundtracks: [
        bed({ id: "full" }), // 0 → total 10
        bed({ id: "toShot1End", until: { shot: "01" } }), // 0 → offset(01)=0 + dur(01)=3
      ],
    });
    expect(tracks.find((t) => t.duration === 10)).toMatchObject({ start: 0 });
    expect(tracks.find((t) => t.duration === 3)).toMatchObject({ start: 0 });
  });

  it("treats overlapping soundtracks as independent tracks", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map(),
      soundtracks: [
        bed({ id: "a", until: { shot: "02", at: 1 } }), // 0 → 4
        bed({ id: "b", from: { shot: "02" } }), // 3 → end (overlaps a)
      ],
    });
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.start)).toEqual([0, 3]);
  });

  it("ducks under a line the picture carries, not only under a standalone cue", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map([
        ["02", [cue({ role: "embedded", kind: "voice", file: "/take.mp4", localEnd: 4 })]],
      ]),
      soundtracks: [bed({ duck: true })],
    });
    // offset(02)=3, so the line runs 3→7 and the bed dips once across it.
    expect(tracks.find((t) => t.file === "/bgm.mp3")?.duck?.steps).toHaveLength(1);
  });

  it("ducks from where the line's sound starts, not from where its clip does", async () => {
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map([
        ["02", [cue({ role: "sound", kind: "voice", file: "/vo.wav", localEnd: 2 })]],
      ]),
      soundtracks: [bed({ duck: true })],
      mediaOf: () => ({
        kind: "audio",
        durationSec: 2,
        channels: 1,
        sampleRate: 24000,
        loudness: { integratedLufs: -20, truePeakDb: -3, leadInSec: 0.4 },
      }),
    });
    // The clip sits at 3→5, but it opens on 0.4s of silence: the dip lands on 3.4, not 3.
    expect(tracks.find((t) => t.file === "/bgm.mp3")?.duck?.steps).toEqual([
      { a: 3.25, b: 3.4, c: 5.2, d: expect.closeTo(5.6, 6) },
    ]);
  });

  it("loops a bed shorter than its span and threads fades", async () => {
    vi.mocked(probeMediaDuration).mockResolvedValue(5);
    const tracks = await buildTimelineTracks({
      shotOrder: order,
      actualDurations: durations,
      audioByShot: new Map(),
      soundtracks: [bed({ fadeIn: 1, fadeOut: 2 })], // span 0→10, source 5s
    });
    expect(tracks[0]).toMatchObject({ loop: true, fadeIn: 1, fadeOut: 2 });
  });
});

describe("shouldAutoLoop", () => {
  it("does not loop when the source undershoots the span within slack", () => {
    expect(shouldAutoLoop(14.95, 15)).toBe(false);
    expect(shouldAutoLoop(14.75, 15)).toBe(false);
  });

  it("loops when the source falls short of the span by more than the slack", () => {
    expect(shouldAutoLoop(14.7, 15)).toBe(true);
    expect(shouldAutoLoop(6, 7)).toBe(true);
  });

  it("does not loop a source at least as long as the span", () => {
    expect(shouldAutoLoop(15, 15)).toBe(false);
    expect(shouldAutoLoop(20, 15)).toBe(false);
  });
});

describe("resolveSoundtrackSpan", () => {
  const offsets = new Map([
    ["01", 0],
    ["02", 3],
    ["03", 7],
  ]);
  const total = 10;

  it("defaults to the whole timeline when no anchors are given", () => {
    expect(resolveSoundtrackSpan({}, offsets, durations, total)).toEqual({ start: 0, end: 10 });
  });

  it("resolves from/until anchors with explicit at", () => {
    expect(
      resolveSoundtrackSpan(
        { from: { shot: "02", at: 1 }, until: { shot: "03", at: 2 } },
        offsets,
        durations,
        total,
      ),
    ).toEqual({ start: 4, end: 9 });
  });

  it("defaults at: from→shot head, until→shot end", () => {
    expect(resolveSoundtrackSpan({ from: { shot: "02" } }, offsets, durations, total)).toEqual({
      start: 3,
      end: 10,
    });
    expect(resolveSoundtrackSpan({ until: { shot: "01" } }, offsets, durations, total)).toEqual({
      start: 0,
      end: 3, // offset(01)=0 + duration(01)=3
    });
  });
});
