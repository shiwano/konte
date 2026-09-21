// source-hash: c3a97075c30a61c22c82335f423d1717206826bdb8af23f4dcde6794ceff903f
// source: github.com/Comfy-Org/workflow_templates / templates/video_minimax_h3_r2v.json (MIT License)
import {
  defineComfyAsset,
  formatCutTime,
  inertInputs,
  minimaxH3Dialogue,
  minimaxH3Prompt,
  promptReferenceTags,
} from "konte";

type Task =
  | "keyframe completion"
  | "reference generation"
  | "video editing"
  | "video continuation"
  | "audio reuse"
  | "audio reference";
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

export const videoMinimaxH3R2v = defineComfyAsset({
  workflow: "video_minimax_h3_r2v.json",
  description:
    "MiniMax H3 R2V — a ~≤15s shot from up to nine images, three clips, three audios; pins first/last frame to a panel, lip-syncs the stem.",
  guide: [
    "konte/guides/minimax-h3.md",
    "konte/guides/minimax-h3-picture.md",
    "konte/guides/minimax-h3-sound.md",
    "konte/guides/minimax-h3-r2v.md",
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
    {
      filename: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
      type: "lora",
      url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    },
  ],
  inputs: {
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_0
    image1: { nodeId: "137", field: "image", type: "image", required: true },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_1
    image2: { nodeId: "139", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_2
    image3: { nodeId: "147", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_3
    image4: { nodeId: "148", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_4
    image5: { nodeId: "149", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_5
    image6: { nodeId: "150", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_6
    image7: { nodeId: "151", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_7
    image8: { nodeId: "152", field: "image", type: "image" },
    // LoadImage → MiniMaxH3ReferenceToVideo.ref_images.ref_image_8
    image9: { nodeId: "153", field: "image", type: "image" },
    // LoadVideo → GetVideoComponents → MiniMaxH3ReferenceToVideo.ref_videos.ref_video_0
    //
    // `branch` takes the splitter with the loader when the input is omitted. The clip's own
    // soundtrack is `video1Audio`'s.
    video1: { nodeId: "154", field: "file", type: "video", branch: ["155"] },
    // LoadVideo → GetVideoComponents → MiniMaxH3ReferenceToVideo.ref_videos.ref_video_1
    video2: { nodeId: "156", field: "file", type: "video", branch: ["157"] },
    // LoadVideo → GetVideoComponents → MiniMaxH3ReferenceToVideo.ref_videos.ref_video_2
    video3: { nodeId: "158", field: "file", type: "video", branch: ["159"] },
    // LoadAudio → MiniMaxH3ReferenceToVideo.ref_video_audios.ref_video_audio_0
    video1Audio: {
      nodeId: "169",
      field: "audio",
      type: "video",
      description:
        "Takes `video1`'s own soundtrack in beside it as an `<Audio N>` — pass the same clip. Omitted, the clip goes in as picture alone and spends no ordinal.",
    },
    // LoadAudio → MiniMaxH3ReferenceToVideo.ref_video_audios.ref_video_audio_1
    video2Audio: {
      nodeId: "170",
      field: "audio",
      type: "video",
      description:
        "Takes `video2`'s own soundtrack in beside it as an `<Audio N>` — pass the same clip. Omitted, the clip goes in as picture alone and spends no ordinal.",
    },
    // LoadAudio → MiniMaxH3ReferenceToVideo.ref_video_audios.ref_video_audio_2
    video3Audio: {
      nodeId: "171",
      field: "audio",
      type: "video",
      description:
        "Takes `video3`'s own soundtrack in beside it as an `<Audio N>` — pass the same clip. Omitted, the clip goes in as picture alone and spends no ordinal.",
    },
    // LoadAudio → MiniMaxH3ReferenceToVideo.ref_audios.ref_audio_0
    audio1: { nodeId: "160", field: "audio", type: "audio" },
    // LoadAudio → MiniMaxH3ReferenceToVideo.ref_audios.ref_audio_1
    audio2: { nodeId: "161", field: "audio", type: "audio" },
    // LoadAudio → MiniMaxH3ReferenceToVideo.ref_audios.ref_audio_2
    audio3: { nodeId: "162", field: "audio", type: "audio" },
    // LoadAudio → MiniMaxH3AddGuide.audio (→ BasicGuider.conditioning)
    //
    // `branch` takes the guide node with the loader when the input is omitted.
    audioStem: {
      nodeId: "163",
      field: "audio",
      type: "audio",
      branch: [{ nodeId: "164", passThrough: "positive" }],
      description:
        "The take's own soundtrack, anchored at frame 0 so the lips follow it — the shot's `animatic.stem`. It takes no `<Audio N>` tag. Cropped to the take's length.",
    },
    // LoadImage → MiniMaxH3AddGuide.image at frame 0 (→ BasicGuider.conditioning)
    //
    // `branch` takes the guide node with the loader when the input is omitted.
    startImage: {
      nodeId: "165",
      field: "image",
      type: "image",
      pin: "start",
      branch: [{ nodeId: "166", passThrough: "positive" }],
      description:
        "Pins the first frame to this image pixel for pixel, with or without a reference. It takes no `<Picture N>` tag — pass the same panel as `image1` to name it in the prompt (keyframe completion).",
    },
    // LoadImage → MiniMaxH3AddGuide.image at frame_idx (→ BasicGuider.conditioning)
    endImage: {
      nodeId: "167",
      field: "image",
      type: "image",
      pin: { end: { nodeId: "168", field: "frame_idx" } },
      branch: [{ nodeId: "168", passThrough: "positive" }],
      description:
        "Pins the frame just past the shot to this image; the take lands on it instead of wherever the prompt takes it.",
    },
    // MiniMaxH3ReferenceToVideo → SamplerCustomAdvanced.latent_image, BasicGuider.conditioning
    prompt: {
      nodeId: "136",
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
            description: "shots: [Shot 1] as a string, each later one as { at: seconds, text }",
            render: (d: { style: string; shots: [string, ...Cut[]] }) =>
              `detailed_description: ${d.style} ${shotsText(d.shots)}`,
          },
          overallSoundscape: {
            required: true,
            render: (text: string) => `overall_soundscape: ${text}`,
          },
          nonDiegeticMusic: {
            required: true,
            render: (text: string) => `non_diegetic_music: ${text}`,
          },
        },
      },
    },
    // MiniMaxH3ReferenceToVideo → SamplerCustomAdvanced.latent_image, BasicGuider.conditioning
    width: { nodeId: "136", field: "width", type: "width", default: 1344, grid: { step: 32 } },
    // MiniMaxH3ReferenceToVideo → SamplerCustomAdvanced.latent_image, BasicGuider.conditioning
    height: { nodeId: "136", field: "height", type: "height", default: 768, grid: { step: 32 } },
    // MiniMaxH3ReferenceToVideo → SamplerCustomAdvanced.latent_image, BasicGuider.conditioning
    length: {
      nodeId: "136",
      field: "length",
      type: "frames",
      clock: 24,
      default: 120,
      grid: { step: 17, offset: 5 },
      max: 362,
      description:
        "Follows the shot's duration on a 24fps clock; the default stands in where none is in scope. Trained to 362 (~15s); a longer shot is rejected at load.",
    },
    // MiniMaxH3ReferenceToVideo → SamplerCustomAdvanced.latent_image, BasicGuider.conditioning
    refImageSize: {
      nodeId: "136",
      field: "ref_image_size",
      type: "string",
      default: "max",
      values: ["match", "max"],
      description:
        '"match" scales each reference to the generation\'s pixel area; "max" holds a 2048px short edge — stronger identity, several times the cost.',
    },
    // RandomNoise → SamplerCustomAdvanced.noise
    seed: { nodeId: "129", field: "noise_seed", type: "seed", default: 0 },
    // PrimitiveInt → BasicScheduler.steps
    steps: {
      nodeId: "143",
      field: "value",
      type: "number",
      default: 20,
      description: "Not read by the turbo take, which samples through the 4-step turbo LoRA.",
    },
    // PrimitiveBoolean → ComfySwitchNode.switch, ComfySwitchNode.switch, ComfySwitchNode.switch
    useTurbo: {
      nodeId: "146",
      field: "value",
      type: "boolean",
      default: false,
      description:
        "Samples through the 4-step turbo LoRA on its own euler/simple schedule instead of the base weights; `steps` is not read.",
    },
    // CreateVideo → SaveVideo.video
    //
    // Left a plain number, not the canvas `"fps"` type: the model settles a burst on a 24fps clock,
    // so muxing it at another rate rescales the motion and slips the audio decoded alongside it.
    fps: { nodeId: "130", field: "fps", type: "number", default: 24 },
    // UNETLoader → BasicScheduler.model, ComfySwitchNode.on_false, LoraLoaderModelOnly.model
    unetName: {
      nodeId: "127",
      field: "unet_name",
      type: "string",
      default: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    },
    // CLIPLoader → MiniMaxH3ReferenceToVideo.clip
    clipName: {
      nodeId: "128",
      field: "clip_name",
      type: "string",
      default: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
    // VAELoader → VAEDecode.vae, MiniMaxH3ReferenceToVideo.vae
    vaeName: {
      nodeId: "119",
      field: "vae_name",
      type: "string",
      default: "minimax_h3_video_vae_int8_convrot.safetensors",
    },
    // VAELoader → VAEDecodeAudio.vae, MiniMaxH3ReferenceToVideo.audio_vae
    audioVaeName: {
      nodeId: "120",
      field: "vae_name",
      type: "string",
      default: "minimax_h3_audio_vae_fp32.safetensors",
    },
    // LoraLoaderModelOnly → ComfySwitchNode.on_true, BasicScheduler.model
    loraName: {
      nodeId: "145",
      field: "lora_name",
      type: "string",
      default: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    },
  },
  outputs: {
    video: { nodeId: "92", type: "video" },
  },
  validators: [
    minimaxH3Prompt({ mode: "r2v", length: "length" }),
    inertInputs({
      inputs: { video1Audio: "" },
      whenUnset: { video1: "" },
      reason: "a soundtrack rides on the clip it belongs to, and `video1` is not passed",
      fix: "Pass the clip as `video1`, or drop `video1Audio`.",
    }),
    inertInputs({
      inputs: { video2Audio: "" },
      whenUnset: { video2: "" },
      reason: "a soundtrack rides on the clip it belongs to, and `video2` is not passed",
      fix: "Pass the clip as `video2`, or drop `video2Audio`.",
    }),
    inertInputs({
      inputs: { video3Audio: "" },
      whenUnset: { video3: "" },
      reason: "a soundtrack rides on the clip it belongs to, and `video3` is not passed",
      fix: "Pass the clip as `video3`, or drop `video3Audio`.",
    }),
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
        Video: ["video1", "video2", "video3"],
        // Not a numbered family: a silent clip leaves a hole here.
        Audio: ["video1Audio", "video2Audio", "video3Audio", "audio1", "audio2", "audio3"],
      },
    }),
  ],
  turbo: { useTurbo: true },
  promptExemptions: [
    /\bnothing\b[^.,;]*\b(?:moves|slides|turns|tilts|enters|leaves|shifts|changes)\b/i,
    /\bdoes\s+not\s+move\b/i,
  ],
  spokenTextPattern: minimaxH3Dialogue,
});
