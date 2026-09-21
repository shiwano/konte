import { describe, expect, it } from "vitest";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineFalAsset } from "../dsl/fal-asset.js";
import { asset } from "../dsl/adapter.js";
import { defineReference } from "../dsl/reference-builders.js";
import {
  imageFile,
  imageResize,
  videoFile,
  videoTrim,
  audioTrim,
  videoFrame,
} from "../dsl/adapters/index.js";
import { defineVideo, makeMediaAsset } from "../dsl/builders.js";
import { upscale } from "../dsl/delivery-upscale.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { Composition } from "../dsl/composition/composition.js";
import { runInPatchDiscoveryMode, runTimelineInDiscoveryMode, seed } from "../dsl/shot-context.js";
import { computeDefinitionHash } from "../definition-hash.js";
import { buildDependencyGraph } from "../graph.js";
import { KonteError } from "../errors.js";
import type {
  ComfyAssetDefinition,
  FalAssetDefinition,
  FileAssetDefinition,
  LocalAssetDefinition,
} from "../types/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const testAdapter = defineComfyAsset({
  workflow: "test.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    seed: { nodeId: "5", field: "seed", type: "seed" },
    steps: { nodeId: "5", field: "steps", type: "number" },
  },
  outputs: {
    result: { nodeId: "9", type: "image" },
  },
});

const videoAdapter = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    image: { nodeId: "1", field: "image", type: "image" },
    prompt: { nodeId: "3", field: "text", type: "string" },
    seed: { nodeId: "5", field: "seed", type: "seed" },
  },
  outputs: {
    video: { nodeId: "10", type: "video" },
  },
});

describe("asset()", () => {
  it("registers asset definition in shot context during discovery", () => {
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
                asset("bg", testAdapter, { prompt: "sky" });
                return el();
              },
            }),
          ]),
      },
    );

    const p = video.shots[0]!.assets.bg;
    expect(p).toBeDefined();
    expect(p!.kind).toBe("comfy");
    expect((p as { workflow: string }).workflow).toBe("test.json");
  });

  it("returns MediaAsset with placeholder src in shot context", () => {
    let result: { src: string } | undefined;
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
                result = asset("bg", testAdapter, { prompt: "sky" });
                return el();
              },
            }),
          ]),
      },
    );

    expect(result).toBeDefined();
    expect(result!.src).toContain("video:shot.01.bg");
  });

  it("registers asset definition in shared context during discovery", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          asset("character", testAdapter, { prompt: "girl" });
          return videoTimeline([]);
        },
      },
    );

    expect(video.topLevelAssets).toBeDefined();
    expect(video.topLevelAssets!.character).toBeDefined();
    expect(video.topLevelAssets!.character!.kind).toBe("comfy");
  });

  it("throws when called outside timeline or shot context", () => {
    expect(() => asset("bg", testAdapter, { prompt: "sky" })).toThrow(
      "asset() must be called inside a timeline() or shot() function",
    );
  });

  it("throws on a duplicate asset name within a shot", () => {
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
                  asset("bg", testAdapter, { prompt: "sky" });
                  asset("bg", testAdapter, { prompt: "sea" });
                  return el();
                },
              }),
            ]),
        },
      ),
    ).toThrow(/Duplicate asset "bg"/);
  });

  it("throws on a duplicate timeline asset name", () => {
    expect(() =>
      defineVideo(
        testDirection({
          fps: 30,
          size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
        }),
        {
          timeline: () => {
            asset("character", testAdapter, { prompt: "girl" });
            asset("character", testAdapter, { prompt: "boy" });
            return videoTimeline([]);
          },
        },
      ),
    ).toThrow(/Duplicate asset "character"/);
  });
});

describe("defineComfyAsset()", () => {
  it("maps user inputs to node ID-based inputs", () => {
    const def = testAdapter.createDefinition({
      prompt: "hello world",
      steps: 20,
    }) as ComfyAssetDefinition;

    expect(def.kind).toBe("comfy");
    expect(def.workflow).toBe("test.json");
    expect(def.inputs["3.text"]).toBe("hello world");
    expect(def.inputs["5.steps"]).toBe(20);
  });

  it("auto-injects seed() placeholder for seed type when not specified", () => {
    const def = testAdapter.createDefinition({ prompt: "hello" }) as ComfyAssetDefinition;

    expect(def.inputs["5.seed"]).toBe(seed());
  });

  it("uses explicit seed value when provided", () => {
    const def = testAdapter.createDefinition({
      prompt: "hello",
      seed: 42,
    }) as ComfyAssetDefinition;

    expect(def.inputs["5.seed"]).toBe(42);
  });

  it("extracts .src from media type inputs", () => {
    const mediaAsset = { src: "__konte:video:timeline.character__" };
    const def = videoAdapter.createDefinition({
      image: mediaAsset as any,
      prompt: "walk",
    }) as ComfyAssetDefinition;

    expect(def.inputs["1.image"]).toBe("__konte:video:timeline.character__");
    expect(def.inputs["3.text"]).toBe("walk");
  });

  it("prunes the source node of an omitted optional media input", () => {
    const adapter = defineComfyAsset({
      workflow: "edit.json",
      description: "test adapter",
      inputs: {
        image1: { nodeId: "41", field: "image", type: "image", required: true },
        image2: { nodeId: "83", field: "image", type: "image" },
        prompt: { nodeId: "3", field: "text", type: "string" },
      },
      outputs: { image: { nodeId: "9", type: "image" } },
    });

    const def = adapter.createDefinition({
      image1: { src: "__konte:x__" } as any,
      prompt: "edit",
    }) as ComfyAssetDefinition;

    expect(def.inputs["83.image"]).toBeUndefined();
    expect(def.prunedNodes).toEqual(["83"]);
  });

  // An optional input that owns a branch: the ControlNet shape. Omitting it must take the loader
  // and the apply node with it, and say how the apply node is spliced out of the model chain.
  it("prunes an omitted optional input's whole branch, naming its pass-through", () => {
    const adapter = defineComfyAsset({
      workflow: "edit.json",
      description: "test adapter",
      inputs: {
        image1: { nodeId: "41", field: "image", type: "image", required: true },
        depthImage: {
          nodeId: "221",
          field: "image",
          type: "image",
          branch: ["220", { nodeId: "222", passThrough: "model" }],
        },
        controlStrength: { nodeId: "222", field: "strength", type: "number", default: 1 },
        controlNetName: {
          nodeId: "220",
          field: "name",
          type: "string",
          default: "depth.safetensors",
        },
      },
      models: [
        {
          filename: "depth.safetensors",
          type: "checkpoint",
          nodeId: "220",
          url: "https://example/x",
        },
      ],
      outputs: { image: { nodeId: "9", type: "image" } },
    });

    const without = adapter.createDefinition({
      image1: { src: "__konte:x__" } as any,
    }) as ComfyAssetDefinition;
    expect(without.prunedNodes).toEqual(["221", "220", "222"]);
    expect(without.prunedPassThroughs).toEqual({ "222": "model" });
    // An input aimed at a node that is no longer in the graph is dead weight in the hash.
    expect(without.inputs["222.strength"]).toBeUndefined();
    // …and the weights only that branch loads are not provisioned for a take that never uses it.
    expect(without.models).toBeUndefined();

    const with_ = adapter.createDefinition({
      image1: { src: "__konte:x__" } as any,
      depthImage: { src: "__konte:reference:depthMap__" } as any,
    }) as ComfyAssetDefinition;
    expect(with_.prunedNodes).toBeUndefined();
    expect(with_.prunedPassThroughs).toBeUndefined();
    expect(with_.inputs["221.image"]).toBe("__konte:reference:depthMap__");
    expect(with_.inputs["222.strength"]).toBe(1);
    expect(with_.models).toHaveLength(1);
  });

  // A file two loaders share — the LTX adapters name one checkpoint from two inputs — must survive
  // one of them being pruned, or the take that still needs it fails at generation time. Keying the
  // declaration on its own loader node is what makes that structural rather than a filename guess.
  it("keeps a model declared by a surviving loader, even when a pruned node names the same file", () => {
    const adapter = defineComfyAsset({
      workflow: "edit.json",
      description: "test adapter",
      inputs: {
        image1: { nodeId: "41", field: "image", type: "image", required: true },
        depthImage: { nodeId: "221", field: "image", type: "image", branch: ["220"] },
        branchModel: {
          nodeId: "220",
          field: "name",
          type: "string",
          default: "shared.safetensors",
        },
        liveModel: {
          nodeId: "207",
          field: "unet_name",
          type: "string",
          default: "shared.safetensors",
        },
      },
      models: [
        { filename: "shared.safetensors", type: "unet", nodeId: "207", url: "https://example/x" },
      ],
      outputs: { image: { nodeId: "9", type: "image" } },
    });

    const def = adapter.createDefinition({
      image1: { src: "__konte:x__" } as any,
    }) as ComfyAssetDefinition;
    expect(def.prunedNodes).toEqual(["221", "220"]);
    expect(def.models?.map((m) => m.filename)).toEqual(["shared.safetensors"]);
  });

  it("does not set prunedNodes when all optional media inputs are provided", () => {
    const def = videoAdapter.createDefinition({
      image: { src: "__konte:x__" } as any,
      prompt: "walk",
    }) as ComfyAssetDefinition;

    expect(def.prunedNodes).toBeUndefined();
  });

  it("sets outputNodeId for multi-output workflows", () => {
    const multiOutput = defineComfyAsset({
      workflow: "multi.json",
      description: "test adapter",
      inputs: {
        prompt: { nodeId: "3", field: "text", type: "string" },
      },
      outputs: {
        image: { nodeId: "9", type: "image" },
        preview: { nodeId: "10", type: "image" },
      },
      primary: "image",
    });

    const def = multiOutput.createDefinition({ prompt: "test" }) as ComfyAssetDefinition;
    expect(def.outputNodeId).toBe("9");
  });

  it("does not set outputNodeId for single-output workflows", () => {
    const def = testAdapter.createDefinition({ prompt: "test" }) as ComfyAssetDefinition;
    expect(def.outputNodeId).toBeUndefined();
  });

  it("falls back to default value when user does not specify input", () => {
    const adapterWithDefault = defineComfyAsset({
      workflow: "test.json",
      description: "test adapter",
      inputs: {
        prompt: { nodeId: "3", field: "text", type: "string" },
        steps: { nodeId: "5", field: "steps", type: "number", default: 30 },
      },
      outputs: {
        result: { nodeId: "9", type: "image" },
      },
    });

    const def = adapterWithDefault.createDefinition({
      prompt: "hello",
    }) as ComfyAssetDefinition;

    expect(def.inputs["5.steps"]).toBe(30);
  });

  it("uses user value over default when both are provided", () => {
    const adapterWithDefault = defineComfyAsset({
      workflow: "test.json",
      description: "test adapter",
      inputs: {
        prompt: { nodeId: "3", field: "text", type: "string" },
        steps: { nodeId: "5", field: "steps", type: "number", default: 30 },
      },
      outputs: {
        result: { nodeId: "9", type: "image" },
      },
    });

    const def = adapterWithDefault.createDefinition({
      prompt: "hello",
      steps: 50,
    }) as ComfyAssetDefinition;

    expect(def.inputs["5.steps"]).toBe(50);
  });
});

describe("file adapters with type field", () => {
  it("imageFile sets type to image", () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", imageFile, { path: "assets/files/bg.png" });
      return { bg };
    });
    const p = reference.topLevelAssets!.bg as Record<string, unknown>;
    expect(p.kind).toBe("file");
    expect(p.type).toBe("image");
  });

  it("videoFile sets type to video", () => {
    const reference = defineReference(plainDirection, () => {
      const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
      return { bg };
    });
    const p = reference.topLevelAssets!.bg as Record<string, unknown>;
    expect(p.kind).toBe("file");
    expect(p.type).toBe("video");
  });

  it("accepts a file asset declared in a stage shot as a per-profile asset", () => {
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
                const bg = asset("bg", videoFile, { path: "assets/files/bg.mp4" });
                expect(bg.src).toContain("video:shot.01.bg");
                return el();
              },
            }),
          ]),
      },
    );
    expect(video).toBeDefined();
  });
});

describe("dependency graph integration", () => {
  it("asset() created definitions are compatible with collectRefs/buildDependencyGraph", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const character = asset("character", testAdapter, { prompt: "a girl" });
          return videoTimeline([
            shot("01", {
              duration: 5,
              build: () => {
                asset("motion", videoAdapter, { image: character, prompt: "walk" });
                return el();
              },
            }),
          ]);
        },
      },
    );

    const graph = buildDependencyGraph(video);
    const deps = graph.dependencies.get("video:shot.01.motion");
    expect(deps).toBeDefined();
    expect(deps).toContain("video:timeline.character");
  });
});

describe("videoTrim adapter", () => {
  it("creates a local asset definition with trim operation", () => {
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
                const raw = asset("motionRaw", videoAdapter, {
                  image: { src: "img" } as any,
                  prompt: "walk",
                });
                asset("motion", videoTrim, { source: raw, start: 2, duration: 3 });
                return el();
              },
            }),
          ]),
      },
    );

    const def = video.shots[0]!.assets.motion as LocalAssetDefinition;
    expect(def.kind).toBe("local");
    expect(def.operation).toBe("trim");
    expect(def.mediaType).toBe("video");
    expect(def.inputs.start).toBe(2);
    expect(def.inputs.duration).toBe(3);
  });

  it("creates a dependency on the source asset", () => {
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
                const raw = asset("motionRaw", videoAdapter, {
                  image: { src: "img" } as any,
                  prompt: "walk",
                });
                asset("motion", videoTrim, { source: raw, start: 2, duration: 3 });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);
    const deps = graph.dependencies.get("video:shot.01.motion");
    expect(deps).toBeDefined();
    expect(deps).toContain("video:shot.01.motionRaw");
  });
});

describe("videoFrame adapter", () => {
  it("creates an image asset out of a video, defaulting `at` to the clip's last frame", () => {
    const def = videoFrame.createDefinition({
      source: { src: "__konte:video:shot.01.motion__" } as any,
    }) as LocalAssetDefinition;

    expect(def.kind).toBe("local");
    expect(def.operation).toBe("frame");
    expect(def.mediaType).toBe("image");
    expect(def.inputs.at).toBe("last");
  });

  it("keeps an explicit `at` as given", () => {
    const def = videoFrame.createDefinition({
      source: { src: "__konte:video:shot.01.motion__" } as any,
      at: 14.5,
    }) as LocalAssetDefinition;

    expect(def.inputs.at).toBe(14.5);
  });

  it("rejects an `at` that is negative or not a number", () => {
    for (const at of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => videoFrame.createDefinition({ source: { src: "x" } as any, at })).toThrow(
        KonteError,
      );
    }
  });

  it("creates a dependency on the source video, so a reroll of it ages the frame out", () => {
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
                const raw = asset("motionA", videoAdapter, {
                  image: { src: "img" } as any,
                  prompt: "walk",
                });
                asset("motionAEnd", videoFrame, { source: raw, at: 4.5 });
                return el();
              },
            }),
          ]),
      },
    );

    const graph = buildDependencyGraph(video);
    expect(graph.dependencies.get("video:shot.01.motionAEnd")).toContain("video:shot.01.motionA");
  });
});

describe("deterministic flag", () => {
  it("marks local adapter definitions as deterministic", () => {
    const resized = imageResize.createDefinition({
      image: { src: "__konte:reference:bg__" } as any,
      width: 10,
      height: 10,
    }) as LocalAssetDefinition;
    expect(resized.deterministic).toBe(true);
  });

  it("marks file adapter definitions as deterministic", () => {
    const def = imageFile.createDefinition({ path: "assets/files/x.png" }) as FileAssetDefinition;
    expect(def.deterministic).toBe(true);
  });

  it("leaves generative adapter definitions non-deterministic by default", () => {
    const def = testAdapter.createDefinition({ prompt: "hi" }) as ComfyAssetDefinition;
    expect(def.deterministic).toBeUndefined();
  });

  it("lets generative adapters opt into deterministic", () => {
    const fixed = defineComfyAsset({
      workflow: "fixed.json",
      description: "test adapter",
      inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
      outputs: { result: { nodeId: "9", type: "image" } },
      deterministic: true,
    });
    const def = fixed.createDefinition({ prompt: "hi" }) as ComfyAssetDefinition;
    expect(def.deterministic).toBe(true);
  });
});

describe("audioTrim adapter", () => {
  it("creates a local asset definition with trim operation for audio", () => {
    const video = defineVideo(
      testDirection({
        fps: 30,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () => {
          const reference = defineReference(plainDirection, () => {
            const bgmRaw = asset("bgmRaw", videoFile, { path: "assets/files/bgm.wav" });
            return { bgmRaw };
          });
          asset("bgm", audioTrim, { source: reference.bgmRaw as any, start: 10, duration: 5 });
          return videoTimeline([]);
        },
      },
    );

    const def = video.topLevelAssets!.bgm as LocalAssetDefinition;
    expect(def.kind).toBe("local");
    expect(def.operation).toBe("trim");
    expect(def.mediaType).toBe("audio");
    expect(def.inputs.start).toBe(10);
    expect(def.inputs.duration).toBe(5);
  });
});

describe("nested field paths", () => {
  const falNested = defineFalAsset({
    endpointId: "fal-ai/nested",
    description: "test adapter",
    mediaType: "audio",
    inputs: {
      prompt: { field: "prompt", type: "string", required: true },
      sampleRate: { field: "audio_setting.sample_rate", type: "number", default: 44100 },
      format: { field: "audio_setting.format", type: "string", default: "mp3" },
    },
  });

  it("expands dotted fields, grouping leaves under a shared parent object", () => {
    const def = falNested.createDefinition({ prompt: "song" }) as FalAssetDefinition;
    expect(def.inputs).toEqual({
      prompt: "song",
      audio_setting: { sample_rate: 44100, format: "mp3" },
    });
  });

  it("omits an unset nested leaf that has no default", () => {
    const adapter = defineFalAsset({
      endpointId: "fal-ai/nested",
      description: "test adapter",
      mediaType: "audio",
      inputs: {
        prompt: { field: "prompt", type: "string", required: true },
        bitrate: { field: "audio_setting.bitrate", type: "number" },
        format: { field: "audio_setting.format", type: "string", default: "mp3" },
      },
    });
    const def = adapter.createDefinition({ prompt: "song" }) as FalAssetDefinition;
    expect(def.inputs).toEqual({ prompt: "song", audio_setting: { format: "mp3" } });
  });
});

describe("required input enforcement", () => {
  it("comfy: throws MISSING_REQUIRED_INPUT when a required image is omitted", () => {
    const adapter = defineComfyAsset({
      workflow: "edit.json",
      description: "test adapter",
      inputs: {
        image1: { nodeId: "41", field: "image", type: "image", required: true },
        image2: { nodeId: "83", field: "image", type: "image", required: true },
      },
      outputs: { image: { nodeId: "9", type: "image" } },
    });
    try {
      adapter.createDefinition({ image1: makeMediaAsset("a.png") } as never);
      expect.unreachable("expected createDefinition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KonteError);
      expect((err as KonteError).code).toBe("MISSING_REQUIRED_INPUT");
      expect((err as KonteError).message).toContain("image2");
    }
  });

  it("comfy: does not throw when an optional media input is omitted", () => {
    const adapter = defineComfyAsset({
      workflow: "edit.json",
      description: "test adapter",
      inputs: {
        image1: { nodeId: "41", field: "image", type: "image", required: true },
        image2: { nodeId: "83", field: "image", type: "image" },
      },
      outputs: { image: { nodeId: "9", type: "image" } },
    });
    const def = adapter.createDefinition({
      image1: makeMediaAsset("a.png"),
    } as never) as ComfyAssetDefinition;
    expect(def.inputs).toEqual({ "41.image": "a.png" });
  });

  it("fal: throws MISSING_REQUIRED_INPUT when a required field is omitted", () => {
    const adapter = defineFalAsset({
      endpointId: "fal-ai/edit",
      description: "test adapter",
      mediaType: "image",
      inputs: {
        prompt: { field: "prompt", type: "string", required: true },
        image: { field: "image_url", type: "image", required: true },
      },
    });
    expect(() => adapter.createDefinition({ prompt: "hi" } as never)).toThrowError(
      /Required input "image".*image_url/,
    );
  });
});

describe("array media inputs", () => {
  it("fal: maps an array image field to a list of sources", () => {
    const adapter = defineFalAsset({
      endpointId: "fal-ai/nano-banana-2/edit",
      description: "test adapter",
      mediaType: "image",
      inputs: {
        prompt: { field: "prompt", type: "string", required: true },
        inputImage: { field: "image_urls", type: "image", required: true, array: true },
      },
    });
    const def = adapter.createDefinition({
      prompt: "edit it",
      inputImage: [makeMediaAsset("a.png"), makeMediaAsset("b.png")],
    } as never) as FalAssetDefinition;
    expect(def.inputs).toEqual({ prompt: "edit it", image_urls: ["a.png", "b.png"] });
  });

  it("fal: maps a single-element array image field to a list of one source", () => {
    const adapter = defineFalAsset({
      endpointId: "fal-ai/edit",
      description: "test adapter",
      mediaType: "image",
      inputs: {
        prompt: { field: "prompt", type: "string", required: true },
        inputImage: { field: "input_images", type: "image", required: true, array: true },
      },
    });
    const def = adapter.createDefinition({
      prompt: "edit it",
      inputImage: [makeMediaAsset("a.png")],
    } as never) as FalAssetDefinition;
    expect(def.inputs).toEqual({ prompt: "edit it", input_images: ["a.png"] });
  });
});

describe("fixed inputs", () => {
  const falMode = defineFalAsset({
    endpointId: "fal-ai/multi-mode",
    description: "test adapter",
    mediaType: "audio",
    inputs: {
      mode: { field: "mode", type: "string", fixed: true, default: "voice_clone" },
      text: { field: "text", type: "string", required: true },
    },
  });

  it("fal: sends the pinned value, ignoring one passed at runtime", () => {
    const def = falMode.createDefinition({ text: "hi" } as never) as FalAssetDefinition;
    expect(def.inputs).toEqual({ mode: "voice_clone", text: "hi" });

    const forced = falMode.createDefinition({
      text: "hi",
      mode: "custom_voice",
    } as never) as FalAssetDefinition;
    expect(forced.inputs).toEqual({ mode: "voice_clone", text: "hi" });
  });

  it("leaves a fixed input out of the reported surface", () => {
    expect(Object.keys(falMode.meta.inputs)).toEqual(["text"]);
  });

  it("rejects a fixed input whose invalid shape would fail silently", () => {
    const declare = (mode: Record<string, unknown>) => () =>
      defineFalAsset({
        endpointId: "fal-ai/multi-mode",
        description: "test adapter",
        mediaType: "audio",
        inputs: { mode, text: { field: "text", type: "string" } } as never,
      });

    expect(declare({ field: "mode", type: "string", fixed: true })).toThrowError(
      /needs a literal default/,
    );
    expect(declare({ field: "mode", type: "audio", fixed: true, default: "a.wav" })).toThrowError(
      /must be a string, number or boolean/,
    );
    expect(
      declare({ field: "mode", type: "string", fixed: true, default: "x", required: true }),
    ).toThrowError(/cannot also set required, array or values/);
    expect(declare({ field: "mode", type: "string", fixed: true, default: 3 })).toThrowError(
      /typed "string" but defaults to number/,
    );
  });

  it("rejects a fixed key in the call options", () => {
    // @ts-expect-error — `mode` is pinned by the adapter, so it is not a call option
    falMode.createDefinition({ text: "hi", mode: "custom_voice" });
  });
});

describe("format-derived comfy inputs (width/height/fps)", () => {
  const sizedAdapter = defineComfyAsset({
    workflow: "sized.json",
    description: "test adapter",
    inputs: {
      width: { nodeId: "1", field: "value", type: "width", default: 100 },
      height: { nodeId: "2", field: "value", type: "height", default: 100 },
      fps: { nodeId: "3", field: "value", type: "fps", default: 8 },
    },
    outputs: {
      video: { nodeId: "9", type: "video" },
    },
  });

  function buildInDiscovery(format?: { size: { width: number; height: number }; fps?: number }) {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", sizedAdapter, {});
        return {};
      },
      format,
    );
    return assets["m"] as ComfyAssetDefinition;
  }

  it("resolves omitted width/height/fps from the active format", () => {
    const def = buildInDiscovery({ size: { width: 1280, height: 720 }, fps: 24 });
    expect(def.inputs["1.value"]).toBe(1280);
    expect(def.inputs["2.value"]).toBe(720);
    expect(def.inputs["3.value"]).toBe(24);
  });

  it("falls back to the declared default when no format is in scope", () => {
    const def = sizedAdapter.createDefinition({}) as ComfyAssetDefinition;
    expect(def.inputs["1.value"]).toBe(100);
    expect(def.inputs["2.value"]).toBe(100);
    expect(def.inputs["3.value"]).toBe(8);
  });

  it("lets an explicit value override the format", () => {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", sizedAdapter, { width: 512, fps: 16 });
        return {};
      },
      { size: { width: 1280, height: 720 }, fps: 24 },
    );
    const def = assets["m"] as ComfyAssetDefinition;
    expect(def.inputs["1.value"]).toBe(512);
    expect(def.inputs["2.value"]).toBe(720);
    expect(def.inputs["3.value"]).toBe(16);
  });

  it("changing the format changes the definition hash (staleness signal)", () => {
    const a = computeDefinitionHash(
      buildInDiscovery({ size: { width: 1280, height: 720 }, fps: 24 }),
    );
    const b = computeDefinitionHash(
      buildInDiscovery({ size: { width: 1920, height: 1080 }, fps: 24 }),
    );
    const c = computeDefinitionHash(
      buildInDiscovery({ size: { width: 1280, height: 720 }, fps: 30 }),
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("grid (a model's own step)", () => {
  const griddedAdapter = defineComfyAsset({
    workflow: "gridded.json",
    description: "test adapter",
    inputs: {
      width: { nodeId: "1", field: "value", type: "width", default: 1344, grid: { step: 32 } },
      height: { nodeId: "2", field: "value", type: "height", default: 768, grid: { step: 32 } },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
  });

  function buildWith(
    format: { size: { width: number; height: number } } | undefined,
    inputs: { width?: number; height?: number } = {},
  ) {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", griddedAdapter, inputs);
        return {};
      },
      format,
    );
    return assets["m"] as ComfyAssetDefinition;
  }

  it("raises a format-derived size to the next multiple, leaving an on-grid one alone", () => {
    const def = buildWith({ size: { width: 720, height: 1280 } });
    expect(def.inputs["1.value"]).toBe(736);
    expect(def.inputs["2.value"]).toBe(1280);
  });

  it("never rounds down, so a take is never generated under the canvas", () => {
    const def = buildWith({ size: { width: 710, height: 1250 } });
    expect(def.inputs["1.value"]).toBe(736);
    expect(def.inputs["2.value"]).toBe(1280);
  });

  it("raises an explicitly passed size too", () => {
    const def = buildWith({ size: { width: 720, height: 1280 } }, { width: 1000, height: 500 });
    expect(def.inputs["1.value"]).toBe(1024);
    expect(def.inputs["2.value"]).toBe(512);
  });

  it("raises a sub-step size to one full step", () => {
    expect(buildWith({ size: { width: 10, height: 10 } }).inputs["1.value"]).toBe(32);
  });

  it("leaves an on-grid default alone with no format in scope", () => {
    const def = griddedAdapter.createDefinition({}) as ComfyAssetDefinition;
    expect(def.inputs["1.value"]).toBe(1344);
    expect(def.inputs["2.value"]).toBe(768);
  });

  it("reports the step in meta", () => {
    expect(griddedAdapter.meta.inputs.width).toEqual({
      type: "width",
      required: false,
      default: 1344,
      grid: { step: 32 },
    });
  });
});

describe("frames (a shot's duration on the model's clock)", () => {
  const clockedAdapter = defineComfyAsset({
    workflow: "clocked.json",
    description: "test adapter",
    inputs: {
      length: {
        nodeId: "1",
        field: "value",
        type: "frames",
        clock: 24,
        default: 120,
        grid: { step: 17, offset: 5 },
      },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
  });

  const canvasAdapter = defineComfyAsset({
    workflow: "canvas.json",
    description: "test adapter",
    inputs: {
      length: {
        nodeId: "1",
        field: "value",
        type: "frames",
        default: 81,
        grid: { step: 4, offset: 1 },
      },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
  });

  function buildWith(
    adapter: typeof clockedAdapter,
    format:
      | { size: { width: number; height: number }; fps?: number; duration?: number }
      | undefined,
    inputs: { length?: number } = {},
  ) {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", adapter, inputs);
        return {};
      },
      format,
    );
    return assets["m"] as ComfyAssetDefinition;
  }

  it("counts the shot's duration on the declared clock, not the canvas fps", () => {
    // 3s * 24 = 72 frames → next point on 17k+5 is 73.
    const def = buildWith(clockedAdapter, {
      size: { width: 1280, height: 720 },
      fps: 30,
      duration: 3,
    });
    expect(def.inputs["1.value"]).toBe(73);
  });

  it("falls back to the canvas fps when the model has no clock of its own", () => {
    // 3s * 16 = 48 frames → next point on 4k+1 is 49.
    const def = buildWith(canvasAdapter, {
      size: { width: 1280, height: 720 },
      fps: 16,
      duration: 3,
    });
    expect(def.inputs["1.value"]).toBe(49);
  });

  it("raises an explicitly passed count onto the grid too", () => {
    const def = buildWith(
      clockedAdapter,
      { size: { width: 1280, height: 720 }, fps: 24, duration: 3 },
      { length: 100 },
    );
    expect(def.inputs["1.value"]).toBe(107);
  });

  it("falls back to the default where no duration is in scope", () => {
    expect(
      buildWith(clockedAdapter, { size: { width: 1280, height: 720 }, fps: 24 }).inputs["1.value"],
    ).toBe(124);
    expect((clockedAdapter.createDefinition({}) as ComfyAssetDefinition).inputs["1.value"]).toBe(
      124,
    );
  });

  it("floors a sub-offset duration at the grid's first point", () => {
    const format = { size: { width: 1280, height: 720 }, fps: 24 };
    expect(buildWith(clockedAdapter, { ...format, duration: 0.1 }).inputs["1.value"]).toBe(5);
    expect(buildWith(clockedAdapter, { ...format, duration: 0 }).inputs["1.value"]).toBe(5);
  });

  it("floors a count passed below the grid, however far below", () => {
    const def = buildWith(
      clockedAdapter,
      { size: { width: 1280, height: 720 }, fps: 24, duration: 3 },
      { length: -100 },
    );
    expect(def.inputs["1.value"]).toBe(5);
  });

  it("reports the clock and the grid in meta", () => {
    expect(clockedAdapter.meta.inputs.length).toEqual({
      type: "frames",
      required: false,
      default: 120,
      grid: { step: 17, offset: 5 },
      clock: 24,
    });
  });
});

describe("max (the model's ceiling)", () => {
  const cappedAdapter = defineComfyAsset({
    workflow: "capped.json",
    description: "test adapter",
    inputs: {
      length: {
        nodeId: "1",
        field: "value",
        type: "frames",
        clock: 24,
        default: 120,
        grid: { step: 17, offset: 5 },
        max: 362,
      },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
  });

  function buildWith(duration: number, inputs: { length?: number } = {}) {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", cappedAdapter, inputs);
        return {};
      },
      { size: { width: 1280, height: 720 }, fps: 24, duration },
    );
    return assets["m"] as ComfyAssetDefinition;
  }

  it("rejects a shot konte's own frame count carries past the ceiling", () => {
    // 20s * 24 = 480 → 481 on the grid, past 362.
    expect(() => buildWith(20)).toThrow(KonteError);
    expect(() => buildWith(20)).toThrow(/481.*20\.0s at 24fps.*362.*15\.1s/);
  });

  it("names the way out, since the count is derived and there is no input to lower", () => {
    expect(() => buildWith(20)).toThrow(/adapters\.videoFrame/);
  });

  it("passes a shot the grid raise lifts to exactly the ceiling", () => {
    // 15.05s * 24 = 361.2 → 362 on the grid, which is the ceiling itself.
    expect(buildWith(15.05).inputs["1.value"]).toBe(362);
  });

  it("rejects an explicitly passed count too", () => {
    expect(() => buildWith(3, { length: 400 })).toThrow(KonteError);
    expect(buildWith(3, { length: 100 }).inputs["1.value"]).toBe(107);
  });

  it("judges only what is submitted — a ceiling on a pruned branch rejects nothing", () => {
    const branched = defineComfyAsset({
      workflow: "branched.json",
      description: "test adapter",
      inputs: {
        image1: { nodeId: "41", field: "image", type: "image", required: true },
        depthImage: { nodeId: "221", field: "image", type: "image", branch: ["220"] },
        controlSteps: { nodeId: "220", field: "steps", type: "number", default: 40, max: 10 },
      },
      outputs: { image: { nodeId: "9", type: "image" } },
    });

    // Omitting the optional media takes node 220 with it, so its over-max default is never sent.
    const without = branched.createDefinition({
      image1: { src: "__konte:x__" } as any,
    }) as ComfyAssetDefinition;
    expect(without.inputs["220.steps"]).toBeUndefined();

    expect(() =>
      branched.createDefinition({
        image1: { src: "__konte:x__" } as any,
        depthImage: { src: "__konte:y__" } as any,
      }),
    ).toThrow(KonteError);
  });

  it("rejects a non-finite count rather than serializing it into the workflow", () => {
    expect(() => buildWith(3, { length: Number.NaN })).toThrow(/not a finite number/);
  });

  it("rejects a ceiling the adapter could never enforce, where it is declared", () => {
    const declare = (input: Record<string, unknown>) =>
      defineComfyAsset({
        workflow: "bad.json",
        description: "test adapter",
        inputs: { x: input as never },
        outputs: { video: { nodeId: "9", type: "video" } },
      });

    expect(() => declare({ nodeId: "1", field: "v", type: "string", max: 10 })).toThrow(
      /never enforced/,
    );
    expect(() =>
      declare({ nodeId: "1", field: "v", type: "number", max: Number.POSITIVE_INFINITY }),
    ).toThrow(/finite max/);
  });

  it("reports the ceiling in meta, so `adapter show` can print it", () => {
    expect(cappedAdapter.meta.inputs.length).toEqual({
      type: "frames",
      required: false,
      default: 120,
      grid: { step: 17, offset: 5 },
      max: 362,
      clock: 24,
    });
  });
});

describe("pin: { end } (an end image anchored past the shot)", () => {
  const anchoredAdapter = defineComfyAsset({
    workflow: "anchored.json",
    description: "test adapter",
    inputs: {
      startImage: { nodeId: "10", field: "image", type: "image", pin: "start" },
      endImage: {
        nodeId: "20",
        field: "image",
        type: "image",
        pin: { end: { nodeId: "21", field: "frame_idx" } },
        branch: [{ nodeId: "21", passThrough: "positive" }],
      },
      length: {
        nodeId: "1",
        field: "length",
        type: "frames",
        clock: 24,
        default: 120,
        grid: { step: 17, offset: 5 },
      },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
  });

  function buildWith(
    duration: number | undefined,
    inputs: { endImage?: boolean; length?: number } = {},
  ) {
    const { endImage = true, length } = inputs;
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", anchoredAdapter, {
          startImage: { src: "__konte:a__" } as any,
          ...(endImage ? { endImage: { src: "__konte:b__" } as any } : {}),
          ...(length !== undefined ? { length } : {}),
        });
        return {};
      },
      {
        size: { width: 1280, height: 720 },
        fps: 30,
        ...(duration !== undefined ? { duration } : {}),
      },
    );
    return assets["m"] as ComfyAssetDefinition;
  }

  it("anchors the end image on the first frame past the shot", () => {
    // 5s * 24 = 120 shown; 121 → 124 on the grid, so frame 120 exists and is never played.
    const def = buildWith(5);
    expect(def.inputs["1.length"]).toBe(124);
    expect(def.inputs["21.frame_idx"]).toBe(120);
  });

  it("derives one frame more where the shot lands exactly on the grid", () => {
    // 8s * 24 = 192 is a grid point; the anchor needs frame 192, so the clip takes the next rung.
    const def = buildWith(8);
    expect(def.inputs["1.length"]).toBe(209);
    expect(def.inputs["21.frame_idx"]).toBe(192);
  });

  it("leaves the derived length alone without an end image", () => {
    const def = buildWith(8, { endImage: false });
    expect(def.inputs["1.length"]).toBe(192);
    expect(def.inputs["21.frame_idx"]).toBeUndefined();
  });

  it("anchors at the clip's last frame when a passed length leaves no frame past the shot", () => {
    expect(buildWith(5, { length: 107 }).inputs["21.frame_idx"]).toBe(-1);
    expect(buildWith(5, { length: 141 }).inputs["21.frame_idx"]).toBe(120);
  });

  it("writes no anchor outside a shot", () => {
    const def = buildWith(undefined);
    expect(def.inputs["1.length"]).toBe(124);
    expect(def.inputs["21.frame_idx"]).toBeUndefined();
  });

  it("reports the anchored input as an end pin in meta, so the pin check and `adapter show` read it", () => {
    expect(anchoredAdapter.meta.inputs.endImage!.pin).toBe("end");
  });

  it("rejects an anchor with no frame count, or one an input also writes, where it is declared", () => {
    const declare = (inputs: Record<string, unknown>) =>
      defineComfyAsset({
        workflow: "bad.json",
        description: "test adapter",
        inputs: inputs as never,
        outputs: { video: { nodeId: "9", type: "video" } },
      });
    const anchor = { nodeId: "21", field: "frame_idx" };

    expect(() =>
      declare({
        endImage: { nodeId: "20", field: "image", type: "image", pin: { end: anchor } },
      }),
    ).toThrow(/"frames" length/);
    expect(() =>
      declare({
        endImage: { nodeId: "20", field: "image", type: "image", pin: { end: anchor } },
        length: { nodeId: "1", field: "duration", type: "seconds" },
      }),
    ).toThrow(/"frames" length/);
    expect(() =>
      declare({
        endImage: { nodeId: "20", field: "image", type: "image", pin: { end: anchor } },
        length: { nodeId: "1", field: "length", type: "frames", clock: 24 },
        frameIdx: { nodeId: "21", field: "frame_idx", type: "number", default: -1 },
      }),
    ).toThrow(/"frameIdx" writes 21\.frame_idx/);
  });
});

describe("function default (computed from the build format)", () => {
  const framedAdapter = defineComfyAsset({
    workflow: "framed.json",
    description: "test adapter",
    inputs: {
      // 4n+1 frame count from the shot's duration × fps.
      length: {
        nodeId: "1",
        field: "value",
        type: "number",
        default: (f) =>
          f?.duration && f.fps ? Math.round((f.duration * f.fps - 1) / 4) * 4 + 1 : 81,
      },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
  });

  function buildWith(format?: {
    size: { width: number; height: number };
    fps?: number;
    duration?: number;
  }) {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", framedAdapter, {});
        return {};
      },
      format,
    );
    return assets["m"] as ComfyAssetDefinition;
  }

  it("computes the default from format.duration and format.fps", () => {
    // 5 * 16 = 80 → nearest 4n+1 is 81.
    expect(
      buildWith({ size: { width: 1280, height: 720 }, fps: 16, duration: 5 }).inputs["1.value"],
    ).toBe(81);
  });

  it("falls back to the static branch when no duration is in scope", () => {
    expect(buildWith({ size: { width: 1280, height: 720 }, fps: 16 }).inputs["1.value"]).toBe(81);
    expect((framedAdapter.createDefinition({}) as ComfyAssetDefinition).inputs["1.value"]).toBe(81);
  });

  it("lets an explicit value override the computed default", () => {
    const { assets } = runTimelineInDiscoveryMode(
      "video",
      () => {
        asset("m", framedAdapter, { length: 41 });
        return {};
      },
      { size: { width: 1280, height: 720 }, fps: 16, duration: 5 },
    );
    expect((assets["m"] as ComfyAssetDefinition).inputs["1.value"]).toBe(41);
  });

  it("reports the input as computed (no static default) in meta", () => {
    expect(framedAdapter.meta.inputs.length).toEqual({
      type: "number",
      required: false,
      computed: true,
    });
  });

  it("threads the shot's duration into the build so the count varies per shot", () => {
    const video = defineVideo(
      testDirection({
        fps: 16,
        size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
      }),
      {
        timeline: () =>
          videoTimeline([
            shot("01", {
              duration: 3,
              build: () => {
                asset("motion", framedAdapter, {});
                return el();
              },
            }),
            shot("02", {
              duration: 5,
              build: () => {
                asset("motion", framedAdapter, {});
                return el();
              },
            }),
          ]),
      },
    );
    // 3 * 16 = 48 → 49; 5 * 16 = 80 → 81.
    expect((video.shots[0]!.assets.motion as ComfyAssetDefinition).inputs["1.value"]).toBe(49);
    expect((video.shots[1]!.assets.motion as ComfyAssetDefinition).inputs["1.value"]).toBe(81);
  });
});

describe("declaration-time rejection of a grid or clock that would never be applied", () => {
  const define = (input: Record<string, unknown>) =>
    defineComfyAsset({
      workflow: "invalid.json",
      description: "test adapter",
      inputs: { knob: { nodeId: "1", field: "value", ...input } as never },
      outputs: { video: { nodeId: "9", type: "video" } },
    });

  it("rejects a clock on anything but a frame count", () => {
    expect(() => define({ type: "number", clock: 24 })).toThrow(/never read/);
  });

  it("rejects a clock that is not a positive rate", () => {
    expect(() => define({ type: "frames", clock: 0 })).toThrow(/positive clock/);
    expect(() => define({ type: "frames", clock: -24 })).toThrow(/positive clock/);
    expect(() => define({ type: "frames", clock: Number.NaN })).toThrow(/positive clock/);
  });

  it("rejects a grid on a non-numeric input", () => {
    expect(() => define({ type: "string", grid: { step: 32 } })).toThrow(/never applied/);
    expect(() => define({ type: "image", grid: { step: 32 } })).toThrow(/never applied/);
    expect(() => define({ type: "seed", grid: { step: 32 } })).toThrow(/never applied/);
  });

  it("rejects a step that would not raise the value onto a grid", () => {
    expect(() => define({ type: "number", grid: { step: 0 } })).toThrow(/positive integer/);
    expect(() => define({ type: "number", grid: { step: -32 } })).toThrow(/positive integer/);
    expect(() => define({ type: "number", grid: { step: 0.1 } })).toThrow(/positive integer/);
    expect(() => define({ type: "number", grid: { step: Number.POSITIVE_INFINITY } })).toThrow(
      /positive integer/,
    );
  });

  it("rejects an offset that is not a whole floor", () => {
    expect(() => define({ type: "number", grid: { step: 17, offset: -5 } })).toThrow(
      /non-negative integer/,
    );
    expect(() => define({ type: "number", grid: { step: 17, offset: 0.5 } })).toThrow(
      /non-negative integer/,
    );
  });

  it("accepts the shapes the H3 adapters declare", () => {
    expect(() => define({ type: "width", grid: { step: 32 } })).not.toThrow();
    expect(() =>
      define({ type: "frames", clock: 24, default: 120, grid: { step: 17, offset: 5 } }),
    ).not.toThrow();
  });
});

describe("allowedIn", () => {
  const editAdapter = defineComfyAsset({
    workflow: "edit.json",
    description: "works on a take that already exists",
    allowedIn: ["patch", "reference"],
    inputs: {
      image1: { nodeId: "1", field: "image", type: "image", required: true },
    },
    outputs: {
      image: { nodeId: "9", type: "image" },
    },
  });

  it("carries the sites into the adapter's meta", () => {
    expect(editAdapter.meta.allowedIn).toEqual(["patch", "reference"]);
  });

  it("rejects a site it does not name, saying where the asset sits and what it allows", () => {
    let error: unknown;
    try {
      runTimelineInDiscoveryMode("animatic", () => {
        asset("panel", editAdapter, { image1: makeMediaAsset<"image">("plate.png") });
        return {};
      });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as KonteError).code).toBe("ADAPTER_OUT_OF_SCOPE");
    expect((error as Error).message).toMatch(/Asset "panel" in the animatic timeline/);
    expect((error as Error).message).toMatch(/may only be declared in patch or reference/);
  });

  it("declares in a patch", () => {
    const { assets } = runInPatchDiscoveryMode("animatic", "v-1", () => {
      asset("fixed", editAdapter, { image1: makeMediaAsset<"image">("take.png") });
      return {};
    });
    expect(Object.keys(assets)).toEqual(["fixed"]);
  });

  it("declares in the reference stage", () => {
    const reference = defineReference(plainDirection, () => {
      const sheet = asset("sheet", editAdapter, { image1: makeMediaAsset<"image">("raw.png") });
      return { sheet };
    });
    expect(Object.keys(reference.topLevelAssets!)).toEqual(["sheet"]);
  });

  it("classifies a shot build as a shot, not the timeline it is nested in", () => {
    const shotOnly = defineComfyAsset({
      workflow: "shot-only.json",
      description: "shot sites only",
      allowedIn: ["shot"],
      inputs: {
        prompt: { nodeId: "3", field: "text", type: "string" },
      },
      outputs: {
        image: { nodeId: "9", type: "image" },
      },
    });

    const video = defineVideo(plainDirection, {
      timeline: () =>
        videoTimeline([
          shot("01", {
            duration: 5,
            build: () => {
              asset("bg", shotOnly, { prompt: "sky" });
              return el();
            },
          }),
        ]),
    });
    expect(Object.keys(video.shots[0]!.assets)).toEqual(["bg"]);

    expect(() =>
      runTimelineInDiscoveryMode("video", () => {
        asset("bg", shotOnly, { prompt: "sky" });
        return {};
      }),
    ).toThrow(/may only be declared in shot/);
  });

  it("rejects the site before the adapter looks at the inputs", () => {
    let error: unknown;
    try {
      runTimelineInDiscoveryMode("animatic", () => {
        asset("panel", editAdapter, {} as never);
        return {};
      });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as KonteError).code).toBe("ADAPTER_OUT_OF_SCOPE");
  });

  it("carries the sites through defineFalAsset too", () => {
    const falEdit = defineFalAsset({
      endpointId: "fal-ai/test-edit",
      description: "works on a take that already exists",
      mediaType: "image",
      allowedIn: ["patch"],
      inputs: {
        image: { field: "image_url", type: "image", required: true },
      },
    });
    expect(falEdit.meta.allowedIn).toEqual(["patch"]);
    expect(() =>
      runTimelineInDiscoveryMode("animatic", () => {
        asset("panel", falEdit, { image: makeMediaAsset<"image">("a.png") });
        return {};
      }),
    ).toThrow(/may only be declared in patch/);
  });

  it("refuses a delivery upscale, which is declared outside asset()", () => {
    expect(() => upscale(editAdapter, { image1: makeMediaAsset<"image">("take.png") })).toThrow(
      /may only be declared in patch or reference/,
    );
  });

  it("leaves an adapter that names no sites callable everywhere", () => {
    const { assets } = runTimelineInDiscoveryMode("animatic", () => {
      asset("bg", testAdapter, { prompt: "sky" });
      return {};
    });
    expect(Object.keys(assets)).toEqual(["bg"]);
  });
});
