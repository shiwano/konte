import { describe, expect, it } from "vitest";
import { shotGalleryTabs, soundtrackGalleryTabs } from "../gallery-tabs.js";

const take = [{}];

describe("shotGalleryTabs", () => {
  it("orders the shot's assets as the timeline stacks them", () => {
    const shot = {
      shotId: "01",
      assets: [
        { address: "video:shot.01.bg", variants: take },
        { address: "video:shot.01.motion", variants: take },
        { address: "video:shot.01.title", variants: take },
      ],
      clips: [
        { address: "video:shot.01.title", mediaType: "image" as const, start: 1 },
        { address: "video:shot.01.bg", mediaType: "image" as const, start: 0 },
        { address: "video:shot.01.sfx", mediaType: "audio" as const, start: 0.6 },
        { address: "video:shot.01.motion", mediaType: "video" as const, start: 0 },
      ],
    };
    const audio = [
      {
        address: "reference:bgm",
        kind: "soundtrack" as const,
        variants: take,
        cues: [{ start: 0 }],
      },
      {
        address: "video:shot.01.sfx",
        kind: "sound" as const,
        variants: take,
        cues: [{ start: 0.6, shotId: "01" }],
      },
      {
        address: "video:shot.01.narration",
        kind: "sound" as const,
        variants: take,
        cues: [{ start: 0.2, shotId: "01" }],
      },
    ];
    expect(shotGalleryTabs(shot, audio)).toEqual([
      "video:shot.01.motion",
      "video:shot.01.bg",
      "video:shot.01.title",
      "video:shot.01.narration",
      "video:shot.01.sfx",
    ]);
  });

  it("leaves out an asset with no take, a clip outside the shot's pool, and another shot's cue", () => {
    const shot = {
      shotId: "02",
      assets: [
        { address: "video:shot.02.motion", variants: [] },
        { address: "video:shot.02.bg", variants: take },
      ],
      clips: [
        { address: "video:shot.02.motion", mediaType: "video" as const, start: 0 },
        { address: "animatic:shot.02.first", mediaType: "image" as const, start: 0 },
        { address: "video:shot.02.bg", mediaType: "image" as const, start: 0 },
        { address: null, mediaType: "image" as const, start: 0 },
      ],
    };
    const audio = [
      {
        address: "reference:whoosh",
        kind: "sound" as const,
        variants: take,
        cues: [
          { start: 0.5, shotId: "01" },
          { start: 3.5, shotId: "02" },
        ],
      },
      {
        address: "video:shot.01.sfx",
        kind: "sound" as const,
        variants: take,
        cues: [{ start: 1, shotId: "01" }],
      },
    ];
    expect(shotGalleryTabs(shot, audio)).toEqual(["video:shot.02.bg", "reference:whoosh"]);
  });
});

describe("soundtrackGalleryTabs", () => {
  it("lists the beds with takes by start time, once each", () => {
    const audio = [
      {
        address: "reference:outro",
        kind: "soundtrack" as const,
        variants: take,
        cues: [{ start: 8 }],
      },
      {
        address: "reference:bgm",
        kind: "soundtrack" as const,
        variants: take,
        cues: [{ start: 0 }, { start: 12 }],
      },
      {
        address: "reference:silence",
        kind: "soundtrack" as const,
        variants: [],
        cues: [{ start: 4 }],
      },
      {
        address: "video:shot.01.sfx",
        kind: "sound" as const,
        variants: take,
        cues: [{ start: 1, shotId: "01" }],
      },
    ];
    expect(soundtrackGalleryTabs(audio)).toEqual(["reference:bgm", "reference:outro"]);
  });
});
