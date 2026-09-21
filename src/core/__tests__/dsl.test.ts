import { describe, expect, it } from "vitest";
import {
  formatAssetPath,
  formatCompositionAddress,
  formatTimelineAssetPath,
  formatTimelineStemAddress,
} from "../address.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { Animate, type GsapTimeline } from "../dsl/composition/animate.js";
import { Composition } from "../dsl/composition/composition.js";
import { KonteError } from "../errors.js";
import {
  type MediaAsset,
  defineVideo,
  asset,
  defineReference,
  soundtrack,
  videoFile,
} from "../dsl/index.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { renderToHtml } from "../jsx-html.js";
import {
  ComfyAssetDefinitionSchema,
  FileAssetDefinitionSchema,
  ShotDefinitionSchema,
  VideoDefinitionSchema,
} from "../types/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const testComfy = defineComfyAsset({
  workflow: "w.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const animateWithImageComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

describe("defineVideo", () => {
  it("returns a valid VideoDefinition", () => {
    const video = defineVideo(
      testDirection({
        fps: 24,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => videoTimeline([]),
      },
    );
    expect(VideoDefinitionSchema.parse(video)).toEqual(video);
  });

  it("processes shot inputs and extracts assets", () => {
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
                asset("bg", testComfy, {});
                return el();
              },
            }),
          ]),
      },
    );
    expect(video.shots[0]!.id).toBe("01");
    expect(video.shots[0]!.duration).toBe(5);
    expect(video.shots[0]!.assets.bg).toBeDefined();
    expect((video.shots[0]!.assets.bg as { kind: string }).kind).toBe("comfy");
    expect(video.shots[0]!.shotFn).toBeDefined();
    expect(ShotDefinitionSchema.parse(video.shots[0])).toEqual(video.shots[0]);
  });

  it("carries the direction action and decomposes build into shotFn", () => {
    let seenDuration: number | undefined;
    const build = ({ duration }: { duration: number }): React.ReactElement => {
      seenDuration = duration;
      return el();
    };
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([shot("01", { duration: 5, action: "reveal the result", build })]),
      },
    );
    expect(video.shots[0]!.action).toBe("reveal the result");
    // shotFn runs the body and is fed the injected direction duration; action is never folded into it.
    video.shots[0]!.shotFn!();
    expect(seenDuration).toBe(5);
    expect(ShotDefinitionSchema.parse(video.shots[0]).action).toBe("reveal the result");
  });

  it("registers timeline assets declared at the top of timeline", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", imageComfy, { prompt: "a girl" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("motion", animateWithImageComfy, {
                  prompt: "walk",
                  image: character,
                });
                return el();
              },
            }),
          ]);
        },
      },
    );

    expect(video.topLevelAssets).toBeDefined();
    expect(video.topLevelAssets!.character).toBeDefined();
    expect(video.topLevelAssets!.character!.kind).toBe("comfy");
    expect(video.timelineFn).toBeDefined();
    expect(VideoDefinitionSchema.parse(video)).toEqual(video);
  });

  it("exposes timeline assets to shots via closure with a timeline placeholder src", () => {
    let receivedCharacter: MediaAsset | undefined;
    defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", imageComfy, { prompt: "a girl" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                receivedCharacter = character;
                asset("motion", animateWithImageComfy, {
                  prompt: "walk",
                  image: character,
                });
                return el();
              },
            }),
          ]);
        },
      },
    );

    expect(receivedCharacter).toBeDefined();
    expect(receivedCharacter!.src).toContain("video:timeline.character");
  });
});

function composedEl(children: unknown[]): React.ReactElement {
  return {
    type: Composition,
    props: { children },
  } as unknown as React.ReactElement;
}

function videoEl(src: MediaAsset): unknown {
  return { type: "Video", props: { src } };
}

describe("composition refs", () => {
  it("collects shot asset refs referenced in the composition output", () => {
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
                const motion = asset("motion", animateComfy, { prompt: "x" });
                return composedEl([videoEl(motion)]);
              },
            }),
          ]),
      },
    );
    expect(video.shots[0]!.compositionRefs).toEqual(["video:shot.01.motion"]);
  });

  it("collects timeline asset refs pulled in via closure (not in shot.assets)", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const bgm = asset("bgm", imageComfy, { prompt: "music" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                const motion = asset("motion", animateComfy, { prompt: "x" });
                return composedEl([videoEl(motion), videoEl(bgm)]);
              },
            }),
          ]);
        },
      },
    );
    expect([...(video.shots[0]!.compositionRefs ?? [])].sort()).toEqual([
      "video:shot.01.motion",
      "video:timeline.bgm",
    ]);
    // timeline asset is NOT registered in shot.assets
    expect(video.shots[0]!.assets.bgm).toBeUndefined();
  });

  it("ignores assets declared but not rendered in the composition", () => {
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
                asset("unused", animateComfy, { prompt: "x" });
                const motion = asset("motion", animateComfy, { prompt: "y" });
                return composedEl([videoEl(motion)]);
              },
            }),
          ]),
      },
    );
    expect(video.shots[0]!.compositionRefs).toEqual(["video:shot.01.motion"]);
  });

  // `composition` and `stem` are ordinary author names: the targets that once claimed them live in
  // the `#` namespace, which `validateAssetName` cannot produce, so there is nothing left to reject.
  it("accepts user assets named 'composition' and 'stem', apart from the reserved addresses", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          asset("stem", animateComfy, { prompt: "x" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("composition", animateComfy, { prompt: "x" });
                asset("stem", animateComfy, { prompt: "x" });
                return el();
              },
            }),
          ]);
        },
      },
    );

    expect(Object.keys(video.topLevelAssets ?? {})).toEqual(["stem"]);
    expect(Object.keys(video.shots[0]!.assets)).toEqual(["composition", "stem"]);
    expect(formatAssetPath("video", "01", "composition")).toBe("video:shot.01.composition");
    expect(formatCompositionAddress("video", "01")).toBe("video:shot.01#composition");
    expect(formatTimelineAssetPath("video", "stem")).toBe("video:timeline.stem");
    expect(formatTimelineStemAddress("video")).toBe("video:timeline#stem");
  });
});

describe("shot", () => {
  it("returns a ShotInput", () => {
    let seenDuration: number | undefined;
    const fn = ({ duration }: { duration: number }) => {
      seenDuration = duration;
      return el();
    };
    const input = shot("01", { duration: 5, build: fn });
    expect(input.__shotInput).toBe(true);
    expect(input.id).toBe("01");
    // The video build is wrapped to inject the direction duration, so calling `input.fn` runs it with it.
    input.fn();
    expect(seenDuration).toBe(5);
  });

  it("accepts valid shot IDs", () => {
    expect(() => shot("01", { duration: 5, build: () => el() })).not.toThrow();
    expect(() => shot("intro01", { duration: 5, build: () => el() })).not.toThrow();
    expect(() => shot("intro-01", { duration: 5, build: () => el() })).not.toThrow();
    expect(() => shot("intro_01", { duration: 5, build: () => el() })).not.toThrow();
    expect(() => shot("ABC", { duration: 5, build: () => el() })).not.toThrow();
  });

  it("rejects invalid shot IDs", () => {
    expect(() =>
      // @ts-expect-error -- intentionally passing invalid identifier
      shot("shot.01", { duration: 5, build: () => el() }),
    ).toThrow("Invalid shot ID");
    expect(() =>
      // @ts-expect-error -- intentionally passing invalid identifier
      shot("shot:01", { duration: 5, build: () => el() }),
    ).toThrow("Invalid shot ID");
    expect(() =>
      // @ts-expect-error -- intentionally passing invalid identifier
      shot("shot 01", { duration: 5, build: () => el() }),
    ).toThrow("Invalid shot ID");
    // @ts-expect-error -- intentionally passing invalid identifier
    expect(() => shot("", { duration: 5, build: () => el() })).toThrow("Invalid shot ID");
  });
});

describe("asset identifier validation", () => {
  it("accepts valid asset names", () => {
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
                asset("motion", testComfy, {});
                asset("my-asset", testComfy, {});
                asset("my_asset", testComfy, {});
                return el();
              },
            }),
          ]),
      },
    );
    expect(video.shots[0]!.assets.motion).toBeDefined();
    expect(video.shots[0]!.assets["my-asset"]).toBeDefined();
    expect(video.shots[0]!.assets["my_asset"]).toBeDefined();
  });

  it("rejects invalid asset names", () => {
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
                duration: 5,
                build: () => {
                  // @ts-expect-error -- intentionally passing invalid identifier
                  asset("my.asset", testComfy, {});
                  return el();
                },
              }),
            ]),
        },
      ),
    ).toThrow("Invalid asset name");

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
                duration: 5,
                build: () => {
                  // @ts-expect-error -- intentionally passing invalid identifier
                  asset("my:asset", testComfy, {});
                  return el();
                },
              }),
            ]),
        },
      ),
    ).toThrow("Invalid asset name");
  });
});

describe("soundtrack()", () => {
  it("rejects an undefined src (e.g. a reference asset that is not declared yet)", () => {
    expect(() =>
      defineVideo(
        testDirection({
          fps: 30,
          size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
        }),
        {
          timeline: () =>
            videoTimeline(
              [shot("01", { duration: 5, build: () => el() })],
              // @ts-expect-error -- simulate `reference.bgm` being undefined at authoring time
              [soundtrack("bgm", undefined, { duck: false, volume: 0.6 })],
            ),
        },
      ),
    ).toThrow(/soundtrack "bgm" has an invalid src/);
  });

  it("rejects a volume above MAX_AUDIO_GAIN", () => {
    expect(() =>
      defineVideo(
        testDirection({
          fps: 30,
          size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
        }),
        {
          timeline: () =>
            videoTimeline(
              [shot("01", { duration: 5, build: () => el() })],
              [soundtrack("bgm", { src: "__konte:reference:bgm__" }, { duck: false, volume: 4 })],
            ),
        },
      ),
    ).toThrow(/soundtrack "bgm": volume 4 is outside/);
  });
});

describe("comfy via asset()", () => {
  it("creates a ComfyAssetDefinition in discovery context", () => {
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
                asset("motion", animateComfy, { prompt: "test" });
                return el();
              },
            }),
          ]),
      },
    );
    const p = video.shots[0]!.assets.motion;
    expect(p).toBeDefined();
    expect((p as { kind: string }).kind).toBe("comfy");
    expect(ComfyAssetDefinitionSchema.parse(p)).toEqual(p);
  });

  it("returns MediaAsset with placeholder src in discovery context", () => {
    let props: MediaAsset | undefined;
    defineVideo(
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
                props = asset("motion", animateComfy, { prompt: "test" });
                return el();
              },
            }),
          ]),
      },
    );
    expect(props).toBeDefined();
    expect(props!.src).toContain("video:shot.01.motion");
  });

  it("throws when called outside timeline or shot context", () => {
    expect(() => asset("motion", animateComfy, { prompt: "test" })).toThrow(
      "asset() must be called inside a timeline() or shot() function",
    );
  });

  it("works at the top of the timeline (shared context)", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          asset("character", imageComfy, { prompt: "girl" });
          return videoTimeline([]);
        },
      },
    );
    expect(video.topLevelAssets!.character).toBeDefined();
    expect(video.topLevelAssets!.character!.kind).toBe("comfy");
  });
});

describe("file via defineReference(plainDirection, )", () => {
  it("creates a FileAssetDefinition in reference discovery context", () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });
    const p = reference.topLevelAssets!.bg;
    expect(p).toBeDefined();
    expect((p as { kind: string }).kind).toBe("file");
    expect((p as { path: string }).path).toBe("assets/files/bg.mp4");
    expect(FileAssetDefinitionSchema.parse(p)).toEqual(p);
  });

  it("returns MediaAsset with reference placeholder src", () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });
    const props: MediaAsset = reference.bg;
    expect(props).toBeDefined();
    expect(props.src).toContain("reference:bg");
  });

  it("declares a file asset in a stage timeline as a per-profile asset", () => {
    let src: string | undefined;
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          src = asset("bg", videoFile, { path: "assets/files/bg.mp4" }).src;
          return videoTimeline([]);
        },
      },
    );
    expect(video).toBeDefined();
    expect(src).toContain("video:timeline.bg");
  });
});

describe("Animate", () => {
  const ctx = {
    shotId: "01",
    width: 1920,
    height: 1080,
    duration: 5,
    typography: { lang: "en" as const },
  };

  function animateEl(props: Parameters<typeof Animate>[0] = {}): React.ReactElement {
    return { type: Animate, props } as unknown as React.ReactElement;
  }

  it("renders script prop as IIFE with timeline parameter", () => {
    const html = renderToHtml(
      animateEl({
        script: ({ timeline }) => {
          timeline.from(".clip", { opacity: 0, duration: 1 }, 0);
        },
      }),
      ctx,
    );
    expect(html).toContain("({ timeline })");
    expect(html).toContain("timeline.from");
    expect(html).toContain("({ timeline: tl })");
  });

  it("renders without script prop", () => {
    const html = renderToHtml(animateEl(), ctx);
    expect(html).toContain("gsap.timeline");
    expect(html).toContain('window.__timelines["shot-01"]');
    expect(html).not.toContain("undefined");
  });

  it("embeds shotId in window.__timelines key", () => {
    const html = renderToHtml(animateEl(), {
      shotId: "05",
      width: 1920,
      height: 1080,
      duration: 5,
      typography: { lang: "en" as const },
    });
    expect(html).toContain('window.__timelines["shot-05"]');
  });

  it("registers the timeline before running the script", () => {
    const html = renderToHtml(
      animateEl({
        script: ({ timeline }) => {
          timeline.to(".clip", { opacity: 0 }, 0);
        },
      }),
      ctx,
    );
    expect(html.indexOf('window.__timelines["shot-01"] = tl')).toBeLessThan(
      html.indexOf("({ timeline: tl })"),
    );
  });

  it("rejects a source that cannot be embedded as an expression", () => {
    const holder = {
      script({ timeline }: { timeline: GsapTimeline }) {
        timeline.to("#title", { opacity: 1 }, 0);
      },
    };
    let code: string | undefined;
    try {
      renderToHtml(animateEl({ script: holder.script }), ctx);
    } catch (err) {
      code = (err as KonteError).code;
    }
    expect(code).toBe("ANIMATE_SCRIPT_INVALID");
  });

  it("rejects a source carrying a sequence that keeps the element from closing", () => {
    // A `Function`-built source is verbatim; the transpiler escapes `</script` in an authored literal.
    const endTag = Function(
      "ctx",
      '/* </script> */ ctx.timeline.set("#t", { opacity: 1 }, 0);',
    ) as (ctx: { timeline: GsapTimeline }) => void;
    const doubleEscape = Function(
      "ctx",
      '/* <!-- <script> */ ctx.timeline.set("#t", { opacity: 1 }, 0);',
    ) as (ctx: { timeline: GsapTimeline }) => void;
    const codes = [endTag, doubleEscape].map((script) => {
      try {
        renderToHtml(animateEl({ script }), ctx);
        return "no throw";
      } catch (err) {
        return (err as KonteError).code;
      }
    });
    expect(codes).toEqual(["ANIMATE_SCRIPT_INVALID", "ANIMATE_SCRIPT_INVALID"]);
  });

  it("accepts an opening tag or a comment opener alone, which cannot end the element", () => {
    const harmless: Array<(ctx: { timeline: GsapTimeline }) => void> = [
      ({ timeline }) => {
        timeline.set("#code", { text: "<script>" }, 0);
      },
      ({ timeline }) => {
        timeline.set("#code", { text: "<!-- example -->" }, 0);
      },
      ({ timeline }) => {
        timeline.set("#code", { text: "</scripture>" }, 0);
      },
    ];
    for (const script of harmless) {
      expect(() => renderToHtml(animateEl({ script }), ctx)).not.toThrow();
    }
  });

  it("emits a script body that cannot end its own element", () => {
    const html = renderToHtml(
      animateEl({
        script: ({ timeline }) => {
          timeline.set("#title", { opacity: 1 }, 0);
        },
      }),
      ctx,
    );
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const body = html.slice(
      html.indexOf("<script>") + "<script>".length,
      html.indexOf("</script>"),
    );
    expect(body).not.toMatch(/<\/script[\s/>]|<script[\s/>]|<!--/i);
  });

  it("resolves the banner host to the shot root, emitting no element of its own", () => {
    const html = renderToHtml(animateEl({ script: () => {} }), ctx);
    expect(html).toContain('document.querySelector("[data-composition-id=\\"shot-01\\"]")');
    expect(html).toContain('host.tagName==="META"');
    expect(html).toContain('document.getElementById("stage")');
    expect(html.startsWith("<script>")).toBe(true);
  });

  it("wraps the script so a throw is reported instead of swallowed", () => {
    const html = renderToHtml(
      animateEl({
        script: () => {
          throw new Error("boom");
        },
      }),
      ctx,
    );
    expect(html).toContain("catch (err)");
    expect(html).toContain("window.__konteAnimateErrors");
    expect(html).toContain('data-konte-animate-error","shot-01"');
    expect(html).toContain("console.error");
  });
});

describe("full video definition", () => {
  it("composes all builders into a valid VideoDefinition", () => {
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
                asset("motion", animateComfy, { prompt: "a cat" });
                return el();
              },
            }),
          ]),
      },
    );
    expect(VideoDefinitionSchema.parse(video)).toEqual(video);
    expect(video.shots[0]!.shotFn).toBeDefined();
  });

  it("composes timeline + shots into a valid VideoDefinition", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", imageComfy, { prompt: "a girl" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("motion", animateWithImageComfy, {
                  prompt: "walk",
                  image: character,
                });
                return el();
              },
            }),
          ]);
        },
      },
    );
    expect(VideoDefinitionSchema.parse(video)).toEqual(video);
    expect(video.topLevelAssets).toBeDefined();
    expect(video.topLevelAssets!.character!.kind).toBe("comfy");
    expect(video.shots[0]!.shotFn).toBeDefined();
  });
});

describe("format-derived asset inputs", () => {
  const fpsComfy = defineComfyAsset({
    workflow: "fps.json",
    description: "test adapter",
    inputs: {
      frameRate: { nodeId: "5", field: "fps", type: "number" },
      width: { nodeId: "6", field: "value", type: "number" },
    },
    outputs: { result: { nodeId: "9", type: "video" } },
  });

  const makeVideo = () =>
    defineVideo(
      testDirection({
        fps: 16,
        size: { megapixels: 0.3072, delivery: { width: 640, height: 480 } },
      }),
      {
        timeline: ({ format }) =>
          videoTimeline([
            shot("01", {
              duration: 3,
              build: () => {
                asset("motion", fpsComfy, {
                  frameRate: format.fps,
                  width: format.size.width,
                });
                return el();
              },
            }),
          ]),
      },
    );

  const inputs = (def: { kind: string }) =>
    (def as unknown as { inputs: Record<string, unknown> }).inputs;

  it("bakes the format-derived inputs into the shots snapshot", () => {
    const video = makeVideo();
    expect(inputs(video.shots[0]!.assets.motion!)["5.fps"]).toBe(16);
    expect(inputs(video.shots[0]!.assets.motion!)["6.value"]).toBe(640);
  });
});
