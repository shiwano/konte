import { describe, expect, it } from "vitest";
import { inBuild } from "./helpers/build.js";
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

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const animateWithImage = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

describe("AnimaticRef", () => {
  it("animatic.shot('01').image('keyframe') returns a MediaAsset with an animatic placeholder", () => {
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
                const kf = asset("keyframe", imageComfy, { prompt: "test" });
                return (
                  <Composition>
                    <Panel src={kf} {...moves} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    const ref = inBuild(() => animatic.shot("01"));
    expect(ref.image("keyframe").src).toBe("__konte:animatic:shot.01.keyframe__");
  });

  it("can be used in defineVideo to create cross-stage dependencies", () => {
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
                const kf = asset("keyframe", imageComfy, { prompt: "test" });
                return (
                  <Composition>
                    <Panel src={kf} {...moves} />
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
              build: () => {
                asset("motion", animateWithImage, { image: animatic.shot("01").image("keyframe") });
                return el();
              },
            }),
          ]),
      },
    );

    const motionAsset = video.shots[0]!.assets.motion;
    expect(motionAsset).toBeDefined();
    expect(motionAsset!.kind).toBe("comfy");

    const inputs = (motionAsset as { inputs: Record<string, unknown> }).inputs;
    expect(inputs["1.image"]).toBe("__konte:animatic:shot.01.keyframe__");
  });

  it("multiple shot refs work independently", () => {
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
                const kf = asset("keyframe", imageComfy, { prompt: "scene 1" });
                return (
                  <Composition>
                    <Panel src={kf} {...moves} />
                  </Composition>
                );
              },
            }),
            shot("02", {
              duration: 3,
              build: () => {
                const kf = asset("keyframe", imageComfy, { prompt: "scene 2" });
                return (
                  <Composition>
                    <Panel src={kf} {...moves} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    expect(inBuild(() => animatic.shot("01").image("keyframe").src)).toBe(
      "__konte:animatic:shot.01.keyframe__",
    );
    expect(inBuild(() => animatic.shot("02").image("keyframe").src)).toBe(
      "__konte:animatic:shot.02.keyframe__",
    );
  });

  it("a panel built from a timeline-scope asset resolves to its timeline address", () => {
    const animatic = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const shared = asset("key01", imageComfy, { prompt: "shared keyframe" });
          return animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => (
                <Composition>
                  <Panel src={shared} {...moves} />
                </Composition>
              ),
            }),
            shot("02", {
              duration: 3,
              build: () => {
                const local = asset("first", imageComfy, { prompt: "local" });
                return (
                  <Composition>
                    <Panel src={local} blocking="she crosses the room" camera="fixed" />
                    <Panel src={shared} />
                  </Composition>
                );
              },
            }),
          ]);
        },
      },
    );

    // A shared timeline asset passed to a panel resolves to `timeline.<name>` — the target that
    // actually exists — from whichever shot references it, while a shot-local part stays shot-scoped.
    expect(inBuild(() => animatic.shot("01").image("key01").src)).toBe(
      "__konte:animatic:timeline.key01__",
    );
    expect(inBuild(() => animatic.shot("02").image("key01").src)).toBe(
      "__konte:animatic:timeline.key01__",
    );
    expect(inBuild(() => animatic.shot("02").image("first").src)).toBe(
      "__konte:animatic:shot.02.first__",
    );
  });

  it("a panel built from a reference asset resolves to its reference address", () => {
    const reference = defineReference(plainDirection, () => ({
      bg: asset("bg", imageComfy, { prompt: "background" }),
    }));

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
                  <Panel src={reference.bg} {...moves} />
                </Composition>
              ),
            }),
          ]),
      },
    );

    // A shared reference image used as a panel resolves to its `reference:<name>` address — the
    // target that actually exists — so it renders in the contact sheet and stays referenceable.
    expect(animatic.shots[0]!.panels![0]).toMatchObject({ assetName: "bg" });
    expect(inBuild(() => animatic.shot("01").image("bg").src)).toBe("__konte:reference:bg__");
  });

  // `<Panel>` is a component, so its src rule fires when the shot renders — at definition time,
  // which is what makes a bogus keyframe a load error rather than a broken frame.
  it("rejects a non-animatic, non-reference asset passed to <Panel>", () => {
    expect(() =>
      defineAnimatic(
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
                    <Panel src={{ src: "__konte:video:shot.01.motion__" } as never} />
                  </Composition>
                ),
              }),
            ]),
        },
      ),
    ).toThrow(/<Panel> takes an animatic asset/);
  });

  it("rejects two panels in one shot that claim the same part name from different assets", () => {
    const reference = defineReference(plainDirection, () => ({
      first: asset("first", imageComfy, { prompt: "shared" }),
    }));
    expect(() =>
      defineAnimatic(
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
                  const local = asset("first", imageComfy, { prompt: "local" });
                  return (
                    <Composition>
                      <Panel src={local} blocking="she crosses the room" camera="fixed" />
                      <Panel src={reference.first} />
                    </Composition>
                  );
                },
              }),
            ]),
        },
      ),
    ).toThrow(/two panels named "first"/);
  });

  it("different asset names within same shot work independently", () => {
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
                const first = asset("first", imageComfy, { prompt: "a" });
                const second = asset("second", imageComfy, { prompt: "b" });
                return (
                  <Composition>
                    <Panel src={first} blocking="she crosses the room" camera="fixed" />
                    <Panel src={second} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    expect(inBuild(() => animatic.shot("01").image("first").src)).toBe(
      "__konte:animatic:shot.01.first__",
    );
    expect(inBuild(() => animatic.shot("01").image("second").src)).toBe(
      "__konte:animatic:shot.01.second__",
    );
  });
});
