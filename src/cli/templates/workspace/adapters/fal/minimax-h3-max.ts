import { defineFalAsset, requireOneOf } from "konte";

const ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const RESOLUTIONS = ["480P", "768P", "1080P"] as const;
const PROMPT_EXPANSION_MODES = ["disabled", "balanced", "quality"] as const;

// A double-quoted line in prose, or a `<d>` span in H3's own structured prompt.
const SPOKEN_LINE = /(?:<d>\s*\[[^\]]+\]\s*|")([^"<]+?)(?:<\/d>|")/g;

const DURATION_DESC = "Whole seconds, 5-15.";
const RESOLUTION_DESC =
  "768P is the resolution the model is tuned around; 1080P is a latent refinement of a 768P render.";
const PROMPT_EXPANSION_DESC =
  "How far the provider rewrites the prompt before generating. 'disabled' sends it as written; 'balanced' adds about a second; 'quality' spends up to ~30s on a richer rewrite.";

export const falMinimaxH3MaxT2v = defineFalAsset({
  endpointId: "minimax/h3-max/text-to-video",
  description:
    "MiniMax H3 Max T2V — keyframeless 5-15s shot from a prompt with synchronized audio (dialogue lip-sync, foley, ambience, music); strong prompt adherence, holds one look across cuts.",
  mediaType: "video",
  guide: "konte/guides/minimax-h3-max.md",
  spokenTextPattern: SPOKEN_LINE,
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    duration: { field: "duration", type: "number", default: 5, description: DURATION_DESC },
    aspectRatio: { field: "aspect_ratio", type: "string", default: "16:9", values: ASPECT_RATIOS },
    resolution: {
      field: "resolution",
      type: "string",
      default: "768P",
      values: RESOLUTIONS,
      description: RESOLUTION_DESC,
    },
    promptExpansionMode: {
      field: "prompt_expansion_mode",
      type: "string",
      default: "balanced",
      values: PROMPT_EXPANSION_MODES,
      description: PROMPT_EXPANSION_DESC,
    },
    seed: { field: "seed", type: "seed" },
  },
});

export const falMinimaxH3MaxI2v = defineFalAsset({
  endpointId: "minimax/h3-max/image-to-video",
  description:
    "MiniMax H3 Max I2V — 5-15s shot from a first and/or last frame with synchronized audio; the output ratio follows the frame passed.",
  mediaType: "video",
  guide: "konte/guides/minimax-h3-max.md",
  spokenTextPattern: SPOKEN_LINE,
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    image: {
      field: "image_url",
      type: "image",
      pin: "start",
      description: "Frame the shot starts from. The output canvas follows it.",
    },
    endImage: {
      field: "end_image_url",
      type: "image",
      pin: "end",
      description: "Frame the shot lands on. Passed alone, the output canvas follows it instead.",
    },
    duration: { field: "duration", type: "number", default: 5, description: DURATION_DESC },
    resolution: {
      field: "resolution",
      type: "string",
      default: "768P",
      values: RESOLUTIONS,
      description: RESOLUTION_DESC,
    },
    promptExpansionMode: {
      field: "prompt_expansion_mode",
      type: "string",
      default: "balanced",
      values: PROMPT_EXPANSION_MODES,
      description: PROMPT_EXPANSION_DESC,
    },
    seed: { field: "seed", type: "seed" },
  },
  validators: requireOneOf({
    inputs: { image: "", endImage: "" },
    reason: "image-to-video has no frame to anchor on. Wire one, or take the T2V adapter.",
  }),
});

export const falMinimaxH3MaxR2v = defineFalAsset({
  endpointId: "minimax/h3-max/reference-to-video",
  description:
    "MiniMax H3 Max R2V — 5-15s shot built from up to 9 reference images, 3 clips and 3 audios with synchronized audio; pick it when identity, a move or a voice has to come through as supplied.",
  mediaType: "video",
  guide: "konte/guides/minimax-h3-max.md",
  spokenTextPattern: SPOKEN_LINE,
  inputs: {
    prompt: { field: "prompt", type: "prompt", required: true },
    referenceImages: {
      field: "reference_image_urls",
      type: "image",
      array: true,
      description:
        "Subject and style references, named Image 1, Image 2, … in the prompt in list order. Up to 9; 12 files across all references.",
    },
    referenceVideos: {
      field: "reference_video_urls",
      type: "video",
      array: true,
      description:
        "Motion references, named Video 1, Video 2, … in list order. Up to 3, each 2-15s, 15s combined.",
    },
    referenceAudios: {
      field: "reference_audio_urls",
      type: "audio",
      array: true,
      description:
        "Audio references, named Audio 1, Audio 2, … in list order. Up to 3, each 2-15s, 15s combined.",
    },
    duration: { field: "duration", type: "number", default: 5, description: DURATION_DESC },
    aspectRatio: {
      field: "aspect_ratio",
      type: "string",
      default: "adaptive",
      values: ["adaptive", ...ASPECT_RATIOS],
    },
    resolution: {
      field: "resolution",
      type: "string",
      default: "768P",
      values: RESOLUTIONS,
      description: RESOLUTION_DESC,
    },
    promptExpansionMode: {
      field: "prompt_expansion_mode",
      type: "string",
      default: "balanced",
      values: PROMPT_EXPANSION_MODES,
      description: PROMPT_EXPANSION_DESC,
    },
    seed: { field: "seed", type: "seed" },
  },
  validators: requireOneOf({
    inputs: { referenceImages: "", referenceVideos: "", referenceAudios: "" },
    reason: "reference-to-video has nothing to reference. Wire one, or take the T2V adapter.",
  }),
});
