import { describe, expect, it } from "vitest";
import { imageOrbit } from "../dsl/adapters/index.js";
import type { MediaAsset } from "../dsl/builders.js";
import { runInPlateDiscoveryMode } from "../dsl/shot-context.js";
import type { LocalAssetDefinition } from "../types/index.js";

const master: MediaAsset<"image"> = { src: "__konte:reference:office__" };

function define(inputs: Parameters<typeof imageOrbit.createDefinition>[0]): LocalAssetDefinition {
  const { result } = runInPlateDiscoveryMode(() => imageOrbit.createDefinition(inputs), {
    size: { width: 2496, height: 1248 },
  });
  return result as LocalAssetDefinition;
}

describe("imageOrbit", () => {
  it("draws the master from the pose at the canvas's aspect, about a megapixel", () => {
    expect(define({ master, yaw: -90 })).toEqual({
      kind: "local",
      operation: "orbit",
      mediaType: "image",
      deterministic: true,
      inputs: {
        master: master.src,
        pose: { yaw: -90, pitch: 0, distance: 1, fovY: 45 },
        width: 1424,
        height: 712,
      },
    });
  });

  it("lets an explicit size override the canvas", () => {
    expect(define({ master, yaw: 0, pitch: 90, width: 800, height: 600 }).inputs).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it("refuses a size that is not a whole number of pixels", () => {
    expect(() => define({ master, yaw: 0, width: 800.5, height: 600 })).toThrow(
      /width must be an integer > 0/,
    );
    expect(() => define({ master, yaw: 0, width: 800, height: 0 })).toThrow(
      /height must be an integer > 0/,
    );
  });

  it("refuses a pitch past straight up or down", () => {
    expect(() => define({ master, yaw: 0, pitch: 120 })).toThrow(/pitch must be a number from/);
  });

  it("demands a size where there is no canvas to take one from", () => {
    expect(() => imageOrbit.createDefinition({ master, yaw: -90 })).toThrow(
      /needs a width and height/,
    );
  });
});
