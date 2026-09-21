import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { Composition, Image, Video } from "../dsl/composition/index.js";
import { defineDirection, defineAnimatic, defineVideo, asset, Panel } from "../dsl/index.js";
import { buildRenderPlan } from "../render-plan.js";
import { buildShotRenderInputs } from "../render-video.js";
import { StateManager } from "../state/index.js";
import { directionDefaults, testDirection } from "./helpers/direction.js";
import { moves, shot, animaticTimeline, videoTimeline } from "./helpers/shot.js";

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const SIZE = { width: 1024, height: 576 };

let tmpDir: string;
let manager: StateManager;

function setupAccepted(address: string, file: string): string {
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  manager.setAccepted(address, variantId);
  return variantId;
}

function setupReady(address: string, file: string): string {
  const variantId = manager.reserveVariantId(address);
  manager.getAssetState(address).variants![variantId]!.file = file;
  return variantId;
}

function renderInputs(
  video: ReturnType<typeof defineVideo>,
  shotId: string,
  mutatePlan?: (plan: ReturnType<typeof buildRenderPlan>) => void,
) {
  const plan = buildRenderPlan(video, manager, { outputDir: "" });
  mutatePlan?.(plan);
  const shotPlan = plan.shots.find((s) => s.shotId === shotId)!;
  return buildShotRenderInputs(shotPlan as never, {
    size: SIZE,
    typography: { lang: "en" as const },
    manager,
    renderShotInputs: null,
    shots: plan.shots,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-render-refs-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// The export path stages each source into the HyperFrames workspace under a filename and rewrites
// the HTML to point at it. A shot's own assets go through `asset()`; an out-of-shot ref reaches the
// HTML as a raw placeholder, which ffmpeg would resolve to nothing.
describe("buildShotRenderInputs — out-of-shot refs", () => {
  const crossShotDirection = defineDirection({
    ...directionDefaults,
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
  const crossShotVideo = defineVideo(crossShotDirection, {
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
  const CROSS_SHOT_STAGED = "video.shot.01.motion.mp4";

  it("stages a prior video shot's asset reached through shot()", () => {
    setupAccepted("video:shot.01.motion", "assets/shot.01.motion/m.mp4");

    const { compositionHtml, assetFiles } = renderInputs(crossShotVideo, "02");

    expect(compositionHtml).not.toContain("__konte:");
    expect(compositionHtml).toContain(`src="${CROSS_SHOT_STAGED}"`);
    expect(assetFiles[CROSS_SHOT_STAGED]).toBe(path.resolve(tmpDir, "assets/shot.01.motion/m.mp4"));
  });

  // A `delivery.upscale.video` export swaps each shot's own video layers for their #delivery files
  // before compositing at delivery resolution. A cross-shot ref must follow that swap, or it alone
  // composites from the working-size source and renders soft.
  it("follows a delivery upscale on the shot that owns the ref", () => {
    setupAccepted("video:shot.01.motion", "assets/shot.01.motion/m.mp4");
    const upscaled = path.resolve(tmpDir, "assets/shot.01.motion.delivery/m-4k.mp4");

    const { assetFiles } = renderInputs(crossShotVideo, "02", (plan) => {
      plan.shots.find((s) => s.shotId === "01")!.resolvedFiles.motion = upscaled;
    });

    expect(assetFiles[CROSS_SHOT_STAGED]).toBe(upscaled);
  });

  it("stages an animatic panel reached through animatic.shot(id)", () => {
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: (SIZE.width * SIZE.height) / 1e6, delivery: SIZE },
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
        size: { megapixels: (SIZE.width * SIZE.height) / 1e6, delivery: SIZE },
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
    setupAccepted("animatic:shot.01.first", "assets/sb.01.first/frame.png");

    const { compositionHtml, assetFiles } = renderInputs(video, "01");

    expect(compositionHtml).not.toContain("__konte:");
    const staged = "animatic.shot.01.first.png";
    expect(compositionHtml).toContain(`src="${staged}"`);
    expect(assetFiles[staged]).toBe(path.resolve(tmpDir, "assets/sb.01.first/frame.png"));
  });

  // `-` and `_` are both legal in a shot id and an asset name, so a staged filename that collapsed
  // them (or the `.` separators) would map distinct asset paths onto one file.
  it("keeps two refs apart when their asset paths differ only by separator character", () => {
    const direction = defineDirection({
      ...directionDefaults,
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
          const hyphen = asset("b-c", animateComfy, { prompt: "a" });
          const under = asset("b_c", animateComfy, { prompt: "b" });
          return (
            <Composition>
              <Video src={hyphen} />
              <Video src={under} />
            </Composition>
          );
        }).nextShot("02", ({ shot }) => (
          <Composition>
            <Video src={shot("01").video("b-c")} />
            <Video src={shot("01").video("b_c")} />
          </Composition>
        )),
      }),
    });
    const hyphenFile = "assets/shot.01.b-c/h.mp4";
    const underFile = "assets/shot.01.b_c/u.mp4";
    setupAccepted("video:shot.01.b-c", hyphenFile);
    setupAccepted("video:shot.01.b_c", underFile);

    const { assetFiles } = renderInputs(video, "02");

    expect(assetFiles["video.shot.01.b-c.mp4"]).toBe(path.resolve(tmpDir, hyphenFile));
    expect(assetFiles["video.shot.01.b_c.mp4"]).toBe(path.resolve(tmpDir, underFile));
  });

  // A ref's filename keeps the asset path's `.` separators, and an asset name may not contain `.`,
  // so no legal asset name can name the same file. The shot's own assets are staged first; a ref
  // able to collide would silently overwrite one.
  it("cannot collide with a shot's own asset, whatever that asset is named", () => {
    const direction = defineDirection({
      ...directionDefaults,
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
          const motion = asset("motion", animateComfy, { prompt: "a" });
          return (
            <Composition>
              <Video src={motion} />
            </Composition>
          );
        })
          // The closest a legal asset name can get to the ref's `video.shot.01.motion.mp4`.
          .nextShot("02", ({ shot }) => {
            const own = asset("video-shot-01-motion", animateComfy, { prompt: "b" });
            return (
              <Composition>
                <Video src={own} />
                <Video src={shot("01").video("motion")} />
              </Composition>
            );
          }),
      }),
    });
    setupAccepted("video:shot.01.motion", "assets/shot.01.motion/prev.mp4");
    setupAccepted("video:shot.02.video-shot-01-motion", "assets/shot.02.own/own.mp4");

    const { assetFiles } = renderInputs(video, "02");

    expect(assetFiles["video-shot-01-motion.mp4"]).toBe(
      path.resolve(tmpDir, "assets/shot.02.own/own.mp4"),
    );
    expect(assetFiles[CROSS_SHOT_STAGED]).toBe(
      path.resolve(tmpDir, "assets/shot.01.motion/prev.mp4"),
    );
  });

  it("stages one file for a ref used twice in the same composition", () => {
    const direction = defineDirection({
      ...directionDefaults,
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
          const motion = asset("motion", animateComfy, { prompt: "a" });
          return (
            <Composition>
              <Video src={motion} />
            </Composition>
          );
        }).nextShot("02", ({ shot }) => (
          <Composition>
            <Video src={shot("01").video("motion")} start={0} duration={1} />
            <Video src={shot("01").video("motion")} start={1} duration={2} />
          </Composition>
        )),
      }),
    });
    setupAccepted("video:shot.01.motion", "assets/shot.01.motion/m.mp4");

    const { assetFiles } = renderInputs(video, "02");

    expect(Object.keys(assetFiles)).toEqual([CROSS_SHOT_STAGED]);
  });

  it("keeps a shot's own asset on its plain asset-name filename", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: (SIZE.width * SIZE.height) / 1e6, delivery: SIZE },
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
          ]),
      },
    );
    setupAccepted("video:shot.01.motion", "assets/shot.01.motion/m.mp4");

    const { compositionHtml, assetFiles } = renderInputs(video, "01");

    expect(compositionHtml).toContain('src="motion.mp4"');
    expect(assetFiles).toEqual({
      "motion.mp4": path.resolve(tmpDir, "assets/shot.01.motion/m.mp4"),
    });
  });
});

// `unacceptedAssets` / `notReadyAssets` only ever described a shot's OWN assets, so nothing gated a
// composition's refs into the animatic or reference stage: an unresolvable one used to reach the
// renderer as a raw placeholder and ship as a black layer. The plan reports; `export` gates.
describe("buildRenderPlan — out-of-shot refs", () => {
  const animatic = defineAnimatic(
    testDirection({
      fps: 24,
      size: { megapixels: (SIZE.width * SIZE.height) / 1e6, delivery: SIZE },
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
      size: { megapixels: (SIZE.width * SIZE.height) / 1e6, delivery: SIZE },
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
                  <Image src={animatic.shot("01").image("first")} fill />
                </Composition>
              );
            },
          }),
        ]),
    },
  );
  const PANEL = "animatic:shot.01.first";

  function plan() {
    setupAccepted("video:shot.01.motion", "assets/shot.01.motion/m.mp4");
    return buildRenderPlan(video, manager, {
      outputDir: "",
      allowUnaccepted: true,
    }).shots[0]!;
  }

  it("reports an animatic panel with no variant at all as unresolved", () => {
    const s = plan();
    expect(s.unresolvedRefs).toEqual(["animatic:shot.01.first"]);
    expect(s.unacceptedRefs).toEqual([]);
  });

  it("reports a ready-but-unaccepted panel as unaccepted, not unresolved", () => {
    setupReady(PANEL, "assets/sb/frame.png");
    const s = plan();
    expect(s.unresolvedRefs).toEqual([]);
    expect(s.unacceptedRefs).toEqual([PANEL]);
  });

  it("reports nothing once the panel is accepted", () => {
    setupAccepted(PANEL, "assets/sb/frame.png");
    const s = plan();
    expect(s.unresolvedRefs).toEqual([]);
    expect(s.unacceptedRefs).toEqual([]);
  });

  it("never reports the shot's own assets as refs", () => {
    setupAccepted(PANEL, "assets/sb/frame.png");
    const s = plan();
    // `motion` is the shot's own asset and is covered by unacceptedAssets/resolvedFiles instead.
    expect([...s.unresolvedRefs, ...s.unacceptedRefs].join()).not.toContain("motion");
  });
});
