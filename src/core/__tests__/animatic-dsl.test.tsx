import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineAnimatic, asset, type MediaAsset, Composition, Image, Panel } from "../dsl/index.js";
import { moves, pendingAnimaticShot, shot, animaticTimeline } from "./helpers/shot.js";
import { directionDefaults, testDirection } from "./helpers/direction.js";
import { defineDirection } from "../dsl/direction.js";
import { AnimaticDefinitionSchema, isPendingAnimaticShot } from "../types/animatic.js";

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const editComfy = defineComfyAsset({
  workflow: "edit.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

// A plate is filed under the roster id it holds still, so both halves of that binding are checked
// at definition time — before the address it would be generated at exists.
describe("defineAnimatic plates", () => {
  const direction = testDirection({
    fps: 24,
    size: { megapixels: 0.004096, delivery: { width: 64, height: 64 } },
  });
  const animatic = (plates: () => Record<string, { image: MediaAsset<"image">; prompt: string }>) =>
    defineAnimatic(direction, {
      plates: plates as never,
      timeline: () => animaticTimeline([]),
    });

  it("files a plate at animatic:plate.<id> and hands it to the timeline", () => {
    let handed: unknown;
    const sb = defineAnimatic(direction, {
      plates: () => ({
        front: {
          image: asset("front", imageComfy, { prompt: "the empty frame" }),
          prompt: "a plain studio, the desk at the right edge",
        },
      }),
      timeline: ({ plates }) => {
        handed = plates.front;
        return animaticTimeline([]);
      },
    });
    expect(Object.keys(sb.plates ?? {})).toEqual(["front"]);
    // The sentence reaches `timeline` as the author wrote it — konte stores it and writes no prompt
    // text of its own.
    expect(handed).toEqual({
      image: expect.objectContaining({ src: "__konte:animatic:plate.front__" }),
      prompt: "a plain studio, the desk at the right edge",
    });
    expect(sb.platePrompts?.front).toBe("a plain studio, the desk at the right edge");
  });

  it("rejects a key naming no declared setup", () => {
    expect(() =>
      animatic(() => ({
        nope: { image: asset("nope", imageComfy, { prompt: "x" }), prompt: "a plain studio" },
      })),
    ).toThrow(/not a setup direction.ts declares/);
  });

  // Matching key SETS is not enough — two plates filed under each other's ids would pass that and
  // then build every keyframe on the wrong frame, with `setup-unconsumed` naming the innocent setup.
  it("rejects a plate filed under another setup's id", () => {
    const twoSetups = defineDirection({
      ...directionDefaults,
      setups: {
        ...directionDefaults.setups,
        back: {
          name: "the back angle",
          description: "from behind",
          location: "studio",
          framing: "wide",
          holds: ["studioMark"],
        },
      },
      sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
    });
    expect(() =>
      defineAnimatic(twoSetups, {
        plates: () => {
          const front = asset("front", imageComfy, { prompt: "the front frame" });
          const back = asset("back", imageComfy, { prompt: "the back frame" });
          return {
            front: { image: back, prompt: "a plain studio" },
            back: { image: front, prompt: "a plain studio" },
          } as never;
        },
        timeline: () => animaticTimeline([]),
      }),
    ).toThrow(/handle for a different plate/);
  });

  // Returning is what files a plate under a setup.
  it("keeps an unreturned asset as an intermediate the plate is built from", () => {
    const sb = animatic(() => {
      const master = asset("master", imageComfy, { prompt: "the whole room" });
      return {
        front: { image: asset("front", editComfy, { image: master }), prompt: "a plain studio" },
      } as never;
    });
    expect(Object.keys(sb.plates ?? {}).sort()).toEqual(["front", "master"]);
    expect(sb.exposedPlateIds).toEqual(["front"]);
    const front = sb.plates?.front as { inputs: Record<string, unknown> };
    expect(front.inputs["1.image"]).toBe("__konte:animatic:plate.master__");
  });

  // konte cannot look inside a crop, so what the frame holds reaches the model only through this.
  it("rejects a plate returned with no sentence saying what it holds", () => {
    expect(() =>
      animatic(() => ({
        front: { image: asset("front", imageComfy, { prompt: "x" }) } as never,
      })),
    ).toThrow(/declares no `prompt`/);
  });

  it("rejects a bare asset handle where a plate is owed", () => {
    expect(() =>
      animatic(() => ({ front: asset("front", imageComfy, { prompt: "x" }) as never })),
    ).toThrow(/must return \{ image, prompt \}/);
  });

  // An intermediate under a roster id would take the address that setup's plate occupies.
  it("rejects an intermediate named after a setup", () => {
    expect(() =>
      animatic(() => {
        asset("front", imageComfy, { prompt: "x" });
        return {} as never;
      }),
    ).toThrow(/named after a setup but not returned/);
  });
});

describe("defineAnimatic", () => {
  it("returns a valid AnimaticDefinition", () => {
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
                const keyframe = asset("keyframe", imageComfy, { prompt: "a cat" });
                return (
                  <Composition>
                    <Panel src={keyframe} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    const parsed = AnimaticDefinitionSchema.parse(sb);
    expect(parsed.shots).toHaveLength(1);
    expect(parsed.shots[0]!.panels![0]).toMatchObject({ assetName: "keyframe" });
  });

  it("extracts assets from animatic shots", () => {
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
                const keyframe = asset("keyframe", imageComfy, { prompt: "a girl" });
                return (
                  <Composition>
                    <Panel src={keyframe} {...moves} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    expect(sb.shots[0]!.assets.keyframe).toBeDefined();
    expect(sb.shots[0]!.assets.keyframe!.kind).toBe("comfy");
  });

  it("collects panels from animatic shots", () => {
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
                const kf1 = asset("first", imageComfy, { prompt: "scene A" });
                const kf2 = asset("second", imageComfy, { prompt: "scene B" });
                return (
                  <Composition>
                    <Panel src={kf1} blocking="she crosses the room" camera="fixed" />
                    <Panel src={kf2} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    expect(sb.shots[0]!.panels).toHaveLength(2);
    expect(sb.shots[0]!.panels![0]).toEqual({
      assetName: "first",
      assetPath: "animatic:shot.01.first",
      blocking: "she crosses the room",
      camera: "fixed",
      start: 0,
      duration: 2.5,
    });
    expect(sb.shots[0]!.panels![1]).toEqual({
      assetName: "second",
      assetPath: "animatic:shot.01.second",
      start: 2.5,
      duration: 2.5,
    });
  });

  it("uses duration from shot options", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          animaticTimeline([
            shot("01", {
              duration: 3,
              build: () => {
                const kf = asset("keyframe", imageComfy, { prompt: "test" });
                return (
                  <Composition>
                    <Panel src={kf} {...moves} />
                  </Composition>
                );
              },
            }),
            shot("02", {
              duration: 7,
              build: () => {
                const kf = asset("keyframe", imageComfy, { prompt: "test2" });
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
    expect(sb.shots[0]!.duration).toBe(3);
    expect(sb.shots[1]!.duration).toBe(7);
  });

  it("carries each panel's movement and preserves it through a schema round-trip", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
      }),
      {
        timeline: () =>
          animaticTimeline([
            shot("01", {
              duration: 3,
              build: () => {
                const first = asset("first", imageComfy, { prompt: "test" });
                const last = asset("last", imageComfy, { prompt: "test2" });
                return (
                  <Composition>
                    <Panel
                      src={first}
                      blocking="she crosses to the window and stops"
                      camera="fixed"
                    />
                    <Panel src={last} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    expect(sb.shots[0]!.panels![0]).toEqual({
      assetName: "first",
      assetPath: "animatic:shot.01.first",
      blocking: "she crosses to the window and stops",
      camera: "fixed",
      start: 0,
      duration: 1.5,
    });
    // The landing keyframe has nothing after it, so it declares no movement.
    expect(sb.shots[0]!.panels![1]).toEqual({
      assetName: "last",
      assetPath: "animatic:shot.01.last",
      start: 1.5,
      duration: 1.5,
    });
    const parsed = AnimaticDefinitionSchema.parse(sb);
    expect(parsed.shots[0]!.panels![0]).toEqual(sb.shots[0]!.panels![0]);
  });

  it("handles timeline assets", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", imageComfy, { prompt: "a girl" });
          return animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("motion", animateComfy, { image: character });
                return (
                  <Composition>
                    <Panel src={character} />
                  </Composition>
                );
              },
            }),
          ]);
        },
      },
    );
    expect(sb.topLevelAssets).toBeDefined();
    expect(sb.topLevelAssets!.character).toBeDefined();
    expect(sb.topLevelAssets!.character!.kind).toBe("comfy");
  });

  it("generates animatic-prefixed placeholders", () => {
    let capturedSrc: MediaAsset<"image"> | undefined;
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
                capturedSrc = asset("keyframe", imageComfy, { prompt: "test" });
                return (
                  <Composition>
                    <Panel src={capturedSrc} {...moves} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    expect(capturedSrc).toBeDefined();
    expect(capturedSrc!.src).toContain("animatic:shot.01.keyframe");
  });

  it("generates animatic-prefixed timeline placeholders", () => {
    let capturedTimelineSrc: unknown;
    defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", imageComfy, { prompt: "a girl" });
          capturedTimelineSrc = character;
          return animaticTimeline([]);
        },
      },
    );
    expect((capturedTimelineSrc as MediaAsset).src).toContain("animatic:timeline.character");
  });

  it("validates against AnimaticDefinitionSchema", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          asset("bg", imageComfy, { prompt: "background" });
          return animaticTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                const kf = asset("keyframe", imageComfy, { prompt: "shot 1" });
                return (
                  <Composition>
                    <Panel src={kf} />
                  </Composition>
                );
              },
            }),
            shot("02", {
              duration: 3,
              build: () => {
                const kf = asset("keyframe", imageComfy, { prompt: "shot 2" });
                return (
                  <Composition>
                    <Panel src={kf} />
                  </Composition>
                );
              },
            }),
          ]);
        },
      },
    );
    const parsed = AnimaticDefinitionSchema.parse(sb);
    expect(parsed.shots).toHaveLength(2);
    expect(parsed.topLevelAssets).toBeDefined();
    expect(parsed.topLevelAssets!.bg!.kind).toBe("comfy");
    expect(parsed.format.size).toEqual({ width: 1024, height: 576 });
  });
});

describe("<Panel>", () => {
  const board = (build: () => React.ReactElement) =>
    defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => animaticTimeline([shot("01", { duration: 5, build })]),
      },
    );

  it("takes its part name from the leaf of its src address", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("opening-frame", imageComfy, { prompt: "test" })} />
      </Composition>
    ));
    expect(sb.shots[0]!.panels![0]).toMatchObject({
      assetName: "opening-frame",
      assetPath: "animatic:shot.01.opening-frame",
    });
  });

  it("refuses a src that is neither an animatic nor a reference asset", () => {
    expect(() =>
      board(() => (
        <Composition>
          <Panel src={{ src: "https://cdn.example/frame.png" }} />
        </Composition>
      )),
    ).toThrow(/<Panel> takes an animatic asset/);
  });

  it("marks its <img> so discovery and the review UI can tell a keyframe from a layer", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} />
        <Image src={asset("bg", imageComfy, { prompt: "a wall" })} />
      </Composition>
    ));
    // Only the <Panel> is a keyframe; the plain <Image> is a layer with no part name.
    expect(sb.shots[0]!.panels!.map((p) => p.assetName)).toEqual(["first"]);
  });
});

describe("pendingShot", () => {
  it("produces an undeveloped shot with no panel and no asset", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => animaticTimeline([pendingAnimaticShot("01", { duration: 5 })]),
      },
    );
    const parsed = AnimaticDefinitionSchema.parse(sb);
    expect(parsed.shots[0]!.assets).toEqual({});
    expect(parsed.shots[0]!.panels).toBeUndefined();
    expect(isPendingAnimaticShot(parsed.shots[0]!)).toBe(true);
  });

  it("keeps the shot's duration and action, which it carries nothing of its own for", () => {
    const sb = defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          animaticTimeline([
            pendingAnimaticShot("01", { duration: 5, action: "she opens the window" }),
          ]),
      },
    );
    expect(sb.shots[0]!.duration).toBe(5);
    expect(sb.shots[0]!.action).toBe("she opens the window");
    expect(isPendingAnimaticShot(sb.shots[0]!)).toBe(true);
  });

  it("leaves a developed shot with no pending marker", () => {
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
                const kf = asset("first", imageComfy, { prompt: "scene A" });
                return (
                  <Composition>
                    <Panel src={kf} />
                  </Composition>
                );
              },
            }),
          ]),
      },
    );
    expect(isPendingAnimaticShot(sb.shots[0]!)).toBe(false);
    expect(sb.shots[0]!.assets.first).toBeDefined();
  });
});

describe("shot with 3-arg form", () => {
  it("works with ShotFunction (video context)", () => {
    const el = {
      type: "Composition",
      props: { duration: 5, children: [] },
    } as unknown as React.ReactElement;

    const input = shot("01", {
      duration: 5,
      build: () => {
        return el;
      },
    });
    expect(input.__shotInput).toBe(true);
    expect(input.id).toBe("01");
    expect(input.options).toEqual({ duration: 5, action: "test shot" });
  });
});

describe("panel movement position rule", () => {
  const board = (build: () => React.ReactElement) =>
    defineAnimatic(
      testDirection({
        fps: 24,
        size: { megapixels: 0.016384, delivery: { width: 128, height: 128 } },
      }),
      {
        timeline: () => animaticTimeline([shot("01", { duration: 5, build })]),
      },
    );

  it("rejects movement on the landing keyframe, which has nothing to move into", () => {
    expect(() =>
      board(() => {
        const a = asset("first", imageComfy, { prompt: "a" });
        const b = asset("second", imageComfy, { prompt: "b" });
        return (
          <Composition>
            <Panel src={a} blocking="she walks in" camera="fixed" />
            <Panel src={b} blocking="she walks out frame left" camera="fixed" />
          </Composition>
        );
      }),
    ).toThrow(/landing keyframe.*declares blocking and camera/s);
  });

  // The seam of a long take is the next shot's opening keyframe, so the last panel before it is no
  // landing frame: it moves into that keyframe.
  it("accepts movement on the last keyframe of a shot the next shot runs on from", () => {
    const longTake = defineDirection({
      ...directionDefaults,
      sequence: {
        lens: "mini-drama",
        pleasure: "cute",
        shots: [
          {
            id: "01",
            role: "ordinary",
            action: "she waits",
            setup: "front",
            duration: 5,
            lineup: [],
          },
          {
            id: "02",
            role: "disruption",
            action: "she turns",
            setup: "front",
            join: "continuous",
            duration: 5,
            lineup: [],
          },
        ],
      },
    });
    const sb = defineAnimatic(longTake, {
      timeline: () =>
        animaticTimeline([
          shot("01", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", imageComfy, { prompt: "a" })} {...moves} />
                <Panel
                  src={asset("last", imageComfy, { prompt: "b" })}
                  blocking="she turns to the door"
                  camera="fixed"
                />
              </Composition>
            ),
          }),
          shot("02", {
            duration: 5,
            build: () => (
              <Composition>
                <Panel src={asset("first", imageComfy, { prompt: "c" })} {...moves} />
              </Composition>
            ),
          }),
        ]),
    });
    expect(sb.shots[0]!.continuedBy).toEqual({ main: "02" });
    expect(sb.shots[0]!.panels![1]!.blocking).toBe("she turns to the door");
    expect(sb.shots[1]!.continuedBy).toBeUndefined();
  });

  // Movement is written from the take, so an unbound panel is a state discovery accepts; the review
  // gates (REVIEW_PREREQUISITE_MISSING) are what require it.
  it("accepts a keyframe that declares no movement yet", () => {
    const sb = board(() => {
      const a = asset("first", imageComfy, { prompt: "a" });
      const b = asset("second", imageComfy, { prompt: "b" });
      return (
        <Composition>
          <Panel src={a} />
          <Panel src={b} />
        </Composition>
      );
    });
    expect(sb.shots[0]!.panels![0]).toEqual({
      assetName: "first",
      assetPath: "animatic:shot.01.first",
      start: 0,
      duration: 2.5,
    });
  });

  it("accepts a keyframe that declares only half the movement", () => {
    const sb = board(() => {
      const a = asset("first", imageComfy, { prompt: "a" });
      const b = asset("second", imageComfy, { prompt: "b" });
      return (
        <Composition>
          <Panel src={a} blocking="she walks out frame left" />
          <Panel src={b} />
        </Composition>
      );
    });
    expect(sb.shots[0]!.panels![0]).toEqual({
      assetName: "first",
      assetPath: "animatic:shot.01.first",
      blocking: "she walks out frame left",
      start: 0,
      duration: 2.5,
    });
  });

  it("accepts a lone unbound keyframe", () => {
    const sb = board(() => (
      <Composition>
        <Panel src={asset("first", imageComfy, { prompt: "a" })} />
      </Composition>
    ));
    expect(sb.shots[0]!.panels).toHaveLength(1);
  });
});
