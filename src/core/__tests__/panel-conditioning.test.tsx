import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineAnimatic, asset, Composition, Panel } from "../dsl/index.js";
import { listPanelConditioning } from "../graph.js";
import { moves, shot, pendingAnimaticShot, animaticTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "prompt" },
    image1: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const resize = defineComfyAsset({
  workflow: "resize.json",
  description: "test adapter",
  inputs: { image: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const format = { fps: 24, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } };

describe("listPanelConditioning", () => {
  it("names each panel's place in its lane and the addresses behind it that carry a prompt", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const drawn = asset("drawn", imageComfy, { prompt: "the first instant" });
              const first = asset("first", resize, { image: drawn });
              const last = asset("last", imageComfy, { prompt: "the landing", image1: first });
              return (
                <Composition>
                  <Panel src={first} {...moves} />
                  <Panel src={last} />
                </Composition>
              );
            },
          }),
        ]),
    });

    expect(listPanelConditioning(animatic)).toEqual([
      {
        shotId: "01",
        lane: "main",
        index: 1,
        of: 2,
        panel: "animatic:shot.01.first",
        // The panel itself is a wrapper, so the text that writes the frame is one step behind it.
        conditioning: ["animatic:shot.01.drawn"],
      },
      {
        shotId: "01",
        lane: "main",
        index: 2,
        of: 2,
        panel: "animatic:shot.01.last",
        conditioning: ["animatic:shot.01.last", "animatic:shot.01.drawn"],
      },
    ]);
  });

  it("carries a shared timeline asset into every panel that stands on it, and skips a pending shot", () => {
    const animatic = defineAnimatic(testDirection(format), {
      timeline: () => {
        const plateLike = asset("wall", imageComfy, { prompt: "the empty wall" });
        return animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              const first = asset("first", imageComfy, {
                prompt: "she leans in",
                image1: plateLike,
              });
              return (
                <Composition>
                  <Panel src={first} {...moves} />
                </Composition>
              );
            },
          }),
          pendingAnimaticShot("02", { duration: 3 }),
        ]);
      },
    });

    expect(listPanelConditioning(animatic)).toEqual([
      {
        shotId: "01",
        lane: "main",
        index: 1,
        of: 1,
        panel: "animatic:shot.01.first",
        conditioning: ["animatic:shot.01.first", "animatic:timeline.wall"],
      },
    ]);
  });
});
