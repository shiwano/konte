// source-hash: 07e51af8cc913801a1f9982e2a0c127cc721508f75ce6c2db3cf73c40772e60a
// source: github.com/Comfy-Org/workflow_templates / templates/audio_minimax_music_3.json (MIT License)
import { defineComfyAsset } from "konte";

export const audioMinimaxMusic3 = defineComfyAsset({
  workflow: "audio_minimax_music_3.json",
  description:
    "MiniMax Music 3 — a song from a structured caption plus tagged lyrics, up to 5 min; length follows the lyric sections.",
  guide: "konte/guides/minimax-music-3.md",
  models: [
    {
      filename: "minimax_music3_dit_fp16.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_fp16.safetensors",
    },
    {
      filename: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
    },
    {
      filename: "minimax_music3_dav.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors",
    },
  ],
  inputs: {
    // MiniMaxMusic3TextEncode → ConditioningZeroOut.conditioning, EmptyMiniMaxMusic3LatentAudio.seconds, KSampler.positive
    caption: { nodeId: "45", field: "caption", type: "prompt", default: "" },
    // MiniMaxMusic3TextEncode → ConditioningZeroOut.conditioning, EmptyMiniMaxMusic3LatentAudio.seconds, KSampler.positive
    lyrics: { nodeId: "45", field: "lyrics", type: "spokenText", default: "" },
    // MiniMaxMusic3TextEncode → ConditioningZeroOut.conditioning, EmptyMiniMaxMusic3LatentAudio.seconds, KSampler.positive
    maxDuration: { nodeId: "45", field: "max_duration", type: "number", default: 60 },
    // SeedNode → MiniMaxMusic3TextEncode.seed, KSampler.seed
    seed: { nodeId: "52", field: "seed", type: "seed", default: 0 },
    // KSampler → VAEDecodeAudio.samples, VAEDecodeAudioTiled.samples
    steps: { nodeId: "50", field: "steps", type: "number", default: 30 },
    // KSampler → VAEDecodeAudio.samples, VAEDecodeAudioTiled.samples
    cfg: { nodeId: "50", field: "cfg", type: "number", default: 1.7 },
    // KSampler → VAEDecodeAudio.samples, VAEDecodeAudioTiled.samples
    denoise: { nodeId: "50", field: "denoise", type: "number", default: 1 },
    // ComfySwitchNode → SaveAudioAdvanced.audio
    tiledDecode: { nodeId: "54", field: "switch", type: "boolean", default: false },
    // UNETLoader → KSampler.model
    unetName: {
      nodeId: "44",
      field: "unet_name",
      type: "string",
      default: "minimax_music3_dit_fp16.safetensors",
    },
    // CLIPLoader → MiniMaxMusic3TextEncode.clip
    clipName: {
      nodeId: "46",
      field: "clip_name",
      type: "string",
      default: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
    },
    // VAELoader → VAEDecodeAudio.vae, VAEDecodeAudioTiled.vae
    vaeName: {
      nodeId: "47",
      field: "vae_name",
      type: "string",
      default: "minimax_music3_dav.safetensors",
    },
  },
  outputs: {
    audio: { nodeId: "35", type: "audio" },
  },
  promptExemptions: [/^none$/i],
});
