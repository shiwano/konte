import { describe, expect, it } from "vitest";
import { buildOrphanContext } from "../orphans.js";
import type {
  ReferenceDefinition,
  AnimaticDefinition,
  KonteState,
  VideoDefinition,
} from "../types/index.js";

const video = {
  stage: "video" as const,
  format: { fps: 24, size: { width: 1280, height: 720 } },
  shots: [
    { id: "01", duration: 3, assets: { motion: { kind: "fal" } }, shotFn: () => null },
    { id: "02", duration: 3, assets: { motion: { kind: "fal" } } },
  ],
} as unknown as VideoDefinition;

const animatic = {
  stage: "animatic" as const,
  format: { size: { width: 1280, height: 720 }, fps: 30 },
  shots: [{ id: "01", assets: { frame: { kind: "comfy" } } }],
} as unknown as AnimaticDefinition;

const reference = {
  topLevelAssets: { cat: { kind: "comfy" } },
  shots: [],
} as unknown as ReferenceDefinition;

describe("buildOrphanContext", () => {
  it("does not flag a bare shot-level feedback target whose shot still exists", () => {
    const { isOrphan } = buildOrphanContext(video, animatic);
    expect(isOrphan("video:shot.01")).toBe(false);
    expect(isOrphan("video:shot.02")).toBe(false);
    expect(isOrphan("animatic:shot.01")).toBe(false);
  });

  it("flags a bare shot-level feedback target for a shot no longer in the definition", () => {
    const { isOrphan } = buildOrphanContext(video, animatic);
    expect(isOrphan("video:shot.99")).toBe(true);
  });

  it("still flags asset-level addresses that are absent from the definition", () => {
    const { isOrphan } = buildOrphanContext(video, animatic);
    expect(isOrphan("video:shot.01.motion")).toBe(false);
    expect(isOrphan("video:shot.01.gone")).toBe(true);
    expect(isOrphan("video:shot.99.motion")).toBe(true);
  });

  it("does not flag a composition baseline the pipeline auto-materializes", () => {
    const { isOrphan } = buildOrphanContext(video, animatic);
    expect(isOrphan("video:shot.01#composition")).toBe(false);
  });

  it("does not flag a reference asset declared in the reference stage", () => {
    const { isOrphan } = buildOrphanContext(video, animatic, reference);
    expect(isOrphan("reference:cat")).toBe(false);
  });

  it("does not flag a shot or timeline stem the pipeline auto-materializes", () => {
    const stemVideo = {
      stage: "video" as const,
      format: { fps: 24, size: { width: 1280, height: 720 } },
      shots: [
        {
          id: "01",
          duration: 3,
          assets: { motion: { kind: "fal" } },
          shotFn: () => null,
          stemRefs: ["video:shot.01.motion"],
        },
      ],
      timelineSoundtracks: [
        {
          __soundtrackEntry: true,
          id: "bed",
          src: { src: "__konte:reference:bgm__" },
          options: {},
        },
      ],
    } as unknown as VideoDefinition;
    const { isOrphan } = buildOrphanContext(stemVideo, null);
    expect(isOrphan("video:shot.01#stem")).toBe(false);
    expect(isOrphan("video:timeline#stem")).toBe(false);
  });

  it("keeps a stem still accepted after its shot stopped sounding anything", () => {
    const state = {
      assets: { "video:shot.01#stem": { variants: { "v-1": { status: "accepted" } } } },
    } as unknown as KonteState;
    expect(
      buildOrphanContext(video, animatic, undefined, undefined, state).isOrphan(
        "video:shot.01#stem",
      ),
    ).toBe(false);
    const released = {
      assets: { "video:shot.01#stem": { variants: { "v-1": { status: "undecided" } } } },
    } as unknown as KonteState;
    expect(
      buildOrphanContext(video, animatic, undefined, undefined, released).isOrphan(
        "video:shot.01#stem",
      ),
    ).toBe(true);
  });

  // The board has leaves of its own. Read against the video definition they match no shot, so
  // `prune` would delete the composition's accept and its HTML, and `doctor` would warn about both.
  it("does not flag the animatic's own materialized leaves", () => {
    const board = {
      stage: "animatic" as const,
      format: { size: { width: 1280, height: 720 }, fps: 30 },
      shots: [{ id: "01", assets: { frame: { kind: "comfy" } }, shotFn: () => null }],
      timelineSoundtracks: [
        {
          __soundtrackEntry: true,
          id: "bed",
          src: { src: "__konte:reference:bgm__" },
          options: {},
        },
      ],
    } as unknown as AnimaticDefinition;
    const { isOrphan } = buildOrphanContext(video, board);
    expect(isOrphan("animatic:shot.01#composition")).toBe(false);
    expect(isOrphan("animatic:timeline#stem")).toBe(false);
    // A leaf for a shot the board no longer declares is still an orphan.
    expect(isOrphan("animatic:shot.09#composition")).toBe(true);
  });
});
