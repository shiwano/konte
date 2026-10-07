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
      "v0.39.0",
    );
    expect(inputs).toEqual({
      models: [
        { type: "diffusion_models", filename: "flux.safetensors", sourceUri: flux.url },
        { type: "vae", filename: "ae.safetensors", sourceUri: vae.url },
      ],
      nodeIds: ["comfyui-easy-use", "comfyui-kjnodes"],
      comfyVersion: "v0.39.0",
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
        "v0.39.0",
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
    expect(() => buildInputs([adapter("a.json", [gated])], "v0.39.0")).toThrow(
      expect.objectContaining({ code: "COMFY_API_AUTHENTICATED_MODEL" }),
    );
  });
});

describe("resolveBuildDefinition", () => {
  const inputs = buildInputs([adapter("a.json", [flux], ["comfyui-kjnodes"])], "v0.39.0");
  const unpinned = { inputsHash: null, registryVersions: {} };

  function resolvers(pack = "1.2.0") {
    return { registryVersion: vi.fn(async (_id: string) => pack) };
  }

  it("runs on comfyVersion and pins each pack's registry version", async () => {
    const resolved = await resolveBuildDefinition(inputs, unpinned, resolvers());
    expect(resolved).toEqual({
      definition: {
        baseComfyVersion: "v0.39.0",
        models: inputs.models,
        customNodes: [{ name: "comfyui-kjnodes", id: "comfyui-kjnodes", registryVersion: "1.2.0" }],
      },
      inputsHash: hashOf(inputs),
      registryVersions: { "comfyui-kjnodes": "1.2.0" },
    });
  });

  it("keeps the recorded pins while the inputs hold", async () => {
    const first = await resolveBuildDefinition(inputs, unpinned, resolvers());
    const r = resolvers("9.9.9");
    const again = await resolveBuildDefinition(inputs, first, r);
    expect(again.definition).toEqual(first.definition);
    expect(r.registryVersion).not.toHaveBeenCalled();
  });

  it("resolves the pins again once the inputs change", async () => {
    const first = await resolveBuildDefinition(inputs, unpinned, resolvers());
    const changed = buildInputs([adapter("a.json", [flux], ["comfyui-kjnodes"])], "v0.40.0");
    const again = await resolveBuildDefinition(changed, first, resolvers("9.9.9"));
    expect(again.definition.baseComfyVersion).toBe("v0.40.0");
    expect(again.registryVersions).toEqual({ "comfyui-kjnodes": "9.9.9" });
    expect(again.inputsHash).not.toBe(first.inputsHash);
  });
});
