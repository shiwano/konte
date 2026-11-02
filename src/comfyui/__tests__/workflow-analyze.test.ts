import { describe, expect, it } from "vitest";
import type { ComfyUINodeDefinition } from "../types.js";
import { KonteError } from "../../core/errors.js";
import {
  analyzeWorkflow,
  extractHiddenSubgraphInputs,
  pruneUnreachableNodes,
} from "../workflow-analyze.js";

describe("analyzeWorkflow()", () => {
  it("rejects litegraph format (last_node_id)", () => {
    const data = { last_node_id: 10, last_link_id: 5, nodes: [] };
    expect(() => analyzeWorkflow(data)).toThrow(KonteError);
    expect(() => analyzeWorkflow(data)).toThrow("Litegraph format detected");
  });

  it("rejects litegraph format (nodes key)", () => {
    const data = { nodes: [{ id: 1 }], links: [] };
    expect(() => analyzeWorkflow(data)).toThrow("Litegraph format detected");
  });

  it("rejects invalid format (non-object)", () => {
    expect(() => analyzeWorkflow("string")).toThrow("Invalid workflow format");
    expect(() => analyzeWorkflow(null)).toThrow("Invalid workflow format");
    expect(() => analyzeWorkflow([])).toThrow("Invalid workflow format");
  });

  it("rejects invalid format (missing class_type)", () => {
    const data = { "1": { inputs: {} } };
    expect(() => analyzeWorkflow(data)).toThrow("Invalid workflow format");
  });

  it("detects KSampler seed inputs", () => {
    const data = {
      "5": {
        class_type: "KSampler",
        inputs: {
          seed: 12345,
          steps: 20,
          cfg: 7.5,
          denoise: 1.0,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: ["8", 0],
        },
      },
    };

    const result = analyzeWorkflow(data);
    const seedInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "5" && i.field === "seed",
    );
    expect(seedInput).toBeDefined();
    expect(seedInput!.type).toBe("seed");
  });

  it("types a seed outside a sampler as a seed", () => {
    const data = {
      "53": { class_type: "SeedNode", inputs: { seed: 0 } },
      "60": { class_type: "RandomNoise", inputs: { noise_value: 7 } },
    };
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      RandomNoise: {
        input: { required: { noise_value: ["INT", { control_after_generate: true }] } },
      },
    };
    const result = analyzeWorkflow(data, undefined, objectInfo);
    expect(Object.values(result.inputs).map((i) => [i.nodeId, i.type])).toEqual([
      ["53", "seed"],
      ["60", "seed"],
    ]);
  });

  it("detects KSampler numeric inputs (steps, cfg, denoise)", () => {
    const data = {
      "5": {
        class_type: "KSampler",
        inputs: {
          seed: 42,
          steps: 20,
          cfg: 7.5,
          denoise: 1.0,
          model: ["4", 0],
        },
      },
    };

    const result = analyzeWorkflow(data);
    const numericInputs = Object.values(result.inputs).filter((i) => i.type === "number");
    expect(numericInputs.length).toBe(3);
  });

  it("skips link inputs (array format [nodeId, outputIndex])", () => {
    const data = {
      "5": {
        class_type: "KSampler",
        inputs: {
          seed: 42,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: ["8", 0],
        },
      },
    };

    const result = analyzeWorkflow(data);
    const allFields = Object.values(result.inputs).map((i) => i.field);
    expect(allFields).not.toContain("model");
    expect(allFields).not.toContain("positive");
    expect(allFields).not.toContain("negative");
    expect(allFields).not.toContain("latent_image");
  });

  it("detects CLIPTextEncode text inputs", () => {
    const data = {
      "3": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "a beautiful landscape",
          clip: ["1", 0],
        },
        _meta: { title: "Positive Prompt" },
      },
    };

    const result = analyzeWorkflow(data);
    const textInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "3" && i.field === "text",
    );
    expect(textInput).toBeDefined();
    expect(textInput!.type).toBe("string");
  });

  it("names an unwired CLIPTextEncode input by its node title", () => {
    const data = {
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: "test", clip: ["1", 0] },
        _meta: { title: "Positive Prompt" },
      },
    };

    const result = analyzeWorkflow(data);
    const keys = Object.keys(result.inputs);
    expect(keys.some((k) => k.startsWith("positive_prompt"))).toBe(true);
  });

  it("names a text encode by the sampler input it reaches, not its title or node order", () => {
    const encode = (text: string) => ({
      class_type: "CLIPTextEncode",
      inputs: { text, clip: ["1", 0] },
      _meta: { title: "CLIP Text Encode (Prompt)" },
    });
    const data = {
      "2": encode("blurry"),
      "3": encode("a cat"),
      "4": {
        class_type: "ControlNetApplyAdvanced",
        inputs: { positive: ["6", 0], negative: ["2", 0], strength: 1 },
      },
      "5": {
        class_type: "KSampler",
        inputs: { seed: 1, positive: ["4", 0], negative: ["4", 1] },
      },
      "6": { class_type: "FluxGuidance", inputs: { conditioning: ["3", 0], guidance: 3.5 } },
    };

    const result = analyzeWorkflow(data);
    expect(result.inputs.prompt).toMatchObject({ nodeId: "3", field: "text" });
    expect(result.inputs.negative_prompt).toMatchObject({ nodeId: "2", field: "text" });
  });

  it("names a text encode feeding both polarities by its node title", () => {
    const data = {
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: "", clip: ["1", 0] },
        _meta: { title: "Shared" },
      },
      "5": { class_type: "KSampler", inputs: { positive: ["3", 0], negative: ["3", 0] } },
    };

    expect(Object.keys(analyzeWorkflow(data).inputs)).toContain("shared");
  });

  it("detects TextEncodeQwenImageEditPlus prompt inputs as semantic", () => {
    const data = {
      "199": {
        class_type: "TextEncodeQwenImageEditPlus",
        inputs: { prompt: "", clip: ["208", 0], image2: ["83", 0] },
      },
      "201": {
        class_type: "TextEncodeQwenImageEditPlus",
        inputs: { prompt: "edit the thing", clip: ["208", 0], image2: ["83", 0] },
      },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out" } },
    };

    const result = analyzeWorkflow(data);
    const promptInputs = Object.values(result.inputs).filter(
      (i) => i.field === "prompt" && i.type === "string",
    );
    expect(promptInputs).toHaveLength(2);
    expect(promptInputs.every((i) => i.semantic === true)).toBe(true);
  });

  it("detects LoadImage inputs", () => {
    const data = {
      "2": {
        class_type: "LoadImage",
        inputs: { image: "input.png" },
      },
    };

    const result = analyzeWorkflow(data);
    const imgInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "2" && i.field === "image",
    );
    expect(imgInput).toBeDefined();
    expect(imgInput!.type).toBe("image");
    expect(imgInput!.required).toBe(true);
    expect(imgInput!.default).toBeUndefined();
  });

  it("detects LoadVideo inputs", () => {
    const data = {
      "2": {
        class_type: "LoadVideo",
        inputs: { video: "input.mp4", frame_rate: 30 },
      },
    };

    const result = analyzeWorkflow(data);
    const videoInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "2" && i.field === "video",
    );
    expect(videoInput).toBeDefined();
    expect(videoInput!.type).toBe("video");
    expect(videoInput!.required).toBe(true);
    expect(videoInput!.default).toBeUndefined();
  });

  it("detects LoadVideo inputs with a `file` field (ComfyUI core)", () => {
    const data = {
      "2": {
        class_type: "LoadVideo",
        inputs: { file: "input.mp4" },
      },
    };

    const result = analyzeWorkflow(data);
    const videoInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "2" && i.field === "file",
    );
    expect(videoInput).toBeDefined();
    expect(videoInput!.type).toBe("video");
    expect(videoInput!.required).toBe(true);
    expect(videoInput!.default).toBeUndefined();
  });

  it("detects VHS_LoadVideo inputs", () => {
    const data = {
      "2": {
        class_type: "VHS_LoadVideo",
        inputs: { video: "input.mp4" },
      },
    };

    const result = analyzeWorkflow(data);
    const videoInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "2" && i.field === "video",
    );
    expect(videoInput).toBeDefined();
    expect(videoInput!.type).toBe("video");
    expect(videoInput!.required).toBe(true);
    expect(videoInput!.default).toBeUndefined();
  });

  it("detects LoadAudio inputs as audio type", () => {
    const data = {
      "2": {
        class_type: "LoadAudio",
        inputs: { audio: "input.mp3" },
      },
    };

    const result = analyzeWorkflow(data);
    const audioInput = Object.values(result.inputs).find(
      (i) => i.nodeId === "2" && i.field === "audio",
    );
    expect(audioInput).toBeDefined();
    expect(audioInput!.type).toBe("audio");
    expect(audioInput!.required).toBe(true);
    expect(audioInput!.default).toBeUndefined();
  });

  it("detects SaveAudio outputs as audio type", () => {
    const data = {
      "9": {
        class_type: "SaveAudio",
        inputs: { audio: ["8", 0], filename_prefix: "output" },
      },
    };

    const result = analyzeWorkflow(data);
    const output = Object.values(result.outputs).find((o) => o.nodeId === "9");
    expect(output).toBeDefined();
    expect(output!.type).toBe("audio");
  });

  it("detects SaveImage outputs", () => {
    const data = {
      "9": {
        class_type: "SaveImage",
        inputs: { images: ["8", 0], filename_prefix: "output" },
      },
    };

    const result = analyzeWorkflow(data);
    const output = Object.values(result.outputs).find((o) => o.nodeId === "9");
    expect(output).toBeDefined();
    expect(output!.type).toBe("image");
  });

  it("detects SaveImageAdvanced outputs without exposing its format widgets", () => {
    const data = {
      "9": {
        class_type: "SaveImageAdvanced",
        inputs: {
          images: ["8", 0],
          filename_prefix: "output",
          format: "png",
          "format.bit_depth": "8-bit",
          "format.input_color_space": "sRGB",
        },
      },
    };

    const result = analyzeWorkflow(data);
    const output = Object.values(result.outputs).find((o) => o.nodeId === "9");
    expect(output).toBeDefined();
    expect(output!.type).toBe("image");
    expect(Object.values(result.inputs).filter((i) => i.nodeId === "9")).toEqual([]);
  });

  it("detects VHS_VideoCombine outputs", () => {
    const data = {
      "10": {
        class_type: "VHS_VideoCombine",
        inputs: { images: ["8", 0], frame_rate: 30 },
      },
    };

    const result = analyzeWorkflow(data);
    const output = Object.values(result.outputs).find((o) => o.nodeId === "10");
    expect(output).toBeDefined();
    expect(output!.type).toBe("video");
  });

  it("detects SaveWEBM outputs as video type", () => {
    const data = {
      "10": {
        class_type: "SaveWEBM",
        inputs: { images: ["8", 0], filename_prefix: "out", codec: "vp9", fps: 24, crf: 32 },
      },
    };

    const result = analyzeWorkflow(data);
    expect(Object.values(result.outputs)).toEqual([{ nodeId: "10", type: "video" }]);
  });

  it("infers type from default value for unknown node inputs", () => {
    const data = {
      "99": {
        class_type: "CustomNode",
        inputs: {
          someParam: "hello",
          linked: ["4", 0],
        },
      },
    };

    const result = analyzeWorkflow(data);
    const unknown = Object.values(result.inputs).find(
      (i) => i.nodeId === "99" && i.field === "someParam",
    );
    expect(unknown).toBeDefined();
    expect(unknown!.type).toBe("string");
  });

  it("handles a complete workflow with multiple node types", () => {
    const data = {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "model.safetensors" },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: "a cat", clip: ["1", 1] },
        _meta: { title: "Positive" },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: "ugly", clip: ["1", 1] },
        _meta: { title: "Negative" },
      },
      "5": {
        class_type: "KSampler",
        inputs: {
          seed: 42,
          steps: 20,
          cfg: 7,
          denoise: 1,
          model: ["1", 0],
          positive: ["3", 0],
          negative: ["4", 0],
          latent_image: ["6", 0],
        },
      },
      "9": {
        class_type: "SaveImage",
        inputs: { images: ["8", 0], filename_prefix: "out" },
      },
    };

    const result = analyzeWorkflow(data);

    expect(Object.keys(result.outputs).length).toBe(1);
    expect(Object.values(result.outputs)[0]!.type).toBe("image");

    const types = Object.values(result.inputs).map((i) => i.type);
    expect(types).toContain("seed");
    expect(types).toContain("number");
    expect(types).toContain("string");
  });
});

describe("analyzeWorkflow() combo choices", () => {
  it("pins combo (enum) choices from object_info onto the input", () => {
    const data = {
      "69": {
        class_type: "CustomCombo",
        inputs: { choice: "Music" },
      },
    };
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      CustomCombo: {
        input: { required: { choice: [["Music", "SFX", "Speech"], {}] } },
      },
    };
    const result = analyzeWorkflow(data, undefined, objectInfo);
    expect(result.inputs.choice).toMatchObject({
      type: "string",
      default: "Music",
      values: ["Music", "SFX", "Speech"],
    });
  });

  it("pins the choices a COMBO-typed input lists in its options", () => {
    const data = { "42": { class_type: "YuE2GenerateABC", inputs: { mode: "full" } } };
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      YuE2GenerateABC: {
        input: {
          required: { mode: ["COMBO", { multiselect: false, options: ["full", "melody"] }] },
        },
      },
    };
    const result = analyzeWorkflow(data, undefined, objectInfo);
    expect(result.inputs.mode).toMatchObject({ default: "full", values: ["full", "melody"] });
  });

  it("leaves a plain string input without `values` when object_info gives a scalar type", () => {
    const data = {
      "10": {
        class_type: "SomeNode",
        inputs: { label: "hello" },
      },
    };
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      SomeNode: {
        input: { required: { label: ["STRING", {}] } },
      },
    };
    const result = analyzeWorkflow(data, undefined, objectInfo);
    expect(result.inputs.label!.values).toBeUndefined();
  });

  it("does not pin a model/file picker's installed filenames as `values`", () => {
    const data = {
      "4": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "sd_xl_base.safetensors" },
      },
    };
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      CheckpointLoaderSimple: {
        input: {
          required: { ckpt_name: [["sd_xl_base.safetensors", "dreamshaper.safetensors"], {}] },
        },
      },
    };
    const result = analyzeWorkflow(data, undefined, objectInfo);
    expect(result.inputs.ckpt_name!.values).toBeUndefined();
  });

  it("emits no `values` for a bare combo when object_info is absent and nothing selects its value", () => {
    const data = {
      "69": {
        class_type: "CustomCombo",
        inputs: { choice: "Music" },
      },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.choice!.values).toBeUndefined();
  });

  it("derives combo choices from a downstream JsonExtractString's json_string keys", () => {
    const data = {
      "69": {
        class_type: "CustomCombo",
        inputs: { choice: "Music" },
      },
      "70": {
        class_type: "JsonExtractString",
        inputs: {
          json_string: JSON.stringify({ Music: "m", Instrument: "i", SFX: "s", "One-shot": "o" }),
          key: ["69", 0],
        },
      },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.choice).toMatchObject({
      type: "string",
      default: "Music",
      values: ["Music", "Instrument", "SFX", "One-shot"],
    });
  });

  it("prefers object_info combo choices over a downstream JsonExtractString", () => {
    const data = {
      "69": {
        class_type: "CustomCombo",
        inputs: { choice: "Music" },
      },
      "70": {
        class_type: "JsonExtractString",
        inputs: { json_string: JSON.stringify({ Music: "m", SFX: "s" }), key: ["69", 0] },
      },
    };
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      CustomCombo: { input: { required: { choice: [["Music", "SFX", "Speech"], {}] } } },
    };
    const result = analyzeWorkflow(data, undefined, objectInfo);
    expect(result.inputs.choice!.values).toEqual(["Music", "SFX", "Speech"]);
  });

  it("ignores a JsonExtractString fed by a different node", () => {
    const data = {
      "69": {
        class_type: "CustomCombo",
        inputs: { choice: "Music" },
      },
      "70": {
        class_type: "JsonExtractString",
        inputs: { json_string: JSON.stringify({ Music: "m", SFX: "s" }), key: ["42", 0] },
      },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.choice!.values).toBeUndefined();
  });

  it("only pins choices on the sibling input whose value selects the key", () => {
    const data = {
      "69": {
        class_type: "CustomCombo",
        inputs: { choice: "Music", label: "not-a-key" },
      },
      "70": {
        class_type: "JsonExtractString",
        inputs: { json_string: JSON.stringify({ Music: "m", SFX: "s" }), key: ["69", 0] },
      },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.choice!.values).toEqual(["Music", "SFX"]);
    expect(result.inputs.label!.values).toBeUndefined();
  });
});

describe("analyzeWorkflow() model detection", () => {
  it("detects checkpoint, unet, vae, clip, lora model fields", () => {
    const data = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "ck.safetensors" } },
      "2": { class_type: "UNETLoader", inputs: { unet_name: "u.safetensors" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "v.safetensors" } },
      "4": {
        class_type: "CLIPLoader",
        inputs: { clip_name: "c.safetensors", type: "lumina2", device: "default" },
      },
      "5": {
        class_type: "LoraLoaderModelOnly",
        inputs: { lora_name: "l.safetensors", strength_model: 0.8, model: ["1", 0] },
      },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
    };

    const result = analyzeWorkflow(data);
    const byFilename = Object.fromEntries(result.models.map((m) => [m.filename, m.type]));

    expect(byFilename).toEqual({
      "ck.safetensors": "checkpoint",
      "u.safetensors": "diffusion_model",
      "v.safetensors": "VAE",
      "c.safetensors": "clip",
      "l.safetensors": "lora",
    });
  });

  it("dedupes identical filenames referenced by multiple nodes", () => {
    const data = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "same.safetensors" } },
      "2": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "same.safetensors" } },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
    };
    const result = analyzeWorkflow(data);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.filename).toBe("same.safetensors");
  });

  it("detects model files from custom loaders not in the rule table", () => {
    const data = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "base.safetensors" } },
      "2": {
        class_type: "LatentUpscaleModelLoader",
        inputs: { model_name: "spatial-upscaler.safetensors" },
      },
      "3": {
        class_type: "LTXAVTextEncoderLoader",
        inputs: { text_encoder: "gemma.safetensors", device: "default" },
      },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
    };
    const result = analyzeWorkflow(data);
    const byFilename = Object.fromEntries(result.models.map((m) => [m.filename, m.type]));
    expect(byFilename).toEqual({
      "base.safetensors": "checkpoint",
      "spatial-upscaler.safetensors": "upscale",
      "gemma.safetensors": "clip",
    });
  });

  it("does not misclassify non-model string widgets as models", () => {
    const data = {
      "1": {
        class_type: "CLIPLoader",
        inputs: { clip_name: "c.safetensors", type: "lumina2", device: "default" },
      },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
    };
    const result = analyzeWorkflow(data);
    expect(result.models.map((m) => m.filename)).toEqual(["c.safetensors"]);
  });

  it("treats DualCLIPLoader fields as two separate clip entries", () => {
    const data = {
      "1": {
        class_type: "DualCLIPLoader",
        inputs: { clip_name1: "a.safetensors", clip_name2: "b.safetensors", type: "sdxl" },
      },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
    };
    const result = analyzeWorkflow(data);
    expect(result.models.map((m) => m.filename).sort()).toEqual(["a.safetensors", "b.safetensors"]);
    expect(result.models.every((m) => m.type === "clip")).toBe(true);
  });
});

describe("analyzeWorkflow() semantic flag", () => {
  it("marks dedicated-branch inputs (prompt, image, video, seed) as semantic", () => {
    const data = {
      "3": { class_type: "CLIPTextEncode", inputs: { text: "ugly", clip: ["1", 0] } },
      "2": { class_type: "LoadImage", inputs: { image: "in.png" } },
      "4": { class_type: "LoadVideo", inputs: { video: "in.mp4" } },
      "5": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, model: ["1", 0] } },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "out" } },
    };
    const result = analyzeWorkflow(data);
    for (const input of Object.values(result.inputs)) {
      expect(input.semantic).toBe(true);
    }
  });

  it("does not mark generic widget inputs as semantic", () => {
    const data = {
      "99": { class_type: "CustomNode", inputs: { someParam: "hello" } },
      "9": { class_type: "SaveImage", inputs: { images: ["99", 0], filename_prefix: "out" } },
    };
    const result = analyzeWorkflow(data);
    const generic = Object.values(result.inputs).find((i) => i.field === "someParam");
    expect(generic).toBeDefined();
    expect(generic!.semantic).toBeUndefined();
  });

  it("names a PrimitiveFloat feeding CreateVideo.fps as a semantic `fps` knob", () => {
    const data = {
      "187": { class_type: "PrimitiveFloat", inputs: { value: 16 } },
      "171": { class_type: "CreateVideo", inputs: { images: ["172", 0], fps: ["187", 0] } },
      "9": { class_type: "SaveVideo", inputs: { video: ["171", 0] } },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.fps).toMatchObject({
      nodeId: "187",
      field: "value",
      type: "number",
      default: 16,
      semantic: true,
    });
  });

  it("names a Primitive feeding VHS_VideoCombine.frame_rate as `fps`", () => {
    const data = {
      "10": { class_type: "PrimitiveFloat", inputs: { value: 24 } },
      "11": {
        class_type: "VHS_VideoCombine",
        inputs: { images: ["8", 0], frame_rate: ["10", 0] },
      },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.fps).toMatchObject({ nodeId: "10", field: "value", semantic: true });
  });

  it("surfaces an inline frame_rate on a video saver as `fps`", () => {
    const data = {
      "11": {
        class_type: "VHS_VideoCombine",
        inputs: { images: ["8", 0], frame_rate: 8, format: "video/h264-mp4" },
      },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.fps).toMatchObject({
      nodeId: "11",
      field: "frame_rate",
      default: 8,
      semantic: true,
    });
    // Non-frame-rate widgets on the saver still short-circuit (output-only).
    expect(Object.values(result.inputs).some((i) => i.field === "format")).toBe(false);
  });

  it("normalizes an inline `fps` widget to a semantic `fps` knob", () => {
    const data = {
      "86": { class_type: "CreateVideo", inputs: { images: ["85", 0], fps: 16 } },
      "9": { class_type: "SaveVideo", inputs: { video: ["86", 0] } },
    };
    const result = analyzeWorkflow(data);
    expect(result.inputs.fps).toMatchObject({ nodeId: "86", field: "fps", semantic: true });
  });

  it("leaves a Primitive feeding only a non-frame-rate target as an anonymous `value`", () => {
    const data = {
      "188": { class_type: "PrimitiveFloat", inputs: { value: 5 } },
      "190": {
        class_type: "ComfyMathExpression",
        inputs: { expression: "a + 1", "values.a": ["188", 0] },
      },
      "9": { class_type: "SaveVideo", inputs: { video: ["190", 0] } },
    };
    const result = analyzeWorkflow(data);
    const prim = Object.values(result.inputs).find((i) => i.nodeId === "188");
    expect(prim).toMatchObject({ field: "value" });
    expect(prim!.semantic).toBeUndefined();
  });
});

describe("analyzeWorkflow() subgraph input labels", () => {
  const data = {
    "54": { class_type: "PrimitiveStringMultiline", inputs: { value: "indie pop" } },
    "47": { class_type: "PrimitiveBoolean", inputs: { value: true } },
    "46": { class_type: "YuE2GenerateMusic", inputs: { style: ["54", 0], max_duration: 120 } },
    "10": { class_type: "SaveAudio", inputs: { audio: ["46", 0] } },
  };
  const meta = (inputLabels: Map<string, string>) => ({
    internalNodeIds: new Set(["54", "47", "46"]),
    inputTargetKeys: new Set(["54:value", "47:value", "46:max_duration"]),
    sharedPrimitiveGroups: [],
    inputLabels,
  });

  it("names an input by the label on the subgraph input that feeds it", () => {
    const result = analyzeWorkflow(
      data,
      meta(
        new Map([
          ["54:value", "Style"],
          ["47:value", "ABC_planning"],
        ]),
      ),
    );
    expect(result.inputs.style).toMatchObject({ nodeId: "54", field: "value" });
    expect(result.inputs.abc_planning).toMatchObject({ nodeId: "47", field: "value" });
    expect(result.inputs.max_duration).toMatchObject({ nodeId: "46" });
  });

  it("keeps the field name for a label that makes no identifier", () => {
    const result = analyzeWorkflow(data, meta(new Map([["47:value", "2nd pass"]])));
    expect(Object.values(result.inputs).find((i) => i.nodeId === "47")).toMatchObject({
      field: "value",
    });
    expect(Object.keys(result.inputs)).not.toContain("2nd_pass");
  });
});

describe("pruneUnreachableNodes()", () => {
  const workflow = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 0] } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "unused", clip: ["4", 0] } },
    "3": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: "clip.safetensors" } },
    "5": { class_type: "ShowText", inputs: { text: "note" } },
  };

  it("keeps only the nodes an output node depends on", () => {
    expect(Object.keys(pruneUnreachableNodes(workflow, {}) as object)).toEqual(["1", "3", "4"]);
  });

  it("returns the workflow as is without object_info", () => {
    expect(pruneUnreachableNodes(workflow, undefined)).toBe(workflow);
  });

  it("treats a node object_info declares as an output node as a root", () => {
    const objectInfo: Record<string, ComfyUINodeDefinition> = {
      ShowText: { input: {}, output_node: true },
    };
    expect(Object.keys(pruneUnreachableNodes(workflow, objectInfo) as object)).toEqual([
      "1",
      "3",
      "4",
      "5",
    ]);
  });

  it("returns a workflow with no output node as is", () => {
    const noOutput = { "1": workflow["1"], "4": workflow["4"] };
    expect(pruneUnreachableNodes(noOutput, {})).toBe(noOutput);
  });

  it("returns a fully reachable workflow as is", () => {
    const reachable = { "1": workflow["1"], "3": workflow["3"], "4": workflow["4"] };
    expect(pruneUnreachableNodes(reachable, {})).toBe(reachable);
  });
});

describe("extractHiddenSubgraphInputs()", () => {
  it("hides semantic internal inputs, drops generic ones, keeps exposed/top-level", () => {
    const analysis = {
      inputs: {
        topLevelPrompt: { nodeId: "1", field: "text", type: "string", semantic: true },
        exposedPrompt: { nodeId: "10", field: "text", type: "string", semantic: true },
        hiddenNegative: { nodeId: "20", field: "text", type: "string", semantic: true },
        hiddenGeneric: { nodeId: "20", field: "sigmas", type: "string" },
      },
      outputs: {},
      models: [],
    };
    const hidden = extractHiddenSubgraphInputs(analysis, {
      internalNodeIds: new Set(["10", "20"]),
      inputTargetKeys: new Set(["10:text"]),
      sharedPrimitiveGroups: [],
      inputLabels: new Map(),
    });

    expect(analysis.inputs.topLevelPrompt).toBeDefined(); // not internal
    expect(analysis.inputs.exposedPrompt).toBeDefined(); // internal but exposed
    expect(analysis.inputs.hiddenNegative).toBeUndefined(); // internal + unexposed
    expect(analysis.inputs.hiddenGeneric).toBeUndefined();
    expect(Object.keys(hidden)).toEqual(["hiddenNegative"]); // only semantic surfaces
  });

  it("returns nothing and keeps inputs when there are no internal nodes", () => {
    const analysis = {
      inputs: { a: { nodeId: "1", field: "text", type: "string", semantic: true } },
      outputs: {},
      models: [],
    };
    const hidden = extractHiddenSubgraphInputs(analysis, {
      internalNodeIds: new Set<string>(),
      inputTargetKeys: new Set<string>(),
      sharedPrimitiveGroups: [],
      inputLabels: new Map(),
    });
    expect(hidden).toEqual({});
    expect(analysis.inputs.a).toBeDefined();
  });
});

describe("analyzeWorkflow() shared-primitive collapse", () => {
  // One litegraph primitive fed KSampler.seed and CLIPTextEncode.seed; after inlining
  // both nodes carry the literal, surfacing as two candidates that must move together.
  const data = {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 31, steps: 20, model: ["1", 0] },
    },
    "4": {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: { tags: "hi", seed: 31, duration: 120 },
    },
    "5": {
      class_type: "EmptyAceStep1.5LatentAudio",
      inputs: { seconds: 120 },
    },
    "9": { class_type: "SaveAudioMP3", inputs: { audio: ["3", 0] } },
  };

  it("merges the seed group into one seed input with the rest as `also` targets", () => {
    const result = analyzeWorkflow(data, {
      internalNodeIds: new Set<string>(),
      inputTargetKeys: new Set<string>(),
      sharedPrimitiveGroups: [
        [
          { nodeId: "3", field: "seed" },
          { nodeId: "4", field: "seed" },
        ],
      ],
      inputLabels: new Map(),
    });

    // Single `seed` knob (seed-typed primary), no seed0/seed1 split.
    expect(result.inputs.seed).toBeDefined();
    expect(result.inputs.seed0).toBeUndefined();
    expect(result.inputs.seed1).toBeUndefined();
    expect(result.inputs.seed!.type).toBe("seed");
    expect(result.inputs.seed!.nodeId).toBe("3");
    expect(result.inputs.seed!.also).toEqual([{ nodeId: "4", field: "seed" }]);
  });

  it("collapses a group whose members have different field names", () => {
    const result = analyzeWorkflow(data, {
      internalNodeIds: new Set<string>(),
      inputTargetKeys: new Set<string>(),
      sharedPrimitiveGroups: [
        [
          { nodeId: "4", field: "duration" },
          { nodeId: "5", field: "seconds" },
        ],
      ],
      inputLabels: new Map(),
    });

    expect(result.inputs.duration).toBeDefined();
    expect(result.inputs.seconds).toBeUndefined();
    expect(result.inputs.duration!.also).toEqual([{ nodeId: "5", field: "seconds" }]);
  });

  it("leaves inputs untouched without subgraphMeta", () => {
    const result = analyzeWorkflow(data);
    expect(result.inputs.seed_0).toBeDefined();
    expect(result.inputs.seed_1).toBeDefined();
    expect(result.inputs.seed).toBeUndefined();
  });
});
