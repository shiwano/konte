// source-hash: 478933dc7c9c0cf823466b0572d7a3137928ba1c2b3bc78f6086020921507733
// source: github.com/Comfy-Org/workflow_templates / templates/image_z_image.json (MIT License)
import { defineComfyAsset } from "konte";

export const imageZImageBase = defineComfyAsset({
  workflow: "image_z_image_base.json",
  description:
    "Z Image — generate a still from text for realistic subject, location or prop references. Choose it to establish readable physical structure: body build, garment cut, materials and shape from different views.",
  guide: "konte/guides/z-image-base.md",
  models: [
    {
      filename: "ae.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors",
    },
    {
      filename: "qwen_3_4b.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
    },
    {
      filename: "z_image_bf16.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors",
    },
  ],
  inputs: {
    // CLIPTextEncode → KSampler.positive
    prompt: {
      nodeId: "96",
      field: "text",
      type: "prompt",
      default:
        "Latina female with thick wavy hair, harbor boats and pastel houses behind. Breezy seaside light, warm tones, cinematic close-up.",
    },
    // CLIPTextEncode → KSampler.negative
    negativePrompt: { nodeId: "103", field: "text", type: "negativePrompt", default: "" },
    // EmptySD3LatentImage → KSampler.latent_image
    width: { nodeId: "97", field: "width", type: "width", default: 1280 },
    // EmptySD3LatentImage → KSampler.latent_image
    height: { nodeId: "97", field: "height", type: "height", default: 720 },
    // KSampler → VAEDecode.samples
    seed: { nodeId: "104", field: "seed", type: "seed", default: 0 },
    // KSampler → VAEDecode.samples
    steps: { nodeId: "104", field: "steps", type: "number", default: 25 },
    // KSampler → VAEDecode.samples
    cfg: { nodeId: "104", field: "cfg", type: "number", default: 4 },
    // VAELoader → VAEDecode.vae
    vaeName: { nodeId: "98", field: "vae_name", type: "string", default: "ae.safetensors" },
    // CLIPLoader → CLIPTextEncode.clip, CLIPTextEncode.clip
    clipName: {
      nodeId: "99",
      field: "clip_name",
      type: "string",
      default: "qwen_3_4b.safetensors",
    },
    // UNETLoader → ModelSamplingAuraFlow.model
    unetName: {
      nodeId: "102",
      field: "unet_name",
      type: "string",
      default: "z_image_bf16.safetensors",
    },
  },
  outputs: {
    image: { nodeId: "95", type: "image" },
  },
});
