import { describe, expect, it, vi } from "vitest";
import { configuredVendorBackends, unconfiguredBackendAssets } from "../backend-policy.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { adapters, defineVideo, asset } from "../dsl/index.js";
import { imageFile } from "../dsl/adapters/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";
import type { KonteConfig, VideoDefinition } from "../types/index.js";

function el(): React.ReactElement {
  return { type: Composition, props: { children: [] } } as unknown as React.ReactElement;
}

const imageComfy = defineComfyAsset({
  workflow: "image.json",
  description: "test adapter",
  inputs: { prompt: { nodeId: "3", field: "text", type: "string" } },
  outputs: { result: { nodeId: "9", type: "image" } },
});

// A comfy shot asset plus the two timeline assets the policy exempts: a `file` (no backend) and a
// `local` (konte's own ffmpeg plumbing).
const video: VideoDefinition = defineVideo(
  testDirection({
    fps: 30,
    size: { megapixels: 0.589824, delivery: { width: 1024, height: 576 } },
  }),
  {
    timeline: () => {
      asset("bg", imageFile, { path: "assets/files/bg.png" });
      asset("canvas", adapters.jsxImage, { width: 1920, height: 1080 });
      return videoTimeline([
        shot("01", {
          duration: 5,
          build: () => {
            asset("motion", imageComfy, { prompt: "cat" });
            return el();
          },
        }),
      ]);
    },
  },
);

const withComfy: KonteConfig = { comfyui: { url: "http://127.0.0.1:8188" } };
const withoutComfy: KonteConfig = {};

describe("unconfiguredBackendAssets", () => {
  it("reports an asset whose vendor this workspace has not configured", () => {
    expect(unconfiguredBackendAssets(video, "video", withoutComfy)).toEqual([
      { address: "video:shot.01.motion", kind: "comfy" },
    ]);
  });

  it("reports nothing once that vendor is configured", () => {
    expect(unconfiguredBackendAssets(video, "video", withComfy)).toEqual([]);
  });

  it("never reports `file` or `local` assets — no vendor policy speaks about them", () => {
    // Nothing is configured; only the comfy asset is flagged.
    expect(unconfiguredBackendAssets(video, "video", withoutComfy)).toEqual([
      { address: "video:shot.01.motion", kind: "comfy" },
    ]);
  });
});

describe("configuredVendorBackends", () => {
  it("reads comfy from its server URL and fal from its credential", () => {
    vi.stubEnv("FAL_KEY", "");
    expect(configuredVendorBackends(withComfy)).toEqual(["comfy"]);

    vi.stubEnv("FAL_KEY", "key");
    expect(configuredVendorBackends(withoutComfy)).toEqual(["fal"]);
    expect(configuredVendorBackends(withComfy)).toEqual(["comfy", "fal"]);

    vi.unstubAllEnvs();
  });
});
