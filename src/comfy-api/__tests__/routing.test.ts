import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace, type Workspace } from "../../core/__tests__/helpers/workspace.js";
import type { ComfyAssetDefinition, KonteConfig } from "../../core/types/index.js";
import type { ComfyCloudCatalog } from "../cloud-catalog.js";
import { assertComfyAdapterKeys, comfyCandidates, ComfyRouter } from "../routing.js";

const WORKFLOW = {
  "3": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
  "5": { class_type: "ControlNetApply", inputs: { conditioning: ["3", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
};

const MODEL = {
  filename: "flux.safetensors",
  type: "diffusion_model" as const,
  url: "https://example.com/flux.safetensors",
};

const DEPLOYMENTS = { main: { comfyVersion: "v0.39.0" } };

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace();
  await fs.mkdir(path.join(ws.root, "adapters", "comfy"), { recursive: true });
  await fs.writeFile(
    path.join(ws.root, "adapters", "comfy", "image.json"),
    JSON.stringify(WORKFLOW),
  );
  vi.stubEnv("COMFY_API_KEY", "key");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ws.cleanup();
});

function def(overrides: Partial<ComfyAssetDefinition> = {}): ComfyAssetDefinition {
  return { kind: "comfy", workflow: "image.json", inputs: {}, models: [MODEL], ...overrides };
}

function fakeCatalog(classes: string[], models: string[]): ComfyCloudCatalog {
  return {
    nodeClasses: async () => new Set(classes),
    hasModel: async (relative: string) => models.includes(relative),
  } as unknown as ComfyCloudCatalog;
}

const fullCatalog = () =>
  fakeCatalog(
    ["CLIPTextEncode", "ControlNetApply", "SaveImage"],
    ["diffusion_models/flux.safetensors"],
  );

describe("comfyCandidates", () => {
  it("tries comfyui then comfycloud when comfy.adapters is absent", () => {
    expect(comfyCandidates("image", {})).toEqual(["comfyui", "comfycloud"]);
  });

  it("takes `*` as the default and an adapter's own key in its place, whole", () => {
    const config: KonteConfig = {
      comfy: {
        adapters: { "*": ["comfycloud", "comfyui"], image: ["comfyapi:main"] },
        comfyapi: { deployments: DEPLOYMENTS },
      },
    };
    expect(comfyCandidates("image", config)).toEqual(["comfyapi:main"]);
    expect(comfyCandidates("video", config)).toEqual(["comfycloud", "comfyui"]);
  });
});

describe("assertComfyAdapterKeys", () => {
  it("refuses a key no workflow under adapters/comfy/ is called", () => {
    const config: KonteConfig = { comfy: { adapters: { "*": ["comfyui"], missing: ["comfyui"] } } };
    expect(() => assertComfyAdapterKeys(ws.root, config)).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining('"missing"'),
      }),
    );
    expect(() => new ComfyRouter(ws.root, config)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("takes a key naming a workflow", () => {
    expect(() =>
      assertComfyAdapterKeys(ws.root, { comfy: { adapters: { image: ["comfyui"] } } }),
    ).not.toThrow();
  });
});

describe("ComfyRouter", () => {
  it("routes to comfyui when its url is set", async () => {
    const router = new ComfyRouter(ws.root, {
      comfy: { comfyui: { url: "http://127.0.0.1:8188" } },
    });
    expect(await router.route(def())).toEqual({ kind: "routed", target: "comfyui" });
  });

  it("falls to comfycloud when comfyui has no url and Cloud has everything", async () => {
    const router = new ComfyRouter(ws.root, {}, { catalog: fullCatalog() });
    expect(await router.route(def())).toEqual({ kind: "routed", target: "comfycloud" });
  });

  it("finds comfycloud unusable without COMFY_API_KEY", async () => {
    vi.stubEnv("COMFY_API_KEY", "");
    const router = new ComfyRouter(ws.root, {}, { catalog: fullCatalog() });
    expect(await router.route(def())).toEqual({
      kind: "unroutable",
      reasons: ["comfyui: comfy.comfyui.url is not set", "comfycloud: COMFY_API_KEY is not set"],
    });
  });

  it("names the node classes and models Cloud lacks", async () => {
    const router = new ComfyRouter(ws.root, {}, { catalog: fakeCatalog(["CLIPTextEncode"], []) });
    const route = await router.route(def());
    expect(route).toEqual({
      kind: "unroutable",
      reasons: [
        "comfyui: comfy.comfyui.url is not set",
        "comfycloud: no node ControlNetApply, SaveImage; no model flux.safetensors",
      ],
    });
  });

  it("falls past a comfycloud gap to the next candidate", async () => {
    const config: KonteConfig = {
      comfy: { adapters: { "*": ["comfycloud", "comfyui"] }, comfyui: { url: "http://h:8188" } },
    };
    const router = new ComfyRouter(ws.root, config, { catalog: fakeCatalog([], []) });
    expect(await router.route(def())).toEqual({ kind: "routed", target: "comfyui" });
  });

  it("checks only the node classes the pruned graph keeps", async () => {
    const catalog = fakeCatalog(
      ["CLIPTextEncode", "SaveImage"],
      ["diffusion_models/flux.safetensors"],
    );
    const router = new ComfyRouter(ws.root, {}, { catalog });
    expect(await router.route(def({ prunedNodes: ["5"] }))).toEqual({
      kind: "routed",
      target: "comfycloud",
    });
    expect((await router.route(def())).kind).toBe("unroutable");
  });

  describe("onto a deployment", () => {
    const config: KonteConfig = {
      comfy: { adapters: { "*": ["comfyapi:main"] }, comfyapi: { deployments: DEPLOYMENTS } },
    };

    it("routes there", async () => {
      const router = new ComfyRouter(ws.root, config);
      expect(await router.route(def())).toEqual({ kind: "routed", target: "comfyapi:main" });
    });

    it("routes a whole adapter there", async () => {
      const router = new ComfyRouter(ws.root, config);
      expect(await router.routeAdapter("image.json", [MODEL])).toEqual({
        kind: "routed",
        target: "comfyapi:main",
      });
    });

    it("is unusable without COMFY_API_KEY", async () => {
      vi.stubEnv("COMFY_API_KEY", "");
      const router = new ComfyRouter(ws.root, config);
      expect(await router.route(def())).toEqual({
        kind: "unroutable",
        reasons: ["comfyapi:main: COMFY_API_KEY is not set"],
      });
    });
  });
});
