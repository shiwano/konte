import { defineFalAsset, requireOneOf } from "konte";

const DURATION_SECONDS = [
  "auto",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "29",
  "30",
] as const;

const ASPECT_RATIOS = ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const RESOLUTIONS = ["480p", "720p", "1080p"] as const;

const RESOLUTION_DESC = "Higher = better quality but slower and more costly.";
const GENERATE_AUDIO_DESC =
  "Native sound effects, ambience and lip-synced speech; the take costs the same either way. With it on, the prompt's audio cues and its double-quoted lines drive the soundtrack.";
const BITRATE_MODE_DESC = "'high' asks for a larger-file, higher-quality encode of the same take.";

export const falSeedance25T2v = defineFalAsset({
  endpointId: "bytedance/seedance-2.5/text-to-video",
  description:
    "Seedance 2.5 T2V — keyframeless shot from a prompt; up to 30s in one pass, native audio, several connected beats holding identity and continuity across them.",
  mediaType: "video",
  guide: "konte/guides/seedance-2-5.md",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    duration: { field: "duration", type: "string", default: "auto", values: DURATION_SECONDS },
    aspectRatio: {
      field: "aspect_ratio",
      type: "string",
      default: "auto",
      values: ASPECT_RATIOS,
    },
    resolution: {
      field: "resolution",
      type: "string",
      default: "720p",
      values: RESOLUTIONS,
      description: RESOLUTION_DESC,
    },
    generateAudio: {
      field: "generate_audio",
      type: "boolean",
      default: true,
      description: GENERATE_AUDIO_DESC,
    },
    bitrateMode: {
      field: "bitrate_mode",
      type: "string",
      default: "standard",
      values: ["standard", "high"],
      description: BITRATE_MODE_DESC,
    },
  },
});

export const falSeedance25I2v = defineFalAsset({
  endpointId: "bytedance/seedance-2.5/image-to-video",
  description:
    "Seedance 2.5 I2V — shot anchored on a keyframe, optionally landing on a second; up to 30s in one pass, native audio, holds identity through the motion.",
  mediaType: "video",
  guide: "konte/guides/seedance-2-5.md",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    image: {
      field: "image_url",
      type: "image",
      required: true,
      pin: "start",
      description:
        "Keyframe the shot starts from — don't re-describe it; repeat only a few identity anchors and describe the motion. The output ratio follows this frame.",
    },
    endImage: {
      field: "end_image_url",
      type: "image",
      pin: "end",
      description:
        "Frame the shot lands on — describe the movement towards it, not the state it already fixes.",
    },
    duration: { field: "duration", type: "string", default: "auto", values: DURATION_SECONDS },
    resolution: {
      field: "resolution",
      type: "string",
      default: "720p",
      values: RESOLUTIONS,
      description: RESOLUTION_DESC,
    },
    generateAudio: {
      field: "generate_audio",
      type: "boolean",
      default: true,
      description: GENERATE_AUDIO_DESC,
    },
    bitrateMode: {
      field: "bitrate_mode",
      type: "string",
      default: "standard",
      values: ["standard", "high"],
      description: BITRATE_MODE_DESC,
    },
  },
});

export const falSeedance25R2v = defineFalAsset({
  endpointId: "bytedance/seedance-2.5/reference-to-video",
  description:
    "Seedance 2.5 R2V — shot built from up to 30 reference images, 10 clips and 10 audios; pick it when identity, a move or a voice has to come through as supplied.",
  mediaType: "video",
  guide: "konte/guides/seedance-2-5.md",
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    referenceImages: {
      field: "image_urls",
      type: "image",
      array: true,
      description:
        "Identity, style and composition references, addressed @Image1, @Image2, … in prompt order. Up to 30.",
    },
    referenceVideos: {
      field: "video_urls",
      type: "video",
      array: true,
      description:
        "Motion and editing references, addressed @Video1, @Video2, … in prompt order. Up to 10, each 1.8-30.2s, 30.2s combined.",
    },
    referenceAudios: {
      field: "audio_urls",
      type: "audio",
      array: true,
      description:
        "Rhythm, timing and voice references driving lip-sync, addressed @Audio1, @Audio2, … in prompt order. Up to 10, each 1.8-30.2s, 30.2s combined.",
    },
    duration: { field: "duration", type: "string", default: "auto", values: DURATION_SECONDS },
    aspectRatio: {
      field: "aspect_ratio",
      type: "string",
      default: "auto",
      values: ASPECT_RATIOS,
    },
    resolution: {
      field: "resolution",
      type: "string",
      default: "720p",
      values: RESOLUTIONS,
      description: RESOLUTION_DESC,
    },
    generateAudio: {
      field: "generate_audio",
      type: "boolean",
      default: true,
      description: GENERATE_AUDIO_DESC,
    },
    bitrateMode: {
      field: "bitrate_mode",
      type: "string",
      default: "standard",
      values: ["standard", "high"],
      description: BITRATE_MODE_DESC,
    },
  },
  validators: [
    requireOneOf({
      inputs: { referenceImages: "", referenceVideos: "", referenceAudios: "" },
      reason: "reference-to-video has nothing to reference. Wire one, or take the T2V adapter.",
    }),
    (inputs) =>
      inputs.referenceAudios !== undefined &&
      inputs.referenceImages === undefined &&
      inputs.referenceVideos === undefined
        ? `"referenceAudios" is set with no picture reference. The model drives audio onto a subject it can see, so wire at least one "referenceImages" or "referenceVideos".`
        : undefined,
  ],
});
