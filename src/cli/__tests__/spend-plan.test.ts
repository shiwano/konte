import { describe, expect, it } from "vitest";
import { comfyModelJobId } from "../../core/job-manager.js";
import type { AssetDefinition, ComfyModelDeclaration } from "../../core/types/index.js";
import { collectComfyDownloads, formatComfyDownloadNotice } from "../spend-plan.js";

const fileDef = { kind: "file" } as unknown as AssetDefinition;

function comfyAsset(opts: {
  models?: Array<{ filename: string; type: string; displayName?: string }>;
  nodes?: Array<{ id: string; displayName?: string }>;
}): AssetDefinition {
  return { kind: "comfy", ...opts } as unknown as AssetDefinition;
}

describe("collectComfyDownloads", () => {
  it("returns empty arrays when there are no comfy entries", () => {
    expect(collectComfyDownloads([], new Set(), new Set())).toEqual({ models: [], nodes: [] });
  });

  it("skips non-comfy entries", () => {
    const result = collectComfyDownloads(
      [{ address: "video:timeline.bgm", def: fileDef }],
      new Set(["x.safetensors"]),
      new Set(),
    );
    expect(result).toEqual({ models: [], nodes: [] });
  });

  it("includes only declarations flagged missing", () => {
    const present = { filename: "present.safetensors", type: "checkpoint" as const };
    const missing = { filename: "missing.safetensors", type: "lora" as const };
    const def = comfyAsset({ models: [present, missing] });
    const result = collectComfyDownloads(
      [{ address: "video:shot.01.motion", def }],
      new Set([comfyModelJobId(missing as ComfyModelDeclaration)]),
      new Set(),
    );
    expect(result.models).toEqual([
      {
        filename: "missing.safetensors",
        type: "lora",
        savePath: undefined,
        displayName: undefined,
        addresses: ["video:shot.01.motion"],
      },
    ]);
  });

  it("keeps one entry per install target when a filename repeats across savePaths", () => {
    // A directory-shaped model contributes several files sharing a name; keying by filename
    // alone would collapse them into one line and hide a download.
    const root = { filename: "config.json", type: "checkpoint" as const, savePath: "TTS/m" };
    const nested = { ...root, savePath: "TTS/m/speech_tokenizer" };
    const def = comfyAsset({ models: [root, nested] });
    const result = collectComfyDownloads(
      [{ address: "reference:narration", def }],
      new Set([root, nested].map((m) => comfyModelJobId(m as ComfyModelDeclaration))),
      new Set(),
    );
    expect(result.models.map((m) => m.savePath)).toEqual(["TTS/m", "TTS/m/speech_tokenizer"]);
  });

  it("dedups a shared model and aggregates its addresses", () => {
    const base = { filename: "base.safetensors", type: "checkpoint" as const };
    const a = comfyAsset({ models: [base] });
    const b = comfyAsset({ models: [base] });
    const result = collectComfyDownloads(
      [
        { address: "video:shot.01.motion", def: a },
        { address: "video:shot.02.motion", def: b },
      ],
      new Set([comfyModelJobId(base as ComfyModelDeclaration)]),
      new Set(),
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.addresses).toEqual(["video:shot.01.motion", "video:shot.02.motion"]);
  });

  it("carries type/displayName for models, and the cnr_id for nodes", () => {
    const model = {
      filename: "m.safetensors",
      type: "diffusion_model" as const,
      displayName: "My Model",
    };
    const def = comfyAsset({
      models: [model],
      nodes: [{ id: "ComfyUI-SeedVR2_VideoUpscaler" }],
    });
    const result = collectComfyDownloads(
      [{ address: "video:shot.01.motion", def }],
      new Set([comfyModelJobId(model as ComfyModelDeclaration)]),
      new Set(["ComfyUI-SeedVR2_VideoUpscaler"]),
    );
    expect(result.models[0]).toMatchObject({ type: "diffusion_model", displayName: "My Model" });
    expect(result.nodes[0]).toMatchObject({ id: "ComfyUI-SeedVR2_VideoUpscaler" });
  });
});

describe("formatComfyDownloadNotice", () => {
  it("returns null when nothing is pending", () => {
    expect(formatComfyDownloadNotice({ models: [], nodes: [] })).toBeNull();
  });

  it("uses distinct download/install verbs and includes the address", () => {
    const text = formatComfyDownloadNotice({
      models: [
        {
          filename: "sd3.5_large.safetensors",
          type: "checkpoint",
          addresses: ["video:shot.01.motion"],
        },
      ],
      nodes: [{ id: "ComfyUI-SeedVR2_VideoUpscaler", addresses: ["video:shot.02.motion"] }],
    });
    expect(text).toContain("skipped if already present");
    expect(text).toContain(
      "download  sd3.5_large.safetensors (checkpoint)  — video:shot.01.motion",
    );
    expect(text).toContain(
      "install   ComfyUI-SeedVR2_VideoUpscaler (custom node)  — video:shot.02.motion",
    );
  });

  it("prefers displayName as the label", () => {
    const text = formatComfyDownloadNotice({
      models: [
        {
          filename: "m.safetensors",
          type: "lora",
          displayName: "Pretty Name",
          addresses: ["video:shot.01.motion"],
        },
      ],
      nodes: [],
    });
    expect(text).toContain("download  Pretty Name (lora)");
    expect(text).not.toContain("m.safetensors");
  });

  it("abbreviates multiple addresses to the first plus a count", () => {
    const text = formatComfyDownloadNotice({
      models: [
        {
          filename: "base.safetensors",
          type: "checkpoint",
          addresses: ["video:shot.01.motion", "video:shot.02.motion", "video:shot.03.motion"],
        },
      ],
      nodes: [],
    });
    expect(text).toContain("— video:shot.01.motion (+2 more)");
    expect(text).not.toContain("shot.02.motion");
  });
});
