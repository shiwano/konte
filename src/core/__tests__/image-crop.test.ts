import { describe, expect, it } from "vitest";
import { imageCrop } from "../dsl/adapters/index.js";
import type { MediaAsset } from "../dsl/builders.js";
import { runInPlateDiscoveryMode } from "../dsl/shot-context.js";
import { extractRefs } from "../graph.js";
import type { LocalAssetDefinition } from "../types/index.js";

const master = (src: string): MediaAsset<"image"> => ({ src });

const CANVAS = { size: { width: 1920, height: 1080 } };

const WINDOW = {
  image: master("__konte:reference:office__"),
  x: 512,
  y: 256,
  width: 2048,
  height: 1152,
};

// createDefinition reads the working canvas off the active discovery context, so drive it through
// the one a plate is declared in.
function define(
  inputs: Parameters<typeof imageCrop.createDefinition>[0],
  format = CANVAS,
): LocalAssetDefinition {
  const { result } = runInPlateDiscoveryMode(() => imageCrop.createDefinition(inputs), format);
  return result as LocalAssetDefinition;
}

describe("imageCrop", () => {
  it("builds a deterministic local 'crop' definition", () => {
    const def = define(WINDOW);

    expect(def).toMatchObject({
      kind: "local",
      operation: "crop",
      mediaType: "image",
      deterministic: true,
    });
    expect(imageCrop.type).toBe("image");
  });

  it("scales to the working canvas when given no out size", () => {
    expect(define(WINDOW).inputs).toMatchObject({
      x: 512,
      y: 256,
      width: 2048,
      height: 1152,
      outWidth: 1920,
      outHeight: 1080,
    });
  });

  it("lets an explicit out size override the canvas", () => {
    const def = define({ ...WINDOW, outWidth: 1024, outHeight: 576 });

    expect(def.inputs).toMatchObject({ outWidth: 1024, outHeight: 576 });
  });

  it("demands an out size where there is no canvas to take one from", () => {
    expect(() => imageCrop.createDefinition(WINDOW)).toThrow(/needs an outWidth and outHeight/);
  });

  it("makes the master a dependency edge", () => {
    expect(extractRefs(define(WINDOW))).toEqual(["reference:office"]);
  });

  it.each([
    ["x", { ...WINDOW, x: -1 }],
    ["y", { ...WINDOW, y: 1.5 }],
    ["width", { ...WINDOW, width: 0 }],
    ["height", { ...WINDOW, height: -8 }],
    ["outWidth", { ...WINDOW, outWidth: 0, outHeight: 576 }],
  ])("rejects a %s that is not a whole number of pixels", (name, inputs) => {
    expect(() => define(inputs)).toThrow(new RegExp(`^${name} must be an integer`));
  });
});
