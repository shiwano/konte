// source-hash: 2816d7e0f8278897bb90f9ac4ea8b4c59a62e2e083fc207240a71592f845cb7d
// source: github.com/Comfy-Org/workflow_templates / templates/image_qwen_image_2_1_image_edit.json (MIT License)
import { defineComfyAsset, inertInputs } from "konte";

export const imageQwenImageEdit21Inpaint = defineComfyAsset({
  workflow: "image_qwen_image_edit_2_1_inpaint.json",
  description:
    "Qwen Image 2.1, masked — redraws a rectangle with a feathered margin, preserving source pixels beyond that margin. Output keeps image1 dimensions.",
  guide: "konte/guides/qwen-image-edit-2-1-inpaint.md",
  allowedIn: ["patch"],
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
      description: "The source frame. The model sees the selected crop as <image1>.",
    },
    image2: {
      nodeId: "475",
      field: "image",
      type: "image",
      description: "Optional reference, addressed as <image2>.",
    },
    image3: {
      nodeId: "517",
      field: "image",
      type: "image",
      description: "Optional reference after image2, addressed as <image3>.",
    },
    left: {
      nodeId: "520",
      field: "value",
      type: "number",
      required: true,
      description: "Left edge of the edit rectangle, as a fraction of image1 from 0 to 1.",
    },
    top: {
      nodeId: "521",
      field: "value",
      type: "number",
      required: true,
      description: "Top edge of the edit rectangle, as a fraction of image1 from 0 to 1.",
    },
    right: {
      nodeId: "522",
      field: "value",
      type: "number",
      required: true,
      description: "Right edge of the edit rectangle, as a fraction of image1 from 0 to 1.",
    },
    bottom: {
      nodeId: "523",
      field: "value",
      type: "number",
      required: true,
      description: "Bottom edge of the edit rectangle, as a fraction of image1 from 0 to 1.",
    },
    prompt: {
      nodeId: "510",
      field: "prompt",
      type: "prompt",
      required: true,
    },
    negativePrompt: {
      nodeId: "510",
      field: "negative_prompt",
      type: "negativePrompt",
      default: "",
      description: "Terms for what the rectangle must not show; only effective with cfg above 1.",
    },
    seed: {
      nodeId: "507",
      field: "seed",
      type: "seed",
      default: 0,
    },
    steps: {
      nodeId: "507",
      field: "steps",
      type: "number",
      default: 25,
    },
    cfg: {
      nodeId: "507",
      field: "cfg",
      type: "number",
      default: 4,
      description: "Above 1 enables negativePrompt.",
    },
    unetName: {
      nodeId: "502",
      field: "unet_name",
      type: "string",
      default: "qwen_image_2.1_int8_convrot.safetensors",
    },
    clipName: {
      nodeId: "503",
      field: "clip_name",
      type: "string",
      default: "qwen3vl_8b_int8_convrot.safetensors",
    },
    vaeName: {
      nodeId: "504",
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
      const edge = (["left", "top", "right", "bottom"] as const).find((key) => {
        const value = inputs[key];
        return typeof value !== "number" || !(value >= 0 && value <= 1);
      });
      if (edge !== undefined) {
        return `${edge} must be a fraction of image 1 from 0 to 1, got ${String(inputs[edge])}`;
      }
      if ((inputs.left as number) >= (inputs.right as number)) {
        return `left (${String(inputs.left)}) must be less than right (${String(inputs.right)})`;
      }
      if ((inputs.top as number) >= (inputs.bottom as number)) {
        return `top (${String(inputs.top)}) must be less than bottom (${String(inputs.bottom)})`;
      }
      return undefined;
    },

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
