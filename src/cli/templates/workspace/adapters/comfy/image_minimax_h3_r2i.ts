// source-hash: 8edfef99106d3342c229e0594e6dd1aedad95717f1e90adb5462d644479209a0
// source: konte / workflows/konte/image_minimax_h3_r2i.json (hand-authored)
import {
  defineComfyAsset,
  formatCutTime,
  minimaxH3CutSource,
  minimaxH3Prompt,
  promptReferenceTags,
} from "konte";

type Task = "keyframe completion" | "reference generation";
type Cut = { at: number; text: string };

const labelLines = (header: string) => (lines: string[]) =>
  `${header}: ${lines.length > 0 ? lines.join("\n") : "N/A"}`;

const shotsText = (shots: readonly (string | Cut)[]) =>
  shots
    .map((shot, i) =>
      typeof shot === "string"
        ? `[Shot ${i + 1}] ${shot}`
        : `[Shot ${i + 1}] At ${formatCutTime(shot.at)}, ${shot.text}`,
    )
    .join(" ");

export const imageMinimaxH3R2i = defineComfyAsset({
  workflow: "image_minimax_h3_r2i.json",
  description:
    "MiniMax H3 R2I — a still from a prompt plus up to nine reference images; the origin of a frame, keeping the scene of every reference passed, so never a sheet. Takes a two-shot description, cutting into the frame from the panel before it.",
  guide: [
    "konte/guides/minimax-h3.md",
    "konte/guides/minimax-h3-picture.md",
    "konte/guides/minimax-h3-r2i.md",
  ],
  models: [
    {
      filename: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      type: "diffusion_model",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    },
    {
      filename: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "clip",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
    {
      filename: "minimax_h3_video_vae_int8_convrot.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors",
    },
    {
      filename: "minimax_h3_audio_vae_fp32.safetensors",
      type: "VAE",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
    },
  ],
  inputs: {
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_0
    image1: { nodeId: "21", field: "image", type: "image", required: true },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_1
    image2: { nodeId: "22", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_2
    image3: { nodeId: "23", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_3
    image4: { nodeId: "24", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_4
    image5: { nodeId: "25", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_5
    image6: { nodeId: "26", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_6
    image7: { nodeId: "27", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_7
    image8: { nodeId: "28", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_8
    image9: { nodeId: "29", field: "image", type: "image" },
    // MiniMaxH3ReferenceToVideo → BasicGuider.conditioning, SamplerCustomAdvanced.latent_image
    prompt: {
      nodeId: "10",
      field: "prompt",
      type: "prompt",
      required: true,
      structure: {
        join: "\n\n",
        fields: {
          subjectDefinitions: {
            required: true,
            description: "one line per label, label written in the line",
            render: labelLines("subject_definitions"),
          },
          summary: {
            required: true,
            render: (s: { tasks: [Task, ...Task[]]; text: string }) =>
              `summary: [${s.tasks.join(" + ")}] ${s.text}`,
          },
          retentionAnalysis: {
            required: true,
            description: "one line per label",
            render: labelLines("retention_analysis"),
          },
          detailedDescription: {
            required: true,
            description: "shots: [Shot 1] as a string, [Shot 2] as { at: seconds, text }",
            render: (d: { style: string; shots: [string] | [string, Cut] }) =>
              `detailed_description: ${d.style} ${shotsText(d.shots)}`,
          },
          overallSoundscape: { render: () => "overall_soundscape: N/A" },
          nonDiegeticMusic: { render: () => "non_diegetic_music: N/A" },
        },
      },
    },
    // MiniMaxH3ReferenceToVideo → BasicGuider.conditioning, SamplerCustomAdvanced.latent_image
    width: { nodeId: "10", field: "width", type: "width", default: 1344, grid: { step: 32 } },
    // MiniMaxH3ReferenceToVideo → BasicGuider.conditioning, SamplerCustomAdvanced.latent_image
    height: { nodeId: "10", field: "height", type: "height", default: 768, grid: { step: 32 } },
    // MiniMaxH3ReferenceToVideo → BasicGuider.conditioning, SamplerCustomAdvanced.latent_image
    refImageSize: {
      nodeId: "10",
      field: "ref_image_size",
      type: "string",
      default: "max",
      values: ["match", "max"],
      description:
        '"match" scales each reference to the generation\'s pixel area; "max" holds a 2048px short edge — stronger identity, several times the cost.',
    },
    // RandomNoise → SamplerCustomAdvanced.noise
    seed: { nodeId: "11", field: "noise_seed", type: "seed", default: 0 },
    // BasicScheduler → SamplerCustomAdvanced.sigmas
    steps: { nodeId: "13", field: "steps", type: "number", default: 20 },
    // MiniMaxH3ReferenceToVideo → BasicGuider.conditioning, SamplerCustomAdvanced.latent_image
    length: {
      nodeId: "10",
      field: "length",
      type: "number",
      default: 22,
      description:
        "Frames the model settles over — only the rungs 5, 22, 39, 56, 73, 90, 107, 124 land, a value between rounds up. A description carrying a cut takes 22 or more.",
    },
    // ImageFromBatch → SaveImage.images
    frameIndex: {
      nodeId: "17",
      field: "batch_index",
      type: "number",
      default: 8,
      description:
        "Which frame of the burst is kept: 0-based, clamped to the last. On a description that carries a cut it lands past the last one.",
    },
    // UNETLoader → BasicScheduler.model, BasicGuider.model
    unetName: {
      nodeId: "1",
      field: "unet_name",
      type: "string",
      default: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    },
    // CLIPLoader → MiniMaxH3ReferenceToVideo.clip
    clipName: {
      nodeId: "2",
      field: "clip_name",
      type: "string",
      default: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
    // VAELoader → MiniMaxH3ReferenceToVideo.vae, VAEDecode.vae
    vaeName: {
      nodeId: "3",
      field: "vae_name",
      type: "string",
      default: "minimax_h3_video_vae_int8_convrot.safetensors",
    },
    // VAELoader → MiniMaxH3ReferenceToVideo.audio_vae
    audioVaeName: {
      nodeId: "4",
      field: "vae_name",
      type: "string",
      default: "minimax_h3_audio_vae_fp32.safetensors",
    },
  },
  outputs: {
    image: { nodeId: "18", type: "image" },
  },
  validators: [
    minimaxH3Prompt({ mode: "r2i", length: "length", frameIndex: "frameIndex" }),
    promptReferenceTags({
      tags: {
        Picture: [
          "image1",
          "image2",
          "image3",
          "image4",
          "image5",
          "image6",
          "image7",
          "image8",
          "image9",
        ],
        Video: [],
        Audio: [],
      },
      prevPanel: { tag: "Picture", within: minimaxH3CutSource },
    }),
  ],
  readsPrevPanel: true,
  promptExemptions: [
    /\bnothing\b[^.,;]*\b(?:moves|slides|turns|tilts|enters|leaves|shifts|changes)\b/i,
    /\bdoes\s+not\s+move\b/i,
  ],
});
