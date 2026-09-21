import { describe, expect, it } from "vitest";
import { inBuild } from "./helpers/build.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import {
  Composition,
  defineAnimatic,
  defineVideo,
  asset,
  soundtrack,
  type ShotFunction,
  type MediaAsset,
  type StageTimelineReturn,
  Panel,
} from "../dsl/index.js";
import { moves, shot, animaticTimeline, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

describe("type inference", () => {
  it("detects invalid shot ID at compile time", () => {
    const sb = defineAnimatic(
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
                const kf = asset("first", imageComfy, { prompt: "test" });
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

    void inBuild(() => sb.shot("01").image("first"));

    // A `<Composition>` build hides its shot ids and asset names from the type system, so both are
    // checked when the definition loads instead — see the runtime cases below.
    expect(() => inBuild(() => sb.shot("99"))).toThrow(/declares no shot "99"/);
  });

  it("detects invalid asset name at load", () => {
    const sb = defineAnimatic(
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
                const kf = asset("first", imageComfy, { prompt: "test" });
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

    expect(() => inBuild(() => sb.shot("01").image("nonexistent"))).toThrow(
      /declares no asset named "nonexistent"/,
    );
  });

  it("supports multiple shots with different assets", () => {
    const sb = defineAnimatic(
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
                const kf = asset("first", imageComfy, { prompt: "a" });
                const last = asset("last", imageComfy, { prompt: "b" });
                return (
                  <Composition>
                    <Panel src={kf} blocking="she crosses the room" camera="fixed" />
                    <Panel src={last} />
                  </Composition>
                );
              },
            }),
            shot("02", {
              duration: 3,
              build: () => {
                const kf = asset("keyframe", imageComfy, { prompt: "c" });
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

    void inBuild(() => sb.shot("01").image("first"));
    void inBuild(() => sb.shot("01").image("last"));
    void inBuild(() => sb.shot("02").image("keyframe"));

    expect(() => inBuild(() => sb.shot("01").image("keyframe"))).toThrow(
      /declares no asset named "keyframe"/,
    );
    expect(() => inBuild(() => sb.shot("02").image("first"))).toThrow(
      /declares no asset named "first"/,
    );
  });

  it("propagates animatic type through closure usage in defineVideo", () => {
    const sb = defineAnimatic(
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
                const last = asset("last", imageComfy, { prompt: "b" });
                return (
                  <Composition>
                    <Panel src={first} blocking="she crosses the room" camera="fixed" />
                    <Panel src={last} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );

    defineVideo(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          void sb.shot("01").image("first");
          void sb.shot("01").image("last");

          expect(() => sb.shot("99")).toThrow(/declares no shot "99"/);
          expect(() => sb.shot("01").image("nonexistent")).toThrow(
            /declares no asset named "nonexistent"/,
          );

          return videoTimeline([]);
        },
      },
    );
  });

  it("still works at runtime with correct values", () => {
    const sb = defineAnimatic(
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

    expect(inBuild(() => sb.shot("01").image("keyframe").src)).toBe(
      "__konte:animatic:shot.01.keyframe__",
    );
    expect(sb.shots).toHaveLength(1);
  });

  it("checks soundtrack anchor shot ids against the declared shots at compile time", () => {
    const bgm = { src: "bgm.mp3" } as MediaAsset<"audio">;
    type Anchored = StageTimelineReturn<"01" | "02">["soundtracks"];

    const ok: Anchored = [soundtrack("ok", bgm, { duck: false, from: { shot: "02", at: 1 } })];
    void ok;

    // @ts-expect-error -- shot "99" is not one of the declared shots ("01" | "02")
    const bad: Anchored = [soundtrack("bad", bgm, { duck: false, until: { shot: "99" } })];
    void bad;
  });

  it("rejects a soundtrack anchored to an unknown shot at runtime", () => {
    const audioComfy = defineComfyAsset({
      workflow: "tts.json",
      description: "test adapter",
      inputs: { text: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "audio" } },
    });
    const mkFn = (() => ({
      type: Composition,
      props: { children: [] },
    })) as unknown as ShotFunction;

    expect(() =>
      defineVideo(
        testDirection({
          fps: 24,
          size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
        }),
        {
          timeline: () => {
            const bgm = asset("bgm", audioComfy, { text: "music" });
            return videoTimeline(
              [shot("01", { duration: 3, build: mkFn })],
              // cast bypasses the compile-time check to exercise the runtime guard
              [soundtrack("bad", bgm, { duck: false, until: { shot: "99" } })] as never,
            );
          },
        },
      ),
    ).toThrow(/unknown shot "99"/);
  });
});
