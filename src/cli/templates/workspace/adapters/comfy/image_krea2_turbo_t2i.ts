// source-hash: 2bd47fd51196b5e71cdbda295347f39b18899bd8fdf9c8f29607cfb3b974bae1
// source: github.com/Comfy-Org/workflow_templates / templates/image_krea2_turbo_t2i_int8.json (MIT License)
import { defineComfyAsset } from "konte";

export const imageKrea2TurboT2i = defineComfyAsset({
  workflow: "image_krea2_turbo_t2i.json",
  description:
    "Krea 2 Turbo — generate a still from text in eight steps. Choose it for illustrated or stylized references whose line, palette and shading establish the piece's finished look. Describe the subject and target style in words.",
  guide: "konte/guides/krea2-turbo.md",
  models: [
    {
      filename: "krea2_turbo_int8_convrot.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors",
    },
    {
      filename: "qwen3vl_4b_fp8_scaled.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
    },
    {
      filename: "qwen_image_vae.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors",
    },
  ],
  inputs: {
    // CLIPTextEncode → KSampler.positive, ConditioningZeroOut.conditioning
    prompt: {
      nodeId: "52",
      field: "text",
      type: "prompt",
      default:
        "A human hand holding a martini glass, overlaid with whimsical ink-style doodles — a cartoon figure inside the glass, a citrus wedge drawn on the rim — clean white background, lit photograph blended with loose marker artistry.",
    },
    // EmptyLatentImage → KSampler.latent_image
    width: { nodeId: "53", field: "width", type: "width", default: 1280, grid: { step: 16 } },
    // EmptyLatentImage → KSampler.latent_image
    height: { nodeId: "53", field: "height", type: "height", default: 720, grid: { step: 16 } },
    // KSampler → VAEDecode.samples
    seed: { nodeId: "54", field: "seed", type: "seed", default: 0 },
    // KSampler → VAEDecode.samples
    steps: {
      nodeId: "54",
      field: "steps",
      type: "number",
      default: 8,
      description: "The checkpoint is distilled for 8; raising it costs time and changes little.",
    },
    // VAELoader → VAEDecode.vae
    vaeName: {
      nodeId: "58",
      field: "vae_name",
      type: "string",
      default: "qwen_image_vae.safetensors",
    },
    // CLIPLoader → CLIPTextEncode.clip
    clipName: {
      nodeId: "57",
      field: "clip_name",
      type: "string",
      default: "qwen3vl_4b_fp8_scaled.safetensors",
    },
    // UNETLoader → KSampler.model
    unetName: {
      nodeId: "56",
      field: "unet_name",
      type: "string",
      default: "krea2_turbo_int8_convrot.safetensors",
    },
  },
  outputs: {
    image: { nodeId: "29", type: "image" },
  },
});
