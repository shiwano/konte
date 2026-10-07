import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSpendAllowed,
  configuredVendorBackends,
  unconfiguredBackendAssets,
} from "../backend-policy.js";
import { registerDaemon, unregisterDaemonSync } from "../daemon-registry.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { adapters, defineVideo, asset } from "../dsl/index.js";
import { imageFile } from "../dsl/adapters/index.js";
import { Composition } from "../dsl/composition/composition.js";
import { shot, videoTimeline } from "./helpers/shot.js";
import { testDirection } from "./helpers/direction.js";
import type { ComfyAssetDefinition, KonteConfig, VideoDefinition } from "../types/index.js";
import { makeWorkspace, type Workspace } from "./helpers/workspace.js";

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

const withComfy: KonteConfig = { comfy: { comfyui: { url: "http://127.0.0.1:8188" } } };
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
    vi.stubEnv("COMFY_API_KEY", "");
    vi.stubEnv("FAL_KEY", "");
    expect(configuredVendorBackends(withComfy)).toEqual(["comfy"]);

    vi.stubEnv("FAL_KEY", "key");
    expect(configuredVendorBackends(withoutComfy)).toEqual(["fal"]);
    expect(configuredVendorBackends(withComfy)).toEqual(["comfy", "fal"]);

    vi.unstubAllEnvs();
  });
});

describe("assertSpendAllowed", () => {
  let ws: Workspace;

  beforeEach(async () => {
    ws = await makeWorkspace();
    await fs.mkdir(path.join(ws.root, "adapters", "comfy"), { recursive: true });
    await fs.writeFile(path.join(ws.root, "adapters", "comfy", "image.json"), "{}");
    vi.stubEnv("COMFY_API_KEY", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    unregisterDaemonSync(ws.root);
    await ws.cleanup();
  });

  const comfyDef = (url = "https://example.com/flux.safetensors"): ComfyAssetDefinition => ({
    kind: "comfy",
    workflow: "image.json",
    inputs: {},
    models: [{ filename: "flux.safetensors", type: "diffusion_model", url }],
  });
  const onDeployment: KonteConfig = {
    comfy: {
      adapters: { "*": ["comfyapi:main"] },
      comfyapi: { deployments: { main: { gpuClass: "L40S", region: "us-east" } } },
    },
  };

  it("routes a comfy asset to comfyui when its url is set", async () => {
    const def = comfyDef();
    const routes = await assertSpendAllowed([{ label: "a", def }], withComfy, ws.root);
    expect(routes.targetOf(def)).toBe("comfyui");
    expect(routes.targetOf({ kind: "file", path: "x.png" })).toBeNull();
    expect(routes.routed).toEqual([{ label: "a", target: "comfyui" }]);
    expect(routes.deployments()).toEqual([]);
  });

  it("refuses a comfy asset no target can run, naming why for each", async () => {
    const err = await assertSpendAllowed([{ label: "a", def: comfyDef() }], {}, ws.root).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: "BACKEND_NOT_CONFIGURED",
      items: [
        "  a (comfy) — comfyui: comfy.comfyui.url is not set; comfycloud: COMFY_API_KEY is not set",
      ],
    });
  });

  it("refuses a deployment no daemon is there to close", async () => {
    vi.stubEnv("COMFY_API_KEY", "key");
    await expect(
      assertSpendAllowed([{ label: "a", def: comfyDef() }], onDeployment, ws.root),
    ).rejects.toMatchObject({ code: "COMFY_API_DAEMON_REQUIRED", items: ["  a → comfyapi:main"] });
  });

  it("routes to a deployment while a daemon is alive", async () => {
    vi.stubEnv("COMFY_API_KEY", "key");
    await registerDaemon(ws.root);
    const def = comfyDef();
    const routes = await assertSpendAllowed([{ label: "a", def }], onDeployment, ws.root);
    expect(routes.targetOf(def)).toBe("comfyapi:main");
    expect(routes.deployments()).toEqual(["main"]);
  });

  it("refuses a deployment a model URL with a credential would land on", async () => {
    vi.stubEnv("COMFY_API_KEY", "key");
    await registerDaemon(ws.root);
    await expect(
      assertSpendAllowed(
        [{ label: "a", def: comfyDef("https://hf.co/flux?token=${HF_TOKEN}") }],
        onDeployment,
        ws.root,
      ),
    ).rejects.toMatchObject({ code: "COMFY_API_AUTHENTICATED_MODEL" });
  });
});
