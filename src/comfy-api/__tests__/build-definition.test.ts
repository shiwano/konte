import { describe, expect, it, vi } from "vitest";
import type { ComfyModelDeclaration } from "../../core/types/index.js";
import {
  buildInputs,
  type ComfyAdapterDeclarations,
  hashOf,
  resolveBuildDefinition,
} from "../build-definition.js";

function adapter(
  workflow: string,
  models: ComfyModelDeclaration[],
  nodes: string[] = [],
): ComfyAdapterDeclarations {
  return { workflow, models, nodes: nodes.map((id) => ({ id })) };
}

const flux: ComfyModelDeclaration = {
  filename: "flux.safetensors",
  type: "diffusion_model",
  url: "https://example.com/flux.safetensors",
};
const vae: ComfyModelDeclaration = {
  filename: "ae.safetensors",
  type: "VAE",
  url: "https://example.com/ae.safetensors",
};

describe("buildInputs", () => {
  it("holds each model and node pack once, sorted", () => {
    const inputs = buildInputs(
      [
        adapter("b.json", [flux, vae], ["comfyui-kjnodes", "comfyui-easy-use"]),
        adapter("a.json", [vae], ["comfyui-kjnodes"]),
      ],
      null,
    );
    expect(inputs).toEqual({
      models: [
        { type: "diffusion_models", filename: "flux.safetensors", sourceUri: flux.url },
        { type: "vae", filename: "ae.safetensors", sourceUri: vae.url },
      ],
      nodeIds: ["comfyui-easy-use", "comfyui-kjnodes"],
      comfyVersion: null,
    });
  });

  it("files a model under its savePath, and its type's folder without one", () => {
    const seedvr = {
      filename: "seedvr2.safetensors",
      type: "upscale" as const,
      url: "https://example.com/seedvr2.safetensors",
      savePath: "SEEDVR2",
    };
    const nested = { ...vae, filename: "x.safetensors", savePath: "vae/sub" };
    const inputs = buildInputs(
      [adapter("a.json", [seedvr, nested, { ...flux, type: "unet" }])],
      "v0.3.0",
    );
    expect(inputs.models).toEqual([
      { type: "diffusion_models", filename: "flux.safetensors", sourceUri: flux.url },
      { type: "SEEDVR2", filename: "seedvr2.safetensors", sourceUri: seedvr.url },
      { type: "vae", filename: "sub/x.safetensors", sourceUri: vae.url },
    ]);
    expect(inputs.comfyVersion).toBe("v0.3.0");
  });

  it("refuses one model file from two URLs", () => {
    expect(() =>
      buildInputs(
        [adapter("a.json", [flux]), adapter("b.json", [{ ...flux, url: "https://mirror/flux" }])],
        null,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("a.json and b.json both declare"),
      }),
    );
  });

  it("refuses a model URL carrying a credential", () => {
    const gated = { ...flux, url: "https://huggingface.co/x?token=${HF_TOKEN}" };
    expect(() => buildInputs([adapter("a.json", [gated])], null)).toThrow(
      expect.objectContaining({ code: "COMFY_API_AUTHENTICATED_MODEL" }),
    );
  });
});

describe("resolveBuildDefinition", () => {
  const inputs = buildInputs([adapter("a.json", [flux], ["comfyui-kjnodes"])], null);
  const unpinned = { inputsHash: null, baseComfyVersion: null, registryVersions: {} };

  function resolvers(comfy = "v0.4.0", pack = "1.2.0") {
    return {
      latestComfyVersion: vi.fn(async () => comfy),
      registryVersion: vi.fn(async (_id: string) => pack),
    };
  }

  it("pins ComfyUI's latest tag and each pack's registry version", async () => {
    const r = resolvers();
    const resolved = await resolveBuildDefinition(inputs, unpinned, r);
    expect(resolved).toEqual({
      definition: {
        baseComfyVersion: "v0.4.0",
        models: inputs.models,
        customNodes: [{ name: "comfyui-kjnodes", id: "comfyui-kjnodes", registryVersion: "1.2.0" }],
      },
      inputsHash: hashOf(inputs),
      baseComfyVersion: "v0.4.0",
      registryVersions: { "comfyui-kjnodes": "1.2.0" },
    });
  });

  it("keeps the recorded pins while the inputs hold", async () => {
    const first = await resolveBuildDefinition(inputs, unpinned, resolvers());
    const r = resolvers("v9.9.9", "9.9.9");
    const again = await resolveBuildDefinition(inputs, first, r);
    expect(again.definition).toEqual(first.definition);
    expect(r.latestComfyVersion).not.toHaveBeenCalled();
    expect(r.registryVersion).not.toHaveBeenCalled();
  });

  it("resolves the pins again once the inputs change", async () => {
    const first = await resolveBuildDefinition(inputs, unpinned, resolvers());
    const changed = buildInputs([adapter("a.json", [flux, vae], ["comfyui-kjnodes"])], null);
    const again = await resolveBuildDefinition(changed, first, resolvers("v9.9.9", "9.9.9"));
    expect(again.baseComfyVersion).toBe("v9.9.9");
    expect(again.registryVersions).toEqual({ "comfyui-kjnodes": "9.9.9" });
    expect(again.inputsHash).not.toBe(first.inputsHash);
  });

  it("takes comfyVersion over any tag", async () => {
    const pinned = buildInputs([adapter("a.json", [flux])], "abc123");
    const r = resolvers();
    const resolved = await resolveBuildDefinition(pinned, unpinned, r);
    expect(resolved.baseComfyVersion).toBe("abc123");
    expect(r.latestComfyVersion).not.toHaveBeenCalled();
  });
});
