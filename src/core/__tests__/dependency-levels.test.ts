import { describe, expect, it } from "vitest";
import { computeDependencyLevels } from "../dependency-levels.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineVideo, asset, defineReference, videoFile } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { buildDependencyGraph } from "../graph.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const simpleComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {},
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

const mergeComfy = defineComfyAsset({
  workflow: "merge.json",
  description: "test adapter",
  inputs: {
    sources: { nodeId: "1", field: "sources", type: "video" },
    config: { nodeId: "2", field: "config", type: "video" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

describe("computeDependencyLevels", () => {
  it("assigns level 0 to all independent assets", () => {
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
                asset("a", simpleComfy, {});
                asset("b", simpleComfy, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);
    const result = computeDependencyLevels(graph);

    expect(result.levels.length).toBe(1);
    expect([...result.levels[0]!].sort()).toEqual(["video:shot.01.a", "video:shot.01.b"]);
    expect(result.levelOf.get("video:shot.01.a")).toBe(0);
    expect(result.levelOf.get("video:shot.01.b")).toBe(0);
  });

  it("assigns sequential levels for linear dependency chain", () => {
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
    const result = computeDependencyLevels(graph);

    expect(result.levels.length).toBe(2);
    expect(result.levelOf.get("video:timeline.character")).toBe(0);
    expect(result.levelOf.get("video:shot.01.motion")).toBe(1);
    expect([...result.levels[0]!]).toEqual(["video:timeline.character"]);
    expect([...result.levels[1]!]).toEqual(["video:shot.01.motion"]);
  });

  it("groups independent assets at the same level when sharing a dependency", () => {
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
                asset("motionA", animateWithImageComfy, { image: character });
                asset("motionB", animateWithImageComfy, { image: character });
                return el();
              },
            }),
          ]);
        },
      },
    );

    const graph = buildDependencyGraph(video);
    const result = computeDependencyLevels(graph);

    expect(result.levels.length).toBe(2);
    expect(result.levelOf.get("video:timeline.character")).toBe(0);
    expect(result.levelOf.get("video:shot.01.motionA")).toBe(1);
    expect(result.levelOf.get("video:shot.01.motionB")).toBe(1);
  });

  it("handles three-level dependency chain", () => {
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
                const motion = asset("motion", animateWithBg, { background: reference.bg });
                asset("final", mergeComfy, { sources: motion, config: motion });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video, undefined, reference);
    const result = computeDependencyLevels(graph);

    expect(result.levels.length).toBe(3);
    expect(result.levelOf.get("reference:bg")).toBe(0);
    expect(result.levelOf.get("video:shot.01.motion")).toBe(1);
    expect(result.levelOf.get("video:shot.01.final")).toBe(2);
  });

  it("returns empty levels for empty video", () => {
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
    const result = computeDependencyLevels(graph);

    expect(result.levels.length).toBe(0);
    expect(result.levelOf.size).toBe(0);
  });

  it("preserves topological order within each level", () => {
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
                asset("z", simpleComfy, {});
                asset("a", simpleComfy, {});
                asset("m", simpleComfy, {});
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);
    const result = computeDependencyLevels(graph);

    expect(result.levels.length).toBe(1);
    for (const addr of result.levels[0]!) {
      expect(graph.topologicalOrder).toContain(addr);
    }
  });
});
