import { defineComfyAsset } from "../../dsl/comfy-asset.js";
import { defineDirection, defineVideo, asset } from "../../dsl/index.js";
import { Composition } from "../../dsl/composition/composition.js";
import { directionDefaults } from "../helpers/direction.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    video: { nodeId: "1", field: "video", type: "video" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const ttsComfy = defineComfyAsset({
  workflow: "tts.json",
  description: "test adapter",
  inputs: {
    text: { nodeId: "3", field: "text", type: "string" },
    video: { nodeId: "1", field: "video", type: "video" },
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

const direction = defineDirection({
  ...directionDefaults,
  policy: {
    ...directionDefaults.policy,
    format: { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
  },
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      {
        id: "01",
        role: "ordinary",
        action: "calm open",
        setup: "front",
        duration: 5,
        lineup: [],
      },
      {
        id: "02",
        role: "hero",
        action: "the payoff",
        setup: "front",
        duration: 3,
        lineup: [],
      },
    ],
  },
});

export default defineVideo(direction, {
  timeline: ({ shot }) => ({
    shots: shot("01", () => {
      const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
      asset("voice", ttsComfy, { text: "hello world", video: motion });
      return el();
    }).nextShot("02", () => {
      asset("motion", renderComfy, { scene: "forest" });
      return el();
    }),
  }),
});
