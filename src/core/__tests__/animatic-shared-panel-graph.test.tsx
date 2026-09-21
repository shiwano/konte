import { describe, expect, it } from "vitest";
import type { AnimaticRef } from "../dsl/animatic-ref.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import {
  defineAnimatic,
  defineVideo,
  defineReference,
  asset,
  Composition,
  Panel,
} from "../dsl/index.js";
import { moves, shot, animaticTimeline, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { buildDependencyGraph } from "../graph.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}
const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});
const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { image: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// A video shot whose asset consumes `animatic.shot("01").<part>` for a shared-scope panel.
function videoConsuming(animatic: AnimaticRef) {
  return defineVideo(
    testDirection({ fps: 30, size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } } }),
    {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              asset("motion", animate, { image: animatic.shot("01").image("shared") });
              return el();
            },
          }),
        ]),
    },
  );
}

describe("shared-scope panels resolve cross-stage", () => {
  it("a reference-backed panel is referenceable from video via reference:<name>", () => {
    const reference = defineReference(plainDirection, () => ({
      shared: asset("shared", imageComfy, { prompt: "background" }),
    }));
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: () =>
          animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Panel src={reference.shared} {...moves} />
                </Composition>
              ),
            }),
          ]),
      },
    );
    const graph = buildDependencyGraph(videoConsuming(animatic), animatic, reference);
    expect(graph.dependencies.get("video:shot.01.motion")).toContain("reference:shared");
  });

  it("a timeline-backed panel is referenceable from video via animatic:timeline.<name>", () => {
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: () => {
          const shared = asset("shared", imageComfy, { prompt: "keyframe" });
          return animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Panel src={shared} {...moves} />
                </Composition>
              ),
            }),
          ]);
        },
      },
    );
    const graph = buildDependencyGraph(videoConsuming(animatic), animatic);
    expect(graph.dependencies.get("video:shot.01.motion")).toContain("animatic:timeline.shared");
  });
});
