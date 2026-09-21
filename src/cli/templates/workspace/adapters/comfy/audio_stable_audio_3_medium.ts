// source-hash: 6ba35a405ca85f75ad38fbc9222b7d9155ccc2ae5866c8059d9f166e37f1f83c
// source: github.com/Comfy-Org/workflow_templates / templates/audio_stable_audio_3_medium.json (MIT License)
import { defineComfyAsset } from "konte";

export const audioStableAudio3Medium = defineComfyAsset({
  workflow: "audio_stable_audio_3_medium.json",
  description:
    "Stable Audio 3 Medium — SFX, a one-shot or an instrumental bed from a prompt, cut to the shot it plays over; never vocals.",
  guide: "konte/guides/stable-audio-3.md",
  models: [
    {
      filename: "qwen3.5_2b_bf16.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/Qwen3.5/resolve/main/text_encoders/qwen3.5_2b_bf16.safetensors",
    },
    {
      filename: "stable_audio_3_medium.safetensors",
      type: "checkpoint",
      url: "https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_medium.safetensors",
    },
    {
      filename: "t5gemma_b_b_ul2.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors",
    },
  ],
  inputs: {
    // PrimitiveStringMultiline → ComfySwitchNode.on_false, StringReplace.replace
    prompt: {
      nodeId: "69",
      field: "value",
      type: "prompt",
      default:
        "Tropical house track with marimba, steel drums, soft synths, smooth bass, layered percussion, and light piano riffs for sunny chill dance vibes",
    },
    // CLIPTextEncode → KSampler.negative
    negativePrompt: { nodeId: "58", field: "text", type: "negativePrompt", default: "" },
    // CustomCombo → JsonExtractString.key
    category: {
      nodeId: "70",
      field: "choice",
      type: "string",
      default: "Music",
      values: ["Music", "Instrument", "SFX", "One-shot"],
    },
    // PrimitiveBoolean → ComfySwitchNode.switch
    enhancePrompt: { nodeId: "74", field: "value", type: "boolean", default: false },
    // PrimitiveFloat → EmptyLatentAudio.seconds, ComfyMathExpression.values.a
    duration: {
      nodeId: "75",
      field: "value",
      type: "seconds",
      default: 150,
      description:
        "Clip length in seconds; follows the shot's duration where one is in scope, and the default stands in on the timeline.",
    },
    // KSampler → VAEDecodeAudio.samples
    seed: { nodeId: "61", field: "seed", type: "seed", default: 1038503484137406 },
    // KSampler → VAEDecodeAudio.samples
    steps: { nodeId: "61", field: "steps", type: "number", default: 8 },
    // KSampler → VAEDecodeAudio.samples
    cfg: { nodeId: "61", field: "cfg", type: "number", default: 1 },
    // KSampler → VAEDecodeAudio.samples
    denoise: { nodeId: "61", field: "denoise", type: "number", default: 1 },
    // CheckpointLoaderSimple → VAEDecodeAudio.vae, KSampler.model
    ckptName: {
      nodeId: "76",
      field: "ckpt_name",
      type: "string",
      default: "stable_audio_3_medium.safetensors",
    },
    // CLIPLoader → TextGenerate.clip
    llmName: {
      nodeId: "62",
      field: "clip_name",
      type: "string",
      default: "qwen3.5_2b_bf16.safetensors",
    },
    // CLIPLoader → CLIPTextEncode.clip, CLIPTextEncode.clip
    clipName: {
      nodeId: "77",
      field: "clip_name",
      type: "string",
      default: "t5gemma_b_b_ul2.safetensors",
    },
  },
  outputs: {
    audio: { nodeId: "57", type: "audio" },
  },
});
