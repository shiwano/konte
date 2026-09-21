// source-hash: 2be2df3c0061fbc87290bbfd9367c298d9ba01453f8c9f045323a35a61a277a1
// source: github.com/Comfy-Org/workflow_templates / templates/audio_ace_step1_5_xl_turbo.json (MIT License)
import { defineComfyAsset } from "konte";

export const audioAceStep15XlTurbo = defineComfyAsset({
  workflow: "audio_ace_step1_5_xl_turbo.json",
  description:
    "ACE-Step 1.5 XL turbo — a sung song, or a bed with lyrics left empty, from tags, cut to the shot it plays over.",
  guide: "konte/guides/ace-step.md",
  models: [
    {
      filename: "acestep_v1.5_xl_turbo_bf16.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors",
    },
    {
      filename: "qwen_0.6b_ace15.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors",
    },
    {
      filename: "qwen_4b_ace15.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_4b_ace15.safetensors",
    },
    {
      filename: "ace_1.5_vae.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors",
    },
  ],
  inputs: {
    // KSampler → VAEDecodeAudio.samples
    steps: { nodeId: "3", field: "steps", type: "number", default: 8 },
    // KSampler → VAEDecodeAudio.samples
    cfg: { nodeId: "3", field: "cfg", type: "number", default: 1 },
    // KSampler → VAEDecodeAudio.samples
    denoise: { nodeId: "3", field: "denoise", type: "number", default: 1 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    tags: {
      nodeId: "94",
      field: "tags",
      type: "prompt",
      default:
        "Late Night Trap, 95 BPM, Heavy 808 Bass, Wet Synths, Female Background Vocals, Male Rap Vocals + Seductive Female Vocals, Dark Bedroom Production, Atmospheric Club Vibes, Breathy Whispers, Slap Bass, Deep Sub Bass, Cinematic R&B Soundtrack Feel",
    },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    lyrics: {
      nodeId: "94",
      field: "lyrics",
      type: "spokenText",
      default:
        "[Verse 1]\nOpen up the canvas, blank slate on my screen\nDrag a checkpoint loader, you know what I mean\nKSampler in the middle, VAE on the right\nClip text encode, yeah I'm building tonight\n[Chorus]\nConnect the nodes, run the queue\nWatch the latent flow right through\nGreen dot to green dot, link it up\nPositive prompt in my cup\n[Verse 2]\nEmpty latent image, set the width and height\nPlug it to the sampler, get the settings right\nCFG at seven, steps at twenty-two\nHit that Queue Prompt button, render coming through\n[Bridge]\nUpscale node, ControlNet in the chain\nLora stacked on Lora driving me insane\nSave image at the end of every single flow\nRed wire means broken — fix it, let it go\n[Outro]\nNodes connected, workflow clean\nBest AI pipeline you ever seen\nComfyUI, yeah we building art\nOne node at a time right from the start",
    },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    bpm: { nodeId: "94", field: "bpm", type: "number", default: 95 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    timeSignature: { nodeId: "94", field: "timesignature", type: "string", default: "4" },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    language: { nodeId: "94", field: "language", type: "string", default: "en" },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    keyScale: { nodeId: "94", field: "keyscale", type: "string", default: "E minor" },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    generateAudioCodes: {
      nodeId: "94",
      field: "generate_audio_codes",
      type: "boolean",
      default: true,
    },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    cfgScale: { nodeId: "94", field: "cfg_scale", type: "number", default: 2 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    temperature: { nodeId: "94", field: "temperature", type: "number", default: 0.85 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    topP: { nodeId: "94", field: "top_p", type: "number", default: 0.9 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    topK: { nodeId: "94", field: "top_k", type: "number", default: 0 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    minP: { nodeId: "94", field: "min_p", type: "number", default: 0 },
    // TextEncodeAceStepAudio1.5 → KSampler.positive, ConditioningZeroOut.conditioning
    duration: {
      nodeId: "94",
      field: "duration",
      type: "seconds",
      default: 120,
      also: [{ nodeId: "98", field: "seconds" }],
      description:
        "Clip length in seconds; follows the shot's duration where one is in scope, and the default stands in on the timeline.",
    },
    // UNETLoader → ModelSamplingAuraFlow.model
    unetName: {
      nodeId: "104",
      field: "unet_name",
      type: "string",
      default: "acestep_v1.5_xl_turbo_bf16.safetensors",
    },
    // DualCLIPLoader → TextEncodeAceStepAudio1.5.clip
    clipName1: {
      nodeId: "105",
      field: "clip_name1",
      type: "string",
      default: "qwen_0.6b_ace15.safetensors",
    },
    // DualCLIPLoader → TextEncodeAceStepAudio1.5.clip
    clipName2: {
      nodeId: "105",
      field: "clip_name2",
      type: "string",
      default: "qwen_4b_ace15.safetensors",
    },
    // VAELoader → VAEDecodeAudio.vae
    vaeName: {
      nodeId: "106",
      field: "vae_name",
      type: "string",
      default: "ace_1.5_vae.safetensors",
    },
    // PrimitiveInt → KSampler.seed, TextEncodeAceStepAudio1.5.seed
    seed: { nodeId: "109", field: "value", type: "seed", default: 0 },
  },
  outputs: {
    audio: { nodeId: "111", type: "audio" },
  },
});
