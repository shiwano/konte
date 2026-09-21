import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineVideo, asset } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { pendingShot, shot, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";
import { KonteError } from "../errors.js";
import { buildRenderPlan, buildStageReviewPlan, frameAlignedDurations } from "../render-plan.js";
import { StateManager } from "../state/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: {
    text: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const renderComfy = defineComfyAsset({
  workflow: "render.json",
  description: "test adapter",
  inputs: {
    scene: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const animateWithImageComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    bg: { nodeId: "2", field: "bg", type: "video" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

let tmpDir: string;
let manager: StateManager;

const testVideo = defineVideo(
  testDirection({
    fps: 30,
    size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
  }),
  {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            asset("motion", animateComfy, { prompt: "a cat walking" });
            asset("voice", ttsComfy, { text: "hello world" });
            return el();
          },
        }),
        shot("02", {
          duration: 3,
          build: () => {
            asset("motion", renderComfy, { scene: "forest" });
            return el();
          },
        }),
      ]),
  },
);

function setupAccepted(manager: StateManager, address: string, file: string): void {
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  manager.setAccepted(address, variantId);
}

function setupReady(manager: StateManager, address: string, file: string): string {
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  return variantId;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-render-test-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const pendingVideo = defineVideo(
  testDirection({
    fps: 30,
    size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
  }),
  {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            asset("motion", animateComfy, { prompt: "a cat walking" });
            return el();
          },
        }),
        pendingShot("02", { duration: 3, action: "the payoff, later" }),
      ]),
  },
);

describe("buildRenderPlan", () => {
  it("plans a pending shot as an undeveloped tile with no assets or warnings, and gates only the developed shot", () => {
    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");

    const plan = buildRenderPlan(pendingVideo, manager, {
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.shots).toHaveLength(2);
    const pending = plan.shots[1]!;
    expect(pending.shotId).toBe("02");
    expect(pending.pending).toBe(true);
    expect(pending.action).toBe("the payoff, later");
    expect(pending.shotFn).toBeNull();
    expect(pending.fallbackFile).toBeNull();
    expect(pending.warnings).toEqual([]);
  });

  it("builds plan with shotFn shot and resolves files by asset name", () => {
    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");
    setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");

    setupAccepted(manager, "video:shot.02.motion", "output/forest.png");

    const plan = buildRenderPlan(testVideo, manager, {
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.fps).toBe(30);
    expect(plan.size).toEqual({ width: 1024, height: 576 });
    expect(plan.shots).toHaveLength(2);

    const shot01 = plan.shots[0]!;
    expect(shot01.shotId).toBe("01");
    expect(shot01.shotFn).toBeDefined();
    expect(shot01.resolvedFiles.motion).toContain("output/motion.mp4");
    expect(shot01.resolvedFiles.voice).toContain("output/voice.wav");
    expect(shot01.fallbackFile).toBeNull();
    expect(shot01.warnings).toEqual([]);

    const shot02 = plan.shots[1]!;
    expect(shot02.shotId).toBe("02");
    expect(shot02.shotFn).toBeDefined();
    expect(shot02.resolvedFiles.motion).toContain("output/forest.png");
  });

  it("throws SHOT_NOT_FOUND for non-existent shot", () => {
    expect(() =>
      buildRenderPlan(testVideo, manager, {
        shotId: "99",
        outputDir: path.join(tmpDir, "dist"),
      }),
    ).toThrow(KonteError);

    expect(() =>
      buildRenderPlan(testVideo, manager, {
        shotId: "99",
        outputDir: path.join(tmpDir, "dist"),
      }),
    ).toThrow("not found");
  });

  it("filters to single shot when shotId is specified", () => {
    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");
    setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");

    const plan = buildRenderPlan(testVideo, manager, {
      shotId: "01",
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0]!.shotId).toBe("01");
  });

  it("throws RENDER_PLAN_FAILED when no accepted variant exists", () => {
    expect(() =>
      buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
      }),
    ).toThrow(KonteError);

    try {
      buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
      });
    } catch (e) {
      const msg = (e as KonteError).message;
      expect(msg).toContain("Assets without accepted variants");
      expect(msg).toContain("--preview");
    }
  });

  it("warns when shot has no renderable asset (no shotFn)", () => {
    const videoNoAsset: import("../types/index.js").VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "test shot",
          assets: {},
        },
      ],
    };

    const plan = buildRenderPlan(videoNoAsset, manager, {
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.shots[0]!.warnings).toContainEqual(expect.stringContaining("no composition"));
    expect(plan.shots[0]!.warnings).toContainEqual(expect.stringContaining("no renderable asset"));
  });

  it("throws RENDER_PLAN_FAILED listing only unaccepted assets", () => {
    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");

    expect(() =>
      buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
      }),
    ).toThrow(KonteError);

    try {
      buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
      });
    } catch (e) {
      expect(e).toBeInstanceOf(KonteError);
      const msg = (e as KonteError).message;
      expect(msg).toContain("video:shot.01.voice");
      expect(msg).toContain("video:shot.02.motion");
      expect(msg).not.toContain("video:shot.01.motion");
    }
  });

  it("only validates assets of the target shot when shotId is specified", () => {
    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");
    setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");

    const plan = buildRenderPlan(testVideo, manager, {
      shotId: "01",
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0]!.shotId).toBe("01");
  });

  it("resolves timeline assets files into timelineResolvedFiles", () => {
    const videoWithTimeline = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", imageComfy, { prompt: "a girl" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("motion", animateWithImageComfy, { image: character });
                return el();
              },
            }),
          ]);
        },
      },
    );

    setupAccepted(manager, "video:timeline.character", "output/character.png");
    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");

    const plan = buildRenderPlan(videoWithTimeline, manager, {
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.timelineResolvedFiles.character).toContain("output/character.png");
    expect(plan.timelineFn).toBeDefined();
  });

  it("does not require accepted variants for shots without shotFn", () => {
    const videoFallback: import("../types/index.js").VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "test shot",
          assets: {
            bg: {
              kind: "comfy" as const,
              workflow: "bg.json",
              inputs: {},
            },
          },
        },
      ],
    };

    const plan = buildRenderPlan(videoFallback, manager, {
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0]!.warnings).toContainEqual(expect.stringContaining("no composition"));
  });

  it("still requires accepted variants for shots with shotFn", () => {
    expect(() =>
      buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
      }),
    ).toThrow("Assets without accepted variants");
  });

  it("handles mixed shots: shotFn required + fallback not required", () => {
    const videoMixed = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("motion", animateComfy, { prompt: "a cat" });
                return el();
              },
            }),
          ]),
      },
    );

    (videoMixed.shots as import("../types/index.js").ShotDefinition[]).push({
      id: "02",
      duration: 3,
      action: "test shot",
      assets: {
        bg: {
          kind: "comfy" as const,
          workflow: "bg.json",
          inputs: {},
        },
      },
    });

    setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");

    const plan = buildRenderPlan(videoMixed, manager, {
      outputDir: path.join(tmpDir, "dist"),
    });

    expect(plan.shots).toHaveLength(2);
    expect(plan.shots[0]!.shotFn).toBeDefined();
    expect(plan.shots[1]!.shotFn).toBeNull();
    expect(plan.shots[1]!.warnings).toContainEqual(expect.stringContaining("no composition"));
  });

  describe("allowUnaccepted", () => {
    it("uses ready variant (status: none + file) when allowUnaccepted is true", () => {
      setupReady(manager, "video:shot.01.motion", "output/motion.mp4");
      setupReady(manager, "video:shot.01.voice", "output/voice.wav");
      setupReady(manager, "video:shot.02.motion", "output/forest.png");

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
      });

      expect(plan.shots).toHaveLength(2);
      expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion.mp4");
      expect(plan.shots[0]!.resolvedFiles.voice).toContain("output/voice.wav");
      expect(plan.shots[1]!.resolvedFiles.motion).toContain("output/forest.png");
    });

    it("prefers accepted variant over ready variant", () => {
      setupReady(manager, "video:shot.01.motion", "output/motion-ready.mp4");
      setupAccepted(manager, "video:shot.01.motion", "output/motion-accepted.mp4");
      setupReady(manager, "video:shot.01.voice", "output/voice.wav");
      setupReady(manager, "video:shot.02.motion", "output/forest.png");

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
      });

      expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion-accepted.mp4");
      expect(plan.shots[0]!.unacceptedAssets).not.toContain("video:shot.01.motion");
      expect(plan.shots[0]!.unacceptedAssets).toContain("video:shot.01.voice");
    });

    it("excludes input-stale variants", () => {
      // upstream voice is accepted with a known output hash
      setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");
      const voiceVid = manager.getAcceptedVariant("video:shot.01.voice")!;
      manager.getAssetState("video:shot.01.voice").variants![voiceVid]!.outputHash = "current";

      // motion recorded a stale fingerprint for that upstream
      const variantId = setupReady(manager, "video:shot.01.motion", "output/motion.mp4");
      manager.getAssetState("video:shot.01.motion").variants![variantId]!.inputFingerprints = {
        "video:shot.01.voice": "outdated",
      };

      expect(() =>
        buildRenderPlan(testVideo, manager, {
          outputDir: path.join(tmpDir, "dist"),
          allowUnaccepted: true,
        }),
      ).toThrow("Assets without ready variants");

      // The error explains why: the sole variant is input-stale on the changed upstream.
      expect(() =>
        buildRenderPlan(testVideo, manager, {
          outputDir: path.join(tmpDir, "dist"),
          allowUnaccepted: true,
        }),
      ).toThrow("stale (input-stale: video:shot.01.voice)");
    });

    // The gate is the resolver's verdict, not "is every take fresh": a human accept is protected
    // on both staleness axes and goes on resolving.
    it("keeps a stale ACCEPTED take, which is what resolution hands the render", () => {
      setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");
      const voiceVid = manager.getAcceptedVariant("video:shot.01.voice")!;
      manager.getAssetState("video:shot.01.voice").variants![voiceVid]!.outputHash = "current";

      setupReady(manager, "video:shot.02.motion", "output/forest.png");

      // The motion take is accepted, and input-stale on that upstream.
      setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");
      const motionVid = manager.getAcceptedVariant("video:shot.01.motion")!;
      manager.getAssetState("video:shot.01.motion").variants![motionVid]!.inputFingerprints = {
        "video:shot.01.voice": "outdated",
      };

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
      });
      expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion.mp4");
    });

    // The strict preflight has to agree with resolution: a dismissed take resolves to nothing, so
    // an address left holding only those must fail here rather than register an export whose input
    // cannot be resolved later.
    it("excludes dismissed variants", () => {
      const variantId = setupReady(manager, "video:shot.01.motion", "output/motion.mp4");
      manager.getAssetState("video:shot.01.motion").variants![variantId]!.status = "dismissed";
      setupReady(manager, "video:shot.01.voice", "output/voice.wav");
      setupReady(manager, "video:shot.02.motion", "output/forest.png");

      expect(() =>
        buildRenderPlan(testVideo, manager, {
          outputDir: path.join(tmpDir, "dist"),
          allowUnaccepted: true,
        }),
      ).toThrow("Assets without ready variants");
      expect(() =>
        buildRenderPlan(testVideo, manager, {
          outputDir: path.join(tmpDir, "dist"),
          allowUnaccepted: true,
        }),
      ).toThrow("dismissed");
    });

    it("tracks unacceptedAssets correctly", () => {
      setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");
      setupReady(manager, "video:shot.01.voice", "output/voice.wav");
      setupReady(manager, "video:shot.02.motion", "output/forest.png");

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
      });

      expect(plan.shots[0]!.unacceptedAssets).toEqual(["video:shot.01.voice"]);
      expect(plan.shots[1]!.unacceptedAssets).toEqual(["video:shot.02.motion"]);
    });

    it("returns empty unacceptedAssets when all assets are accepted", () => {
      setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");
      setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");
      setupAccepted(manager, "video:shot.02.motion", "output/forest.png");

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
      });

      expect(plan.shots[0]!.unacceptedAssets).toEqual([]);
      expect(plan.shots[1]!.unacceptedAssets).toEqual([]);
      expect(plan.unacceptedTimelineAssets).toEqual([]);
    });

    it("tracks unacceptedTimelineAssets for timeline assets", () => {
      const videoWithTimeline = defineVideo(
        testDirection({
          fps: 30,
          size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
        }),
        {
          timeline: () => {
            const character = asset("character", imageComfy, { prompt: "a girl" });
            return videoTimeline([
              shot("01", {
                duration: 5,
                build: () => {
                  asset("motion", animateWithImageComfy, { image: character });
                  return el();
                },
              }),
            ]);
          },
        },
      );

      setupReady(manager, "video:timeline.character", "output/character.png");
      setupAccepted(manager, "video:shot.01.motion", "output/motion.mp4");

      const plan = buildRenderPlan(videoWithTimeline, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
      });

      expect(plan.unacceptedTimelineAssets).toEqual(["video:timeline.character"]);
      expect(plan.timelineResolvedFiles.character).toContain("output/character.png");
    });

    it("throws error when no ready variant exists with allowUnaccepted", () => {
      expect(() =>
        buildRenderPlan(testVideo, manager, {
          outputDir: path.join(tmpDir, "dist"),
          allowUnaccepted: true,
        }),
      ).toThrow("Assets without ready variants");

      // With no variants at all, the reason says so rather than being a bare address.
      expect(() =>
        buildRenderPlan(testVideo, manager, {
          outputDir: path.join(tmpDir, "dist"),
          allowUnaccepted: true,
        }),
      ).toThrow("no variants yet");
    });

    it("builds a partial plan instead of throwing with allowNotReady", () => {
      // Only shot 01's motion is ready; its voice and shot 02's motion are absent.
      setupReady(manager, "video:shot.01.motion", "output/motion.mp4");

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
        allowNotReady: true,
      });

      expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion.mp4");
      expect(plan.shots[0]!.notReadyAssets).toEqual([
        expect.stringContaining("voice — no variants yet"),
      ]);
      expect(plan.shots[1]!.notReadyAssets).toEqual([
        expect.stringContaining("motion — no variants yet"),
      ]);
    });

    it("shows a stale-but-present variant instead of marking it not-ready with allowNotReady", () => {
      setupAccepted(manager, "video:shot.01.voice", "output/voice.wav");
      const voiceVid = manager.getAcceptedVariant("video:shot.01.voice")!;
      manager.getAssetState("video:shot.01.voice").variants![voiceVid]!.outputHash = "current";

      const motionVid = setupReady(manager, "video:shot.01.motion", "output/motion.mp4");
      manager.getAssetState("video:shot.01.motion").variants![motionVid]!.inputFingerprints = {
        "video:shot.01.voice": "outdated",
      };

      const plan = buildRenderPlan(testVideo, manager, {
        outputDir: path.join(tmpDir, "dist"),
        allowUnaccepted: true,
        allowNotReady: true,
      });

      // The stale motion still resolves (last file shown), so it isn't listed as pending.
      expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion.mp4");
      expect(plan.shots[0]!.notReadyAssets).toEqual([]);
    });
  });
});

describe("frameAlignedDurations", () => {
  const spans = (durations: number[], fps: number): number[] => [
    ...frameAlignedDurations(
      durations.map((duration, i) => ({ id: `s${i}`, duration })),
      fps,
    ).values(),
  ];

  it("leaves a span that already lands whole frames untouched", () => {
    expect(spans([0.5, 3.5, 4], 24)).toEqual([0.5, 3.5, 4]);
  });

  it("cuts off-frame spans at the nearest frame so the cut keeps the direction's length", () => {
    const result = spans([2.3, 3.1, 4.55, 4.55], 24);
    expect(result.map((d) => Math.round(d * 24))).toEqual([55, 75, 109, 109]);
    expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(14.5, 9);
  });

  it("gives a span shorter than half a frame one frame", () => {
    expect(spans([0.01, 1], 24).map((d) => Math.round(d * 24))).toEqual([1, 23]);
  });
});

// The review's plan builder. Its whole reason to exist is that the review UI and the review submit
// must build the plan identically: they diverged once (submit omitted `allowNotReady`), submit threw
// on the first not-ready asset, and every shot accept in that review was silently dropped.
describe("buildStageReviewPlan", () => {
  it("plans every shot when an asset has no variant yet — the review must not die on a half-generated video", () => {
    setupReady(manager, "video:shot.01.motion", "output/motion.mp4");
    setupReady(manager, "video:shot.01.voice", "output/voice.wav");
    // shot 02's motion is never generated: the shape that made submit throw.

    const plan = buildStageReviewPlan(testVideo, manager);

    expect(plan.shots.map((s) => s.shotId)).toEqual(["01", "02"]);
    expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion.mp4");
    expect(plan.shots[1]!.notReadyAssets).toEqual([expect.stringContaining("motion")]);
  });

  it("plans a video with nothing generated at all rather than throwing", () => {
    expect(() => buildStageReviewPlan(testVideo, manager)).not.toThrow();
    expect(buildStageReviewPlan(testVideo, manager).shots).toHaveLength(2);
  });

  it("resolves unaccepted takes — a review signs off what has not been accepted yet", () => {
    setupReady(manager, "video:shot.01.motion", "output/motion.mp4");

    const plan = buildStageReviewPlan(testVideo, manager);

    expect(plan.shots[0]!.unacceptedAssets).toContain("video:shot.01.motion");
    expect(plan.shots[0]!.resolvedFiles.motion).toContain("output/motion.mp4");
  });
});
