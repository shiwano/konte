import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { materializeCompositionVariant } from "../../../../core/composition-resource.js";
import { Composition, Image, Video } from "../../../../core/dsl/composition/index.js";
import { defineComfyAsset } from "../../../../core/dsl/comfy-asset.js";
import { asset, defineAnimatic, defineVideo, Panel } from "../../../../core/dsl/index.js";
import { StateManager } from "../../../../core/state/index.js";
import type { VideoDefinition } from "../../../../core/types/index.js";
import { testDirection } from "../../../../core/__tests__/helpers/direction.js";
import {
  moves,
  shot,
  animaticTimeline,
  videoTimeline,
} from "../../../../core/__tests__/helpers/shot.js";
import { handleGetReelState } from "../reel-review.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const format = { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } };

const animatic = defineAnimatic(testDirection(format), {
  timeline: () =>
    animaticTimeline([
      shot("01", {
        duration: 5,
        build: () => {
          const first = asset("first", imageComfy, { prompt: "a wide establishing frame" });
          return (
            <Composition>
              <Panel src={first} {...moves} />
            </Composition>
          );
        },
      }),
    ]),
});

// A shot whose picture is the board's frame alone — no `asset()` of its own, so the render plan
// resolves no video-stage variant for it.
const boardOnlyVideo = defineVideo(testDirection(format), {
  timeline: () =>
    videoTimeline([
      shot("01", {
        duration: 5,
        build: () => (
          <Composition>
            <Image src={animatic.shot("01").image("first")} fill />
          </Composition>
        ),
      }),
    ]),
});

const motionVideo = defineVideo(testDirection(format), {
  timeline: () =>
    videoTimeline([
      shot("01", {
        duration: 5,
        build: () => {
          const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
          return (
            <Composition>
              <Video src={motion} />
            </Composition>
          );
        },
      }),
    ]),
});

let dir: string;
let manager: StateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "konte-shot-accepted-"));
  manager = await StateManager.init(dir);
});

function acceptReadyVariant(address: string, file: string): string {
  const vid = manager.reserveVariantId(address);
  const v = manager.getAssetState(address).variants![vid]!;
  v.file = file;
  v.outputHash = `out-${vid}`;
  manager.setAccepted(address, vid);
  return vid;
}

async function acceptComposition(video: VideoDefinition, shotId: string): Promise<void> {
  const variantId = await materializeCompositionVariant({ manager, video, shotId });
  manager.setAccepted(`video:shot.${shotId}#composition`, variantId!);
}

async function shotState(video: VideoDefinition) {
  await manager.save();
  const res = await handleGetReelState(dir, video, "/assets", null, null, animatic);
  const body = (await res.json()) as { shots: { shotId: string; allAccepted: boolean }[] };
  return body.shots[0]!;
}

// A shot accept has to have signed something off — but for a shot built purely from another stage's
// takes, the thing signed off is its composition, not a video-stage variant it never declares.
describe("shot allAccepted", () => {
  it("is true for a board-only shot whose composition is accepted", async () => {
    acceptReadyVariant("animatic:shot.01.first", "assets/sb.01.first/frame.png");
    await acceptComposition(boardOnlyVideo, "01");

    expect((await shotState(boardOnlyVideo)).allAccepted).toBe(true);
  });

  it("is false for a board-only shot whose composition was never accepted", async () => {
    acceptReadyVariant("animatic:shot.01.first", "assets/sb.01.first/frame.png");

    expect((await shotState(boardOnlyVideo)).allAccepted).toBe(false);
  });

  it("is false while the shot's own asset is unaccepted", async () => {
    const addr = "video:shot.01.motion";
    const vid = manager.reserveVariantId(addr);
    const v = manager.getAssetState(addr).variants![vid]!;
    v.file = "assets/video/shot.01.motion/m.mp4";
    v.outputHash = "out-m";
    await acceptComposition(motionVideo, "01");

    expect((await shotState(motionVideo)).allAccepted).toBe(false);
  });

  it("is true once the shot's own asset is accepted", async () => {
    acceptReadyVariant("video:shot.01.motion", "assets/video/shot.01.motion/m.mp4");
    await acceptComposition(motionVideo, "01");

    expect((await shotState(motionVideo)).allAccepted).toBe(true);
  });
});

describe("shot moves", () => {
  it("carries the board's movement into the video review", async () => {
    await manager.save();
    const res = await handleGetReelState(dir, motionVideo, "/assets", null, null, animatic);
    const body = (await res.json()) as { shots: { moves: unknown[] }[] };

    expect(body.shots[0]!.moves).toEqual([{ panel: "first", cutin: false, ...moves }]);
  });
});
