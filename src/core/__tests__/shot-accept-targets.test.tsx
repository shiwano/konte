import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Audio, Composition, Video } from "../dsl/composition/index.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineVideo } from "../dsl/index.js";
import { StateManager } from "../state/index.js";
import { testDirection } from "./helpers/direction.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { stageReviewDecidableAddresses } from "../shot-accept-targets.js";

const stitch = defineComfyAsset({
  workflow: "stitch.json",
  description: "test adapter",
  inputs: { source: { nodeId: "1", field: "audio", type: "audio" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});
const speak = defineComfyAsset({
  workflow: "speak.json",
  description: "test adapter",
  inputs: { over: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});
const hum = defineComfyAsset({
  workflow: "hum.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "1", field: "text", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "audio" } },
});
const animate = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { source: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});
const condition = defineComfyAsset({
  workflow: "condition.json",
  description: "test adapter",
  inputs: { audio: { nodeId: "1", field: "audio", type: "audio" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const format = { fps: 30, size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } } };

// `plate` is a TIMELINE asset both halves of shot 01 build on — the delivered motion (a picture
// root) and the animatic's spoken line (a stem source, walked with audio allowed). `under` sits
// beneath it, so only the audio-permitting mode reaches it. Declaring one name in both halves of a
// shot is a load error, so the shared intermediate has to be a timeline asset.
// Shot 02's `cond` conditions its motion and is played nowhere — the shape no toggle reaches.
const video = defineVideo(testDirection(format), {
  timeline: () => {
    const plateAsset = asset("plate", stitch, {
      source: asset("under", hum, { prompt: "a hum" }),
    });
    return videoTimeline([
      shot("01", {
        duration: 2,
        build: () => (
          <Composition>
            <Video src={asset("motion", animate, { source: plateAsset })} />
            <Audio src={asset("line", speak, { over: plateAsset })} />
          </Composition>
        ),
      }),
      shot("02", {
        duration: 2,
        build: () => (
          <Composition>
            <Video
              src={asset("motion", condition, {
                audio: asset("cond", hum, { prompt: "a hum" }),
              })}
            />
          </Composition>
        ),
      }),
    ]);
  },
});

let manager: StateManager;

beforeEach(async () => {
  manager = await StateManager.init(await fs.mkdtemp(path.join(tmpdir(), "konte-decidable-")));
});

function take(address: string, file: string): void {
  const variantId = manager.reserveVariantId(address);
  const variant = manager.getAssetState(address).variants![variantId]!;
  variant.file = file;
  variant.outputHash = variantId;
}

describe("stageReviewDecidableAddresses", () => {
  it("covers what a shot's accept signs off — its picture, its cues and its leaves", () => {
    const decidable = stageReviewDecidableAddresses(manager, video);
    for (const address of [
      "video:shot.01.line",
      "video:timeline.plate",
      "video:shot.01.motion",
      "video:shot.01#composition",
      "video:shot.01#stem",
    ]) {
      expect(decidable.has(address)).toBe(true);
    }
  });

  // The positive control for status' unreachable report: an audio take reachable only under a
  // picture take is one the cascade refuses to sign off and no audio row lists, so the set must say
  // so rather than let it ask for a verdict nothing can give. Keyed on the take's media, so it reads
  // as audio only once something has been generated.
  it("excludes an audio take no cue names, once its media is known", () => {
    expect(stageReviewDecidableAddresses(manager, video).has("video:shot.02.cond")).toBe(true);

    take("video:shot.02.cond", "assets/cond.wav");
    expect(stageReviewDecidableAddresses(manager, video).has("video:shot.02.cond")).toBe(false);
  });

  it("keeps a take that is not audio, and one whose file type is unreadable", () => {
    take("video:shot.02.motion", "assets/motion.mp4");
    take("video:timeline.under", "assets/under.unknown");
    const decidable = stageReviewDecidableAddresses(manager, video);
    expect(decidable.has("video:shot.02.motion")).toBe(true);
    expect(decidable.has("video:timeline.under")).toBe(true);
  });

  // An intermediate both a picture take and a stem source consume is walked under both modes.
  // Reached under the picture mode alone, the audio beneath it drops out of the set — and `status`
  // would report a konte bug about an address the shot's own accept signs off perfectly well.
  it("walks a shared intermediate under both modes, so audio beneath it survives", () => {
    take("video:timeline.plate", "assets/plate.png");
    take("video:timeline.under", "assets/under.wav");
    const decidable = stageReviewDecidableAddresses(manager, video);
    expect(decidable.has("video:timeline.plate")).toBe(true);
    // Reached only through the line's audio-permitting branch. Keyed by address alone, the picture
    // root's visit would have suppressed that walk and lost it.
    expect(decidable.has("video:timeline.under")).toBe(true);
  });
});
