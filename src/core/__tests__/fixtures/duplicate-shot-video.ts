import { defineComfyAsset } from "../../dsl/comfy-asset.js";
import { defineVideo, asset } from "../../dsl/index.js";
import { Composition } from "../../dsl/composition/composition.js";
import { shot, videoTimeline } from "../helpers/shot.js";
import { testDirection } from "../helpers/direction.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
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

export default defineVideo(
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
            asset("motion", animateComfy, {});
            return el();
          },
        }),
        shot("01", {
          duration: 3,
          build: () => {
            asset("voice", ttsComfy, {});
            return el();
          },
        }),
      ]),
  },
);
