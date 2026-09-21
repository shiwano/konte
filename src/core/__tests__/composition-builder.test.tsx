import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFullCompositionHtml,
  buildShotClips,
  buildShotCompositionHtml,
  compositionDrawsSomething,
} from "../composition-builder.js";
import { buildRenderPlan, buildStageReviewPlan } from "../render-plan.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { Animate, Audio, Composition, Image, Video } from "../dsl/composition/index.js";
import {
  defineDirection,
  defineAnimatic,
  defineVideo,
  asset,
  soundtrack,
  Panel,
} from "../dsl/index.js";
import { directionDefaults, testDirection } from "./helpers/direction.js";
import { moves, shot, animaticTimeline, videoTimeline } from "./helpers/shot.js";
import { KonteError } from "../errors.js";
import { StateManager } from "../state/index.js";
import type { VariantMedia } from "../types/index.js";

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const audioComfy = defineComfyAsset({
  workflow: "audio.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "audio" } },
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
            const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
            return (
              <Composition>
                <Video src={motion} data-duration={5} />
                <Animate
                  script={({ timeline }) => {
                    timeline.to("#el-motion", { opacity: 1 }, 0);
                  }}
                />
              </Composition>
            );
          },
        }),
        shot("02", {
          duration: 3,
          build: () => {
            const motion = asset("motion", animateComfy, { prompt: "a dog running" });
            return (
              <Composition>
                <Video src={motion} data-duration={3} />
                <Animate
                  script={({ timeline }) => {
                    timeline.to("#el-motion2", { opacity: 1 }, 0);
                  }}
                />
              </Composition>
            );
          },
        }),
      ]),
  },
);

// Video-only shots (no <Animate>) — the regression case where the composition
// previously rendered black because no capturable gsap timeline existed.
const videoOnlyVideo = defineVideo(
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
            const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
            return (
              <Composition>
                <Video src={motion} />
              </Composition>
            );
          },
        }),
        shot("02", {
          duration: 3,
          build: () => {
            const motion = asset("motion", animateComfy, { prompt: "a dog running" });
            return (
              <Composition>
                <Video src={motion} />
              </Composition>
            );
          },
        }),
      ]),
  },
);

// A clip whose embedded track joins the mix, alongside a plain picture-only one.
const embeddedAudioVideo = defineVideo(
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
            const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
            return (
              <Composition>
                <Video src={motion} />
              </Composition>
            );
          },
        }),
        shot("02", {
          duration: 3,
          build: () => {
            const motion = asset("motion", animateComfy, { prompt: "a dog running" });
            return (
              <Composition>
                <Video src={motion} hasAudio volume={0.4} />
              </Composition>
            );
          },
        }),
      ]),
  },
);

function setupAccepted(manager: StateManager, address: string, file: string): string {
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  manager.setAccepted(address, variantId);
  return variantId;
}

function setupReady(manager: StateManager, address: string, file: string): string {
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  return variantId;
}

const ASSET_BASE = "http://localhost:4649/api/assets";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-comp-test-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildShotCompositionHtml", () => {
  it("generates composition HTML with HTTP URLs for assets", async () => {
    const v1 = setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const result = await buildShotCompositionHtml({
      video: testVideo,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain("<html");
    expect(result.html).toContain(`${ASSET_BASE}/video/shot.01.motion/${v1}/output.mp4`);
    expect(result.html).toContain("data-composition-id");
    expect(result.html).toContain("__timelines");
    expect(result.shots).toHaveLength(1);
    expect(result.shots[0]!.shotId).toBe("01");
    expect(result.shots[0]!.duration).toBe(5);
    expect(result.shots[0]!.startTime).toBe(0);
    expect(result.totalDuration).toBe(5);
    expect(result.fps).toBe(30);
    expect(result.size).toEqual({ width: 1024, height: 576 });
  });

  it("injects hyperframes runtime IIFE", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const result = await buildShotCompositionHtml({
      video: testVideo,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain("</script>\n</body>");
  });

  it("registers a base timeline spanning the shot duration when no <Animate> exists", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const result = await buildShotCompositionHtml({
      video: videoOnlyVideo,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('var key="shot-01"');
    expect(result.html).toContain("tl.set({},{},5)");
    // Video clip defaults to the shot duration so the runtime stops it at the end.
    expect(result.html).toMatch(/<video[^>]*data-duration="5"/);
    // The base timeline must be registered before the runtime captures it.
    expect(result.html.indexOf("tl.set({},{},5)")).toBeLessThan(
      result.html.lastIndexOf("</script>\n</body>"),
    );
  });

  it("does not clobber a user-provided <Animate>", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const result = await buildShotCompositionHtml({
      video: testVideo,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
    });

    // User tween survives, base script only extends an existing timeline (guard present).
    expect(result.html).toContain("#el-motion");
    expect(result.html).toContain("if(!tl");
  });

  it("applies variant override", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/original.mp4");

    const altVariant = manager.reserveVariantId("video:shot.01.motion");
    manager.getAssetState("video:shot.01.motion").variants![altVariant]!.file =
      "assets/shot.01.motion/alternate.mp4";

    const result = await buildShotCompositionHtml({
      video: testVideo,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
      variantOverride: { assetName: "motion", variantId: altVariant },
    });

    expect(result.html).toContain(`${ASSET_BASE}/video/shot.01.motion/${altVariant}/alternate.mp4`);
  });

  it("mirrors a hasAudio clip as an <audio>, inside the document body", async () => {
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildShotCompositionHtml({
      video: embeddedAudioVideo,
      manager,
      shotId: "02",
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toMatch(
      /<audio[^>]*data-konte-track="embedded"[^>]*data-start="0"[^>]*data-duration="3"[^>]*data-volume="0.4"/,
    );
    expect(result.html.indexOf('id="embedded-audio"')).toBeLessThan(
      result.html.lastIndexOf("</body>"),
    );
  });

  it("throws COMPOSITION_BUILD_FAILED for non-existent shot", async () => {
    await expect(
      buildShotCompositionHtml({
        video: testVideo,
        manager,
        shotId: "99",
        assetBaseUrl: ASSET_BASE,
      }),
    ).rejects.toThrow(KonteError);
  });

  it("tracks unaccepted assets", async () => {
    setupReady(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const result = await buildShotCompositionHtml({
      video: testVideo,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.shots[0]!.unacceptedAssets).toContain("video:shot.01.motion");
  });
});

// Every stylesheet/script the head pulls in, in document order.
function externalResources(html: string): string[] {
  return [...html.matchAll(/<(?:link[^>]*href|script[^>]*src)="([^"]*)"/g)].map((m) => m[1]!);
}

// The head's own base CSS (the first <style>).
function styleBlock(html: string): string {
  return html.match(/<style>([\s\S]*?)<\/style>/)![1]!.trim();
}

describe("buildFullCompositionHtml", () => {
  // The reel's <head> is hand-written rather than emitted by `Composition`, so it is asserted on its
  // own: a font declared for the shots and missing from the reel would typeset the two differently.
  it("carries the same language and fonts as a single shot's head", async () => {
    const video = defineVideo(
      testDirection(
        { fps: 30, size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } } },
        "ja",
        ["Inter", "Noto Sans JP"],
      ),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
                return (
                  <Composition>
                    <Video src={motion} data-duration={5} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const reel = await buildFullCompositionHtml({ video, manager, assetBaseUrl: ASSET_BASE });
    const single = await buildShotCompositionHtml({
      video,
      manager,
      shotId: "01",
      assetBaseUrl: ASSET_BASE,
    });

    for (const html of [reel.html, single.html]) {
      expect(html).toContain('<html lang="ja">');
    }
    expect(externalResources(reel.html)).toEqual(externalResources(single.html));
    expect(styleBlock(reel.html)).toBe(styleBlock(single.html));
    expect(styleBlock(single.html)).toContain('font-family: "Inter", "Noto Sans JP", sans-serif;');
  });

  it("generates merged composition with all shots", async () => {
    const v1 = setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    const v2 = setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: testVideo,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('data-composition-id="full-video"');
    expect(result.html).toContain(`data-duration="${5 + 3}"`);
    expect(result.html).toContain(`${ASSET_BASE}/video/shot.01.motion/${v1}/output.mp4`);
    expect(result.html).toContain(`${ASSET_BASE}/video/shot.02.motion/${v2}/output.mp4`);
    expect(result.shots).toHaveLength(2);
    expect(result.shots[0]!.startTime).toBe(0);
    expect(result.shots[0]!.duration).toBe(5);
    expect(result.shots[1]!.startTime).toBe(5);
    expect(result.shots[1]!.duration).toBe(3);
    expect(result.totalDuration).toBe(8);
    expect(result.fps).toBe(30);
  });

  it("mirrors a hasAudio clip into a full-span group, shifted onto the master timeline", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    const v2 = setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: embeddedAudioVideo,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('id="embedded-audio"');
    // Shot 02 starts at 5, so the mirror's window matches the slot the mux places the clip in.
    expect(result.html).toMatch(
      /<audio[^>]*data-konte-track="embedded"[^>]*data-start="5"[^>]*data-duration="3"[^>]*data-volume="0.4"/,
    );
    expect(result.html).toMatch(
      new RegExp(`<audio[^>]*src="${ASSET_BASE}/video/shot.02.motion/${v2}/output.mp4"`),
    );
    // The picture clip stays muted — the mirror is the only thing the runtime plays.
    expect(result.html).toMatch(/<video[^>]*muted[^>]*data-has-audio="true"/);
    // Shot 01 carries no embedded audio, so nothing mirrors it.
    expect(result.html.match(/<audio\b/g)).toHaveLength(1);
  });

  it("injects timeline soundtracks as a full-span audio group", async () => {
    const audioComfy = defineComfyAsset({
      workflow: "tts.json",
      description: "test adapter",
      inputs: { text: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "audio" } },
    });
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const bgm = asset("bgm", audioComfy, { text: "music" });
          return videoTimeline(
            [
              shot("01", {
                duration: 4,
                build: () => {
                  const motion = asset("motion", animateComfy, { prompt: "a" });
                  return (
                    <Composition>
                      <Video src={motion} />
                    </Composition>
                  );
                },
              }),
            ],
            [soundtrack("bed", bgm, { duck: false, volume: 0.3, until: { shot: "01", at: 2 } })],
          );
        },
      },
    );
    setupAccepted(manager, "video:timeline.bgm", "assets/timeline.bgm/b.mp3");
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/m.mp4");

    const result = await buildFullCompositionHtml({
      video,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('id="timeline-audio"');
    // span: from omitted → 0; until shot 01 @ 2 → 2. data-duration (not the non-existent
    // data-end) bounds the clip so it doesn't stretch the timeline (span = 2 - 0).
    expect(result.html).toMatch(
      /<audio[^>]*data-konte-track="soundtrack"[^>]*data-start="0"[^>]*data-duration="2"/,
    );
    expect(result.html).not.toMatch(/<audio[^>]*data-end=/);
    expect(result.html).toContain('data-volume="0.3"');
  });

  it("honors a variant override for a timeline soundtrack", async () => {
    const audioComfyLocal = defineComfyAsset({
      workflow: "tts.json",
      description: "test adapter",
      inputs: { text: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "audio" } },
    });
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const bgm = asset("bgm", audioComfyLocal, { text: "music" });
          return videoTimeline(
            [
              shot("01", {
                duration: 4,
                build: () => {
                  const motion = asset("motion", animateComfy, { prompt: "a" });
                  return (
                    <Composition>
                      <Video src={motion} />
                    </Composition>
                  );
                },
              }),
            ],
            [soundtrack("bed", bgm, { duck: false, volume: 0.3 })],
          );
        },
      },
    );
    setupAccepted(manager, "video:timeline.bgm", "assets/timeline.bgm/old.mp3");
    const fresh = setupReady(manager, "video:timeline.bgm", "assets/timeline.bgm/new.mp3");
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/m.mp4");

    const result = await buildFullCompositionHtml({
      video,
      manager,
      assetBaseUrl: ASSET_BASE,
      variantOverrides: [{ address: "video:timeline.bgm", variantId: fresh }],
    });

    expect(result.html).toContain(`${ASSET_BASE}/video/timeline.bgm/${fresh}/new.mp3`);
    expect(result.html).not.toContain("old.mp3");
  });

  it("ignores a timeline override whose variant belongs to a different asset", async () => {
    const audioComfyLocal = defineComfyAsset({
      workflow: "tts.json",
      description: "test adapter",
      inputs: { text: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "audio" } },
    });
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const bgm = asset("bgm", audioComfyLocal, { text: "music" });
          return videoTimeline(
            [
              shot("01", {
                duration: 4,
                build: () => {
                  const motion = asset("motion", animateComfy, { prompt: "a" });
                  return (
                    <Composition>
                      <Video src={motion} />
                    </Composition>
                  );
                },
              }),
            ],
            [soundtrack("bed", bgm, { duck: false, volume: 0.3 })],
          );
        },
      },
    );
    setupAccepted(manager, "video:timeline.bgm", "assets/timeline.bgm/old.mp3");
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/accepted.mp4");
    // A variant living under a different asset (the motion shot) — its id must not be
    // borrowable by the bgm slot just because it is globally unique.
    const foreign = setupReady(
      manager,
      "video:shot.01.motion",
      "assets/shot.01.motion/foreign.mp4",
    );

    const result = await buildFullCompositionHtml({
      video,
      manager,
      assetBaseUrl: ASSET_BASE,
      variantOverrides: [{ address: "video:timeline.bgm", variantId: foreign }],
    });

    expect(result.html).toContain(`${ASSET_BASE}/video/timeline.bgm/`);
    expect(result.html).toContain("old.mp3");
    expect(result.html).not.toContain("foreign.mp4");
  });

  it("emits each shot as a nested composition host with its data-start offset", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: testVideo,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    // Each shot is an empty [data-composition-id] host carrying its absolute offset, paired
    // with a <template> the runtime hydrates into it (sequencing + scoping are the runtime's job).
    expect(result.html).toMatch(/<div data-composition-id="shot-01"[^>]*data-start="0"/);
    expect(result.html).toMatch(/<div data-composition-id="shot-02"[^>]*data-start="5"/);
    expect(result.html).toMatch(/<div data-composition-id="shot-02"[^>]*data-duration="3"/);
    expect(result.html).toContain('<template id="shot-01-template">');
    expect(result.html).toContain('<template id="shot-02-template">');
  });

  it("registers each shot's timeline under its plain shot key, without manual offset rekeying", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: testVideo,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('window.__timelines["shot-01"]');
    expect(result.html).toContain('window.__timelines["shot-02"]');
    // The runtime sequences children by host data-start; konte no longer rekeys to "shot-NN@offset"
    // nor merges a master "full-video" timeline by hand.
    expect(result.html).not.toContain("shot-01@0");
    expect(result.html).not.toContain("shot-02@5");
    expect(result.html).not.toContain('ts["full-video"]=m');
  });

  it("registers a base timeline per shot when no shot has an <Animate>", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: videoOnlyVideo,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('data-composition-id="full-video"');
    expect(result.html).toContain('data-duration="8"');
    // Each shot's template carries a guarded base timeline spanning its own duration, so a shot
    // without an <Animate> still registers a capturable timeline for the runtime to sequence.
    expect(result.html).toContain("tl.set({},{},5)");
    expect(result.html).toContain("tl.set({},{},3)");
    expect(result.totalDuration).toBe(8);
  });

  it("includes hyperframes runtime", async () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: testVideo,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain("</script>\n</body>");
  });

  it("handles shots without composition function (fallback)", async () => {
    const videoWithFallback = defineVideo(
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
                const motion = asset("motion", animateComfy, { prompt: "cat" });
                return (
                  <Composition>
                    <Video src={motion} data-duration={5} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    (videoWithFallback.shots as import("../types/index.js").ShotDefinition[]).push({
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

    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");

    const result = await buildFullCompositionHtml({
      video: videoWithFallback,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.shots).toHaveLength(2);
    expect(result.shots[0]!.shotId).toBe("01");
    expect(result.shots[1]!.shotId).toBe("02");
    expect(result.totalDuration).toBe(8);
  });

  it("renders a shotFn-less shot's resolved asset full-frame instead of black", async () => {
    const videoWithFallback = defineVideo(
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
                const motion = asset("motion", animateComfy, { prompt: "cat" });
                return (
                  <Composition>
                    <Video src={motion} data-duration={5} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    (videoWithFallback.shots as import("../types/index.js").ShotDefinition[]).push({
      id: "02",
      duration: 3,
      action: "test shot",
      assets: {
        bg: { kind: "comfy" as const, workflow: "bg.json", inputs: {} },
      },
    });

    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.bg", "assets/shot.02.bg/clip.mp4");

    const result = await buildFullCompositionHtml({
      video: videoWithFallback,
      manager,
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain('id="shot-02"');
    expect(result.html).toContain("clip.mp4");
  });

  it("renders an image fallback as an img clip", async () => {
    const videoWithImageFallback = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 4,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "cat" });
                return (
                  <Composition>
                    <Video src={motion} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    (videoWithImageFallback.shots as import("../types/index.js").ShotDefinition[]).push({
      id: "02",
      duration: 3,
      action: "test shot",
      assets: {
        still: { kind: "comfy" as const, workflow: "still.json", inputs: {} },
      },
    });

    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.still", "assets/shot.02.still/frame.png");

    const result = await buildShotCompositionHtml({
      video: videoWithImageFallback,
      manager,
      shotId: "02",
      assetBaseUrl: ASSET_BASE,
    });

    expect(result.html).toContain("<img");
    expect(result.html).toContain("frame.png");
    expect(result.html).toContain('class="konte-clip"');
  });
});

describe("buildShotClips", () => {
  function plan(video: ReturnType<typeof defineVideo>) {
    return buildRenderPlan(video, manager, {
      outputDir: "",
      allowUnaccepted: true,
    });
  }

  it("extracts shot-local clips with time ranges and asset addresses", () => {
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
                const a = asset("motionA", animateComfy, { prompt: "a" });
                const b = asset("motionB", animateComfy, { prompt: "b" });
                return (
                  <Composition>
                    <Video src={a} start={0} duration={3} />
                    <Video src={b} start={2} duration={3} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    setupAccepted(manager, "video:shot.01.motionA", "assets/shot.01.motionA/a.mp4");
    setupAccepted(manager, "video:shot.01.motionB", "assets/shot.01.motionB/b.mp4");

    const clips = buildShotClips(plan(video), ASSET_BASE).get("01")!;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      assetName: "motionA",
      address: "video:shot.01.motionA",
      mediaType: "video",
      start: 0,
      end: 3,
    });
    expect(clips[1]).toMatchObject({ assetName: "motionB", start: 2, end: 5 });
  });

  it("defaults a clip's end to the shot duration when no duration is set", () => {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");
    const byShot = buildShotClips(plan(videoOnlyVideo), ASSET_BASE);
    expect(byShot.get("01")![0]).toMatchObject({ start: 0, end: 5 });
    expect(byShot.get("02")![0]).toMatchObject({ start: 0, end: 3 });
  });

  it.each([
    ["Audio", 4, /Shot "01" <Audio id="cue1">: volume 4 is outside/],
    ["Video", -1, /Shot "01" <Video>: volume -1 is outside/],
  ])("refuses a %s volume outside 0–MAX_AUDIO_GAIN at load", (tag, volume, message) => {
    expect(() =>
      defineVideo(
        testDirection({
          fps: 30,
          size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
        }),
        {
          timeline: () =>
            videoTimeline([
              shot("01", {
                duration: 4,
                build: () => {
                  const motion = asset("motion", animateComfy, { prompt: "a" });
                  const bgm = asset("bgm", audioComfy, { prompt: "music" });
                  return (
                    <Composition>
                      {tag === "Audio" ? (
                        <Audio id="cue1" src={bgm} volume={volume} />
                      ) : (
                        <Video src={motion} hasAudio volume={volume} />
                      )}
                    </Composition>
                  );
                },
              }),
            ]),
        },
      ),
    ).toThrow(message);
  });

  it("captures audio routing (mediaType, volume) on Audio clips", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 4,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "a" });
                const bgm = asset("bgm", audioComfy, { prompt: "music" });
                return (
                  <Composition>
                    <Video src={motion} hasAudio volume={0.4} />
                    <Audio id="cue1" src={bgm} start={0} duration={4} volume={0.8} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/m.mp4");
    setupAccepted(manager, "video:shot.01.bgm", "assets/shot.01.bgm/b.mp3");

    const clips = buildShotClips(plan(video), ASSET_BASE).get("01")!;
    const audio = clips.find((c) => c.mediaType === "audio")!;
    expect(audio).toMatchObject({
      assetName: "bgm",
      mediaType: "audio",
      volume: 0.8,
      cueId: "cue1",
    });
    const motion = clips.find((c) => c.mediaType === "video")!;
    expect(motion).toMatchObject({ hasAudio: true, volume: 0.4, cueId: null });
  });
});

describe("Video/Audio data attributes", () => {
  function singleShot(render: (motion: ReturnType<typeof asset>) => React.ReactElement) {
    return defineVideo(
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
                const motion = asset("motion", animateComfy, { prompt: "x" });
                return render(motion);
              },
            }),
          ]),
      },
    );
  }

  async function buildSingle(video: ReturnType<typeof defineVideo>): Promise<string> {
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    return (
      await buildShotCompositionHtml({
        video,
        manager,
        shotId: "01",
        assetBaseUrl: ASSET_BASE,
      })
    ).html;
  }

  it("refuses a composition whose class Tailwind generates nothing for", async () => {
    const video = singleShot((motion) => (
      <Composition>
        <Video src={motion} />
        <div className="absolute inset-0 text-whit" />
      </Composition>
    ));
    await expect(buildSingle(video)).rejects.toThrow(/video:shot\.01#composition: text-whit/);
    await expect(
      buildFullCompositionHtml({ video, manager, assetBaseUrl: ASSET_BASE }),
    ).rejects.toThrow(/video:shot\.01#composition: text-whit/);
  });

  it("makes every video a clip, with the author's classes after it", async () => {
    const bare = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} />
        </Composition>
      )),
    );
    expect(bare).toMatch(/<video[^>]*class="konte-clip"/);

    const inset = (
      await buildShotCompositionHtml({
        video: singleShot((motion) => (
          <Composition>
            <Video src={motion} className="w-1/3 h-1/3" />
          </Composition>
        )),
        manager,
        shotId: "01",
        assetBaseUrl: ASSET_BASE,
      })
    ).html;
    expect(inset).toMatch(/<video[^>]*class="konte-clip w-1\/3 h-1\/3"/);
  });

  it("makes an image a clip only when it fills", async () => {
    const html = await buildSingle(
      singleShot(() => (
        <Composition>
          <Image src={{ src: "__konte:video:shot.01.bg__" }} fill className="opacity-50" />
          <Image src={{ src: "__konte:video:shot.01.logo__" }} className="w-1/5" />
        </Composition>
      )),
    );
    expect(html).toMatch(/<img[^>]*class="konte-clip opacity-50"/);
    expect(html).toMatch(/<img[^>]*class="w-1\/5"/);
  });

  it("layers the reset and .konte-clip under Tailwind's utilities", async () => {
    const html = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} />
        </Composition>
      )),
    );
    expect(html).toContain("@layer theme, base, components, utilities;");
    expect(html).toMatch(/@layer components \{ \.konte-clip \{/);
    expect(html).toMatch(/@layer base \{ \* \{/);
  });

  it("maps a typed duration prop to data-duration, overriding the shot default", async () => {
    const html = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} duration={4} />
        </Composition>
      )),
    );
    expect(html).toMatch(/<video[^>]*data-duration="4"/);
  });

  it("maps typed start/duration props to data-start/data-duration", async () => {
    const html = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} start={1} duration={3} />
        </Composition>
      )),
    );
    expect(html).toMatch(/<video[^>]*data-start="1"/);
    expect(html).toMatch(/<video[^>]*data-duration="3"/);
    expect(html).not.toMatch(/<video[^>]*data-end=/);
  });

  it("serializes hasAudio to the string data-has-audio the engine expects", async () => {
    const on = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} hasAudio />
        </Composition>
      )),
    );
    expect(on).toMatch(/<video[^>]*data-has-audio="true"/);

    // Fresh manager so the second build starts from clean state.
    const off = (
      await buildShotCompositionHtml({
        video: singleShot((motion) => (
          <Composition>
            <Video src={motion} hasAudio={false} />
          </Composition>
        )),
        manager,
        shotId: "01",
        assetBaseUrl: ASSET_BASE,
      })
    ).html;
    expect(off).toMatch(/<video[^>]*data-has-audio="false"/);
  });

  it("maps typed volume prop to data-volume", async () => {
    const html = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} hasAudio volume={0.5} />
        </Composition>
      )),
    );
    expect(html).toMatch(/<video[^>]*data-volume="0.5"/);
  });

  it("honors raw data-* attributes as a fallback and drops a stray raw data-end", async () => {
    const html = await buildSingle(
      singleShot((motion) => (
        <Composition>
          <Video src={motion} data-start={2} data-duration={5} data-end={4} />
        </Composition>
      )),
    );
    expect(html).toMatch(/<video[^>]*data-start="2"/);
    expect(html).toMatch(/<video[^>]*data-duration="5"/);
    expect(html).not.toMatch(/<video[^>]*data-end=/);
  });

  it("offsets data-start but not data-duration/data-media-start when concatenating shots", async () => {
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
                const motion = asset("motion", animateComfy, { prompt: "a" });
                return (
                  <Composition>
                    <Video src={motion} />
                  </Composition>
                );
              },
            }),
            shot("02", {
              duration: 3,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "b" });
                return (
                  <Composition>
                    <Video src={motion} duration={3} mediaStart={2} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");

    const html = (
      await buildFullCompositionHtml({
        video,
        manager,
        assetBaseUrl: ASSET_BASE,
      })
    ).html;

    // shot 02 starts at cumulative offset 5: its composition host carries data-start 5, and each
    // inner clip's data-start is offset onto the master clock (the runtime windows raw clip
    // visibility globally, not per-composition). So shot 02's <video> data-start 0 -> 5.
    expect(html).toMatch(/<div data-composition-id="shot-02"[^>]*data-start="5"/);
    expect(html).toMatch(/<video[^>]*data-start="5"/);
    // data-duration is a span, not a timeline value, so it must NOT shift.
    expect(html).toMatch(/<video[^>]*data-duration="3"/);
    expect(html).not.toMatch(/<video[^>]*data-duration="8"/);
    // data-media-start is a source offset, not a timeline value, so it must NOT shift.
    expect(html).toMatch(/<video[^>]*data-media-start="2"/);
    expect(html).not.toMatch(/data-media-start="7"/);
  });

  it("maps typed Audio props to data-* and offsets data-start across shots", async () => {
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
                const motion = asset("motion", animateComfy, { prompt: "a" });
                return (
                  <Composition>
                    <Video src={motion} />
                  </Composition>
                );
              },
            }),
            shot("02", {
              duration: 3,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "b" });
                const bgm = asset("bgm", audioComfy, { prompt: "music" });
                return (
                  <Composition>
                    <Video src={motion} />
                    <Audio src={bgm} start={0} duration={3} mediaStart={2} volume={0.5} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.motion", "assets/shot.02.motion/output.mp4");
    setupAccepted(manager, "video:shot.02.bgm", "assets/shot.02.bgm/output.mp4");

    const html = (
      await buildFullCompositionHtml({
        video,
        manager,
        assetBaseUrl: ASSET_BASE,
      })
    ).html;

    // shot 02 starts at offset 5: its host carries data-start 5 and the inner <audio>'s data-start
    // is offset onto the master clock (0 -> 5). data-duration is a span and stays 3.
    expect(html).toMatch(/<div data-composition-id="shot-02"[^>]*data-start="5"/);
    expect(html).toMatch(/<audio[^>]*data-start="5"/);
    expect(html).toMatch(/<audio[^>]*data-duration="3"/);
    expect(html).not.toMatch(/<audio[^>]*data-end=/);
    expect(html).toMatch(/<audio[^>]*data-media-start="2"/);
    expect(html).toMatch(/<audio[^>]*data-volume="0.5"/);
    expect(html).not.toMatch(/data-media-start="7"/);
  });

  it("bounds an open-ended <audio> to its take's recorded length in preview", async () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 3,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "a" });
                const line = asset("line", audioComfy, { prompt: "line" });
                const sfx = asset("sfx", audioComfy, { prompt: "sfx" });
                const unmeasured = asset("unmeasured", audioComfy, { prompt: "unmeasured" });
                return (
                  <Composition>
                    <Video src={motion} />
                    <Audio src={line} start={0.5} mediaStart={0.25} />
                    <Audio src={sfx} start={1} duration={1} />
                    <Audio src={unmeasured} start={2} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    const wav = (durationSec: number): VariantMedia => ({
      kind: "audio",
      durationSec,
      channels: 1,
      sampleRate: 24000,
    });
    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    const line = setupAccepted(manager, "video:shot.01.line", "assets/shot.01.line/line.wav");
    const sfx = setupAccepted(manager, "video:shot.01.sfx", "assets/shot.01.sfx/sfx.wav");
    setupAccepted(manager, "video:shot.01.unmeasured", "assets/shot.01.unmeasured/u.wav");
    manager.getAssetState("video:shot.01.line").variants![line]!.media = wav(2);
    manager.getAssetState("video:shot.01.sfx").variants![sfx]!.media = wav(4);

    const reel = (await buildFullCompositionHtml({ video, manager, assetBaseUrl: ASSET_BASE }))
      .html;
    const single = (
      await buildShotCompositionHtml({
        video,
        manager,
        shotId: "01",
        assetBaseUrl: ASSET_BASE,
      })
    ).html;

    for (const html of [reel, single]) {
      const tag = (name: string) =>
        (html.match(/<audio\b[^>]*>/g) ?? []).find((t) => t.includes(`/shot.01.${name}/`))!;
      expect(tag("line")).toContain('data-duration="1.75"');
      expect(tag("sfx").match(/data-duration="[^"]*"/g)).toEqual(['data-duration="1"']);
      expect(tag("unmeasured")).not.toContain("data-duration=");
    }
  });
});

// `asset()` swaps a shot's own assets for a file at render; a ref reaching outside the shot stays a
// `__konte:…__` placeholder all the way through renderToHtml. Left unsubstituted it reaches the
// browser as a literal src and the clip renders black — silently, because the composition's readiness
// gate gates on the same ref and reports healthy.
describe("out-of-shot refs in a composition", () => {
  const imageComfy = defineComfyAsset({
    workflow: "image.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });

  it("resolves a prior video shot's asset reached through shot()", async () => {
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
    const video = defineVideo(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => {
          const motion = asset("motion", animateComfy, { prompt: "a cat walking" });
          return (
            <Composition>
              <Video src={motion} />
            </Composition>
          );
        }).nextShot("02", ({ shot }) => (
          <Composition>
            <Video src={shot("01").video("motion")} />
          </Composition>
        )),
      }),
    });

    const v1 = setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/m.mp4");

    const html = (
      await buildShotCompositionHtml({
        video,
        manager,
        shotId: "02",
        assetBaseUrl: ASSET_BASE,
      })
    ).html;

    expect(html).toContain(`${ASSET_BASE}/video/shot.01.motion/${v1}/m.mp4`);
    expect(html).not.toContain("__konte:");
  });

  it("resolves an animatic panel reached through animatic.shot(id)", async () => {
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
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
      },
    );
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
              build: () => (
                <Composition>
                  <Image src={animatic.shot("01").image("first")} fill />
                </Composition>
              ),
            }),
          ]),
      },
    );

    const v1 = setupAccepted(manager, "animatic:shot.01.first", "assets/sb.01.first/frame.png");

    const html = (
      await buildShotCompositionHtml({
        video,
        manager,
        shotId: "01",
        assetBaseUrl: ASSET_BASE,
      })
    ).html;

    expect(html).toContain(`${ASSET_BASE}/animatic/shot.01.first/${v1}/frame.png`);
    expect(html).not.toContain("__konte:");
  });

  // `allowNotReady` is the live preview: it shows a shot's own stale-but-present assets rather than
  // failing. An out-of-shot ref must follow the same rule, or the reviewer sees a broken src for a
  // panel that has a perfectly showable (if stale) frame on disk.
  it("shows a stale out-of-shot ref in a not-ready preview, and hides it otherwise", async () => {
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
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
      },
    );
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
              build: () => (
                <Composition>
                  <Image src={animatic.shot("01").image("first")} fill />
                </Composition>
              ),
            }),
          ]),
      },
    );

    // An accepted upstream whose output moved on, and a ready (unaccepted) panel variant still
    // fingerprinted against the old output — input-stale, but with a file.
    const upstream = setupAccepted(manager, "animatic:shot.01.other", "assets/other/o.png");
    manager.getAssetState("animatic:shot.01.other").variants![upstream]!.outputHash = "new";
    const staleId = setupReady(manager, "animatic:shot.01.first", "assets/sb/frame.png");
    manager.getAssetState("animatic:shot.01.first").variants![staleId]!.inputFingerprints = {
      "animatic:shot.01.other": "old",
    };

    const build = async (allowNotReady: boolean) =>
      (
        await buildShotCompositionHtml({
          video,
          manager,
          shotId: "01",
          assetBaseUrl: ASSET_BASE,
          allowNotReady,
        })
      ).html;

    expect(await build(true)).toContain(
      `${ASSET_BASE}/animatic/shot.01.first/${staleId}/frame.png`,
    );
    expect(await build(false)).toContain("__konte:animatic:shot.01.first__");
  });

  it("leaves an unresolvable ref as a placeholder rather than dropping it", async () => {
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
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
      },
    );
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
              build: () => (
                <Composition>
                  <Image src={animatic.shot("01").image("first")} fill />
                </Composition>
              ),
            }),
          ]),
      },
    );

    const html = (
      await buildShotCompositionHtml({
        video,
        manager,
        shotId: "01",
        assetBaseUrl: ASSET_BASE,
        allowNotReady: true,
      })
    ).html;

    expect(html).toContain("__konte:animatic:shot.01.first__");
  });
});

describe("ref partition (pictureRefs / stemRefs)", () => {
  it("routes audio cues to stemRefs and picture to pictureRefs; a hasAudio video is both", () => {
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
                const pic = asset("pic", animateComfy, { prompt: "p" });
                const sfx = asset("sfx", audioComfy, { prompt: "s" });
                const clip = asset("clip", animateComfy, { prompt: "c" });
                return (
                  <Composition>
                    <Video src={pic} data-duration={5} />
                    <Audio src={sfx} />
                    <Video src={clip} id="clip" hasAudio data-duration={5} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    const s = video.shots[0]!;
    expect([...(s.stemRefs ?? [])].sort()).toEqual(["video:shot.01.clip", "video:shot.01.sfx"]);
    expect([...(s.pictureRefs ?? [])].sort()).toEqual(["video:shot.01.clip", "video:shot.01.pic"]);
    expect(s.pictureRefs).not.toContain("video:shot.01.sfx");
  });

  // `compositionRefs` is the source of truth for a composition's dependencies, its input
  // fingerprints, and the export gate. A raw walk of the element tree cannot see a ref a function
  // component pulls in from a closure — that element has no props at all — so the discovery render
  // has to be consulted too, or the ref is invisible to every one of them.
  it("captures a ref a function component pulls in from a closure", () => {
    const imageComfy = defineComfyAsset({
      workflow: "image.json",
      description: "test adapter",
      inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "image" } },
    });
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Panel src={asset("first", imageComfy, { prompt: "a frame" })} {...moves} />
                </Composition>
              ),
            }),
          ]),
      },
    );
    // The ref appears nowhere in <PanelLayer />'s props — only in what it renders.
    function PanelLayer() {
      return <Image src={animatic.shot("01").image("first")} fill />;
    }
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
              build: () => (
                <Composition>
                  <PanelLayer />
                </Composition>
              ),
            }),
          ]),
      },
    );

    expect(video.shots[0]!.compositionRefs).toEqual(["animatic:shot.01.first"]);
    expect(video.shots[0]!.pictureRefs).toEqual(["animatic:shot.01.first"]);
  });

  // Placeholder syntax is not proof of a reference: a user's own text can spell it, and a
  // `#delivery` target is an export artifact no composition authors. Treating either as a dependency
  // would block `export` on a ref that names no asset.
  it("ignores placeholder-shaped strings that name no consumable asset", () => {
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
                const motion = asset("motion", animateComfy, { prompt: "a" });
                return (
                  <Composition>
                    <Video src={motion} />
                    <div
                      data-a="__konte:video:seed__"
                      data-b="__konte:reference:foo.bar__"
                      data-c="__konte:video:shot.01.motion#delivery__"
                    />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    expect(video.shots[0]!.compositionRefs).toEqual(["video:shot.01.motion"]);
  });
});

// A shot with no spoken lines declares no animatic, so it stands in with the board frame it builds
// from while the reel lock holds its motion.
describe("the board frame stand-in", () => {
  const boardComfy = defineComfyAsset({
    workflow: "still.json",
    description: "test adapter",
    inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
    outputs: { result: { nodeId: "9", type: "image" } },
  });

  const animateFromImageComfy = defineComfyAsset({
    workflow: "i2v.json",
    description: "test adapter",
    inputs: { image: { nodeId: "1", field: "image", type: "image" } },
    outputs: { result: { nodeId: "9", type: "video" } },
  });

  const format = {
    fps: 30,
    size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
  };

  const animatic = defineAnimatic(testDirection(format), {
    timeline: () =>
      animaticTimeline([
        shot("01", {
          duration: 5,
          build: () => (
            <Composition>
              <Panel src={asset("keyframe", boardComfy, { prompt: "a cat" })} {...moves} />
            </Composition>
          ),
        }),
      ]),
  });

  const silentVideo = defineVideo(testDirection(format), {
    timeline: () =>
      videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            const motion = asset("motion", animateFromImageComfy, {
              image: animatic.shot("01").image("keyframe"),
            });
            return (
              <Composition>
                <Video src={motion} />
              </Composition>
            );
          },
        }),
      ]),
  });

  // The reel's stand-in is the ANIMATIC's own plan, spliced in per shot — so it plays the board's
  // composition, not one frame lifted out of it.
  function plan(withStandIn: boolean) {
    return buildRenderPlan(silentVideo, manager, {
      outputDir: "",
      allowUnaccepted: true,
      allowNotReady: true,
      ...(withStandIn ? { standIn: buildStageReviewPlan(animatic, manager) } : {}),
    });
  }

  it("stands in with the board while the motion is not made, and draws it", async () => {
    setupAccepted(manager, "animatic:shot.01.keyframe", "assets/shot.01.keyframe/frame.png");

    expect(plan(true).shots[0]!.showStandIn).toBe(true);

    const html = (
      await buildFullCompositionHtml({
        video: silentVideo,
        manager,
        assetBaseUrl: ASSET_BASE,
        allowNotReady: true,
        standIn: buildStageReviewPlan(animatic, manager),
      })
    ).html;
    expect(html).toContain("<img");
    expect(html).toContain("frame.png");
  });

  it("steps aside once the motion resolves, and never stands in on the delivered path", () => {
    setupAccepted(manager, "animatic:shot.01.keyframe", "assets/shot.01.keyframe/frame.png");
    // Export and the thumbnail paths pass no stand-in: one there would ship as the picture.
    expect(plan(false).shots[0]!.showStandIn).toBe(false);

    setupAccepted(manager, "video:shot.01.motion", "assets/shot.01.motion/output.mp4");
    expect(plan(true).shots[0]!.showStandIn).toBe(false);
  });
});

// A tolerant build leaves an unresolved `src` as its raw placeholder, which draws nothing.
describe("compositionDrawsSomething", () => {
  const page = (stage: string) =>
    `<html><body><div id="stage">${stage}</div><script>runtime()</script></body></html>`;

  it("is false when every layer resolved to nothing", () => {
    expect(
      compositionDrawsSomething(page(`<video src="__konte:video:shot.01.motion__"></video>`)),
    ).toBe(false);
  });

  it("is false when only sound is left, which is never on screen", () => {
    expect(
      compositionDrawsSomething(
        page(`<img src="__konte:animatic:shot.01.first__" /><audio src="assets/vo.wav"></audio>`),
      ),
    ).toBe(false);
  });

  it("is true for a title card whose media is gone but whose text is not", () => {
    expect(
      compositionDrawsSomething(
        page(`<img src="__konte:video:shot.01.bg__" /><div class="title">Amedama</div>`),
      ),
    ).toBe(true);
  });

  // What a bare element draws is its CSS, which this does not read — a layer that might draw counts.
  it("is true for a layer whose picture is its CSS", () => {
    expect(
      compositionDrawsSomething(
        page(`<img src="__konte:video:shot.01.bg__" /><div class="vignette"></div>`),
      ),
    ).toBe(true);
  });

  // `injectEmbeddedAudio` appends a hidden sibling after the stage, whose empty wrapper would
  // otherwise answer for a shot that draws nothing.
  it("is false when the only thing past the stage is the embedded-audio wrapper", () => {
    const html =
      `<html><body><div id="stage"><video src="__konte:video:shot.01.motion__"></video></div>` +
      `<div id="embedded-audio" style="display:none;"><audio src="/a.wav"></audio></div>` +
      `<script>runtime()</script></body></html>`;
    expect(compositionDrawsSomething(html)).toBe(false);
  });

  it("reads past a nested layer to the stage's own close", () => {
    expect(
      compositionDrawsSomething(
        page(`<div class="frame"><img src="__konte:video:shot.01.bg__" /></div>`),
      ),
    ).toBe(true);
  });

  // A page this cannot read is one it does not refuse.
  it("is true for a page carrying no stage at all", () => {
    expect(compositionDrawsSomething("<html><body></body></html>")).toBe(true);
  });

  it("is true once a layer resolves", () => {
    expect(compositionDrawsSomething(page(`<img src="/video-shot-01-bg/v-x/bg.png" />`))).toBe(
      true,
    );
  });
});
