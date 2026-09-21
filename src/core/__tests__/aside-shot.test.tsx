import { describe, expect, it } from "vitest";
import {
  Composition,
  Panel,
  Video,
  asset,
  defineAnimatic,
  defineDirection,
  defineVideo,
} from "../dsl/index.js";
import { isAsideShotInput, isPendingShotInput } from "../dsl/builders.js";
import {
  getDirectionIndex,
  makeAnimaticShotStarter,
  makeVideoShotStarter,
} from "../dsl/direction.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { directionDefaults } from "./helpers/direction.js";

const videoComfy = defineComfyAsset({
  workflow: "video.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// One shot, one aside, in that order — the smallest direction that exercises both starters.
const direction = defineDirection({
  ...directionDefaults,
  sequence: {
    lens: "mini-drama",
    pleasure: "cute",
    shots: [
      {
        id: "01",
        role: "ordinary",
        action: "the cat wakes",
        setup: "front",
        duration: 4,
        lineup: [],
      },
      { kind: "aside", id: "op", label: "OP", duration: 90 },
    ],
  },
});

const animaticStarter = () => makeAnimaticShotStarter(getDirectionIndex(direction));
const videoStarter = () => makeVideoShotStarter(getDirectionIndex(direction));

describe("asideShot", () => {
  it("places an aside on the board with no build", () => {
    const chain = animaticStarter()
      .shot("01", () => (
        <Composition>
          <Panel src={{ src: "__konte:reference:bg__" }} />
        </Composition>
      ))
      .nextAsideShot("op");
    const last = chain.__shots[1]!;
    expect(isAsideShotInput(last)).toBe(true);
    expect(isPendingShotInput(last)).toBe(false);
    // No build: the board is a drawing of the story, and an aside is not story.
    if (!isAsideShotInput(last)) throw new Error("expected an aside");
    expect(last.fn).toBeUndefined();
  });

  it("hands the video the span and its label", () => {
    let seen: { duration: number; label: string } | null = null;
    const chain = videoStarter()
      .shot("01", () => (
        <Composition>
          <Video src={{ src: "__konte:animatic:shot.01.first__" }} />
        </Composition>
      ))
      .nextAsideShot("op", (ctx) => {
        seen = { duration: ctx.duration, label: ctx.label };
        return (
          <Composition>
            <Video src={{ src: "__konte:animatic:shot.01.first__" }} />
          </Composition>
        );
      });
    const last = chain.__shots[1]!;
    if (!isAsideShotInput(last) || !last.fn) throw new Error("expected a built aside");
    last.fn();
    expect(seen).toEqual({ duration: 90, label: "OP" });
  });
});

describe("a stage built with an aside", () => {
  it("carries it on the board as a labelled span with no composition", () => {
    const animatic = defineAnimatic(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Panel src={{ src: "__konte:reference:bg__" }} />
          </Composition>
        )).nextAsideShot("op"),
      }),
    });
    const op = animatic.shots.find((s) => s.id === "op")!;
    expect(op.aside).toBe(true);
    expect(op.pending).toBeUndefined();
    expect(op.shotFn).toBeUndefined();
    expect(op.duration).toBe(90);
    expect(op.action).toBe("OP");
  });

  it("carries it on the video as a developed shot", () => {
    const video = defineVideo(direction, {
      timeline: ({ shot }) => ({
        shots: shot("01", () => (
          <Composition>
            <Video src={{ src: "__konte:animatic:shot.01.first__" }} />
          </Composition>
        )).nextAsideShot("op", () => (
          <Composition>
            <Video src={asset("clip", videoComfy, { prompt: "x" })} />
          </Composition>
        )),
      }),
    });
    const op = video.shots.find((s) => s.id === "op")!;
    expect(op.aside).toBe(true);
    expect(op.shotFn).toBeTypeOf("function");
    expect(Object.keys(op.assets)).toEqual(["clip"]);
  });
});

// Each `@ts-expect-error` below would itself error if the call it marks compiled, so the type-level
// constraint and the runtime guard behind it are asserted in one place. The typed starters live
// inside a `timeline` callback, which is why these run there.
describe("the kind constraint", () => {
  it("keeps the animatic's starters to the shots they are for", () => {
    defineAnimatic(direction, {
      timeline: ({ shot, asideShot }) => {
        // @ts-expect-error — "op" is an aside; `asideShot` is the only step that fits.
        expect(() => shot("op", () => <Composition />)).toThrow(/is an aside shot/);
        // @ts-expect-error — "01" is a narrative shot; `shot` is the step that fits.
        expect(() => asideShot("01")).toThrow(/not an aside shot/);
        // @ts-expect-error — the board's aside takes no build.
        expect(() => asideShot("op", () => <Composition />)).toThrow(/takes no build/);
        return {
          shots: shot("01", () => (
            <Composition>
              <Panel src={{ src: "__konte:reference:bg__" }} />
            </Composition>
          )).nextAsideShot("op"),
        };
      },
    });
  });

  it("makes the video's aside owe a build", () => {
    defineVideo(direction, {
      timeline: ({ shot, asideShot }) => {
        // @ts-expect-error — the video's aside owes a build.
        expect(() => asideShot("op")).toThrow(/needs a build/);
        return {
          shots: shot("01", () => (
            <Composition>
              <Video src={{ src: "__konte:animatic:shot.01.first__" }} />
            </Composition>
          )).nextAsideShot("op", () => (
            <Composition>
              <Video src={asset("clip", videoComfy, { prompt: "x" })} />
            </Composition>
          )),
        };
      },
    });
  });
});
