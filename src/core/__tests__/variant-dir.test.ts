import { describe, expect, it } from "vitest";
import { assetDir, variantOwningFile, variantsHostedBy } from "../variant-dir.js";

// A patched take points at the file the chain's returned step produced, rather than holding a copy:
// one file, two variants naming it, and only one of them owning the directory it sits in.
const STEP_FILE = "assets/reference/patch/v-src/patched/v-step/output.png";

describe("assetDir", () => {
  it("nests a patch step under its chain", () => {
    expect(assetDir("/w", "reference:patch.v-src.patched")).toBe(
      "/w/assets/reference/patch/v-src/patched",
    );
  });

  it("keeps every other address flat", () => {
    expect(assetDir("/w", "video:shot.01.motion")).toBe("/w/assets/video/shot.01.motion");
    expect(assetDir("/w", "video:shot.01.motion#delivery")).toBe(
      "/w/assets/video/shot.01.motion#delivery",
    );
  });
});

const state = {
  assets: {
    "reference:latentA": {
      variants: {
        "v-src": { file: "assets/reference/latentA/v-src/output.png" },
        "v-patched": { file: STEP_FILE },
      },
    },
    "reference:patch.v-src.patched": {
      variants: { "v-step": { file: STEP_FILE } },
    },
    "reference:character": {
      // A `file` asset mirrors a file that is inside no variant directory at all.
      variants: { "v-file": { file: "assets/files/character.png" } },
    },
  },
};

describe("variantsHostedBy", () => {
  it("reports the variants that would lose their file with this one", () => {
    expect(variantsHostedBy(state, "reference:patch.v-src.patched", "v-step")).toEqual([
      { address: "reference:latentA", variantId: "v-patched" },
    ]);
  });

  it("reports nothing for the variant merely pointing at it", () => {
    expect(variantsHostedBy(state, "reference:latentA", "v-patched")).toEqual([]);
  });

  it("reports nothing for an ordinary take", () => {
    expect(variantsHostedBy(state, "reference:latentA", "v-src")).toEqual([]);
  });
});

describe("variantOwningFile", () => {
  it("finds the variant whose directory holds the file, not the one pointing at it", () => {
    expect(variantOwningFile(state, STEP_FILE)).toEqual({
      address: "reference:patch.v-src.patched",
      variantId: "v-step",
    });
  });

  it("returns null for a file outside every variant directory", () => {
    expect(variantOwningFile(state, "assets/files/character.png")).toBeNull();
  });
});
