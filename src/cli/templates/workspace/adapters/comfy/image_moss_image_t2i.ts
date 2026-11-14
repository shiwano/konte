// source-hash: 40c0b3f02a86f6392dab750acca21b0825f084633fbdf371ddd34b7a506168d3
// source: github.com/Comfy-Org/workflow_templates / templates/image_moss_image_t2i.json (MIT License)
import { defineComfyAsset } from "konte";

export const imageMossImageT2i = defineComfyAsset({
  workflow: "image_moss_image_t2i.json",
  description:
    "MOSS-Image — generate a still from text for realistic subject, location or prop references. Choose it to establish readable physical structure: body build, garment cut, materials and shape from different views.",
  allowedIn: ["reference", "plate", "timeline", "thumbnail", "shot"],
  guide: "konte/guides/moss-image.md",
  models: [
    {
      filename: "flux2-vae_small.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae_small.safetensors",
    },
    {
      filename: "qwen3.5_9b_w4a8_gptq.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors",
    },
    {
      filename: "moss_image_sft_int8_convrot.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/diffusion_models/moss_image_sft_int8_convrot.safetensors",
    },
  ],
  inputs: {
    // CLIPTextEncode → KSampler.positive
    prompt: {
      nodeId: "30",
      field: "text",
      type: "prompt",
      default:
        "Studio photograph of a woman in her thirties with thick wavy black hair, standing full-length against a plain light grey backdrop, wearing a belted camel wool coat over a cream knit sweater, dark straight trousers and brown leather ankle boots. Soft even key light from the front left, neutral colour, sharp fabric texture.",
    },
    // CLIPTextEncode → KSampler.negative
    negativePrompt: {
      nodeId: "37",
      field: "text",
      type: "negativePrompt",
      default: "nsfw, worst quality, bad anatomy, watermark, jpeg artifact",
    },
    // EmptyFlux2LatentImage → KSampler.latent_image
    width: { nodeId: "36", field: "width", type: "width", default: 1280, grid: { step: 16 } },
    // EmptyFlux2LatentImage → KSampler.latent_image
    height: { nodeId: "36", field: "height", type: "height", default: 720, grid: { step: 16 } },
    // KSampler → VAEDecode.samples
    seed: { nodeId: "32", field: "seed", type: "seed", default: 0 },
    // KSampler → VAEDecode.samples
    steps: { nodeId: "32", field: "steps", type: "number", default: 25 },
    // KSampler → VAEDecode.samples
    cfg: { nodeId: "32", field: "cfg", type: "number", default: 2.5 },
    // VAELoader → VAEDecode.vae
    vaeName: {
      nodeId: "33",
      field: "vae_name",
      type: "string",
      default: "flux2-vae_small.safetensors",
    },
    // CLIPLoader → CLIPTextEncode.clip, CLIPTextEncode.clip
    clipName: {
      nodeId: "31",
      field: "clip_name",
      type: "string",
      default: "qwen3.5_9b_w4a8_gptq.safetensors",
    },
    // UNETLoader → KSampler.model
    unetName: {
      nodeId: "29",
      field: "unet_name",
      type: "string",
      default: "moss_image_sft_int8_convrot.safetensors",
    },
  },
  outputs: {
    image: { nodeId: "9", type: "image" },
  },
});
