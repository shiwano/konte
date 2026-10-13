import { describe, expect, it } from "vitest";
import {
  assetNameOf,
  type DefinitionLike,
  addressFromCacheSegments,
  addressToCacheSegments,
  assertValidAddressScope,
  deliveryAddressOf,
  formatAddress,
  formatAssetPath,
  formatCompositionAddress,
  formatPatchAssetPath,
  formatAssetPathSuffix,
  formatPlateAssetPath,
  formatShotStemAddress,
  formatTimelineAddress,
  formatTimelineAssetPath,
  formatTimelineStemAddress,
  getAssetEntry,
  getAssetStage,
  getStage,
  isCompositionAddress,
  isDeliveryAddress,
  isMaterializedLeafAddress,
  isPatchAddress,
  isStemAddress,
  listAddresses,
  listAssetPaths,
  listCompositionAddresses,
  listFrameDeliverySources,
  listStemAddresses,
  listReviewableAssetPaths,
  matchesAddressScope,
  parseAddress,
  parseAssetPath,
  patchSourceVariantIdOf,
  parseStageScope,
  parseReelScope,
  sourceAddressOfDelivery,
  validateAddress,
} from "../address.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { defineVideo, asset, defineReference } from "../dsl/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection, plainDirection } from "./helpers/direction.js";
import { imageFile } from "../dsl/adapters/index.js";
import { KonteError } from "../errors.js";
import type { VideoDefinition } from "../types/index.js";

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

const animateComfy = defineComfyAsset({
  workflow: "animate.json",
  description: "test adapter",
  inputs: {
    prompt: { nodeId: "3", field: "text", type: "string" },
    image: { nodeId: "1", field: "image", type: "image" },
  },
  outputs: { result: { nodeId: "9", type: "video" } },
});

const renderComfy = defineComfyAsset({
  workflow: "render.json",
  description: "test adapter",
  inputs: {},
  outputs: { result: { nodeId: "9", type: "video" } },
});

const testVideo: VideoDefinition = defineVideo(
  testDirection({
    fps: 30,
    size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
  }),
  {
    timeline: () => {
      const character = asset("character", imageComfy, { prompt: "girl" });
      return videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            asset("motion", animateComfy, { prompt: "cat", image: character });
            return el();
          },
        }),
        shot("02", {
          duration: 3,
          build: () => {
            asset("bg", renderComfy, {});
            return el();
          },
        }),
      ]);
    },
  },
);

describe("parseAssetPath", () => {
  it("parses a valid video shot asset path", () => {
    expect(parseAssetPath("video:shot.01.motion")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "01",
      assetName: "motion",
    });
  });

  it("parses a valid animatic shot asset path", () => {
    expect(parseAssetPath("animatic:shot.01.first")).toEqual({
      stage: "animatic",
      kind: "shot",
      delivery: false,
      shotId: "01",
      assetName: "first",
    });
  });

  it("parses a valid video timeline asset path", () => {
    expect(parseAssetPath("video:timeline.character")).toEqual({
      stage: "video",
      kind: "timeline",
      delivery: false,
      assetName: "character",
    });
  });

  it("parses a valid animatic timeline asset path", () => {
    expect(parseAssetPath("animatic:timeline.bgm")).toEqual({
      stage: "animatic",
      kind: "timeline",
      delivery: false,
      assetName: "bgm",
    });
  });

  it("parses an asset path with hyphens and underscores", () => {
    expect(parseAssetPath("video:shot.intro-01.background")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "intro-01",
      assetName: "background",
    });
    expect(parseAssetPath("video:shot.intro_01.bg_main")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "intro_01",
      assetName: "bg_main",
    });
  });

  it("throws on invalid asset path format", () => {
    expect(() => parseAssetPath("invalid")).toThrow(KonteError);
    expect(() => parseAssetPath("")).toThrow(KonteError);
  });
});

describe("parseAddress", () => {
  it("parses a valid video shot address", () => {
    expect(parseAddress("video:shot.01.motion")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "01",
      assetName: "motion",
    });
  });

  it("parses a valid animatic shot address", () => {
    expect(parseAddress("animatic:shot.01.first")).toEqual({
      stage: "animatic",
      kind: "shot",
      delivery: false,
      shotId: "01",
      assetName: "first",
    });
  });

  it("parses a valid video timeline address", () => {
    expect(parseAddress("video:timeline.character")).toEqual({
      stage: "video",
      kind: "timeline",
      delivery: false,
      assetName: "character",
    });
  });

  it("parses a valid animatic timeline address", () => {
    expect(parseAddress("animatic:timeline.bgm")).toEqual({
      stage: "animatic",
      kind: "timeline",
      delivery: false,
      assetName: "bgm",
    });
  });

  it("parses an address with hyphens and underscores", () => {
    expect(parseAddress("video:shot.intro-01.background")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "intro-01",
      assetName: "background",
    });
    expect(parseAddress("video:shot.intro_01.bg_main")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "intro_01",
      assetName: "bg_main",
    });
  });

  it("throws on invalid address format", () => {
    expect(() => parseAddress("invalid")).toThrow(KonteError);
    expect(() => parseAddress("invalid")).toThrow("Invalid address format");
  });

  it("throws on empty string", () => {
    expect(() => parseAddress("")).toThrow(KonteError);
  });
});

describe("delivery addresses", () => {
  it("parses a #delivery shot address with the delivery flag", () => {
    expect(parseAddress("video:shot.01.motion#delivery")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: true,
      shotId: "01",
      assetName: "motion",
    });
  });

  it("parses a #delivery timeline address with the delivery flag", () => {
    expect(parseAddress("video:timeline.bg#delivery")).toEqual({
      stage: "video",
      kind: "timeline",
      delivery: true,
      assetName: "bg",
    });
  });

  it("round-trips delivery <-> source", () => {
    const source = "video:shot.01.motion";
    const delivery = deliveryAddressOf(source);
    expect(delivery).toBe("video:shot.01.motion#delivery");
    expect(isDeliveryAddress(delivery)).toBe(true);
    expect(isDeliveryAddress(source)).toBe(false);
    expect(sourceAddressOfDelivery(delivery)).toBe(source);
  });

  it("accepts a #delivery address as a scope", () => {
    expect(() => assertValidAddressScope("video:shot.01.motion#delivery")).not.toThrow();
    expect(() => assertValidAddressScope("video:timeline.bg#delivery")).not.toThrow();
  });

  it("rejects a #delivery suffix on a bare shot scope", () => {
    expect(() => assertValidAddressScope("video:shot.01#delivery")).toThrow(KonteError);
  });
});

describe("patch addresses", () => {
  it("parses a patch step under any stage", () => {
    expect(parseAddress("animatic:patch.v-abc123.patched")).toEqual({
      stage: "animatic",
      kind: "patch",
      delivery: false,
      sourceVariantId: "v-abc123",
      assetName: "patched",
    });
    expect(parseAddress("reference:patch.v-abc123.wide")).toMatchObject({
      stage: "reference",
      kind: "patch",
      sourceVariantId: "v-abc123",
      assetName: "wide",
    });
  });

  it("round-trips through format and the cache segments", () => {
    const address = formatPatchAssetPath("video", "v-abc123", "patched");
    expect(address).toBe("video:patch.v-abc123.patched");
    expect(isPatchAddress(address)).toBe(true);
    expect(patchSourceVariantIdOf(address)).toBe("v-abc123");
    expect(addressFromCacheSegments(addressToCacheSegments(address))).toBe(address);
  });

  it("reports no patch source for an ordinary address", () => {
    expect(isPatchAddress("video:shot.01.motion")).toBe(false);
    expect(patchSourceVariantIdOf("video:shot.01.motion")).toBeNull();
  });

  it("rejects a suffix that is not a well-formed variant id", () => {
    expect(() => parseAddress("video:patch.notavariant.patched")).toThrow(KonteError);
  });

  it("accepts the axis, one chain and one step as scopes", () => {
    expect(() => assertValidAddressScope("video:patch")).not.toThrow();
    expect(() => assertValidAddressScope("video:patch.v-abc123")).not.toThrow();
    expect(() => assertValidAddressScope("video:patch.v-abc123.patched")).not.toThrow();
    expect(() => assertValidAddressScope("reference:patch.v-abc123")).not.toThrow();
    expect(() => assertValidAddressScope("video:patch.")).toThrow(KonteError);
  });

  it("has no stage definition entry — its definition lives in the patch script", () => {
    expect(() => getAssetEntry({ shots: [] }, "animatic:patch.v-abc123.patched")).toThrow(
      KonteError,
    );
  });
});

describe("getStage", () => {
  it("returns stage from video address", () => {
    expect(getStage("video:shot.01.motion")).toBe("video");
  });

  it("returns stage from animatic address", () => {
    expect(getStage("animatic:shot.01.first")).toBe("animatic");
  });

  it("throws on input without stage prefix", () => {
    expect(() => getStage("shot.01.motion")).toThrow(KonteError);
  });
});

describe("getAssetStage", () => {
  it("returns the stage of an asset address", () => {
    expect(getAssetStage("video:shot.01.motion")).toBe("video");
    expect(getAssetStage("reference:bgm")).toBe("reference");
  });

  // The whole point of the narrower reader: `getStage` accepts this and returns "direction", which
  // would then be fed to a formatter that can only produce an address nothing can parse back.
  it("rejects a direction address that getStage accepts", () => {
    expect(getStage("direction:brief.logline")).toBe("direction");
    expect(() => getAssetStage("direction:brief.logline")).toThrow(KonteError);
  });
});

describe("formatAssetPath", () => {
  it("formats a video shot asset path", () => {
    expect(formatAssetPath("video", "01", "motion")).toBe("video:shot.01.motion");
  });

  it("formats an animatic shot asset path", () => {
    expect(formatAssetPath("animatic", "01", "first")).toBe("animatic:shot.01.first");
  });
});

describe("formatTimelineAssetPath", () => {
  it("formats a video timeline asset path", () => {
    expect(formatTimelineAssetPath("video", "character")).toBe("video:timeline.character");
  });

  it("formats an animatic timeline asset path", () => {
    expect(formatTimelineAssetPath("animatic", "ref")).toBe("animatic:timeline.ref");
  });
});

describe("formatAddress", () => {
  it("formats a video shot address", () => {
    expect(formatAddress("video", "01", "motion")).toBe("video:shot.01.motion");
  });

  it("formats an animatic shot address", () => {
    expect(formatAddress("animatic", "01", "first")).toBe("animatic:shot.01.first");
  });
});

describe("formatTimelineAddress", () => {
  it("formats a video timeline address", () => {
    expect(formatTimelineAddress("video", "character")).toBe("video:timeline.character");
  });

  it("formats an animatic timeline address", () => {
    expect(formatTimelineAddress("animatic", "ref")).toBe("animatic:timeline.ref");
  });
});

describe("validateAddress", () => {
  it("does not throw for a valid shot address", () => {
    expect(() => validateAddress("video:shot.01.motion", testVideo)).not.toThrow();
    expect(() => validateAddress("video:shot.02.bg", testVideo)).not.toThrow();
  });

  it("does not throw for a valid timeline address", () => {
    expect(() => validateAddress("video:timeline.character", testVideo)).not.toThrow();
  });

  it("throws when shot is not found", () => {
    expect(() => validateAddress("video:shot.99.motion", testVideo)).toThrow(KonteError);
    expect(() => validateAddress("video:shot.99.motion", testVideo)).toThrow('Shot "99" not found');
  });

  it("throws when asset is not found in shot", () => {
    expect(() => validateAddress("video:shot.01.nonexistent", testVideo)).toThrow(KonteError);
    expect(() => validateAddress("video:shot.01.nonexistent", testVideo)).toThrow(
      'Asset "nonexistent" not found',
    );
  });

  it("throws when timeline asset is not found", () => {
    expect(() => validateAddress("video:timeline.nonexistent", testVideo)).toThrow(KonteError);
    expect(() => validateAddress("video:timeline.nonexistent", testVideo)).toThrow(
      'Timeline asset "nonexistent" not found',
    );
  });

  it("throws on invalid address format", () => {
    expect(() => validateAddress("bad", testVideo)).toThrow(KonteError);
  });
});

describe("listAddresses", () => {
  it("lists all addresses with video stage prefix", () => {
    const addresses = listAddresses(testVideo, "video");
    expect(addresses).toEqual([
      "video:timeline.character",
      "video:shot.01.motion",
      "video:shot.02.bg",
    ]);
  });

  it("lists addresses with animatic stage prefix", () => {
    const addresses = listAddresses(testVideo, "animatic");
    expect(addresses).toEqual([
      "animatic:timeline.character",
      "animatic:shot.01.motion",
      "animatic:shot.02.bg",
    ]);
  });

  it("returns empty array for video with no shots and no timeline", () => {
    const emptyVideo: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [],
    };
    expect(listAddresses(emptyVideo, "video")).toEqual([]);
  });
});

describe("listAssetPaths", () => {
  it("lists all asset paths with video stage prefix", () => {
    const paths = listAssetPaths(testVideo, "video");
    expect(paths).toEqual(["video:timeline.character", "video:shot.01.motion", "video:shot.02.bg"]);
  });

  it("lists asset paths with animatic stage prefix", () => {
    const paths = listAssetPaths(testVideo, "animatic");
    expect(paths).toEqual([
      "animatic:timeline.character",
      "animatic:shot.01.motion",
      "animatic:shot.02.bg",
    ]);
  });
});

describe("listReviewableAssetPaths", () => {
  const reference = defineReference(plainDirection, () => {
    const character = asset("character", imageFile, { path: "assets/files/character.png" });
    return { character };
  });
  const videoWithReference: VideoDefinition = defineVideo(
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
              asset("motion", animateComfy, { prompt: "cat", image: reference.character });
              return el();
            },
          }),
        ]),
    },
  );

  it("includes file assets", () => {
    expect(listAssetPaths(reference, "reference")).toEqual(["reference:character"]);
    expect(listReviewableAssetPaths(reference, "reference")).toEqual(["reference:character"]);
  });

  it("equals listAssetPaths for a video", () => {
    expect(listAssetPaths(videoWithReference, "video")).toEqual(["video:shot.01.motion"]);
    expect(listReviewableAssetPaths(testVideo, "video")).toEqual(
      listAssetPaths(testVideo, "video"),
    );
  });
});

describe("composition addresses", () => {
  it("formats a composition address", () => {
    expect(formatCompositionAddress("video", "01")).toBe("video:shot.01#composition");
  });

  it("identifies composition addresses", () => {
    expect(isCompositionAddress("video:shot.01#composition")).toBe(true);
    expect(isCompositionAddress("video:shot.01.motion")).toBe(false);
    expect(isCompositionAddress("video:timeline.composition")).toBe(false);
    expect(isCompositionAddress("video:shot.01")).toBe(false);
    expect(isCompositionAddress("not-an-address")).toBe(false);
  });

  it("identifies composition asset paths", () => {
    expect(isCompositionAddress("video:shot.01#composition")).toBe(true);
    expect(isCompositionAddress("video:shot.01.motion")).toBe(false);
    expect(isCompositionAddress("video:timeline#composition")).toBe(false);
    // An author's asset named `composition` is a different target, and never the reserved leaf.
    expect(isCompositionAddress("video:shot.01.composition")).toBe(false);
    // The frame-delivery derivative is a generated upscale, not the leaf itself.
    expect(isCompositionAddress("video:shot.01#composition#delivery")).toBe(false);
    // Both composition stages build one per shot, so both have the leaf.
    expect(isCompositionAddress("animatic:shot.01#composition")).toBe(true);
  });

  // The other half: what the name slot says, leaf or not — an audio sign-off either way.
  it("identifies a stem on either stage and either container", () => {
    expect(isStemAddress("video:shot.01#stem")).toBe(true);
    expect(isStemAddress("video:timeline#stem")).toBe(true);
    expect(isStemAddress("animatic:shot.01#stem")).toBe(true);
    expect(isStemAddress("animatic:timeline#stem")).toBe(true);
    expect(isStemAddress("video:shot.01#composition")).toBe(false);
    expect(isStemAddress("video:shot.01#stem#delivery")).toBe(false);
    expect(isStemAddress("reference:stem")).toBe(false);
    expect(isStemAddress("video:shot.01.stem")).toBe(false);
  });

  it("parses a composition address like any shot asset", () => {
    const parsed = parseAddress("video:shot.01#composition");
    expect(parsed).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "01",
      assetName: "#composition",
    });
  });

  it("parses a reserved name apart from an author's name of the same word", () => {
    expect(parseAddress("video:shot.01.composition")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: false,
      shotId: "01",
      assetName: "composition",
    });
    expect(parseAddress("video:timeline#stem")).toEqual({
      stage: "video",
      kind: "timeline",
      delivery: false,
      assetName: "#stem",
    });
    expect(parseAddress("video:timeline.stem")).toEqual({
      stage: "video",
      kind: "timeline",
      delivery: false,
      assetName: "stem",
    });
  });

  // `#delivery` is the derivative axis, so it is never read as a reserved name — stripping it must
  // leave a real address behind, and a bare shot is not one.
  it("stacks the delivery suffix on a reserved name and rejects it on a bare shot", () => {
    expect(parseAddress("video:shot.01#composition#delivery")).toEqual({
      stage: "video",
      kind: "shot",
      delivery: true,
      shotId: "01",
      assetName: "#composition",
    });
    expect(() => parseAddress("video:shot.01#delivery")).toThrow();
  });

  // Only the exact token is the derivative axis — a longer reserved name that starts with it is a
  // name like any other, so the exclusion must not spill onto `#delivery-…` / `#delivery_…`.
  it("excludes only the exact `delivery` token from the reserved-name slot", () => {
    expect(assetNameOf(parseAddress("video:shot.01#delivery-cut"))).toBe("#delivery-cut");
    expect(assetNameOf(parseAddress("video:shot.01#delivery_cut"))).toBe("#delivery_cut");
    expect(assetNameOf(parseAddress("video:shot.01#deliverything"))).toBe("#deliverything");
    expect(parseAddress("video:shot.01#delivery-cut#delivery").delivery).toBe(true);
  });

  it("lists composition addresses only for shots with a shotFn", () => {
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
                asset(
                  "motion",
                  defineComfyAsset({
                    workflow: "w.json",
                    description: "test adapter",
                    inputs: {},
                    outputs: {},
                  }),
                  {},
                );
                return el();
              },
            }),
            shot("02", {
              duration: 5,
              build: () => {
                asset(
                  "bg",
                  defineComfyAsset({
                    workflow: "w.json",
                    description: "test adapter",
                    inputs: {},
                    outputs: {},
                  }),
                  {},
                );
                return el();
              },
            }),
          ]),
      },
    );
    expect(listCompositionAddresses(video)).toEqual([
      "video:shot.01#composition",
      "video:shot.02#composition",
    ]);
  });
});

describe("stem addresses", () => {
  it("formats shot and timeline stem addresses", () => {
    expect(formatShotStemAddress("video", "01")).toBe("video:shot.01#stem");
    expect(formatTimelineStemAddress("video")).toBe("video:timeline#stem");
  });

  it("identifies stem addresses (shot and timeline)", () => {
    expect(isStemAddress("video:shot.01#stem")).toBe(true);
    expect(isStemAddress("video:timeline#stem")).toBe(true);
    expect(isStemAddress("video:shot.01#composition")).toBe(false);
    expect(isStemAddress("video:shot.01.motion")).toBe(false);
    expect(isStemAddress("video:timeline.bgm")).toBe(false);
    expect(isStemAddress("not-an-address")).toBe(false);
  });

  it("identifies stem asset paths", () => {
    expect(isStemAddress("video:shot.01#stem")).toBe(true);
    expect(isStemAddress("video:timeline#stem")).toBe(true);
    expect(isStemAddress("video:shot.01.motion")).toBe(false);
  });

  it("treats compositions and stems as materialized leaves", () => {
    expect(isMaterializedLeafAddress("video:shot.01#composition")).toBe(true);
    expect(isMaterializedLeafAddress("video:shot.01#stem")).toBe(true);
    expect(isMaterializedLeafAddress("video:timeline#stem")).toBe(true);
    expect(isMaterializedLeafAddress("video:shot.01.motion")).toBe(false);
  });

  it("lists shot stems (for shots with audio) plus the timeline stem", () => {
    const video: VideoDefinition = {
      stage: "video" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        { id: "01", duration: 5, action: "x", assets: {}, stemRefs: ["video:shot.01.sfx"] },
        { id: "02", duration: 5, action: "x", assets: {}, stemRefs: [] },
      ],
      timelineSoundtracks: [{ __soundtrackEntry: true, id: "bed", src: { src: "x" }, options: {} }],
    } as unknown as VideoDefinition;
    expect(listStemAddresses(video)).toEqual(["video:shot.01#stem", "video:timeline#stem"]);
  });

  // Leaves only: the board's per-shot mix is a declared asset `listAddresses` already emits, so
  // listing it here would have `prune`/`status` treat a real take as a materialized leaf.
  it("lists the shot stems and the timeline stem for the animatic", () => {
    const animatic = {
      stage: "animatic" as const,
      format: { size: { width: 1920, height: 1080 }, fps: 30 },
      typography: { lang: "en" as const },
      shots: [
        { id: "01", duration: 5, action: "x", assets: {}, stemRefs: ["animatic:shot.01.vo"] },
      ],
      timelineSoundtracks: [{ __soundtrackEntry: true, id: "bed", src: { src: "x" }, options: {} }],
    } as unknown as VideoDefinition;
    expect(listStemAddresses(animatic)).toEqual([
      "animatic:shot.01#stem",
      "animatic:timeline#stem",
    ]);
  });
});

describe("listFrameDeliverySources", () => {
  it("includes shotFn shots and fallback shots with a renderable asset, but not empty ones", () => {
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
                asset(
                  "motion",
                  defineComfyAsset({
                    workflow: "w.json",
                    description: "test adapter",
                    inputs: {},
                    outputs: {},
                  }),
                  {},
                );
                return el();
              },
            }),
          ]),
      },
    );
    // A fallback shot (no shotFn) with a comfy asset is a valid frame source; one with no
    // comfy/file asset is not renderable and is excluded.
    (video.shots as unknown as Array<Record<string, unknown>>).push(
      {
        id: "02",
        duration: 3,
        assets: { bg: { kind: "comfy", workflow: "bg.json", inputs: {} } },
        compositionRefs: [],
      },
      { id: "03", duration: 3, assets: {}, compositionRefs: [] },
    );

    expect(listFrameDeliverySources(video)).toEqual([
      "video:shot.01#composition",
      "video:shot.02#composition",
    ]);
    // The base composition list stays shotFn-only.
    expect(listCompositionAddresses(video)).toEqual(["video:shot.01#composition"]);
  });
});

describe("timeline address-scope", () => {
  it("accepts the bare timeline container, like a bare shot", () => {
    expect(() => assertValidAddressScope("animatic:timeline")).not.toThrow();
    expect(() => assertValidAddressScope("video:timeline")).not.toThrow();
  });

  it("rejects a trailing separator and a bare #delivery", () => {
    expect(() => assertValidAddressScope("animatic:timeline.")).toThrow(KonteError);
    expect(() => assertValidAddressScope("video:timeline#delivery")).toThrow(KonteError);
  });

  it("matches every timeline asset under it, authored and reserved", () => {
    expect(matchesAddressScope("animatic:timeline.bg1", "animatic:timeline")).toBe(true);
    expect(matchesAddressScope("video:timeline#stem", "video:timeline")).toBe(true);
    expect(matchesAddressScope("video:timeline.bg#delivery", "video:timeline")).toBe(true);
    expect(matchesAddressScope("video:shot.01.motion", "video:timeline")).toBe(false);
    expect(matchesAddressScope("animatic:timeline.bg1", "video:timeline")).toBe(false);
  });
});

describe("setup addresses", () => {
  it("parses a plate as its own kind, with the setup id in the name slot", () => {
    expect(parseAddress("animatic:plate.deskWide")).toEqual({
      stage: "animatic",
      kind: "plate",
      assetName: "deskWide",
      delivery: false,
    });
  });

  it("formats and round-trips", () => {
    const address = formatPlateAssetPath("deskWide");
    expect(address).toBe("animatic:plate.deskWide");
    expect(formatAssetPathSuffix(parseAddress(address))).toBe("plate.deskWide");
  });

  // A plate has no second name slot, so neither `#` axis applies to it.
  it("rejects a reserved name and a delivery derivative on a plate", () => {
    expect(() => parseAddress("animatic:plate.deskWide#delivery")).toThrow(KonteError);
    expect(() => parseAddress("animatic:plate#composition")).toThrow(KonteError);
    expect(() => parseAddress("animatic:plate")).toThrow(KonteError);
  });

  // Only the animatic owns plates, so only the animatic spells one.
  it("refuses the setup namespace on any other stage", () => {
    expect(() => parseAddress("video:setup.deskWide")).toThrow(KonteError);
    expect(() => parseAddress("reference:setup.deskWide")).toThrow(KonteError);
    expect(() => assertValidAddressScope("video:setup")).toThrow(KonteError);
  });

  it("takes the bare container as a scope, like a bare timeline", () => {
    expect(() => assertValidAddressScope("animatic:plate")).not.toThrow();
    expect(() => assertValidAddressScope("animatic:plate.deskWide")).not.toThrow();
    expect(() => assertValidAddressScope("animatic:plate.")).toThrow(KonteError);
    expect(matchesAddressScope("animatic:plate.deskWide", "animatic:plate")).toBe(true);
    expect(matchesAddressScope("animatic:timeline.bg", "animatic:plate")).toBe(false);
  });

  it("looks a plate up in plates, not the timeline pool", () => {
    const definition: DefinitionLike = {
      shots: [],
      topLevelAssets: { deskWide: { kind: "file", path: "timeline.png" } },
      plates: { deskWide: { kind: "file", path: "plate.png" } },
    };
    expect(getAssetEntry(definition, "animatic:plate.deskWide")).toEqual({
      kind: "file",
      path: "plate.png",
    });
    expect(listAssetPaths(definition, "animatic")).toContain("animatic:plate.deskWide");
  });
});

describe("plate review", () => {
  // A plate is judged inside the panels drawn on it; no review lists it on its own.
  it("is listed as an asset but never as review work", () => {
    const definition: DefinitionLike = {
      shots: [],
      plates: { front: { kind: "file", path: "front.png" } },
      exposedPlateIds: ["front"],
    };
    expect(listAssetPaths(definition, "animatic")).toContain("animatic:plate.front");
    expect(listReviewableAssetPaths(definition, "animatic")).not.toContain("animatic:plate.front");
  });
});

describe("parseStageScope", () => {
  it("parses a stage scope", () => {
    expect(parseStageScope("video")).toEqual({ stage: "video" });
    expect(parseStageScope("animatic")).toEqual({ stage: "animatic" });
  });

  it("rejects scopes narrower than a stage (shot / asset)", () => {
    expect(() => parseStageScope("video:shot.01")).toThrow(KonteError);
    expect(() => parseStageScope("video:shot.01.motion")).toThrow(KonteError);
  });

  it("rejects trailing separators and unknown stages", () => {
    expect(() => parseStageScope("video:")).toThrow(KonteError);
    expect(() => parseStageScope("audio")).toThrow(KonteError);
    expect(() => parseStageScope("")).toThrow(KonteError);
  });
});

describe("parseReelScope", () => {
  it("parses a stage-only scope on either composition stage", () => {
    expect(parseReelScope("video")).toEqual({ stage: "video" });
    expect(parseReelScope("animatic")).toEqual({ stage: "animatic" });
  });

  it("parses a shot scope", () => {
    expect(parseReelScope("video:shot.02")).toEqual({ stage: "video", shotId: "02" });
    expect(parseReelScope("animatic:shot.02")).toEqual({ stage: "animatic", shotId: "02" });
  });

  it("rejects asset and timeline scopes", () => {
    expect(() => parseReelScope("video:shot.02.motion")).toThrow(KonteError);
    expect(() => parseReelScope("video:timeline.bgm")).toThrow(KonteError);
    expect(() => parseReelScope("reference")).toThrow(KonteError);
  });

  it("rejects trailing separators", () => {
    expect(() => parseReelScope("video:")).toThrow(KonteError);
  });
});

describe("getAssetEntry", () => {
  it("returns asset definition for shot asset path", () => {
    const p = getAssetEntry(testVideo, "video:shot.01.motion");
    expect(p.kind).toBe("comfy");
  });

  it("returns asset definition for timeline asset path", () => {
    const p = getAssetEntry(testVideo, "video:timeline.character");
    expect(p.kind).toBe("comfy");
  });

  it("throws for non-existent shot asset path", () => {
    expect(() => getAssetEntry(testVideo, "video:shot.99.motion")).toThrow(KonteError);
  });

  it("throws for non-existent timeline asset path", () => {
    expect(() => getAssetEntry(testVideo, "video:timeline.nonexistent")).toThrow(KonteError);
  });
});

describe("address cache segments", () => {
  const cases = [
    "video:shot.02#composition",
    "video:shot.01.motion",
    "video:shot.01",
    "video:timeline.bgm",
    "video:shot.01.motion#delivery",
  ];

  it("splits at : into the <stage>/<suffix> layout", () => {
    expect(addressToCacheSegments("video:shot.02#composition")).toEqual([
      "video",
      "shot.02#composition",
    ]);
  });

  it("never emits a path-hostile @ or : in a segment", () => {
    for (const addr of cases) {
      for (const seg of addressToCacheSegments(addr)) {
        expect(seg).not.toMatch(/[@:]/);
      }
    }
  });

  it("round-trips every address form", () => {
    for (const addr of cases) {
      expect(addressFromCacheSegments(addressToCacheSegments(addr))).toBe(addr);
    }
  });
});
