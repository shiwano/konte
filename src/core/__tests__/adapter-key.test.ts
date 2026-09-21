import { describe, expect, it } from "vitest";
import { adapterKeyFor } from "../adapter-key.js";
import type { AssetDefinition } from "../types/index.js";

describe("adapterKeyFor", () => {
  it("uses endpointId for fal", () => {
    const def: AssetDefinition = {
      kind: "fal",
      endpointId: "fal-ai/kling-video/v3/pro/text-to-video",
      mediaType: "video",
      inputs: {},
    };
    expect(adapterKeyFor(def)).toBe("fal-ai/kling-video/v3/pro/text-to-video");
  });

  it("uses operation for local", () => {
    const def: AssetDefinition = {
      kind: "local",
      operation: "resize",
      mediaType: "image",
      inputs: {},
    };
    expect(adapterKeyFor(def)).toBe("resize");
  });

  it("uses workflow for comfy", () => {
    const def: AssetDefinition = {
      kind: "comfy",
      workflow: "upscale.json",
      inputs: {},
    };
    expect(adapterKeyFor(def)).toBe("upscale.json");
  });

  it("returns an empty key for file assets", () => {
    const def: AssetDefinition = { kind: "file", path: "media/clip.mp4" };
    expect(adapterKeyFor(def)).toBe("");
  });
});
