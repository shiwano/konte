import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineVideo, asset, defineReference, soundtrack, videoFile } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { pendingShot, shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { KonteError } from "../errors.js";
import {
  buildDependencyGraph,
  collectTransitiveDependents,
  listBoardlessVideoShots,
  listPanelReferenceReach,
  listUnusedAssetPaths,
  videoDependentsHoldVerdicts,
  type DependencyGraph,
} from "../graph.js";
import type {
  AnimaticDefinition,
  AssetDefinition,
  ReferenceDefinition,
  VideoDefinition,
} from "../types/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

// A composition element that renders the given MediaAssets, so their placeholders
// are captured into shot.compositionRefs during discovery.
function composed(...srcs: Array<{ src: string }>): React.ReactElement {
  return {
    type: Composition,
    props: {
      children: srcs.map((src) => ({ type: "Video", props: { src } })),
    },
  } as unknown as React.ReactElement;
}

const simpleComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

const comfyA = defineComfyAsset({
  workflow: "a.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

const comfyB = defineComfyAsset({
  workflow: "b.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "audio" } },
});

const enhanceComfy = defineComfyAsset({
  workflow: "enhance.json",
  description: "test adapter",
  inputs: {
    firstFrame: { nodeId: "1", field: "image", type: "video" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const mergeComfy = defineComfyAsset({
  workflow: "merge.json",
  description: "test adapter",
  inputs: {
    sources: { nodeId: "1", field: "sources", type: "video" },
    config: { nodeId: "2", field: "config", type: "audio" },
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
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const animateWithBg = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    background: { nodeId: "1", field: "bg", type: "video" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const seedComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    sampler: { nodeId: "5", field: "seed", type: "seed" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

describe("buildDependencyGraph", () => {
  it("builds graph for independent assets", () => {
    const video = defineVideo(
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
                asset("motion", simpleComfy, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01.motion") ?? [])]).toEqual([]);
  });

  it("registers a pending shot with no composition node and no asset paths", () => {
    const video = defineVideo(
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
                asset("motion", simpleComfy, {});
                return el();
              },
            }),
            pendingShot("02", {
              duration: 4,
              action: "the payoff, later",
            }),
          ]),
      },
    );

    const pending = video.shots.find((s) => s.id === "02");
    expect(pending?.pending).toBe(true);
    expect(pending?.shotFn).toBeUndefined();
    expect(pending?.assets).toEqual({});

    const graph = buildDependencyGraph(video);
    expect(graph.dependencies.has("video:shot.01#composition")).toBe(true);
    expect(graph.dependencies.has("video:shot.02#composition")).toBe(false);
    expect([...graph.dependencies.keys()].some((k) => k.startsWith("video:shot.02"))).toBe(false);
  });

  it("builds graph with no dependencies (all comfy)", () => {
    const video = defineVideo(
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
                asset("a", comfyA, {});
                asset("b", comfyB, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01.a") ?? [])]).toEqual([]);
    expect([...(graph.dependencies.get("video:shot.01.b") ?? [])]).toEqual([]);
  });

  it("builds correct dependents (reverse of dependencies)", () => {
    const video = defineVideo(
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
                asset("motion", simpleComfy, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependents.get("video:shot.01.motion") ?? [])]).toEqual([]);
  });

  it("produces valid topological order", () => {
    const video = defineVideo(
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
                asset("motion", simpleComfy, {});
                asset("voice", ttsComfy, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);
    const order = graph.topologicalOrder;

    expect(order).toContain("video:shot.01.motion");
    expect(order).toContain("video:shot.01.voice");
  });

  it("throws CYCLE_DETECTED for circular dependency A -> B -> A", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "test shot",
          assets: {
            a: {
              kind: "comfy",
              workflow: "a.json",
              inputs: { ref: "__konte:video:shot.01.b__" },
            },
            b: {
              kind: "comfy",
              workflow: "b.json",
              inputs: { ref: "__konte:video:shot.01.a__" },
            },
          },
        },
      ],
    };

    let error: unknown;
    try {
      buildDependencyGraph(video);
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as Error).message).toMatch(/cycle detected/i);
  });

  it("throws CYCLE_DETECTED for self-reference A -> A", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "test shot",
          assets: {
            a: {
              kind: "comfy",
              workflow: "a.json",
              inputs: { ref: "__konte:video:shot.01.a__" },
            },
          },
        },
      ],
    };

    let error: unknown;
    try {
      buildDependencyGraph(video);
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as Error).message).toMatch(/cycle detected/i);
  });

  it("throws INVALID_REFERENCE for non-existent address", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "test shot",
          assets: {
            a: {
              kind: "comfy",
              workflow: "a.json",
              inputs: { ref: "__konte:video:shot.99.nonexistent__" },
            },
          },
        },
      ],
    };

    let error: unknown;
    try {
      buildDependencyGraph(video);
      expect.unreachable("Expected to throw");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KonteError);
    expect((error as Error).message).toContain("non-existent path");
  });

  it("detects dependencies via MediaAsset placeholder in comfy inputs", () => {
    const video = defineVideo(
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
                const motion = asset("motion", simpleComfy, {});
                asset("enhanced", enhanceComfy, { firstFrame: motion });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01.enhanced") ?? [])]).toEqual([
      "video:shot.01.motion",
    ]);
  });

  it("does not treat seed() placeholder as an asset dependency", () => {
    const video = defineVideo(
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
                asset("motion", seedComfy, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01.motion") ?? [])]).toEqual([]);
  });

  it("detects nested MediaAsset placeholders in comfy inputs", () => {
    const video = defineVideo(
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
                const motion = asset("motion", simpleComfy, {});
                const voice = asset("voice", ttsComfy, {});
                asset("final", mergeComfy, {
                  sources: motion,
                  config: voice,
                });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01.final") ?? [])].sort()).toEqual([
      "video:shot.01.motion",
      "video:shot.01.voice",
    ]);
  });

  it("collectTransitiveDependents returns the downstream cone in dependency order", () => {
    const video = defineVideo(
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
                const motion = asset("motion", simpleComfy, {});
                const enhanced = asset("enhanced", enhanceComfy, { firstFrame: motion });
                asset("final", enhanceComfy, { firstFrame: enhanced });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect(collectTransitiveDependents(graph, "video:shot.01.motion")).toEqual([
      "video:shot.01.enhanced",
      "video:shot.01.final",
    ]);
    expect(collectTransitiveDependents(graph, "video:shot.01.enhanced")).toEqual([
      "video:shot.01.final",
    ]);
    expect(collectTransitiveDependents(graph, "video:shot.01.final")).toEqual([]);
  });

  it("handles empty video (no shots)", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => videoTimeline([]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect(graph.dependencies.size).toBe(0);
    expect(graph.dependents.size).toBe(0);
    expect([...graph.topologicalOrder]).toEqual([]);
  });

  it("reference file asset has no dependencies (leaf node)", () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => videoTimeline([]),
      },
    );

    const graph = buildDependencyGraph(video, undefined, reference);

    expect([...(graph.dependencies.get("reference:bg") ?? [])]).toEqual([]);
  });

  it("other assets can depend on a reference file via MediaAsset", () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });
    const video = defineVideo(
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
                asset("motion", animateWithBg, { background: reference.bg });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video, undefined, reference);

    expect([...(graph.dependencies.get("reference:bg") ?? [])]).toEqual([]);
    expect([...(graph.dependencies.get("video:shot.01.motion") ?? [])]).toEqual(["reference:bg"]);
    expect([...(graph.dependents.get("reference:bg") ?? [])]).toEqual(["video:shot.01.motion"]);
  });

  it("builds graph with timeline assets dependencies", () => {
    const video = defineVideo(
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

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:timeline.character") ?? [])]).toEqual([]);
    expect([...(graph.dependencies.get("video:shot.01.motion") ?? [])]).toEqual([
      "video:timeline.character",
    ]);
    expect([...(graph.dependents.get("video:timeline.character") ?? [])]).toEqual([
      "video:shot.01.motion",
    ]);
  });

  it("timeline assets appear before dependents in topological order", () => {
    const video = defineVideo(
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

    const graph = buildDependencyGraph(video);
    const order = graph.topologicalOrder;

    expect(order.indexOf("video:timeline.character")).toBeLessThan(
      order.indexOf("video:shot.01.motion"),
    );
  });

  it("builds cross-stage dependency graph (video -> animatic)", () => {
    const animatic = defineVideo(
      testDirection({
        fps: 1,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("keyframe", imageComfy, { prompt: "a cat" });
                return el();
              },
            }),
          ]),
      },
    );
    const sbDef = {
      ...animatic,
      stage: "animatic" as const,
      shots: animatic.shots.map((s) => ({
        ...s,
        assets: Object.fromEntries(Object.entries(s.assets).map(([k, v]) => [k, v])),
        panels: [],
      })),
    };

    const video = defineVideo(
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
                asset("motion", animateWithImageComfy, {
                  image: { src: "__konte:animatic:shot.01.keyframe__" } as any,
                });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video, sbDef as any);

    expect([...(graph.dependencies.get("video:shot.01.motion") ?? [])]).toEqual([
      "animatic:shot.01.keyframe",
    ]);
    expect([...(graph.dependents.get("animatic:shot.01.keyframe") ?? [])]).toEqual([
      "video:shot.01.motion",
    ]);
  });

  it("throws a targeted error when video references an undeveloped (pendingShot) animatic shot", () => {
    const sbDef = {
      stage: "animatic" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 1 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          assets: {},
          panels: [],
          pending: true as const,
        },
      ],
    };

    const video = defineVideo(
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
                asset("motion", animateWithImageComfy, {
                  image: { src: "__konte:animatic:shot.01.keyframe__" } as any,
                });
                return el();
              },
            }),
          ]),
      },
    );

    expect(() => buildDependencyGraph(video, sbDef as any)).toThrowError(/pendingShot/i);
  });

  it("throws the same targeted error from a video TIMELINE asset, not just a shot asset", () => {
    const sbDef = {
      stage: "animatic" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 1 },
      typography: { lang: "en" as const },
      shots: [{ id: "01", duration: 5, assets: {}, panels: [], pending: true as const }],
    };

    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          asset("plate", animateWithImageComfy, {
            image: { src: "__konte:animatic:shot.01.keyframe__" } as any,
          });
          return videoTimeline([shot("01", { duration: 5, build: () => el() })]);
        },
      },
    );

    expect(() => buildDependencyGraph(video, sbDef as any)).toThrowError(/pendingShot/i);
  });

  it("adds a composition node depending on the assets its shotFn renders", () => {
    const video = defineVideo(
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
                const motion = asset("motion", simpleComfy, {});
                const voice = asset("voice", ttsComfy, {});
                return composed(motion, voice);
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01#composition") ?? [])].sort()).toEqual([
      "video:shot.01.motion",
      "video:shot.01.voice",
    ]);
    // the assets gain the composition as a dependent (so asset changes propagate to it)
    expect(graph.dependents.get("video:shot.01.motion")).toContain("video:shot.01#composition");
    expect(graph.dependents.get("video:shot.01.voice")).toContain("video:shot.01#composition");
  });

  it("composition depends on timeline assets pulled in via closure", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const bgm = asset("bgm", ttsComfy, {});
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                const motion = asset("motion", simpleComfy, {});
                return composed(motion, bgm);
              },
            }),
          ]);
        },
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependencies.get("video:shot.01#composition") ?? [])].sort()).toEqual([
      "video:shot.01.motion",
      "video:timeline.bgm",
    ]);
    expect(graph.dependents.get("video:timeline.bgm")).toContain("video:shot.01#composition");
  });

  it("composition is always a leaf (nothing depends on it)", () => {
    const video = defineVideo(
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
                const motion = asset("motion", simpleComfy, {});
                return composed(motion);
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);

    expect([...(graph.dependents.get("video:shot.01#composition") ?? [])]).toEqual([]);
    // composition appears after its dependency in topological order, no false cycle
    const order = graph.topologicalOrder;
    expect(order.indexOf("video:shot.01.motion")).toBeLessThan(
      order.indexOf("video:shot.01#composition"),
    );
  });

  it("adds no composition node for a shot without a shotFn", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "test shot",
          assets: { a: { kind: "comfy", workflow: "a.json", inputs: {} } },
        },
      ],
    };

    const graph = buildDependencyGraph(video);

    expect(graph.dependencies.has("video:shot.01#composition")).toBe(false);
  });

  it("animatic assets appear before video dependents in topological order", () => {
    const sbDef = {
      stage: "animatic" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      shots: [
        {
          id: "01",
          duration: 5,
          assets: {
            keyframe: {
              kind: "comfy" as const,
              workflow: "image.json",
              description: "test adapter",
              inputs: {},
            },
          },
          panels: [],
        },
      ],
    };

    const video = defineVideo(
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
                asset("motion", animateWithImageComfy, {
                  image: { src: "__konte:animatic:shot.01.keyframe__" } as any,
                });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video, sbDef as any);
    const order = graph.topologicalOrder;

    expect(order.indexOf("animatic:shot.01.keyframe")).toBeLessThan(
      order.indexOf("video:shot.01.motion"),
    );
  });
});

describe("listUnusedAssetPaths", () => {
  const format = { fps: 30, size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } } };

  it("reports a timeline asset and a shot asset no composition uses", () => {
    const video = defineVideo(testDirection(format), {
      timeline: () => {
        asset("bgm", ttsComfy, {});
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const motion = asset("motion", simpleComfy, {});
              asset("extra", comfyB, {});
              return composed(motion);
            },
          }),
        ]);
      },
    });

    const graph = buildDependencyGraph(video);

    expect(new Set(listUnusedAssetPaths(video, null, graph))).toEqual(
      new Set(["video:timeline.bgm", "video:shot.01.extra"]),
    );
  });

  it("treats assets the composition references (timeline or shot) as used", () => {
    const video = defineVideo(testDirection(format), {
      timeline: () => {
        const bgm = asset("bgm", ttsComfy, {});
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const motion = asset("motion", simpleComfy, {});
              return composed(motion, bgm);
            },
          }),
        ]);
      },
    });

    const graph = buildDependencyGraph(video);

    expect(listUnusedAssetPaths(video, null, graph)).toEqual([]);
  });

  it("reports a whole dead chain transitively (unused depends on unused)", () => {
    const video = defineVideo(testDirection(format), {
      timeline: () => {
        const base = asset("base", imageComfy, {});
        asset("character", animateWithImageComfy, { image: base });
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const motion = asset("motion", simpleComfy, {});
              return composed(motion);
            },
          }),
        ]);
      },
    });

    const graph = buildDependencyGraph(video);

    expect(new Set(listUnusedAssetPaths(video, null, graph))).toEqual(
      new Set(["video:timeline.base", "video:timeline.character"]),
    );
  });

  it("keeps an upstream used when its downstream is used", () => {
    const video = defineVideo(testDirection(format), {
      timeline: () => {
        const base = asset("base", imageComfy, {});
        const character = asset("character", animateWithImageComfy, { image: base });
        return videoTimeline([
          shot("01", {
            duration: 5,
            build: () => composed(character),
          }),
        ]);
      },
    });

    const graph = buildDependencyGraph(video);

    expect(listUnusedAssetPaths(video, null, graph)).toEqual([]);
  });

  it("treats a timeline soundtrack's asset as used (muxed, not composition-referenced)", () => {
    const video = defineVideo(testDirection(format), {
      timeline: () => {
        const bgm = asset("bgm", ttsComfy, {});
        return videoTimeline(
          [
            shot("01", {
              duration: 5,
              build: () => composed(asset("motion", simpleComfy, {})),
            }),
          ],
          [soundtrack("bed", bgm, { duck: false, volume: 0.3 })],
        );
      },
    });

    const graph = buildDependencyGraph(video);

    expect(listUnusedAssetPaths(video, null, graph)).toEqual([]);
  });

  const comfyDef = { kind: "comfy" as const, workflow: "x.json", inputs: {} };

  it("treats a shotFn-less shot's own assets as used (fallback render source)", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 100, height: 100 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [{ id: "01", duration: 5, action: "test shot", assets: { clip: comfyDef } }],
    };

    const graph = buildDependencyGraph(video);

    expect(listUnusedAssetPaths(video, null, graph)).toEqual([]);
  });

  it("treats animatic panel assets as used and reports unpanelled animatic timeline", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 100, height: 100 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [],
    };
    const animatic: AnimaticDefinition = {
      stage: "animatic" as const,
      format: { size: { width: 100, height: 100 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: { first: comfyDef },
          panels: [
            { assetName: "first", assetPath: "animatic:shot.01.first", start: 0, duration: 1 },
          ],
        },
      ],
      topLevelAssets: { logo: comfyDef },
    };

    const graph = buildDependencyGraph(video, animatic);

    expect(listUnusedAssetPaths(video, animatic, graph)).toEqual(["animatic:timeline.logo"]);
  });
});

describe("listBoardlessVideoShots", () => {
  // These cases are about which shots are boardless at all; the `spends` split has its own below.
  const boardlessIds = (
    v: VideoDefinition,
    a: AnimaticDefinition,
    g: ReturnType<typeof buildDependencyGraph>,
  ) => listBoardlessVideoShots(v, a, g).map((s) => s.shotId);

  const format = { size: { width: 100, height: 100 }, fps: 30 };
  const comfy = { kind: "comfy" as const, workflow: "x.json", inputs: {} };

  // An animatic whose every listed shot is developed (a real panel over a `first` asset).
  function developedAnimatic(ids: string[]): AnimaticDefinition {
    return {
      stage: "animatic" as const,
      format: { size: { width: 100, height: 100 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: ids.map((id) => ({
        id,
        duration: 5,
        action: `shot ${id}`,
        assets: { first: comfy },
        panels: [
          { assetName: "first", assetPath: `animatic:shot.${id}.first`, start: 0, duration: 5 },
        ],
      })),
    };
  }

  // A video authoring one shot per entry; a `refsAnimatic` shot consumes its animatic panel.
  function videoWithShots(shots: Array<{ id: string; refsAnimatic: boolean }>): VideoDefinition {
    return {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: shots.map((s) => ({
        id: s.id,
        duration: 5,
        action: `shot ${s.id}`,
        assets: {
          motion: s.refsAnimatic
            ? {
                kind: "comfy" as const,
                workflow: "animate.json",
                inputs: { image: `__konte:animatic:shot.${s.id}.first__` },
              }
            : comfy,
        },
      })),
    };
  }

  it("lists nothing when every authored video shot consumes its board", () => {
    const animatic = developedAnimatic(["01"]);
    const video = videoWithShots([{ id: "01", refsAnimatic: true }]);
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual([]);
  });

  it("does not list a developed shot the video has not authored yet (staged development)", () => {
    const animatic = developedAnimatic(["01", "02"]);
    const video = videoWithShots([{ id: "01", refsAnimatic: true }]);
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual([]);
  });

  // A `file`/`local` asset takes a path or a source take, never a board, so the gate cannot ask one
  // for it — `doctor` still says the board went unused.
  it("marks a footage shot as boardless but not spending", () => {
    const animatic = developedAnimatic(["01"]);
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {
            src: { kind: "file" as const, path: "assets/files/01.mp4" },
            clip: {
              kind: "local" as const,
              op: "videoTrim",
              inputs: { source: "__konte:video:shot.01.src__" },
            } as never,
          },
          shotFn: (() => null) as never,
          compositionRefs: ["video:shot.01.clip"],
          pictureRefs: ["video:shot.01.clip"],
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    expect(listBoardlessVideoShots(video, animatic, graph)).toEqual([
      { shotId: "01", spends: false },
    ]);
  });

  it("marks a shot on a vendor backend as spending", () => {
    const animatic = developedAnimatic(["01"]);
    const video = videoWithShots([{ id: "01", refsAnimatic: false }]);
    const graph = buildDependencyGraph(video, animatic);

    expect(listBoardlessVideoShots(video, animatic, graph)).toEqual([
      { shotId: "01", spends: true },
    ]);
  });

  it("lists a shot the video authored but consumes nothing from", () => {
    const animatic = developedAnimatic(["01", "02"]);
    const video = videoWithShots([
      { id: "01", refsAnimatic: true },
      { id: "02", refsAnimatic: false },
    ]);
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual(["02"]);
  });

  // The board reaches a video shot through more than a panel image; every way in has to count.
  it("counts a shot driven only by the board's stem", () => {
    const animatic = developedAnimatic(["01"]);
    (animatic.shots[0] as { stemRefs?: string[] }).stemRefs = ["animatic:shot.01.first"];
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {
            motion: {
              kind: "comfy" as const,
              workflow: "animate.json",
              inputs: { audio: "__konte:animatic:shot.01#stem__" },
            },
          },
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual([]);
  });

  // A keyframe backed by a shared asset is pinned at where it really lives (`animatic:timeline.<n>`,
  // `reference:<n>`), and is still that shot's board.
  it("counts a shared panel, which lives outside the shot's address space", () => {
    const animatic: AnimaticDefinition = {
      stage: "animatic" as const,
      format: { size: { width: 100, height: 100 }, fps: 30 },
      typography: { lang: "en" as const },
      topLevelAssets: { shared: comfy },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {},
          panels: [
            { assetName: "hero", assetPath: "animatic:timeline.shared", start: 0, duration: 5 },
          ],
        },
      ],
    };
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {
            motion: {
              kind: "comfy" as const,
              workflow: "a.json",
              inputs: { image: "__konte:animatic:timeline.shared__" },
            },
          },
          shotFn: (() => null) as never,
          compositionRefs: ["video:shot.01.motion"],
          pictureRefs: ["video:shot.01.motion"],
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual([]);
  });

  // A picture derived from the previous shot's take reaches ITS board, not this shot's.
  it("does not let a cross-shot chain stand in for this shot's board", () => {
    const animatic = developedAnimatic(["01", "02"]);
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {
            motion: {
              kind: "comfy" as const,
              workflow: "a.json",
              inputs: { image: "__konte:animatic:shot.01.first__" },
            },
          },
          shotFn: (() => null) as never,
          compositionRefs: ["video:shot.01.motion"],
          pictureRefs: ["video:shot.01.motion"],
        },
        {
          id: "02",
          duration: 5,
          action: "shot 02",
          assets: {
            motion: {
              kind: "comfy" as const,
              workflow: "a.json",
              inputs: { image: "__konte:video:shot.01.motion__" },
            },
          },
          shotFn: (() => null) as never,
          compositionRefs: ["video:shot.02.motion"],
          pictureRefs: ["video:shot.02.motion"],
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual(["02"]);
  });

  // Asked per video shot, never across the stage: one shot's wiring is not the other's.
  it("does not let one shot's board refs cover for another's", () => {
    const animatic = developedAnimatic(["01", "02"]);
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: { motion: { kind: "comfy" as const, workflow: "a.json", inputs: {} } },
        },
        {
          id: "02",
          duration: 5,
          action: "shot 02",
          assets: {
            motion: {
              kind: "comfy" as const,
              workflow: "a.json",
              inputs: {
                a: "__konte:animatic:shot.01.first__",
                b: "__konte:animatic:shot.02.first__",
              },
            },
          },
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual(["01"]);
  });

  // A shot's picture may be a timeline asset it closes over, which lives in no shot's address space.
  it("counts a vendor-backed timeline asset as the shot spending", () => {
    const animatic = developedAnimatic(["01"]);
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      topLevelAssets: { bed: { kind: "comfy" as const, workflow: "b.json", inputs: {} } },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {},
          shotFn: (() => null) as never,
          compositionRefs: ["video:timeline.bed"],
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual(["01"]);
  });

  // An undeveloped shot has no keyframe anyone signed off.
  it("flags a shot still a pendingShot on the board", () => {
    const animatic = developedAnimatic(["01"]);
    (animatic.shots[0] as { pending?: boolean }).pending = true;
    const video = videoWithShots([{ id: "01", refsAnimatic: false }]);
    const graph = buildDependencyGraph(video, animatic);

    expect(boardlessIds(video, animatic, graph)).toEqual(["01"]);
  });

  // An asset the composition never draws is not generated (`listUnusedAssetPaths` drops it).
  it("reads only what the composition draws", () => {
    const animatic = developedAnimatic(["01"]);
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {
            unused: {
              kind: "comfy" as const,
              workflow: "a.json",
              inputs: { image: "__konte:animatic:shot.01.first__" },
            },
            drawn: { kind: "file" as const, path: "assets/files/01.mp4" },
          },
          shotFn: (() => null) as never,
          compositionRefs: ["video:shot.01.drawn"],
          pictureRefs: ["video:shot.01.drawn"],
        },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    // Boardless because the take it draws is footage — and the undrawn comfy asset neither makes it
    // spend nor stands in for a board it never reaches the screen with.
    expect(listBoardlessVideoShots(video, animatic, graph)).toEqual([
      { shotId: "01", spends: false },
    ]);
  });

  it("does not count a pending video shot as authored", () => {
    const animatic = developedAnimatic(["01", "02"]);
    const video: VideoDefinition = {
      stage: "video" as const,
      format,
      typography: { lang: "en" as const },
      shots: [
        {
          id: "01",
          duration: 5,
          action: "shot 01",
          assets: {
            motion: {
              kind: "comfy" as const,
              workflow: "animate.json",
              inputs: { image: "__konte:animatic:shot.01.first__" },
            },
          },
        },
        { id: "02", duration: 5, action: "shot 02", assets: {}, pending: true },
      ],
    };
    const graph = buildDependencyGraph(video, animatic);

    // Shot 02 is a placeholder shot, not authored — so it is not a wiring gap.
    expect(boardlessIds(video, animatic, graph)).toEqual([]);
  });
});

// The reference-stage half of the reach walk: what a `reference:<id>` was itself built from.
describe("listPanelReferenceReach", () => {
  const comfy = (inputs: Record<string, unknown>): AssetDefinition =>
    ({ kind: "comfy", workflow: "a.json", inputs }) as unknown as AssetDefinition;
  const fixed = (inputs: Record<string, unknown>): AssetDefinition =>
    ({
      kind: "local",
      operation: "crop",
      mediaType: "image",
      deterministic: true,
      inputs,
    }) as unknown as AssetDefinition;

  const boardOn = (first: AssetDefinition) =>
    ({
      shots: [{ id: "01", panels: [{ assetPath: "animatic:shot.01.first" }], assets: { first } }],
    }) as unknown as AnimaticDefinition;
  const referenceOf = (topLevelAssets: Record<string, AssetDefinition>) =>
    ({ stage: "reference", shots: [], topLevelAssets }) as unknown as ReferenceDefinition;

  const FRAME = "__konte:reference:frame__";
  const ROOM = "__konte:reference:room__";

  it("leaves a derived reference a leaf where the reference stage is not at hand", () => {
    expect(listPanelReferenceReach(boardOn(comfy({ image: FRAME })))).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        refs: ["frame"],
        generative: true,
      },
    ]);
  });

  it("walks on through what a reference asset was built from", () => {
    const reference = referenceOf({ frame: fixed({ image: ROOM }), room: comfy({}) });

    expect(listPanelReferenceReach(boardOn(comfy({ image: FRAME })), reference)).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        refs: ["frame", "room"],
        generative: true,
      },
    ]);
  });

  it("does not let a generative reference asset make a deterministic panel generative", () => {
    const reference = referenceOf({ frame: comfy({ image: ROOM }), room: comfy({}) });

    expect(listPanelReferenceReach(boardOn(fixed({ image: FRAME })), reference)).toEqual([
      {
        shotId: "01",
        lane: "main",
        panel: "animatic:shot.01.first",
        refs: ["frame", "room"],
        generative: false,
      },
    ]);
  });

  it("terminates on reference assets built from each other", () => {
    const reference = referenceOf({ frame: comfy({ image: ROOM }), room: comfy({ image: FRAME }) });

    expect(listPanelReferenceReach(boardOn(comfy({ image: FRAME })), reference)[0]!.refs).toEqual([
      "frame",
      "room",
    ]);
  });
});

describe("videoDependentsHoldVerdicts", () => {
  const graph: DependencyGraph = {
    dependencies: new Map(),
    dependents: new Map([
      [
        "animatic:shot.01.first",
        ["animatic:shot.01#composition", "animatic:shot.02.first", "video:shot.01.first"],
      ],
      ["video:shot.01.first", ["video:shot.01.motion"]],
      ["animatic:shot.02.first", ["video:shot.02.motion"]],
      ["video:shot.01.motion", ["video:shot.01#composition"]],
    ]),
    topologicalOrder: [],
  };
  const verdicts =
    (overrides: Record<string, "holds" | "rebakes" | "open">) =>
    (p: string): "holds" | "rebakes" | "open" | null =>
      ({
        "video:shot.01.first": "rebakes" as const,
        "video:shot.01.motion": "holds" as const,
        "video:shot.02.motion": "holds" as const,
        ...overrides,
      })[p] ?? null;

  it("holds when every video take reached holds, through a re-baked take and other stages", () => {
    expect(videoDependentsHoldVerdicts(graph, "animatic:shot.01.first", verdicts({}))).toBe(true);
  });

  it("does not hold when one video take reached is open", () => {
    expect(
      videoDependentsHoldVerdicts(
        graph,
        "animatic:shot.01.first",
        verdicts({ "video:shot.02.motion": "open" }),
      ),
    ).toBe(false);
  });

  it("does not hold when no video take is reached", () => {
    expect(videoDependentsHoldVerdicts(graph, "video:shot.01.motion", verdicts({}))).toBe(false);
  });
});
