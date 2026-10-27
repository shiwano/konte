import { describe, expect, it } from "vitest";
import {
  assertValidAddressScope,
  formatViewAddress,
  listReviewableAssetPaths,
  parseAddress,
} from "../address.js";
import { parseViewName } from "../view.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { asset, defineReference } from "../dsl/index.js";
import { type Direction, defineDirection } from "../dsl/direction.js";
import { checkViewAnchors } from "../direction-check.js";
import { buildDependencyGraph, listViewAnchorGaps } from "../graph.js";
import { collectFindings } from "../checks.js";
import { spendHold } from "../finding.js";
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

describe("reference.view", () => {
  it("holds the image of each view a location's setups face other than front", () => {
    expect(reference.view).toEqual({
      studio: { top: { src: "__konte:reference:view.studio.top__" } },
    });
  });

  it("is reachable before views returns the image", () => {
    const bare = defineReference(direction, {
      references: () => ({ studio: asset("studio", imageGen, { prompt: "the studio" }) }),
    });
    expect(bare.view.studio?.top).toEqual({ src: "__konte:reference:view.studio.top__" });
  });
});

describe("view-unanchored", () => {
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
  const findings = (ref: ReturnType<typeof drawn>) =>
    checkViewAnchors(listViewAnchorGaps(ref), new Set(ref.exposedAssetNames ?? [])).map(
      (f) => `${f.code}_${f.subject}`,
    );

  it("flags a view drawn from nothing of its place", () => {
    expect(findings(drawn())).toEqual(["view-unanchored_studio.top"]);
  });

  it("passes a view made from the master", () => {
    expect(findings(drawn(true))).toEqual([]);
  });

  it("holds the reference spend before the direction is accepted or a board exists", async () => {
    const { findings: found } = await collectFindings({
      videoRoot: "",
      direction: direction as unknown as Direction,
      directionAccepted: false,
      reference: drawn(),
      animatic: null,
      video: null,
      manager: null,
      graph: null,
      patches: [],
      lang: null,
    });
    const view = found.filter((f) => f.code === "view-unanchored");
    expect(view.map((f) => f.key)).toEqual(["view-unanchored_studio.top"]);
    expect(spendHold(view[0]!, { command: "generate", stage: "reference" })).toBe("whole");
  });
});
