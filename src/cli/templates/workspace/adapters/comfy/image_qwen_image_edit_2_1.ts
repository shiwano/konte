// source-hash: b3c2a50a25f92e9b9bd7910953ef91c9c113169313e85557bdb1af7f4dba2fd7
// source: github.com/Comfy-Org/workflow_templates / templates/image_qwen_image_2_1_image_edit.json (MIT License)
import { defineComfyAsset, inertInputs } from "konte";

export const imageQwenImageEdit21 = defineComfyAsset({
  workflow: "image_qwen_image_edit_2_1.json",
  description:
    "Qwen Image 2.1 — edits an existing image, keeping everything the prompt does not change: a change of rendering medium in reference, the next keyframe on the same camera from the one before it in a shot. Never a new viewpoint, a cut or a new composition.",
  guide: "konte/guides/qwen-image-edit-2-1.md",
  allowedIn: ["reference", "shot"],
  models: [
    {
      filename: "qwen_image_2.1_int8_convrot.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
    },
    {
      filename: "qwen3vl_8b_int8_convrot.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
    },
    {
      filename: "qwen_image_2.1_vae_bf16.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
    },
  ],
  inputs: {
    image1: {
      nodeId: "470",
      field: "image",
      type: "image",
      required: true,
      description:
        "Source image whose identity, geometry and composition the edit must retain: the image to convert, or the keyframe before on the same camera.",
    },
    image2: {
      nodeId: "475",
      field: "image",
      type: "image",
      description: "Optional style or character reference, addressed as <image2>.",
    },
    image3: {
      nodeId: "486",
      field: "image",
      type: "image",
      description: "Optional reference after image2, addressed as <image3>.",
    },
    // EmptyLatentImage → KSampler.latent_image
    width: { nodeId: "480", field: "width", type: "width", default: 1280, grid: { step: 32 } },
    height: { nodeId: "480", field: "height", type: "height", default: 736, grid: { step: 32 } },
    prompt: {
      nodeId: "485",
      field: "prompt",
      type: "prompt",
      required: true,
    },
    negativePrompt: {
      nodeId: "485",
      field: "negative_prompt",
      type: "negativePrompt",
      default: "",
      description: "Artifact terms; only effective with cfg above 1.",
    },
    seed: {
      nodeId: "482",
      field: "seed",
      type: "seed",
      default: 0,
    },
    steps: {
      nodeId: "482",
      field: "steps",
      type: "number",
      default: 40,
    },
    cfg: {
      nodeId: "482",
      field: "cfg",
      type: "number",
      default: 4,
      description: "Above 1 enables negativePrompt.",
    },
    unetName: {
      nodeId: "477",
      field: "unet_name",
      type: "string",
      default: "qwen_image_2.1_int8_convrot.safetensors",
    },
    clipName: {
      nodeId: "478",
      field: "clip_name",
      type: "string",
      default: "qwen3vl_8b_int8_convrot.safetensors",
    },
    vaeName: {
      nodeId: "479",
      field: "vae_name",
      type: "string",
      default: "qwen_image_2.1_vae_bf16.safetensors",
    },
  },
  outputs: {
    image: {
      nodeId: "461",
      type: "image",
    },
  },
  validators: [
    (inputs) => {
      if (inputs.image3 !== undefined && inputs.image2 === undefined)
        return "image3 requires image2; reference slots must be consecutive.";
      const count = inputs.image3 !== undefined ? 3 : inputs.image2 !== undefined ? 2 : 1;
      for (const match of String(inputs.prompt).matchAll(/<image(\d+)>/g)) {
        const ordinal = Number(match[1]);
        if (ordinal < 1 || ordinal > count) return `${match[0]} has no connected reference image.`;
      }
    },
    inertInputs({
      inputs: { negativePrompt: ["", " "] },
      when: { cfg: 1 },
      reason: "cfg is 1",
      fix: "Clear negativePrompt or set cfg above 1.",
    }),
  ],
});
