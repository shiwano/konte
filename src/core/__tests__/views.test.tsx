import { describe, expect, it } from "vitest";
import {
  assertValidAddressScope,
  formatViewAddress,
  listReviewableAssetPaths,
  parseAddress,
} from "../address.js";
import { parseViewName } from "../view.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineAnimatic, defineReference } from "../dsl/index.js";
import { defineDirection } from "../dsl/direction.js";
import { assertViewsAnchored } from "../direction.js";
import { buildDependencyGraph, listViewAnchorGaps } from "../graph.js";
import { animaticTimeline } from "./helpers/shot.js";
import { directionDefaults } from "./helpers/direction.js";

const imageGen = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "prompt", type: "prompt" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const imageEdit = defineComfyAsset({
  workflow: "edit.json",
  description: "test adapter",
  inputs: {
    image1: { nodeId: "1", field: "image", type: "image" },
    image2: { nodeId: "2", field: "image", type: "image" },
    prompt: { nodeId: "3", field: "prompt", type: "prompt" },
  },
  outputs: { result: { nodeId: "9", type: "image" } },
});

const noViews = defineComfyAsset({
  workflow: "sheet.json",
  description: "test adapter",
  allowedIn: ["reference", "shot"],
  inputs: { image1: { nodeId: "1", field: "image", type: "image" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

// The studio is boarded from the front and straight down on the desk.
const direction = defineDirection({
  ...directionDefaults,
  setups: {
    ...directionDefaults.setups,
    deskTop: {
      name: "the desk from above",
      description: "straight down on the desk",
      location: "studio",
      framing: "insert",
      view: "top",
      holds: [],
    },
  },
  sequence: { lens: "mini-drama", pleasure: "cute", shots: [] },
});

const reference = defineReference(direction, {
  references: () => {
    const studio = asset("studio", imageGen, { prompt: "the studio" });
    return { studio };
  },
  views: ({ reference }) => {
    const studioTop = asset("studioTop", imageEdit, {
      image1: reference.studio,
      prompt: "the studio from straight above the desk",
    });
    return { studio: { top: studioTop } };
  },
});

describe("view addresses", () => {
  it("parses as a reference address filed by location and view", () => {
    expect(parseAddress("reference:view.studio.top")).toEqual({
      stage: "reference",
      kind: "reference",
      assetName: "view.studio.top",
      delivery: false,
    });
    expect(parseViewName("reference:view.studio.top")).toEqual({
      location: "studio",
      view: "top",
    });
    expect(formatViewAddress("studio", "back")).toBe("reference:view.studio.back");
  });

  it("has no front, which is the master", () => {
    expect(() => parseAddress("reference:view.studio.front")).toThrow(/Invalid reference/);
  });

  it("scopes a location's views and one of them", () => {
    expect(() => assertValidAddressScope("reference:view.studio")).not.toThrow();
    expect(() => assertValidAddressScope("reference:view.studio.top")).not.toThrow();
  });
});

describe("defineReference views", () => {
  it("files a view image under its location and view, whatever its asset is named", () => {
    expect(Object.keys(reference.topLevelAssets!)).toEqual(["studio", "view.studio.top"]);
    expect(reference.exposedAssetNames).toEqual(["studio", "view.studio.top"]);
    expect(listReviewableAssetPaths(reference, "reference")).toContain("reference:view.studio.top");
  });

  it("files the view's prompt under its address", () => {
    expect(reference.prompts?.map((p) => p.address)).toEqual([
      "reference:studio",
      "reference:view.studio.top",
    ]);
  });

  it("wires a view built from another view to its filed address", () => {
    const chained = defineReference(direction, {
      references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
      views: ({ reference }) => {
        const top = asset("top", imageEdit, { image1: reference.studio, prompt: "from above" });
        const back = asset("back", imageEdit, {
          image1: reference.studio,
          image2: top,
          prompt: "from behind",
        });
        return { studio: { top, back } } as never;
      },
    });
    const graph = buildDependencyGraph(null, null, chained);
    expect(graph.dependencies.get("reference:view.studio.back")).toEqual(
      expect.arrayContaining(["reference:studio", "reference:view.studio.top"]),
    );
  });

  it("refuses front, which is the location's master", () => {
    expect(() =>
      defineReference(direction, {
        references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
        views: () => ({ studio: { front: asset("front", imageGen, { prompt: "x" }) } }) as never,
      }),
    ).toThrow(/front view is reference\.studio itself/);
  });

  it("refuses a key naming no location", () => {
    expect(() =>
      defineReference(direction, {
        references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
        views: () => ({ nowhere: { top: asset("top", imageGen, { prompt: "x" }) } }) as never,
      }),
    ).toThrow(/not a location direction.ts declares/);
  });

  it("refuses a handle declared outside views", () => {
    expect(() =>
      defineReference(direction, {
        references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
        views: ({ reference }) => ({ studio: { top: reference.studio } }),
      }),
    ).toThrow(/declared in `views`/);
  });

  it("files no view left undefined", () => {
    const none = defineReference(direction, {
      references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
      views: () => ({ studio: { top: undefined } }),
    });
    expect(Object.keys(none.topLevelAssets!)).toEqual(["studio"]);
  });

  it("reserves the name heading the view images", () => {
    expect(() =>
      defineReference(direction, {
        references: () => ({ view: asset("view", imageGen, { prompt: "x" }) }),
      }),
    ).toThrow(/"view" is reserved/);
  });

  it("is its own declaration site", () => {
    expect(() =>
      defineReference(direction, {
        references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
        views: ({ reference }) => ({
          studio: { top: asset("top", noViews, { image1: reference.studio }) },
        }),
      }),
    ).toThrow(/may only be declared in reference or shot/);
  });
});

describe("defineAnimatic views", () => {
  it("hands plates and timeline each location's front and the views its setups face", () => {
    let fromPlates: unknown;
    let fromTimeline: unknown;
    defineAnimatic(direction, {
      plates: ({ views }) => {
        fromPlates = views;
        return {};
      },
      timeline: ({ views }) => {
        fromTimeline = views;
        return animaticTimeline([]);
      },
    });
    const expected = {
      studio: {
        front: { src: "__konte:reference:studio__" },
        top: { src: "__konte:reference:view.studio.top__" },
      },
    };
    expect(fromPlates).toEqual(expected);
    expect(fromTimeline).toEqual(expected);
  });
});

describe("assertViewsAnchored", () => {
  const drawn = (image1?: unknown) =>
    defineReference(direction, {
      references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
      views: ({ reference }) => ({
        studio: {
          top: image1
            ? asset("top", imageEdit, { image1: reference.studio, prompt: "from above" })
            : asset("top", imageGen, { prompt: "a studio from above" }),
        },
      }),
    });
  const gate = (ref: ReturnType<typeof drawn>, waivers: Record<string, string> = {}) =>
    assertViewsAnchored(
      { ...direction, waivers } as never,
      listViewAnchorGaps(ref),
      ref.exposedAssetNames ?? [],
    );

  it("refuses a reference spend on a view drawn from nothing of its place", () => {
    expect(() => gate(drawn())).toThrow(/view-unanchored_studio\.top/);
  });

  it("passes a view made from the master, and a waived one", () => {
    expect(() => gate(drawn(true))).not.toThrow();
    expect(() => gate(drawn(), { "view-unanchored_studio.top": "drawn by hand" })).not.toThrow();
  });
});
